import type {FastifyInstance} from 'fastify';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {requireActor,editors} from './auth.js';
import {adminPool,withWorkspace,badRequest,notFound,camel} from './db.js';
import {config} from './config.js';
import {privateStorage,safeDownloadName,validateStorageKey} from './storage.js';
import {addDocument} from './intake.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';
import {canonicalPdfSplitSpec,pdfSplitSpecSchema,PdfSplitValidationError} from '../../shared/pdf-split.js';
import {addSplitDocuments} from './pdf-split-intake.js';
import {readPdfSplitReceipt,storedObjectReferenced,assertUploadedSplitBinding} from './pdf-split-records.js';
import {archiveImportSpecSchema,canonicalArchiveImportSpec,ArchiveImportValidationError} from '../../shared/archive-import.js';
import {addArchiveDocuments,previewArchiveDocuments} from './archive-import-intake.js';
import {readArchiveImportReceipt,assertArchiveRequestBinding} from './archive-import-records.js';

const reserveBody=z.object({filename:z.string().min(1).max(300),size:z.number().int().min(1).max(10*1024*1024),sha256:z.string().regex(/^[0-9a-f]{64}$/),pdfSplit:z.object({requestId:z.string().uuid().transform(value=>value.toLowerCase()),options:pdfSplitSpecSchema.optional()}).strict().optional(),archiveImport:z.object({requestId:z.string().uuid().transform(value=>value.toLowerCase()),options:archiveImportSpecSchema.optional()}).strict().optional()}).strict().refine(body=>!(body.pdfSplit&&body.archiveImport),'Choose one import operation.');
class UploadBytesMismatch extends Error {readonly statusCode=400;constructor(){super('Uploaded bytes do not match this reservation. Start a new upload.');}}
const uploadId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
export async function reserveDirectUpload(actor:Actor,parserId:string,input:z.infer<typeof reserveBody>){
  const storage=privateStorage();if(!storage.signUpload)badRequest('Direct upload is unavailable on this installation',409);
  const body=reserveBody.parse(input),id=randomUUID(),key=`${actor.workspaceId}/${id}`;
  const reservation=await withWorkspace(actor.workspaceId,async c=>{
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
    const parser=(await c.query('select id,field_setup_state,allowed_formats from parsers where id=$1 and workspace_id=$2 and archived=false for update',[parserId,actor.workspaceId])).rows[0];
    if(!parser)notFound('Active parser not found');
    if(body.pdfSplit){
      await assertUploadedSplitBinding(c,actor.workspaceId,parserId,body.pdfSplit.requestId,body.sha256,body.pdfSplit.options?canonicalPdfSplitSpec(body.pdfSplit.options):undefined);
      if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before splitting a document.',409);
      if(parser.allowed_formats!==null&&!parser.allowed_formats.some((format:string)=>['pdf','tiff'].includes(format)))badRequest('This parser must allow PDF or TIFF files before splitting.',415);
    }
    if(body.archiveImport){
      if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before importing a ZIP.',409);
      if(body.archiveImport.options&&body.archiveImport.options.sourceSha256!==body.sha256)throw new ArchiveImportValidationError('source_mismatch');
      await assertArchiveRequestBinding(c,actor.workspaceId,parserId,body.archiveImport.requestId,body.sha256,body.archiveImport.options?canonicalArchiveImportSpec(body.archiveImport.options):undefined);
    }
    const {rows:[workspace]}=await c.query('select plan from workspaces where id=$1',[actor.workspaceId]);
    if(body.size>Math.min(config.maxBytes,workspace.plan.maxBytes))badRequest('Document exceeds the workspace file limit',413);
    const {rows:[usage]}=await c.query("select coalesce(sum(pages),0)::int used from usage_ledger where workspace_id=$1 and created_at>=date_trunc('month',now())",[actor.workspaceId]);
    const {rows:[reserved]}=await c.query(`select count(*)::int total,
      coalesce(sum(case when state='complete' then expected_bytes else 10485760 end),0)::bigint bytes,
      count(*) filter(where state in('pending','finalizing') and expires_at>now())::int active,
      count(*) filter(where state in('pending','finalizing') and expires_at>now()
        and not coalesce((pdf_split_request_id=$2::uuid and parser_id=$3::uuid and expected_sha256=$4 and (pdf_split_spec is null or $5::jsonb is null or pdf_split_spec=$5::jsonb))
          or (archive_request_id=$6::uuid and parser_id=$3::uuid and expected_sha256=$4),false))::int page_reservations
      from direct_uploads u where workspace_id=$1 and (state<>'cleaned' or exists(select 1 from file_deletions f where f.workspace_id=u.workspace_id and f.storage_key=u.storage_key))`,[actor.workspaceId,body.pdfSplit?.requestId??null,parserId,body.sha256,body.pdfSplit?.options?canonicalPdfSplitSpec(body.pdfSplit.options):null,body.archiveImport?.requestId??null]);
    // Multiple staging capabilities for the same split can commit only once.
    // Their object/active-slot limits still count every physical reservation.
    if(usage.used+reserved.page_reservations+1>workspace.plan.monthlyPages)badRequest('Monthly page quota reached. Complete pending uploads or update the plan.',429);
    const splitIntents=(await c.query('select coalesce(sum(reserved_bytes),0)::bigint bytes from intake_files where workspace_id=$1 and (split_attempt_id is not null or archive_attempt_id is not null)',[actor.workspaceId])).rows[0];
    if(reserved.active>=20||reserved.total>=100||Number(reserved.bytes)+Number(splitIntents.bytes)+config.maxBytes>250*1024*1024)badRequest('Too many recent uploads. Finish pending uploads or retry after their cleanup window.',429);
    const {rows:[row]}=await c.query('insert into direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256,pdf_split_spec,pdf_split_request_id,archive_spec,archive_request_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning expires_at,cleanup_after',[id,actor.workspaceId,parserId,actor.userId,key,safeDownloadName(body.filename),body.size,body.sha256,body.pdfSplit?.options?canonicalPdfSplitSpec(body.pdfSplit.options):null,body.pdfSplit?.requestId??null,body.archiveImport?.options?canonicalArchiveImportSpec(body.archiveImport.options):null,body.archiveImport?.requestId??null]);
    return row;
  });
  try{return {uploadId:id,uploadUrl:await storage.signUpload!(key),method:'PUT',headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},expiresAt:reservation.expires_at};}
  catch(error){await withWorkspace(actor.workspaceId,c=>c.query("update direct_uploads set state='failed' where id=$1 and state='pending'",[id]));throw error;}
}
export async function finalizeDirectUpload(actor:Actor,id:string):Promise<any>{
  const startedAt=Date.now();
  const leaseOwner=randomUUID();
  const claimed=await withWorkspace(actor.workspaceId,async c=>{
    const {rows:[row]}=await c.query('select * from direct_uploads where id=$1 and workspace_id=$2 for update',[id,actor.workspaceId]);
    if(!row||row.created_by!==actor.userId)notFound('Upload reservation not found');
    validateStorageKey(row.storage_key,actor.workspaceId);
    if(row.state==='complete'||row.state==='cleaned'){
      if(row.pdf_split_id)return {prior:await readPdfSplitReceipt(c,actor.workspaceId,row.pdf_split_id,true)};
      if(row.archive_import_id)return {prior:await readArchiveImportReceipt(c,actor.workspaceId,row.archive_import_id,true)};
      const {rows:[document]}=await c.query('select * from documents where id=$1 and workspace_id=$2',[row.document_id,actor.workspaceId]);
      if(!document)badRequest('This upload is no longer available. Start a new upload.',410);
      return {prior:{document:camel(document),duplicate:row.duplicate,jobId:row.job_id,replayed:true}};
    }
    if(row.state==='failed'||new Date(row.expires_at).getTime()<=Date.now())badRequest('This upload reservation expired or failed. Start a new upload.',410);
    if(row.state==='finalizing'&&new Date(row.finalize_lease_until).getTime()>Date.now())badRequest('This upload is being verified. Retry shortly.',409);
    if(row.pdf_split_request_id&&!row.pdf_split_spec)badRequest('Preview this document and confirm its page ranges before splitting.',409);
    if(row.archive_request_id&&!row.archive_spec)badRequest('Preview this ZIP and confirm the selected files before importing.',409);
    if(!(await c.query('select id from parsers where id=$1 and workspace_id=$2 and archived=false',[row.parser_id,actor.workspaceId])).rowCount)notFound('Active parser not found');
    await c.query("update direct_uploads set state='finalizing',finalize_owner=$2,finalize_lease_until=now()+interval '3 minutes' where id=$1",[id,leaseOwner]);
    return {row};
  });
  if(claimed.prior)return claimed.prior;
  const row=claimed.row!;
  try{
    const bytes=await privateStorage().read(row.storage_key,Math.min(config.maxBytes,row.expected_bytes));
    if(bytes.length!==row.expected_bytes||createHash('sha256').update(bytes).digest('hex')!==row.expected_sha256)throw new UploadBytesMismatch();
    // Persist a distinct object from these verified bytes. The original signed
    // capability never points at the immutable document object consumed by workers.
    if(row.pdf_split_spec){
      const remaining=120_000-(Date.now()-startedAt);
      if(remaining<=0)throw Object.assign(new Error('PDF splitting took too long. Retry the same upload.'),{statusCode:503});
      return await addSplitDocuments(actor,row.parser_id,bytes,row.filename,row.pdf_split_request_id,row.pdf_split_spec,{timeoutMs:remaining,directUpload:{id,owner:leaseOwner}});
    }
    if(row.archive_request_id){
      const remaining=120_000-(Date.now()-startedAt);
      if(remaining<=0)throw Object.assign(new Error('ZIP importing took too long. Retry the same upload.'),{statusCode:503});
      return await addArchiveDocuments(actor,row.parser_id,bytes,row.filename,row.archive_request_id,row.archive_spec,{timeoutMs:remaining,directUpload:{id,owner:leaseOwner}});
    }
    const result=await addDocument(actor,row.parser_id,bytes,row.filename,'application/octet-stream',`direct-upload:${id}`);
    await withWorkspace(actor.workspaceId,async c=>{
      const saved=await c.query("update direct_uploads set state='complete',document_id=$3,job_id=$4,duplicate=$5,finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2",[id,leaseOwner,result.document.id,result.jobId,result.duplicate]);
      if(!saved.rowCount)badRequest('Upload verification completed in another request. Retry shortly.',409);
    });
    return result;
  }catch(error){
    const terminal=error instanceof UploadBytesMismatch||error instanceof ParserFormatNotAllowedError||error instanceof SourceIntakeRejectedError||error instanceof PdfSplitValidationError||error instanceof ArchiveImportValidationError;
    await withWorkspace(actor.workspaceId,c=>c.query("update direct_uploads set state=$3,finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2",[id,leaseOwner,terminal?'failed':'pending']));
    throw error;
  }
}
/** Queue expired capabilities only after their provider upload token has expired. */
export async function reconcileExpiredDirectUploads(onlyWorkspaceId?:string,options:{signal?:AbortSignal;limit?:number}={}){
  if(options.signal?.aborted)return 0;
  const limit=Math.max(1,Math.min(20,options.limit??20));
  const workspaces=(await adminPool.query("select distinct workspace_id from direct_uploads where cleanup_after<now() and state<>'cleaned' and ($1::uuid is null or workspace_id=$1) order by workspace_id limit 10",[onlyWorkspaceId??null])).rows;
  let queued=0;
  for(const workspace of workspaces){if(options.signal?.aborted||queued>=limit)break;await withWorkspace(workspace.workspace_id,async c=>{
    const rows=(await c.query("select * from direct_uploads where workspace_id=$1 and cleanup_after<now() and state<>'cleaned' and (finalize_lease_until is null or finalize_lease_until<now()) order by cleanup_after,id limit $2 for update skip locked",[workspace.workspace_id,limit-queued])).rows;
    for(const row of rows){
      if(options.signal?.aborted)break;
      validateStorageKey(row.storage_key,workspace.workspace_id);
      if(await storedObjectReferenced(c,workspace.workspace_id,row.storage_key))throw new Error('A direct-upload staging key unexpectedly references an original');
      await c.query('insert into file_deletions(workspace_id,storage_key) values($1,$2) on conflict(storage_key) do nothing',[workspace.workspace_id,row.storage_key]);
      await c.query("update direct_uploads set state='cleaned',filename='',finalize_owner=null,finalize_lease_until=null where id=$1",[row.id]);queued++;
    }
  });}
  return queued;
}
export async function registerUploadRoutes(app:FastifyInstance){
  app.get('/api/uploads/config',async request=>{await requireActor(request,{roles:editors,scope:'documents:write'});return {strategy:privateStorage().kind==='supabase'?'signed':'multipart',maxBytes:config.maxBytes};});
  app.post('/api/parsers/:id/uploads',async(request,reply)=>{const actor=await requireActor(request,{roles:editors,scope:'documents:write'});const result=await reserveDirectUpload(actor,uploadId(request.params),reserveBody.parse(request.body));reply.code(201);return result;});
  app.post('/api/uploads/:id/finalize',async(request,reply)=>{const actor=await requireActor(request,{roles:editors,scope:'documents:write'});z.object({}).strict().parse(request.body??{});const result=await finalizeDirectUpload(actor,uploadId(request.params));reply.code(202);return result;});
  app.post('/api/uploads/:id/split-confirm',async request=>{const actor=await requireActor(request,{roles:editors,scope:'documents:write'});return confirmDirectSplit(actor,uploadId(request.params),request.body);});
  app.post('/api/uploads/:id/archive-preview',async request=>{const actor=await requireActor(request,{roles:editors,scope:'documents:write'});z.object({}).strict().parse(request.body??{});return previewDirectArchive(actor,uploadId(request.params));});
  app.post('/api/uploads/:id/archive-confirm',async request=>{const actor=await requireActor(request,{roles:editors,scope:'documents:write'});return confirmDirectArchive(actor,uploadId(request.params),request.body);});
}

/** Workspace/parser locks precede upload locks, matching batch acceptance. */
async function lockArchiveUpload(c:import('pg').PoolClient,actor:Actor,id:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
 const initial=(await c.query('select parser_id,created_by,archive_request_id from direct_uploads where id=$1 and workspace_id=$2',[id,actor.workspaceId])).rows[0];
 if(!initial||initial.created_by!==actor.userId||!initial.archive_request_id)notFound('ZIP upload reservation not found');
 const parser=(await c.query('select archived,field_setup_state from parsers where id=$1 and workspace_id=$2 for update',[initial.parser_id,actor.workspaceId])).rows[0];
 if(!parser||parser.archived)notFound('Active parser not found');
 if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before importing a ZIP.',409);
 const row=(await c.query('select *,expires_at>clock_timestamp() live,finalize_lease_until>clock_timestamp() claimed from direct_uploads where id=$1 and workspace_id=$2 for update',[id,actor.workspaceId])).rows[0];
 if(!row||row.created_by!==actor.userId||!row.archive_request_id)notFound('ZIP upload reservation not found');
 validateStorageKey(row.storage_key,actor.workspaceId);return row;
}
export async function confirmDirectArchive(actor:Actor,id:string,input:unknown){
 const body=z.object({options:archiveImportSpecSchema}).strict().parse(input),canonical=canonicalArchiveImportSpec(body.options);
 return withWorkspace(actor.workspaceId,async c=>{
  const row=await lockArchiveUpload(c,actor,id);
  if(body.options.sourceSha256!==row.expected_sha256)throw new ArchiveImportValidationError('source_mismatch');
  await assertArchiveRequestBinding(c,actor.workspaceId,row.parser_id,row.archive_request_id,row.expected_sha256,canonical);
  if(row.archive_spec){if(canonicalArchiveImportSpec(row.archive_spec)!==canonical)badRequest('This ZIP selection was already confirmed. Start a new import to change it.',409);return {ok:true};}
  if(!row.live||row.state==='failed'||row.state==='cleaned'||row.state==='complete')badRequest('This upload reservation expired or failed. Start a new upload.',410);
  if(row.state==='finalizing'&&row.claimed)badRequest('This ZIP is being verified. Retry shortly.',409);
  const saved=await c.query("update direct_uploads set archive_spec=$2,state='pending',finalize_owner=null,finalize_lease_until=null where id=$1 and archive_spec is null and expires_at>clock_timestamp()",[id,canonical]);
  if(!saved.rowCount)badRequest('This upload reservation changed or expired. Retry the same import.',409);
  return {ok:true};
 });
}
export async function previewDirectArchive(actor:Actor,id:string){
 const owner=randomUUID(),deadline=Date.now()+120_000;
 const row=await withWorkspace(actor.workspaceId,async c=>{
  const row=await lockArchiveUpload(c,actor,id);
  if(!row.live||['failed','cleaned','complete'].includes(row.state))badRequest('This upload reservation expired or completed. Recover its receipt or start a new upload.',410);
  if(row.state==='finalizing'&&row.claimed)badRequest('This ZIP is being verified. Retry shortly.',409);
  await c.query("update direct_uploads set state='finalizing',finalize_owner=$2,finalize_lease_until=now()+interval '3 minutes' where id=$1",[id,owner]);return row;
 });
 const check=async()=>{
  if(Date.now()>=deadline)badRequest('ZIP preview took too long. Retry the same upload.',503);
  const valid=await withWorkspace(actor.workspaceId,c=>c.query("select 1 from direct_uploads where id=$1 and workspace_id=$2 and created_by=$3 and state='finalizing' and finalize_owner=$4 and finalize_lease_until>clock_timestamp() and expires_at>clock_timestamp()",[id,actor.workspaceId,actor.userId,owner]));
  if(!valid.rowCount)badRequest('This ZIP preview changed or expired. Retry the same upload.',409);
 };
 try{
  const bytes=await privateStorage().read(row.storage_key,Math.min(config.maxBytes,row.expected_bytes));
  await check();
  if(bytes.length!==row.expected_bytes||createHash('sha256').update(bytes).digest('hex')!==row.expected_sha256)throw new UploadBytesMismatch();
  const result=await previewArchiveDocuments(actor,row.parser_id,bytes,row.filename,row.archive_request_id);await check();return result;
 }finally{await withWorkspace(actor.workspaceId,c=>c.query("update direct_uploads set state='pending',finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2 and state='finalizing'",[id,owner]));}
}

/** Bind a preview upload to one immutable plan before any charged intake begins. */
export async function confirmDirectSplit(actor:Actor,id:string,input:unknown){
 const {options}=z.object({options:pdfSplitSpecSchema}).strict().parse(input),canonical=canonicalPdfSplitSpec(options);
 return withWorkspace(actor.workspaceId,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
  const initial=(await c.query('select parser_id,created_by,pdf_split_request_id from direct_uploads where id=$1 and workspace_id=$2',[id,actor.workspaceId])).rows[0];
  if(!initial||initial.created_by!==actor.userId||!initial.pdf_split_request_id)notFound('Split upload reservation not found');
  const parser=(await c.query('select archived,field_setup_state from parsers where id=$1 and workspace_id=$2 for update',[initial.parser_id,actor.workspaceId])).rows[0];
  if(!parser||parser.archived)notFound('Active parser not found');
  if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before splitting a document.',409);
  const row=(await c.query('select *,expires_at>clock_timestamp() live,finalize_lease_until>clock_timestamp() claimed from direct_uploads where id=$1 and workspace_id=$2 for update',[id,actor.workspaceId])).rows[0];
  if(!row||row.created_by!==actor.userId||!row.pdf_split_request_id)notFound('Split upload reservation not found');
  await assertUploadedSplitBinding(c,actor.workspaceId,row.parser_id,row.pdf_split_request_id,row.expected_sha256,canonical);
  if(row.pdf_split_spec&&(row.state==='complete'||row.state==='cleaned'))return {ok:true};
  if(!row.live||row.state==='failed'||row.state==='cleaned')badRequest('This upload expired or failed. Upload it again with the same split request.',410);
  if(row.state==='finalizing'&&row.claimed)badRequest('This document is being verified. Retry shortly.',409);
  await c.query("update direct_uploads set pdf_split_spec=$2,state='pending',finalize_owner=null,finalize_lease_until=null where id=$1",[id,canonical]);
  return {ok:true};
 });
}
