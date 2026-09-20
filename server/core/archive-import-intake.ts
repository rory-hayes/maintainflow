import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {pinnedTemplateConfig} from './template-snapshot.js';
import {canonicalArchiveImportSpec,ArchiveImportValidationError,isArchiveImportValidationReason,archiveImportLimits,type ArchiveImportSpec,type ArchiveImportReceipt,type ArchivePreview} from '../../shared/archive-import.js';
import {sourceFormats} from '../../shared/source-formats.js';
import {withWorkspace,badRequest,notFound,audit} from './db.js';
import {importArchiveSource,previewArchiveSource} from './source.js';
import {SourceValidationError,isSourceValidationReason} from './source-validation.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';
import {privateStorage,safeDownloadName} from './storage.js';
import {findArchiveImportByRequest,readArchiveImportReceipt,assertArchiveRequestBinding} from './archive-import-records.js';
import {storedObjectReferenced} from './pdf-split-records.js';

type ImportSource=typeof importArchiveSource;
export type ArchiveDirectUpload={id:string;owner:string};
type Options={importSource?:ImportSource;timeoutMs?:number;directUpload?:ArchiveDirectUpload};
type WrittenObject={id:string;key:string;bytes:Buffer;attempted:boolean;completed:boolean};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const unavailable=()=>Object.assign(new Error('ZIP importing took too long. Retry the same upload.'),{statusCode:503});

async function lockParser(c:PoolClient,actor:Actor,parserId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
 const parser=(await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[parserId,actor.workspaceId])).rows[0];
 if(!parser)notFound('Parser not found');
 return parser;
}
function requireReady(parser:any){
 if(parser.archived)notFound('Active parser not found');
 if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before importing a ZIP.',409);
}
function requireFormats(parser:any,parts:Awaited<ReturnType<ImportSource>>['parts']){
 for(const part of parts)if(parser.allowed_formats!==null&&parser.allowed_formats!==undefined&&!parser.allowed_formats.includes(part.format))throw new ParserFormatNotAllowedError(parser.id,part.format);
}
function rejection(error:unknown):{code:string;reason:string}|undefined{
 if(error instanceof SourceValidationError&&isSourceValidationReason(error.reason))return {code:error.code,reason:error.reason};
 if(error instanceof ArchiveImportValidationError&&isArchiveImportValidationReason(error.reason))return {code:error.code,reason:error.reason};
 if(error instanceof ParserFormatNotAllowedError)return {code:error.code,reason:error.format};
}

/** Every request is a distinct charged operation; only its stable UUID is replayable. */
export async function addArchiveDocuments(actor:Actor,parserId:string,bytes:Buffer,filename:string,requestId:string,spec:ArchiveImportSpec,options:Options={}):Promise<ArchiveImportReceipt>{
 requestId=z.string().uuid().parse(requestId).toLowerCase();parserId=z.string().uuid().parse(parserId).toLowerCase();
 const canonical=canonicalArchiveImportSpec(spec),specHash=sha(canonical),sourceSha=sha(bytes),name=safeDownloadName(filename);
 if((JSON.parse(canonical) as ArchiveImportSpec).sourceSha256!==sourceSha)throw new ArchiveImportValidationError('source_mismatch');
 const timeoutMs=options.timeoutMs??120_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new Error('Archive deadline must be positive and at most 120 seconds');
 const controller=new AbortController(),deadline=Date.now()+timeoutMs;
 const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref();
 const check=()=>{if(controller.signal.aborted||Date.now()>=deadline)throw unavailable();};
 const bounded=<T>(work:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  const abort=()=>reject(unavailable());
  controller.signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
  if(controller.signal.aborted)abort();
 });
 const attemptId=randomUUID(),archiveId=randomUUID();
 let files:WrittenObject[]=[],heartbeat:ReturnType<typeof setInterval>|undefined;
 async function prior(c:PoolClient){
  await assertArchiveRequestBinding(c,actor.workspaceId,parserId,requestId,sourceSha,canonical);
  const row=await findArchiveImportByRequest(c,actor.workspaceId,requestId);
  if(row&&(row.parser_id!==parserId||row.source_sha256!==sourceSha||row.spec_hash!==specHash))badRequest('This archive import request was already used for a different ZIP, parser or file selection.',409);
  return row;
 }
 async function direct(c:PoolClient){
  if(!options.directUpload)return;
  const row=(await c.query('select *,finalize_lease_until>clock_timestamp() and expires_at>clock_timestamp() as lease_live from direct_uploads where id=$1 and workspace_id=$2 for update',[options.directUpload.id,actor.workspaceId])).rows[0];
  if(!row||row.created_by!==actor.userId)notFound('Upload reservation not found');
  if(row.state!=='finalizing'||row.finalize_owner!==options.directUpload.owner||!row.lease_live)badRequest('Upload verification changed or expired. Retry the same archive import request.',409);
  if(row.parser_id!==parserId||row.expected_sha256!==sourceSha||row.expected_bytes!==bytes.length||row.archive_request_id!==requestId||canonicalArchiveImportSpec(row.archive_spec)!==canonical)badRequest('The ZIP does not match this archive upload reservation.',409);
 }
 async function completeDirect(c:PoolClient,id:string){
  if(!options.directUpload)return;
  const saved=await c.query("update direct_uploads set state='complete',archive_import_id=$3,document_id=null,job_id=null,finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2 and state='finalizing' and finalize_lease_until>clock_timestamp() and expires_at>clock_timestamp()",[options.directUpload.id,options.directUpload.owner,id]);
  if(!saved.rowCount)badRequest('Upload verification changed or expired. Retry the same archive import request.',409);
 }
 async function replay(c:PoolClient,row:any){
  await direct(c);check();
  // Rejected reads throw the same safe error; no accepted upload is attached.
  const receipt=await readArchiveImportReceipt(c,actor.workspaceId,row.id,true);
  await completeDirect(c,row.id);check();return receipt;
 }
 async function saveRejection(error:unknown):Promise<ArchiveImportReceipt>{
  const reason=rejection(error);if(!reason)throw error;
  const result=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),existing=await prior(c);
   if(existing)return {receipt:await replay(c,existing)};
   requireReady(parser);await direct(c);check();
   await c.query("insert into archive_imports(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,rejection_code,rejection_reason,source_byte_size,created_by) values($1,$2,$3,$4,$5,$6,$7,'rejected',$8,$9,$10,$11)",[archiveId,actor.workspaceId,parserId,requestId,sourceSha,canonical,specHash,reason.code,reason.reason,bytes.length,actor.userId]);
   await audit(c,actor.workspaceId,actor.userId,'document.archive_rejected',archiveId,{parserId,code:reason.code,reason:reason.reason});check();
   return {error:error instanceof SourceValidationError?new SourceIntakeRejectedError(parserId,error.reason):error};
  });
  if('receipt' in result)return result.receipt!;
  throw result.error;
 }
 async function quota(c:PoolClient,totalPages:number,parts:Awaited<ReturnType<ImportSource>>['parts']){
  const workspace=(await c.query('select plan from workspaces where id=$1',[actor.workspaceId])).rows[0],plan=workspace.plan;
  if(bytes.length>Math.min(archiveImportLimits.maxBytes,plan.maxBytes)||parts.some(p=>p.bytes.length>plan.maxBytes||p.source.pageCount>plan.maxPages))badRequest('Document exceeds the workspace file or page limit',413);
  const usage=(await c.query("select coalesce(sum(pages),0)::integer used from usage_ledger where workspace_id=$1 and created_at>=date_trunc('month',now())",[actor.workspaceId])).rows[0];
  if(usage.used+totalPages>plan.monthlyPages)badRequest('Monthly page quota reached. Update the plan before uploading more documents.',429);
 }
 try{
  const existing=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),row=await prior(c);check();
   if(row)return replay(c,row);
   requireReady(parser);return undefined;
  });
  if(existing)return existing;
  let decoded:Awaited<ReturnType<ImportSource>>;
  try{check();decoded=await bounded((options.importSource??importArchiveSource)(bytes,name,JSON.parse(canonical)));check();}
  catch(error){return await saveRejection(error);}
  validateDecodedArchive(decoded,bytes,JSON.parse(canonical));
  const sourceId=archiveId;
  files=[{id:sourceId,key:`${actor.workspaceId}/${sourceId}`,bytes,attempted:false,completed:false},...decoded.parts.map(part=>{const id=randomUUID();return {id,key:`${actor.workspaceId}/${id}`,bytes:part.bytes,attempted:false,completed:false};})];
  const reserved=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),row=await prior(c);if(row)return replay(c,row);
   requireReady(parser);requireFormats(parser,decoded.parts);await direct(c);await quota(c,decoded.totalPages,decoded.parts);check();
   const active=(await c.query('select count(distinct coalesce(split_attempt_id,archive_attempt_id)) filter(where lease_expires_at>now())::int attempts,coalesce(sum(reserved_bytes),0)::bigint bytes from intake_files where workspace_id=$1 and (split_attempt_id is not null or archive_attempt_id is not null)',[actor.workspaceId])).rows[0];
   const staging=(await c.query("select coalesce(sum(case when state='complete' then expected_bytes else 10485760 end),0)::bigint bytes from direct_uploads u where workspace_id=$1 and (state<>'cleaned' or exists(select 1 from file_deletions f where f.workspace_id=u.workspace_id and f.storage_key=u.storage_key))",[actor.workspaceId])).rows[0];
   const suggestions=(await c.query('select coalesce(sum(source_reserved_bytes+staging_reserved_bytes),0)::bigint bytes from split_suggestions where workspace_id=$1',[actor.workspaceId])).rows[0];
   if(active.attempts>=2||Number(active.bytes)+Number(staging.bytes)+Number(suggestions.bytes)+files.reduce((sum,file)=>sum+file.bytes.length,0)>250*1024*1024)badRequest('Too many pending document imports. Finish them or retry after their cleanup window.',429);
   for(const file of files)await c.query('insert into intake_files(id,workspace_id,storage_key,archive_attempt_id,reserved_bytes) values($1,$2,$3,$4,$5)',[file.id,actor.workspaceId,file.key,attemptId,file.bytes.length]);
   check();return undefined;
  }).catch(error=>{if(rejection(error))return saveRejection(error);throw error;});
  if(reserved)return reserved;
  heartbeat=setInterval(()=>{void withWorkspace(actor.workspaceId,c=>c.query("update intake_files set lease_expires_at=now()+interval '5 minutes' where archive_attempt_id=$1 and workspace_id=$2",[attemptId,actor.workspaceId])).catch(()=>{});},30_000);heartbeat.unref();
  let cursor=0,writeFailed=false;
  const writes=await Promise.allSettled(Array.from({length:2},async()=>{
   while(!writeFailed&&cursor<files.length){
    const file=files[cursor++]!;
    try{check();file.attempted=true;await bounded(privateStorage().write(file.key,file.bytes).then(()=>{file.completed=true;}));check();}
    catch(error){writeFailed=true;throw error;}
   }
  }));
  const failed=writes.find((result):result is PromiseRejectedResult=>result.status==='rejected');if(failed)throw failed.reason;check();
  try{return await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),row=await prior(c);if(row)return replay(c,row);
   requireReady(parser);requireFormats(parser,decoded.parts);await direct(c);
   const intents=(await c.query('select *,lease_expires_at>clock_timestamp() lease_live from intake_files where workspace_id=$1 and archive_attempt_id=$2 order by id for update',[actor.workspaceId,attemptId])).rows;
   if(intents.length!==files.length||intents.some(intent=>!intent.lease_live)||!files.every(file=>intents.some(intent=>intent.id===file.id&&intent.storage_key===file.key))||(await c.query('select 1 from file_deletions where workspace_id=$1 and storage_key=any($2::text[]) limit 1',[actor.workspaceId,files.map(f=>f.key)])).rowCount)badRequest('The ZIP write reservation expired. Retry the same archive import request.',409);
   await quota(c,decoded.totalPages,decoded.parts);
   if(!(await c.query('select id from schema_versions where id=$1 and parser_id=$2 and workspace_id=$3',[parser.active_schema_id,parserId,actor.workspaceId])).rowCount)badRequest('Save valid parser fields before importing a ZIP.',409);
   const templates=(await c.query('select * from templates where parser_id=$1 order by created_at,id',[parserId])).rows;
   const jobConfig=JSON.stringify(pinnedTemplateConfig(parser,templates));check();
   await c.query("insert into archive_imports(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,source_byte_size,total_pages,child_count,source_storage_key,source_name,created_by) values($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12,$13)",[archiveId,actor.workspaceId,parserId,requestId,sourceSha,canonical,specHash,bytes.length,decoded.totalPages,decoded.parts.length,files[0]!.key,name,actor.userId]);
   for(const [i,part] of decoded.parts.entries()){
    check();const file=files[i+1]!,jobId=randomUUID(),index=part.index,childSha=sha(part.bytes),childName=safeDownloadName(part.path);
    await c.query('insert into archive_import_entries(archive_id,workspace_id,parser_id,entry_index,document_id,job_id,page_count,sha256,byte_size,format,entry_path,document_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[archiveId,actor.workspaceId,parserId,index,file.id,jobId,part.source.pageCount,childSha,part.bytes.length,part.format,part.path,childName]);
    await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,source_text,archive_import_id,archive_entry_index) values($1,$2,$3,$4,$5,$6,$7,$8,'received',$9,$10,$11,$12)",[file.id,actor.workspaceId,parserId,childName,part.source.mimeType,part.bytes.length,childSha,file.key,part.source.pageCount,JSON.stringify(part.source.pages),archiveId,index]);
    await c.query('insert into jobs(id,workspace_id,document_id,schema_version_id,config,waiting_for_schema) values($1,$2,$3,$4,$5,false)',[jobId,actor.workspaceId,file.id,parser.active_schema_id,jobConfig]);
    await c.query("update documents set status='queued',updated_at=clock_timestamp() where id=$1",[file.id]);
    await c.query("insert into usage_ledger(workspace_id,document_id,event,pages,idempotency_key) values($1,$2,'upload',$3,$4)",[actor.workspaceId,file.id,part.source.pageCount,`upload:${file.id}`]);
    await audit(c,actor.workspaceId,actor.userId,'document.uploaded',file.id,{parserId,pages:part.source.pageCount,archiveId,index});
   }
   await audit(c,actor.workspaceId,actor.userId,'document.archive_imported',archiveId,{parserId,pages:decoded.totalPages,children:decoded.parts.length});
   await completeDirect(c,archiveId);
   await c.query('delete from intake_files where workspace_id=$1 and archive_attempt_id=$2',[actor.workspaceId,attemptId]);
   const result=await readArchiveImportReceipt(c,actor.workspaceId,archiveId,false);check();return result;
  });}catch(error){return await saveRejection(error);}
 }finally{
  clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);
  if(files.length){
   // Query committed references even after an uncertain COMMIT acknowledgement.
   // If this query cannot run, leave durable intents for reconciliation.
   try{
    await withWorkspace(actor.workspaceId,async c=>{
     await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
     await c.query('select id from intake_files where archive_attempt_id=$1 and workspace_id=$2 order by id for update',[attemptId,actor.workspaceId]);
     for(const file of files){
      const referenced=await storedObjectReferenced(c,actor.workspaceId,file.key);
      if(!referenced&&file.attempted){
       const delay=file.completed?0:300;
       await c.query("insert into file_deletions(workspace_id,storage_key,available_at) values($1,$2,now()+($3::int*interval '1 second')) on conflict(storage_key) do nothing",[actor.workspaceId,file.key,delay]);
       // Failed/uncertain objects still consume temporary storage. Release the
       // active-attempt slot, but only confirmed removal releases their bytes.
       await c.query('update intake_files set lease_expires_at=least(lease_expires_at,now()) where id=$1 and workspace_id=$2 and archive_attempt_id=$3',[file.id,actor.workspaceId,attemptId]);
      }else await c.query('delete from intake_files where id=$1 and workspace_id=$2 and archive_attempt_id=$3',[file.id,actor.workspaceId,attemptId]);
     }
    });
   }catch{/* The original outcome wins; durable intents preserve cleanup on recovery. */}
  }
 }
}

/** Preview has no receipt, accepted-original storage writes, jobs or page charges. */
export async function previewArchiveDocuments(actor:Actor,parserId:string,bytes:Buffer,filename:string,requestId:string):Promise<ArchivePreview>{
 parserId=z.string().uuid().parse(parserId).toLowerCase();requestId=z.string().uuid().parse(requestId).toLowerCase();
 const sourceSha=sha(bytes);
 await withWorkspace(actor.workspaceId,async c=>{const parser=await lockParser(c,actor,parserId);requireReady(parser);await assertArchiveRequestBinding(c,actor.workspaceId,parserId,requestId,sourceSha);});
 const decoded=await previewArchiveSource(bytes,safeDownloadName(filename));
 const parser=await withWorkspace(actor.workspaceId,async c=>{const parser=await lockParser(c,actor,parserId);requireReady(parser);await assertArchiveRequestBinding(c,actor.workspaceId,parserId,requestId,sourceSha);return parser;});
 const entries=decoded.entries.map(entry=>entry.status==='ready'&&parser.allowed_formats!==null&&parser.allowed_formats!==undefined&&!parser.allowed_formats.includes(entry.format)
  ?{...entry,status:'unsupported' as const,reason:'This parser does not accept this file format. Change its accepted formats or use another parser.'}:entry);
 return {requestId,parserId,sourceSha256:decoded.sourceSha256,sourceByteSize:decoded.sourceByteSize,entries,totalPages:entries.reduce((sum,entry)=>sum+(entry.status==='ready'?entry.pageCount??0:0),0)};
}

function validateDecodedArchive(decoded:Awaited<ReturnType<ImportSource>>,bytes:Buffer,spec:ArchiveImportSpec){
 const invalid=()=>{throw Object.assign(new Error('The ZIP importer returned an invalid result. Retry shortly.'),{statusCode:503});};
 if(decoded.sourceSha256!==sha(bytes)||decoded.sourceSha256!==spec.sourceSha256||decoded.sourceByteSize!==bytes.length||!Array.isArray(decoded.parts)||decoded.parts.length!==spec.entries.length)return invalid();
 let pages=0,expanded=0,text=0;
 for(const [i,part] of decoded.parts.entries()){
  const entry=decoded.entries.find(entry=>entry.index===part.index),format=sourceFormats.find(format=>format.id===part.format);
  if(part.index!==spec.entries[i]||!entry||entry.status!=='ready'||entry.path!==part.path||!format||format.mimeType!==part.source.mimeType||entry.format!==part.format||!Buffer.isBuffer(part.bytes)||!part.bytes.length||part.bytes.length>archiveImportLimits.maxBytes||entry.byteSize!==part.bytes.length||sha(part.bytes)!==part.sha256||entry.sha256!==part.sha256||!part.path||Buffer.byteLength(part.path)>archiveImportLimits.maxPathBytes)return invalid();
  if(!Number.isInteger(part.source.pageCount)||part.source.pageCount<1||part.source.pageCount>archiveImportLimits.maxPagesPerDocument||entry.pageCount!==part.source.pageCount||part.source.pages.length!==part.source.pageCount)return invalid();
  for(const [n,page] of part.source.pages.entries()){if(page.page!==n+1||typeof page.text!=='string')return invalid();text+=Buffer.byteLength(page.text);}
  pages+=part.source.pageCount;expanded+=part.bytes.length;
 }
 if(decoded.totalPages!==pages||expanded>archiveImportLimits.maxExpandedBytes||text>archiveImportLimits.maxTextBytes)return invalid();
}
