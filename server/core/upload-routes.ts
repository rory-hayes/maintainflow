import type {FastifyInstance} from 'fastify';
import {randomUUID,createHash} from 'node:crypto';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {requireActor,editors} from './auth.js';
import {adminPool,withWorkspace,badRequest,notFound,camel} from './db.js';
import {config} from './config.js';
import {privateStorage,safeDownloadName,validateStorageKey} from './storage.js';
import {addDocument} from './intake.js';

const reserveBody=z.object({filename:z.string().min(1).max(300),size:z.number().int().min(1).max(10*1024*1024),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
const uploadId=(params:unknown)=>z.object({id:z.string().uuid()}).parse(params).id;
export async function reserveDirectUpload(actor:Actor,parserId:string,input:z.infer<typeof reserveBody>){
  const storage=privateStorage();if(!storage.signUpload)badRequest('Direct upload is unavailable on this installation',409);
  const body=reserveBody.parse(input),id=randomUUID(),key=`${actor.workspaceId}/${id}`;
  const reservation=await withWorkspace(actor.workspaceId,async c=>{
    await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
    if(!(await c.query('select id from parsers where id=$1 and workspace_id=$2 and archived=false',[parserId,actor.workspaceId])).rowCount)notFound('Active parser not found');
    const {rows:[workspace]}=await c.query('select plan from workspaces where id=$1',[actor.workspaceId]);
    if(body.size>Math.min(config.maxBytes,workspace.plan.maxBytes))badRequest('Document exceeds the workspace file limit',413);
    const {rows:[usage]}=await c.query("select coalesce(sum(pages),0)::int used from usage_ledger where workspace_id=$1 and created_at>=date_trunc('month',now())",[actor.workspaceId]);
    const {rows:[reserved]}=await c.query("select count(*)::int total,coalesce(sum(case when state='complete' then expected_bytes else 10485760 end),0)::bigint bytes,count(*) filter(where state in('pending','finalizing') and expires_at>now())::int active from direct_uploads where workspace_id=$1 and cleanup_after>now() and state<>'cleaned'",[actor.workspaceId]);
    if(usage.used+reserved.active+1>workspace.plan.monthlyPages)badRequest('Monthly page quota reached. Complete pending uploads or update the plan.',429);
    if(reserved.active>=20||reserved.total>=100||Number(reserved.bytes)+config.maxBytes>250*1024*1024)badRequest('Too many recent uploads. Finish pending uploads or retry after their cleanup window.',429);
    const {rows:[row]}=await c.query('insert into direct_uploads(id,workspace_id,parser_id,created_by,storage_key,filename,expected_bytes,expected_sha256) values($1,$2,$3,$4,$5,$6,$7,$8) returning expires_at,cleanup_after',[id,actor.workspaceId,parserId,actor.userId,key,safeDownloadName(body.filename),body.size,body.sha256]);
    return row;
  });
  try{return {uploadId:id,uploadUrl:await storage.signUpload!(key),method:'PUT',headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},expiresAt:reservation.expires_at};}
  catch(error){await withWorkspace(actor.workspaceId,c=>c.query("update direct_uploads set state='failed' where id=$1 and state='pending'",[id]));throw error;}
}
export async function finalizeDirectUpload(actor:Actor,id:string){
  const leaseOwner=randomUUID();
  const claimed=await withWorkspace(actor.workspaceId,async c=>{
    const {rows:[row]}=await c.query('select * from direct_uploads where id=$1 and workspace_id=$2 for update',[id,actor.workspaceId]);
    if(!row||row.created_by!==actor.userId)notFound('Upload reservation not found');
    validateStorageKey(row.storage_key,actor.workspaceId);
    if(row.state==='complete'||row.state==='cleaned'){
      const {rows:[document]}=await c.query('select * from documents where id=$1 and workspace_id=$2',[row.document_id,actor.workspaceId]);
      if(!document)badRequest('This upload is no longer available. Start a new upload.',410);
      return {prior:{document:camel(document),duplicate:row.duplicate,jobId:row.job_id,replayed:true}};
    }
    if(row.state==='failed'||new Date(row.expires_at).getTime()<=Date.now())badRequest('This upload reservation expired or failed. Start a new upload.',410);
    if(row.state==='finalizing'&&new Date(row.finalize_lease_until).getTime()>Date.now())badRequest('This upload is being verified. Retry shortly.',409);
    if(!(await c.query('select id from parsers where id=$1 and workspace_id=$2 and archived=false',[row.parser_id,actor.workspaceId])).rowCount)notFound('Active parser not found');
    await c.query("update direct_uploads set state='finalizing',finalize_owner=$2,finalize_lease_until=now()+interval '3 minutes' where id=$1",[id,leaseOwner]);
    return {row};
  });
  if(claimed.prior)return claimed.prior;
  const row=claimed.row!;
  try{
    const bytes=await privateStorage().read(row.storage_key,Math.min(config.maxBytes,row.expected_bytes));
    if(bytes.length!==row.expected_bytes||createHash('sha256').update(bytes).digest('hex')!==row.expected_sha256)badRequest('Uploaded bytes do not match this reservation. Start a new upload.',400);
    // Persist a distinct object from these verified bytes. The original signed
    // capability never points at the immutable document object consumed by workers.
    const result=await addDocument(actor,row.parser_id,bytes,row.filename,'application/octet-stream',`direct-upload:${id}`);
    await withWorkspace(actor.workspaceId,async c=>{
      const saved=await c.query("update direct_uploads set state='complete',document_id=$3,job_id=$4,duplicate=$5,finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2",[id,leaseOwner,result.document.id,result.jobId,result.duplicate]);
      if(!saved.rowCount)badRequest('Upload verification completed in another request. Retry shortly.',409);
    });
    return result;
  }catch(error){
    const status=(error as {statusCode?:number}).statusCode;
    await withWorkspace(actor.workspaceId,c=>c.query("update direct_uploads set state=$3,finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2",[id,leaseOwner,[400,413,422].includes(status??0)?'failed':'pending']));
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
      if((await c.query('select id from documents where storage_key=$1',[row.storage_key])).rowCount)throw new Error('A direct-upload staging key unexpectedly references a document');
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
}
