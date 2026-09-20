import '@fastify/multipart';
import {createHash,randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyReply,FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {splitSuggestionLimits,splitSuggestionRanges,type SplitSuggestion,type SplitSuggestionMime,type SplitSuggestionProvider,type SplitSuggestionResult} from '../../shared/split-suggestions.js';
import {tiffLimits,tiffRenderVersion} from '../../shared/tiff.js';
import {requireActor,editors} from './auth.js';
import {adminPool,transaction,badRequest,notFound,audit} from './db.js';
import {storedPdfAuthorization,withStoredPdfAuthorization,type StoredPdfAuthorization} from './stored-pdf-split.js';
import {privateStorage,readStoredObject,safeDownloadName,validateStorageKey,SIGNED_UPLOAD_RETENTION_SECONDS} from './storage.js';
import {runDecoder,renderTiffPage} from './source.js';
import {isTiffHeader,inspectTiffStructure} from './tiff-engine.js';
import {SourceValidationError} from './source-validation.js';
import {ParserFormatNotAllowedError} from './intake-policy.js';
import {prepareVisualDocument,visualRenderingMetadata} from './visual-source.js';
import {requireSuggestionCapacity,runnableAiWorkSql} from './parser-setup.js';
import {hasWorkspaceExtractionCapacity} from './schema-suggestions.js';
import {SplitSuggestionProviderError} from './split-suggestion-errors.js';
import {assertStorageRestoreReady} from './restore-state.js';
import {config} from './config.js';

let provider:SplitSuggestionProvider|undefined;
export function setSplitSuggestionProvider(value:SplitSuggestionProvider|undefined){provider=value;}
export function splitSuggestionsConfigured(){return provider?.configured()===true;}
const uuid=z.string().uuid().transform(value=>value.toLowerCase()),digest=z.string().regex(/^[0-9a-f]{64}$/);
const mime=z.enum(['application/pdf','image/tiff']);
const storedInput=z.object({requestId:uuid,documentId:uuid,sourceSha256:digest}).strict();
const signedInput=z.object({requestId:uuid,filename:z.string().min(1).max(240),size:z.number().int().min(1).max(splitSuggestionLimits.maxBytes),sourceSha256:digest,mimeType:mime}).strict();
const parameters=z.object({id:uuid,suggestionId:uuid.optional(),requestId:uuid.optional()});
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const maxPendingBytes=250*1024*1024;
const closedExpression="(accepted_split_id is null and (state in('cancelled','failed') or expires_at<=clock_timestamp()))";
const conflict=()=>badRequest('This request was already used for a different split suggestion.',409);
const inaccessible=()=>badRequest('The suggestion source is no longer available. Start a new suggestion.',410);
const timedOut=()=>Object.assign(new Error('Split suggestions took too long. A retry is scheduled.'),{statusCode:503});
type Row=Record<string,any>;
type Services={readSource?:typeof readStoredObject;renderPage?:typeof renderTiffPage;timeoutMs?:number};

export function publicSplitSuggestion(row:Row):SplitSuggestion{
 return {id:row.id,requestId:row.request_id,parserId:row.parser_id,sourceDocumentId:row.source_document_id,sourceName:row.source_name,
  sourceSha256:row.source_sha256,sourceMimeType:row.source_mime_type,pageCount:row.page_count,state:row.state,
  attempts:row.attempts,maxAttempts:row.max_attempts,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),
  startPages:row.start_pages,ranges:row.start_pages&&row.page_count?splitSuggestionRanges(row.start_pages,row.page_count):null,
  error:row.error,model:row.model,promptVersion:row.prompt_version,tokenUsage:row.token_usage,costUsd:Number(row.cost_usd),acceptedSplitId:row.accepted_split_id,confirmedRequestId:row.confirmed_request_id,confirmedOptions:row.confirmed_options,creationClosed:row.creation_closed===true};
}
function authorizationForJob(row:Row):StoredPdfAuthorization{
 return {actor:{userId:row.requested_by,workspaceId:row.workspace_id,role:'editor',authType:row.auth_type},tokenHash:row.token_hash};
}
/** Fresh credential and both required scopes are checked within every short fence. */
export async function withSplitSuggestionAuthorization<T>(auth:StoredPdfAuthorization,fn:(c:PoolClient)=>Promise<T>):Promise<T>{
 return withStoredPdfAuthorization(auth,async c=>{
  await c.query("select set_config('statement_timeout','10000',true),set_config('lock_timeout','5000',true)");
  if(auth.actor.authType==='api'&&!(await c.query("select 1 from api_keys where token_hash=$1 and user_id=$2 and workspace_id=$3 and scopes ? 'documents:read'",[auth.tokenHash,auth.actor.userId,auth.actor.workspaceId])).rowCount)badRequest('API key does not allow this action',403);
  return fn(c);
 });
}
async function actorFor(request:FastifyRequest){
 const actor=await requireActor(request,{roles:editors,scope:'documents:write'});await requireActor(request,{scope:'documents:read'});
 return storedPdfAuthorization(request,actor);
}
async function parserFor(c:PoolClient,actor:Actor,parserId:string,sourceMime?:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
 const row=(await c.query('select p.*,w.plan from parsers p join workspaces w on w.id=p.workspace_id where p.id=$1 and p.workspace_id=$2 for update of p',[parserId,actor.workspaceId])).rows[0];
 if(!row||row.archived)notFound('Active parser not found');
 if(row.field_setup_state!=='ready')badRequest('Finish parser setup before suggesting split boundaries.',409);
 if(sourceMime){const format=sourceMime==='image/tiff'?'tiff':'pdf';if(row.allowed_formats!==null&&!row.allowed_formats.includes(format))throw new ParserFormatNotAllowedError(parserId,format);}
 else if(row.allowed_formats!==null&&!row.allowed_formats.some((value:string)=>value==='pdf'||value==='tiff'))badRequest('This parser must accept PDF or TIFF files to suggest split boundaries.',415);
 return row;
}
async function rowFor(c:PoolClient,auth:StoredPdfAuthorization,parserId:string,id:string,byRequest=false){
 const row=(await c.query(`select *,${closedExpression} creation_closed from split_suggestions where ${byRequest?'request_id':'id'}=$1 and parser_id=$2 and workspace_id=$3 and requested_by=$4 for update`,[id,parserId,auth.actor.workspaceId,auth.actor.userId])).rows[0];
 if(!row)notFound('Split suggestion not found');return row as Row;
}
async function validateOriginal(c:PoolClient,row:Row){
 if(!row.source_document_id)return;
 const doc=(await c.query('select * from documents where id=$1 and workspace_id=$2 and parser_id=$3 for share',[row.source_document_id,row.workspace_id,row.parser_id])).rows[0];
 if(!doc)notFound('Original document not found');
 if(doc.sha256!==row.source_sha256||doc.mime_type!==row.source_mime_type||doc.storage_key!==row.original_source_key||doc.page_count!==row.original_page_count||Number(doc.byte_size)!==row.expected_bytes)badRequest('The original document changed. Start a new suggestion.',409);
}
function assertLive(row:Row){if(row.state==='cancelled'||new Date(row.expires_at).getTime()<=Date.now()||!row.source_storage_key||row.source_released_at)inaccessible();}
function actualMime(bytes:Buffer):SplitSuggestionMime{
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>splitSuggestionLimits.maxBytes)badRequest('Choose one PDF or TIFF of at most 10 MB.',413);
 if(bytes.subarray(0,5).equals(Buffer.from('%PDF-')))return 'application/pdf';
 if(isTiffHeader(bytes))return 'image/tiff';
 badRequest('Split suggestions require a PDF or TIFF file.',415);
}
function verifyBytes(bytes:Buffer,row:Row){
 if(!Buffer.isBuffer(bytes)||bytes.length!==row.expected_bytes||sha(bytes)!==row.source_sha256||actualMime(bytes)!==row.source_mime_type)badRequest('The suggestion source could not be verified. Retry with the same original file.',409);
}
/** Race every untrusted/slow continuation, including noncooperative storage and providers. */
function deadline(ms:number,external?:AbortSignal){
 if(!Number.isFinite(ms)||ms<=0||ms>90_000)throw new Error('Suggestion deadline must be positive and at most 90 seconds');
 const controller=new AbortController(),end=Date.now()+ms;
 const abort=()=>controller.abort();external?.addEventListener('abort',abort,{once:true});
 if(external?.aborted)abort();const timer=setTimeout(abort,ms);timer.unref();
 const check=()=>{if(controller.signal.aborted||Date.now()>=end)throw timedOut();};
 const bounded=<T>(work:()=>Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  const cancel=()=>reject(timedOut());controller.signal.addEventListener('abort',cancel,{once:true});
  Promise.resolve().then(()=>{check();return work();}).then(value=>{check();resolve(value);},reject).catch(reject).finally(()=>controller.signal.removeEventListener('abort',cancel));
  if(controller.signal.aborted)cancel();
 });
 return {check,bounded,signal:controller.signal,abort,remaining(){check();return end-Date.now();},close(){clearTimeout(timer);external?.removeEventListener('abort',abort);}};
}
function requestDeadline(request:FastifyRequest,reply:FastifyReply,ms:number){
 const op=deadline(ms),disconnect=()=>{if(!reply.raw.writableEnded)op.abort();};
 request.raw.once('aborted',disconnect);reply.raw.once('close',disconnect);
 if(request.raw.aborted||reply.raw.destroyed)op.abort();
 return {...op,close(){request.raw.off('aborted',disconnect);reply.raw.off('close',disconnect);op.close();}};
}
async function pendingCapacity(c:PoolClient,workspaceId:string,additional:number){
 const row=(await c.query(`select
  (select coalesce(sum(source_reserved_bytes+staging_reserved_bytes),0) from split_suggestions where workspace_id=$1)+
  (select coalesce(sum(reserved_bytes),0) from intake_files where workspace_id=$1)+
  (select coalesce(sum(case when state='complete' then expected_bytes else 10485760 end),0) from direct_uploads u where workspace_id=$1 and (state<>'cleaned' or exists(select 1 from file_deletions f where f.workspace_id=u.workspace_id and f.storage_key=u.storage_key))) total`,[workspaceId])).rows[0];
 if(Number(row.total)+additional>maxPendingBytes)badRequest('Too many recent uploads. Finish pending uploads or retry after their cleanup window.',429);
}
type Admission={requestId:string;sourceSha256:string;filename:string;size:number;mimeType:SplitSuggestionMime;documentId?:string;originalKey?:string;originalPages?:number;signed?:boolean};
async function reserve(auth:StoredPdfAuthorization,parserId:string,input:Admission){
 return withSplitSuggestionAuthorization(auth,async c=>{
  const parser=await parserFor(c,auth.actor,parserId,input.mimeType);
  const prior=(await c.query(`select *,${closedExpression} creation_closed from split_suggestions where workspace_id=$1 and request_id=$2 for update`,[auth.actor.workspaceId,input.requestId])).rows[0];
  if(prior){
   if(prior.requested_by!==auth.actor.userId||prior.parser_id!==parserId||prior.source_sha256!==input.sourceSha256||prior.expected_bytes!==input.size||prior.source_mime_type!==input.mimeType||prior.source_document_id!==(input.documentId??null))conflict();
   return prior as Row;
  }
  if(!splitSuggestionsConfigured())badRequest('AI split suggestions are unavailable. Check the AI connection or choose page ranges manually.',503);
  if(input.size>Number(parser.plan.maxBytes))badRequest('Document exceeds the workspace file limit',413);
  await requireSuggestionCapacity(c,auth.actor.workspaceId);
  await pendingCapacity(c,auth.actor.workspaceId,input.size+(input.signed?splitSuggestionLimits.maxBytes:0));
  const id=randomUUID(),key=`${auth.actor.workspaceId}/${randomUUID()}`,stage=input.signed?`${auth.actor.workspaceId}/${randomUUID()}`:null;
  const row=(await c.query(`insert into split_suggestions(id,workspace_id,parser_id,requested_by,request_id,auth_type,token_hash,source_document_id,original_source_key,original_page_count,source_name,source_sha256,source_mime_type,expected_bytes,source_storage_key,source_reserved_bytes,staging_storage_key,staging_reserved_bytes,staging_expires_at,config)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$14,$16,$17,case when $16::text is null then null else now()+($18*interval '1 second') end,$19) returning *`,
   [id,auth.actor.workspaceId,parserId,auth.actor.userId,input.requestId,auth.actor.authType,auth.tokenHash,input.documentId??null,input.originalKey??null,input.originalPages??null,safeDownloadName(input.filename),input.sourceSha256,input.mimeType,input.size,key,stage,input.signed?splitSuggestionLimits.maxBytes:0,SIGNED_UPLOAD_RETENTION_SECONDS,JSON.stringify({locale:parser.locale})])).rows[0];
  await validateOriginal(c,row);
  await audit(c,auth.actor.workspaceId,auth.actor.userId,'split.suggestion_requested',id,{parserId,sourceDocumentId:input.documentId??null});return row as Row;
 });
}
async function liveScope(auth:StoredPdfAuthorization,parserId:string,id:string,fn?:(c:PoolClient,row:Row)=>Promise<void>){
 return withSplitSuggestionAuthorization(auth,async c=>{
  await parserFor(c,auth.actor,parserId);const row=await rowFor(c,auth,parserId,id);
  assertLive(row);await parserFor(c,auth.actor,parserId,row.source_mime_type);await validateOriginal(c,row);if(fn)await fn(c,row);return row;
 });
}

/** The copy key is reserved before writes and never replaced on retries. */
async function populate(auth:StoredPdfAuthorization,parserId:string,id:string,read:()=>Promise<Buffer>,op:ReturnType<typeof deadline>){
 const owner=randomUUID();
 const row=await op.bounded(()=>liveScope(auth,parserId,id,async(c,row)=>{
  if(row.state!=='uploading')return;
  if(row.write_until&&new Date(row.write_until).getTime()>Date.now())badRequest('This suggestion upload is still being verified. Retry the same request shortly.',409);
  await c.query("update split_suggestions set write_owner=$2,write_until=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp() where id=$1",[id,owner]);
 }));
 if(row.state!=='uploading')return publicSplitSuggestion(row);
 try{
  const bytes=await op.bounded(read);verifyBytes(bytes,row);op.check();
  await op.bounded(()=>liveScope(auth,parserId,id));
  // A previous successful write may have lost its response. Verify it before
  // treating an immutable-key conflict as recovery; never overwrite the object.
  let existing:Buffer|undefined;
  try{existing=await op.bounded(()=>readStoredObject(row.source_storage_key));}
  catch(error){if((error as any).code!=='ENOENT'&&(error as any).statusCode!==404)throw error;}
  if(existing)verifyBytes(existing,row);else await op.bounded(()=>privateStorage().write(row.source_storage_key,bytes));
  const persisted=await op.bounded(()=>readStoredObject(row.source_storage_key));verifyBytes(persisted,row);
  const ready=await op.bounded(()=>liveScope(auth,parserId,id,async(c,current)=>{
   if(current.state!=='uploading'||current.write_owner!==owner||new Date(current.write_until).getTime()<=Date.now())badRequest('This suggestion upload changed. Check its current status.',409);
   await c.query("update split_suggestions set state='queued',write_owner=null,write_until=null,error=null,updated_at=clock_timestamp() where id=$1 and write_owner=$2",[id,owner]);
  }));
  return publicSplitSuggestion({...ready,state:'queued',write_owner:null,write_until:null,error:null});
 }finally{
  // A timed-out write can still be finishing at storage. Keep its finite lease
  // rather than letting cleanup/retry race that outstanding immutable write.
  if(!op.signal.aborted)await transaction(adminPool,async c=>{await c.query('update split_suggestions set write_owner=null,write_until=null where id=$1 and write_owner=$2',[id,owner]);});
 }
}

export async function readSplitSuggestionSource(auth:StoredPdfAuthorization,parserId:string,suggestionId:string,options:Services&{signal?:AbortSignal}={}):Promise<{suggestion:SplitSuggestion;bytes:Buffer}>{
 parserId=uuid.parse(parserId);suggestionId=uuid.parse(suggestionId);const op=deadline(options.timeoutMs??90_000,options.signal);
 try{
  const row=await op.bounded(()=>liveScope(auth,parserId,suggestionId));
  if(row.state==='uploading')badRequest('Finish uploading this suggestion source first.',409);
  const bytes=await op.bounded(()=>(options.readSource??readStoredObject)(row.source_storage_key,splitSuggestionLimits.maxBytes));verifyBytes(bytes,row);
  await op.bounded(()=>liveScope(auth,parserId,suggestionId));return {suggestion:publicSplitSuggestion(row),bytes};
 }finally{op.close();}
}
function secureBytes(reply:FastifyReply){return reply.header('Cache-Control','private, no-store').header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer').header('Content-Security-Policy',"sandbox; default-src 'none'");}
export async function registerSplitSuggestions(app:FastifyInstance,services:Services={}){
 const base='/api/parsers/:id/split-suggestions';
 app.get(base,async request=>{
  const auth=await actorFor(request),{id}=parameters.parse(request.params);
  return withSplitSuggestionAuthorization(auth,async c=>{await parserFor(c,auth.actor,id);const rows=(await c.query(`select *,${closedExpression} creation_closed from split_suggestions where workspace_id=$1 and parser_id=$2 and requested_by=$3 order by created_at desc,id desc limit 10`,[auth.actor.workspaceId,id,auth.actor.userId])).rows;
   return {available:splitSuggestionsConfigured(),limits:splitSuggestionLimits,suggestions:rows.map(publicSplitSuggestion)};});
 });
 for(const byRequest of [false,true])app.get(`${base}/${byRequest?'requests/:requestId':':suggestionId'}`,async request=>{
  const auth=await actorFor(request),p=parameters.parse(request.params);
  return withSplitSuggestionAuthorization(auth,async c=>{await parserFor(c,auth.actor,p.id);return {suggestion:publicSplitSuggestion(await rowFor(c,auth,p.id,(byRequest?p.requestId:p.suggestionId)!,byRequest))};});
 });
 app.post(base,async(request,reply)=>{
  const auth=await actorFor(request),{id}=parameters.parse(request.params),op=requestDeadline(request,reply,services.timeoutMs??90_000);
  try{
   await op.bounded(()=>withSplitSuggestionAuthorization(auth,c=>parserFor(c,auth.actor,id)));
   if(request.isMultipart()){
    let bytes:Buffer|undefined,name='';const fields:Record<string,string>={},seen=new Set<string>();
    await op.bounded(async()=>{for await(const part of request.parts({limits:{fileSize:splitSuggestionLimits.maxBytes,files:1,fields:2,parts:3,fieldSize:100}})){
     op.check();if(seen.has(part.fieldname))badRequest('Each suggestion field may only be supplied once.');seen.add(part.fieldname);
     if(part.type==='file'){if(part.fieldname!=='file')badRequest('Choose exactly one source file.');bytes=await op.bounded(()=>part.toBuffer());name=safeDownloadName(part.filename);if(part.file.truncated)badRequest('Choose a source of at most 10 MB.',413);}
     else{if(!['requestId','sourceSha256'].includes(part.fieldname)||typeof part.value!=='string')badRequest('Unexpected suggestion field.');fields[part.fieldname]=part.value;}
    }});
    if(!bytes||seen.size!==3)badRequest('Provide one file, request ID and source checksum.');
    const sourceSha256=digest.parse(fields.sourceSha256);if(sha(bytes)!==sourceSha256)badRequest('The source checksum does not match the uploaded file.',409);
    const row=await op.bounded(()=>reserve(auth,id,{requestId:uuid.parse(fields.requestId),sourceSha256,filename:name,size:bytes!.length,mimeType:actualMime(bytes!)}));
    return reply.code(202).send({suggestion:await populate(auth,id,row.id,async()=>bytes!,op)});
   }
   if(storedInput.safeParse(request.body).success){
    const input=storedInput.parse(request.body);
    const doc=await op.bounded(()=>withSplitSuggestionAuthorization(auth,async c=>{await parserFor(c,auth.actor,id);const row=(await c.query('select * from documents where id=$1 and workspace_id=$2 and parser_id=$3 for share',[input.documentId,auth.actor.workspaceId,id])).rows[0];if(!row)notFound('Original document not found');if(row.sha256!==input.sourceSha256)conflict();mime.parse(row.mime_type);if(Number(row.byte_size)>splitSuggestionLimits.maxBytes||row.page_count>30)badRequest('The original exceeds the supported split limits.',413);return row;}));
    const row=await op.bounded(()=>reserve(auth,id,{...input,filename:doc.name,size:Number(doc.byte_size),mimeType:doc.mime_type,originalKey:doc.storage_key,originalPages:doc.page_count}));
    return reply.code(202).send({suggestion:await populate(auth,id,row.id,()=>(services.readSource??readStoredObject)(doc.storage_key),op)});
   }
   const input=signedInput.parse(request.body),storage=privateStorage();if(!storage.signUpload)badRequest('Direct upload is unavailable on this installation.',409);
   const row=await op.bounded(()=>reserve(auth,id,{...input,signed:true}));assertLive(row);
   if(row.state!=='uploading')return reply.code(202).send({suggestion:publicSplitSuggestion(row)});
   if(!row.staging_storage_key||new Date(row.staging_expires_at).getTime()<=Date.now())inaccessible();
   // Renewing a signed URL also renews its cleanup reservation before disclosure.
   await op.bounded(()=>liveScope(auth,id,row.id,async(c,current)=>{if(current.state!=='uploading')badRequest('Check this suggestion status before uploading again.',409);await c.query("update split_suggestions set staging_expires_at=greatest(staging_expires_at,clock_timestamp()+($2*interval '1 second')) where id=$1",[row.id,SIGNED_UPLOAD_RETENTION_SECONDS]);}));
   const url=await op.bounded(()=>storage.signUpload!(row.staging_storage_key));await op.bounded(()=>liveScope(auth,id,row.id));
   return reply.code(202).send({suggestion:publicSplitSuggestion(row),upload:{url,method:'PUT',headers:{'Content-Type':'application/octet-stream','x-upsert':'false'},expiresAt:new Date(Date.now()+2*60*60*1000).toISOString()}});
  }finally{op.close();}
 });
 app.post(`${base}/:suggestionId/finalize`,async(request,reply)=>{
  const auth=await actorFor(request),p=parameters.parse(request.params);z.object({}).strict().parse(request.body??{});const op=requestDeadline(request,reply,services.timeoutMs??90_000);
  try{const row=await op.bounded(()=>liveScope(auth,p.id,p.suggestionId!));if(row.state!=='uploading')return reply.code(202).send({suggestion:publicSplitSuggestion(row)});
   if(!row.staging_storage_key||new Date(row.staging_expires_at).getTime()<=Date.now())inaccessible();
   return reply.code(202).send({suggestion:await populate(auth,p.id,row.id,()=>(services.readSource??readStoredObject)(row.staging_storage_key),op)});
  }finally{op.close();}
 });
 app.post(`${base}/:suggestionId/cancel`,async request=>{
  const auth=await actorFor(request),p=parameters.parse(request.params);z.object({}).strict().parse(request.body??{});
  return withSplitSuggestionAuthorization(auth,async c=>{await parserFor(c,auth.actor,p.id);const row=await rowFor(c,auth,p.id,p.suggestionId!);
   if(row.accepted_split_id)badRequest('This suggestion has already created a split batch.',409);
   if(row.state!=='cancelled')await c.query("update split_suggestions set state='cancelled',lease_owner=null,lease_until=null,error=null,updated_at=clock_timestamp() where id=$1",[row.id]);
   return {suggestion:publicSplitSuggestion({...row,state:'cancelled',error:null,creation_closed:true})};});
 });
 app.get(`${base}/:suggestionId/source`,async(request,reply)=>{
  const auth=await actorFor(request),p=parameters.parse(request.params),op=requestDeadline(request,reply,services.timeoutMs??90_000);
  try{const {suggestion,bytes}=await readSplitSuggestionSource(auth,p.id,p.suggestionId!,{...services,signal:op.signal});op.check();
   return secureBytes(reply).type(suggestion.sourceMimeType).header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(suggestion.sourceName)}`).header('X-Folio-Source-Sha256',suggestion.sourceSha256).send(bytes);
  }finally{op.close();}
 });
 app.get(`${base}/:suggestionId/preview`,async(request,reply)=>{
  const auth=await actorFor(request),p=parameters.parse(request.params),{page}=z.object({page:z.coerce.number().int().min(1).max(30)}).strict().parse(request.query),op=requestDeadline(request,reply,services.timeoutMs??90_000);
  try{
   const {suggestion,bytes}=await op.bounded(()=>readSplitSuggestionSource(auth,p.id,p.suggestionId!,{...services,signal:op.signal}));
   if(suggestion.sourceMimeType!=='image/tiff')badRequest('Page previews are available for TIFF files.',415);
   const info=inspectTiffStructure(bytes);if(page>info.pages.length)badRequest('This page is outside the document.');
   const rendered=await op.bounded(()=>(services.renderPage??renderTiffPage)(bytes,page,{signal:op.signal,timeoutMs:Math.min(30_000,op.remaining())}));
   if(rendered.sourceSha256!==suggestion.sourceSha256||rendered.page!==page||rendered.pageCount!==info.pages.length||rendered.renderVersion!==tiffRenderVersion||rendered.mimeType!=='image/jpeg'||!Buffer.isBuffer(rendered.bytes)||!rendered.bytes.length||rendered.bytes.length>tiffLimits.maxJpegBytes||!rendered.bytes.subarray(0,3).equals(Buffer.from([255,216,255]))||!Number.isInteger(rendered.width)||rendered.width<1||rendered.width>tiffLimits.maxEdge||!Number.isInteger(rendered.height)||rendered.height<1||rendered.height>tiffLimits.maxEdge)badRequest('The TIFF preview could not be verified.',503);
   await op.bounded(()=>liveScope(auth,p.id,p.suggestionId!));
   return secureBytes(reply).type('image/jpeg').header('X-Folio-Source-Sha256',suggestion.sourceSha256).header('X-Folio-Preview-Page',String(page)).header('X-Folio-Page-Count',String(rendered.pageCount)).send(rendered.bytes);
  }finally{op.close();}
 });
}

/** Validate injected providers just as strictly as the network adapter. */
function validatedResult(value:SplitSuggestionResult,pageCount:number):SplitSuggestionResult{
 try{
  splitSuggestionRanges(value?.startPages,pageCount);
  if(typeof value.model!=='string'||!value.model||value.model.length>200||typeof value.promptVersion!=='string'||!value.promptVersion||value.promptVersion.length>200
   ||!Number.isFinite(value.costUsd)||value.costUsd<0||value.costUsd>=1_000_000||!value.tokenUsage||typeof value.tokenUsage!=='object'||Array.isArray(value.tokenUsage))throw new Error('Invalid result');
  const serialized=JSON.stringify(value.tokenUsage);if(Buffer.byteLength(serialized)>12_000)throw new Error('Invalid result');
  const safe=(item:unknown,depth=0):boolean=>depth<=8&&(item===null||typeof item==='string'&&item.length<=1000||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item)&&item>=0||Array.isArray(item)&&item.length<=100&&item.every(v=>safe(v,depth+1))||typeof item==='object'&&item!==null&&Object.keys(item).length<=100&&Object.entries(item).every(([key,v])=>key.length<=100&&safe(v,depth+1)));
  if(!safe(value.tokenUsage))throw new Error('Invalid result');
  return {...value,startPages:[...value.startPages],tokenUsage:JSON.parse(serialized)};
 }catch{throw new SplitSuggestionProviderError('AI returned invalid page boundaries. Choose ranges manually or request a new suggestion.');}
}
async function recoverLeases(onlyId?:string){
 const rows=(await adminPool.query("select id,workspace_id from split_suggestions where state='processing' and lease_until<clock_timestamp() and ($1::uuid is null or id=$1) order by lease_until,id limit 20",[onlyId??null])).rows;
 for(const row of rows)await transaction(adminPool,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[row.workspace_id]);
  await c.query("update split_suggestions set state=case when attempts>=max_attempts or expires_at<=clock_timestamp() then 'failed' else 'queued' end,lease_owner=null,lease_until=null,error='Split suggestion was interrupted. Request a new suggestion if it does not recover.',updated_at=clock_timestamp() where id=$1 and state='processing' and lease_until<clock_timestamp()",[row.id]);
 });
}
export async function processOneSplitSuggestion(onlyId?:string,options:{signal?:AbortSignal;providerTimeoutMs?:number}={}){
 await assertStorageRestoreReady(config.storageDir,process.env.STORAGE_DRIVER||'filesystem');
 const ms=options.providerTimeoutMs??90_000;if(!Number.isFinite(ms)||ms<=0||ms>90_000)throw new Error('Suggestion deadline must be positive and at most 90 seconds');
 if(options.signal?.aborted)return false;await recoverLeases(onlyId);if(options.signal?.aborted)return false;
 const owner=randomUUID();
 const job=await transaction(adminPool,async c=>{
  const selected=(await c.query(`select s.* from split_suggestions s join workspaces w on w.id=s.workspace_id
   where s.state='queued' and s.available_at<=now() and s.attempts<s.max_attempts and s.expires_at>now() and (s.write_until is null or s.write_until<=now())
   and ($1::uuid is null or s.id=$1) and ($1::uuid is not null or not exists(select 1 from (${runnableAiWorkSql}) earlier where earlier.workspace_id=s.workspace_id and (earlier.created_at,earlier.id,earlier.lane)<(s.created_at,s.id,2)))
   and ((select count(*) from jobs j where j.workspace_id=s.workspace_id and j.state='processing')+
        (select count(*) from schema_suggestions a where a.workspace_id=s.workspace_id and a.state='processing')+
        (select count(*) from split_suggestions b where b.workspace_id=s.workspace_id and b.state='processing'))<coalesce((w.plan->>'maxConcurrent')::int,2)
   order by s.created_at,s.id for update of s,w skip locked limit 1`,[onlyId??null])).rows[0];
  if(!selected)return null;
  if(!(await c.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[selected.workspace_id])).rows[0].acquired)return null;
  if(!await hasWorkspaceExtractionCapacity(c,selected.workspace_id,onlyId?undefined:{id:selected.id,createdAt:selected.created_at,lane:2})||options.signal?.aborted)return null;
  await c.query("update split_suggestions set state='processing',attempts=attempts+1,lease_owner=$2,lease_until=clock_timestamp()+interval '120 seconds',error=null,updated_at=clock_timestamp() where id=$1",[selected.id,owner]);
  return {...selected,state:'processing',lease_owner:owner,attempts:selected.attempts+1} as Row;
 });
 if(!job)return false;
 const auth=authorizationForJob(job),op=deadline(ms,options.signal);
 const checkJob=()=>liveScope(auth,job.parser_id,job.id,async(_c,row)=>{if(row.state!=='processing'||row.lease_owner!==owner||new Date(row.lease_until).getTime()<=Date.now())badRequest('This suggestion attempt is no longer current.',409);});
 try{
  const result=await op.bounded(async()=>{
   await op.bounded(checkJob);const bytes=await op.bounded(()=>readStoredObject(job.source_storage_key,splitSuggestionLimits.maxBytes));verifyBytes(bytes,job);
   const source=await op.bounded(()=>runDecoder(bytes,job.source_name,{signal:op.signal,timeoutMs:Math.min(30_000,op.remaining())}));
   if(source.mimeType!==job.source_mime_type||source.pageCount!==source.pages.length||source.pageCount<1||source.pageCount>30||job.original_page_count!==null&&source.pageCount!==job.original_page_count)throw new SplitSuggestionProviderError('The source page count or format could not be verified. Request a new suggestion.');
   await op.bounded(checkJob);
   const input={bytes,mimeType:job.source_mime_type as SplitSuggestionMime,pages:source.pages,locale:job.config.locale,signal:op.signal};
   const visualDocument=await op.bounded(()=>prepareVisualDocument(input,{signal:op.signal,expectedSha256:job.source_sha256}));
   await op.bounded(checkJob);const active=provider;
   if(!active?.configured())throw new SplitSuggestionProviderError('AI split suggestions are unavailable. Choose ranges manually or check the AI connection.');
   const proposed=await op.bounded(()=>active.suggest({...input,...(visualDocument?{visualDocument}:{})}));
   const checked=validatedResult(proposed,source.pageCount);
   return {...checked,pageCount:source.pageCount,tokenUsage:visualDocument?{...checked.tokenUsage,sourceRendering:visualRenderingMetadata(visualDocument)}:checked.tokenUsage};
  });
  await op.bounded(()=>liveScope(auth,job.parser_id,job.id,async(c,row)=>{
   op.check();if(row.state!=='processing'||row.lease_owner!==owner||new Date(row.lease_until).getTime()<=Date.now())return;
   await c.query("update split_suggestions set state='ready',lease_owner=null,lease_until=null,page_count=$3,start_pages=$4,model=$5,prompt_version=$6,token_usage=$7,cost_usd=$8,error=null,completed_at=clock_timestamp(),updated_at=clock_timestamp() where id=$1 and lease_owner=$2 and lease_until>clock_timestamp()",[job.id,owner,result.pageCount,JSON.stringify(result.startPages),result.model,result.promptVersion,JSON.stringify(result.tokenUsage),result.costUsd]);
   await audit(c,job.workspace_id,job.requested_by,'split.suggestion_ready',job.id,{parserId:job.parser_id});op.check();
  }));
 }catch(error){
  const status=(error as {statusCode?:number}).statusCode;
  const trusted=error instanceof SplitSuggestionProviderError;
  const permanent=trusted&&error.permanent||error instanceof SourceValidationError||[400,401,403,404,409,410,413,415].includes(status??0)||job.attempts>=job.max_attempts;
  let message=trusted?error.message.slice(0,500):error instanceof SourceValidationError?'The source could not be decoded safely. Choose another PDF or TIFF.':status===401||status===403?'Access changed before the suggestion completed. Sign in and request a new suggestion.':status===404||status===410?'The suggestion source is no longer available.':status===409?'The suggestion source changed. Request a new suggestion.':'Split suggestions could not be completed. Try again shortly.';
  if(permanent)message=message.replace('A retry is scheduled.','Request a new suggestion to try again.');
  await transaction(adminPool,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[job.workspace_id]);
   const changed=await c.query("update split_suggestions set state=$3,lease_owner=null,lease_until=null,error=$4,available_at=clock_timestamp()+($5*interval '1 second'),updated_at=clock_timestamp() where id=$1 and state='processing' and lease_owner=$2 and lease_until>clock_timestamp() returning id",[job.id,owner,permanent?'failed':'queued',message,Math.min(60,2**job.attempts)]);
   if(changed.rowCount&&permanent)await audit(c,job.workspace_id,null,'split.suggestion_failed',job.id,{parserId:job.parser_id,reason:'processing_failed'});
  });
 }finally{op.close();}
 return true;
}

/** Keys and byte reservations are released only after physical deletion. */
export async function reconcileExpiredSplitSuggestions(onlyWorkspaceId?:string,options:{signal?:AbortSignal;limit?:number;timeoutMs?:number}={}){
 await assertStorageRestoreReady(config.storageDir,process.env.STORAGE_DRIVER||'filesystem');
 const limit=Math.min(100,Math.max(1,options.limit??20));let removed=0;
 const candidates=(await adminPool.query(`select id,workspace_id from split_suggestions where ($1::uuid is null or workspace_id=$1)
  and ((source_storage_key is not null and (expires_at<=clock_timestamp() or state='cancelled')) or (staging_storage_key is not null and staging_expires_at<=clock_timestamp()))
  and (write_until is null or write_until<=clock_timestamp()) and (lease_until is null or lease_until<=clock_timestamp()) order by created_at,id limit $2`,[onlyWorkspaceId??null,limit])).rows;
 for(const candidate of candidates){
  if(options.signal?.aborted)break;const owner=randomUUID();
  const entry=await transaction(adminPool,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.workspace_id]);
   const row=(await c.query('select * from split_suggestions where id=$1 for update',[candidate.id])).rows[0];
   if(!row||row.write_until&&new Date(row.write_until).getTime()>Date.now()||row.lease_until&&new Date(row.lease_until).getTime()>Date.now())return null;
   const source=row.source_storage_key&&(row.state==='cancelled'||new Date(row.expires_at).getTime()<=Date.now()),staging=row.staging_storage_key&&new Date(row.staging_expires_at).getTime()<=Date.now();
   if(!source&&!staging)return null;
   await c.query("update split_suggestions set write_owner=$2,write_until=clock_timestamp()+interval '120 seconds',state=case when state in('uploading','queued','processing') and expires_at<=clock_timestamp() then 'failed' when state='processing' then case when attempts>=max_attempts then 'failed' else 'queued' end else state end,lease_owner=null,lease_until=null,error=case when state in('uploading','queued','processing') and expires_at<=clock_timestamp() then 'The suggestion source expired. Request a new suggestion.' else error end where id=$1",[row.id,owner]);
   return {row,source:source?row.source_storage_key:null,staging:staging?row.staging_storage_key:null};
  });
  if(!entry)continue;
  const op=deadline(options.timeoutMs??90_000,options.signal);
  try{for(const kind of ['source','staging'] as const){
   const key=entry[kind];if(!key||options.signal?.aborted)continue;validateStorageKey(key,candidate.workspace_id);
   try{await op.bounded(()=>privateStorage().remove(key));}catch(error){if((error as any).code!=='ENOENT'&&(error as any).statusCode!==404)continue;}
   await transaction(adminPool,async c=>{await c.query(`update split_suggestions set ${kind}_storage_key=null,${kind}_reserved_bytes=0,${kind}_released_at=clock_timestamp() where id=$1 and write_owner=$2 and ${kind}_storage_key=$3`,[candidate.id,owner,key]);});removed++;
  }}finally{if(!op.signal.aborted)await adminPool.query('update split_suggestions set write_owner=null,write_until=null where id=$1 and write_owner=$2',[candidate.id,owner]);op.close();}
 }
 return {removed};
}
