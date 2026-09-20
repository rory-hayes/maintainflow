import '@fastify/multipart';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireActor,editors} from './auth.js';
import {badRequest,notFound,withWorkspace} from './db.js';
import {ParserFormatNotAllowedError} from './intake-policy.js';
import {readStoredObject,validateStorageKey} from './storage.js';
import {renderTiffPage} from './source.js';
import {inspectTiffStructure,isTiffHeader} from './tiff-engine.js';
import {storedPdfAuthorization,withStoredPdfAuthorization,type StoredPdfAuthorization} from './stored-pdf-split.js';
import {tiffLimits,tiffRenderVersion} from '../../shared/tiff.js';

type PreviewOptions={renderPage?:typeof renderTiffPage;readSource?:typeof readStoredObject;timeoutMs?:number};
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const pageNumber=z.number().int().min(1).max(tiffLimits.maxPages);
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const unavailable=()=>Object.assign(new Error('TIFF preview took too long. Retry the same upload.'),{statusCode:503});

function operation(request:FastifyRequest,reply:FastifyReply,timeoutMs:number){
 const controller=new AbortController(),deadline=Date.now()+timeoutMs;
 const disconnect=()=>{if(!reply.raw.writableEnded)controller.abort();};
 const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref();
 request.raw.once('aborted',disconnect);reply.raw.once('close',disconnect);
 if(request.raw.aborted||reply.raw.destroyed)controller.abort();
 const check=()=>{if(controller.signal.aborted||Date.now()>=deadline)throw unavailable();};
 const bounded=<T>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
  const abort=()=>reject(unavailable());controller.signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
  if(controller.signal.aborted)abort();
 });
 return {controller,check,bounded,remaining:()=>{check();return deadline-Date.now();},close(){clearTimeout(timer);request.raw.off('aborted',disconnect);reply.raw.off('close',disconnect);}};
}

async function parser(c:PoolClient,workspaceId:string,parserId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[workspaceId]);
 const row=(await c.query('select archived,field_setup_state,allowed_formats from parsers where id=$1 and workspace_id=$2 for update',[parserId,workspaceId])).rows[0];
 if(!row||row.archived)notFound('Active parser not found');
 if(row.field_setup_state!=='ready')badRequest('Finish parser setup before splitting a document.',409);
 if(row.allowed_formats!==null&&!row.allowed_formats.includes('tiff'))throw new ParserFormatNotAllowedError(parserId,'tiff');
}

/** No document, admission, job or usage is created by either preview route. */
export function registerSplitPreview(app:FastifyInstance,options:PreviewOptions={}){
 const timeoutMs=options.timeoutMs??120_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new Error('Preview deadline must be positive and at most 120 seconds');
 const render=options.renderPage??renderTiffPage,read=options.readSource??readStoredObject;
 async function authorization(request:FastifyRequest){
  const actor=await requireActor(request,{roles:editors,scope:'documents:write'});
  await requireActor(request,{scope:'documents:read'});
  return storedPdfAuthorization(request,actor);
 }
 async function scope<T>(auth:StoredPdfAuthorization,op:ReturnType<typeof operation>,fn:(c:PoolClient)=>Promise<T>){
  op.check();return op.bounded(withStoredPdfAuthorization(auth,async c=>{
   op.check();await c.query("select set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",[String(Math.min(10_000,op.remaining())),String(Math.min(5_000,op.remaining()))]);
   // The credential is locked by withStoredPdfAuthorization throughout this check.
   if(auth.actor.authType==='api'&&!(await c.query("select 1 from api_keys where token_hash=$1 and workspace_id=$2 and user_id=$3 and scopes ? 'documents:read'",[auth.tokenHash,auth.actor.workspaceId,auth.actor.userId])).rowCount)badRequest('API key does not allow this action',403);
   const value=await fn(c);op.check();return value;
  }));
 }
 async function preview(bytes:Buffer,page:number,op:ReturnType<typeof operation>){
  op.check();if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>tiffLimits.maxBytes)badRequest('Choose one TIFF of at most 10 MB.',413);
  if(!isTiffHeader(bytes))badRequest('Page previews are available for TIFF files.',415);
  const directory=inspectTiffStructure(bytes),sha256=digest(bytes);
  if(page>directory.pages.length)badRequest('This page is outside the document.',400);
  const result=await op.bounded(render(bytes,page,{signal:op.controller.signal,timeoutMs:Math.min(30_000,op.remaining())}));op.check();
  if(result.mimeType!=='image/jpeg'||result.page!==page||result.pageCount!==directory.pages.length||result.sourceSha256!==sha256||result.renderVersion!==tiffRenderVersion
   ||!Buffer.isBuffer(result.bytes)||!result.bytes.length||result.bytes.length>tiffLimits.maxJpegBytes||!result.bytes.subarray(0,3).equals(Buffer.from([255,216,255]))
   ||!Number.isInteger(result.width)||result.width<1||result.width>tiffLimits.maxEdge||!Number.isInteger(result.height)||result.height<1||result.height>tiffLimits.maxEdge)throw Object.assign(new Error('The TIFF preview could not be verified.'),{statusCode:503});
  return result;
 }
 function send(reply:FastifyReply,result:Awaited<ReturnType<typeof renderTiffPage>>){
  return reply.header('Content-Type','image/jpeg').header('Content-Length',result.bytes.length).header('Cache-Control','private, no-store')
   .header('Content-Disposition','inline').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
   .header('Content-Security-Policy',"sandbox; default-src 'none'").header('X-Folio-Source-Sha256',result.sourceSha256)
   .header('X-Folio-Preview-Page',String(result.page)).header('X-Folio-Page-Count',String(result.pageCount)).send(result.bytes);
 }
 app.post('/api/parsers/:id/pdf-splits/preview',async(request,reply)=>{
  const op=operation(request,reply,timeoutMs);
  try{
   const auth=await op.bounded(authorization(request)),{id}=z.object({id:uuid}).parse(request.params);
   const check=()=>scope(auth,op,c=>parser(c,auth.actor.workspaceId,id));await check();
   let bytes:Buffer|undefined,page:number|undefined;const seen=new Set<string>();
   await op.bounded((async()=>{for await(const part of request.parts({limits:{fileSize:tiffLimits.maxBytes,files:1,fields:1,parts:2,fieldSize:16}})){
    op.check();if(seen.has(part.fieldname))badRequest('Each preview field may only be supplied once.');seen.add(part.fieldname);
    if(part.type==='file'){
     if(part.fieldname!=='file')badRequest('Choose exactly one TIFF file.');
     bytes=await op.bounded(part.toBuffer());if(part.file.truncated)badRequest('File exceeds 10 MB limit',413);
    }else{
     if(part.fieldname!=='page'||part.valueTruncated||typeof part.value!=='string'||!/^\d{1,2}$/.test(part.value))badRequest('Choose a valid TIFF page.');
     page=pageNumber.parse(Number(part.value));
    }
   }})());op.check();
   if(!bytes||page===undefined)badRequest('Choose one TIFF and a page to preview.');
   await check();const result=await preview(bytes,page,op);await check();op.check();return send(reply,result);
  }finally{op.close();}
 });
 app.post('/api/uploads/:id/split-preview',async(request,reply)=>{
  const op=operation(request,reply,timeoutMs),owner=randomUUID();let auth:StoredPdfAuthorization|undefined,id:string|undefined;
  let result:Awaited<ReturnType<typeof renderTiffPage>>|undefined;
  try{
   auth=await op.bounded(authorization(request));id=z.object({id:uuid}).parse(request.params).id;
   const {page}=z.object({page:pageNumber}).strict().parse(request.body),a=auth.actor;
   const lock=async(c:PoolClient)=>{
    const initial=(await c.query('select parser_id,created_by,pdf_split_request_id from direct_uploads where id=$1 and workspace_id=$2',[id,a.workspaceId])).rows[0];
    if(!initial||initial.created_by!==a.userId||!initial.pdf_split_request_id)notFound('Split upload reservation not found');
    await parser(c,a.workspaceId,initial.parser_id);
    const row=(await c.query('select *,expires_at>clock_timestamp() live,finalize_lease_until>clock_timestamp() claimed from direct_uploads where id=$1 and workspace_id=$2 for update',[id,a.workspaceId])).rows[0];
    if(!row||row.created_by!==a.userId||!row.pdf_split_request_id||row.parser_id!==initial.parser_id||row.archive_request_id)notFound('Split upload reservation not found');
    validateStorageKey(row.storage_key,a.workspaceId);return row;
   };
   const row=await scope(auth,op,async c=>{
    const row=await lock(c);
    if(!row.live||!['pending','finalizing'].includes(row.state))badRequest('This upload reservation expired or completed. Recover its receipt or start a new upload.',410);
    if(row.state==='finalizing'&&row.claimed)badRequest('This upload is being verified. Retry shortly.',409);
    await c.query("update direct_uploads set state='finalizing',finalize_owner=$2,finalize_lease_until=clock_timestamp()+interval '3 minutes' where id=$1",[id,owner]);return row;
   });
   const check=()=>scope(auth!,op,async c=>{
    const current=await lock(c);
    if(!current.live||!current.claimed||current.state!=='finalizing'||current.finalize_owner!==owner||current.expected_sha256!==row.expected_sha256||current.expected_bytes!==row.expected_bytes||current.storage_key!==row.storage_key||current.pdf_split_request_id!==row.pdf_split_request_id||JSON.stringify(current.pdf_split_spec)!==JSON.stringify(row.pdf_split_spec))badRequest('This preview changed or expired. Retry the same upload.',409);
   });
   const bytes=await op.bounded(read(row.storage_key,Math.min(tiffLimits.maxBytes,row.expected_bytes)));op.check();await check();
   if(!Buffer.isBuffer(bytes)||bytes.length!==row.expected_bytes||digest(bytes)!==row.expected_sha256)badRequest('Uploaded bytes do not match this reservation. Start a new upload.',409);
   result=await preview(bytes,page,op);await check();op.check();
  }finally{
   op.close();
   // Release only our own temporary lease, even if access was revoked meanwhile.
   if(auth&&id)await withWorkspace(auth.actor.workspaceId,async c=>{
    await c.query("select set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)");
    await c.query("update direct_uploads set state='pending',finalize_owner=null,finalize_lease_until=null where id=$1 and workspace_id=$2 and created_by=$3 and finalize_owner=$4 and state='finalizing'",[id,auth!.actor.workspaceId,auth!.actor.userId,owner]);
   });
  }
  op.check();return send(reply,result!);
 });
}
