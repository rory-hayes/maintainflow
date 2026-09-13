import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import type {PoolClient} from 'pg';
import type {Actor} from '../../shared/types.js';
import {withWorkspace,badRequest,notFound,audit,camel} from './db.js';
import {privateStorage} from './storage.js';
import {inspectSource} from './source.js';
import {SourceValidationError,isSourceValidationReason} from './source-validation.js';
import {deleteStoredFile} from './retention.js';
import {inspectedFormat,ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';

type IntakeResult={document:any;duplicate:boolean;jobId:string|null};
type Decision=IntakeResult|{rejection:ParserFormatNotAllowedError|SourceIntakeRejectedError};
async function lockParser(c:PoolClient,actor:Actor,parserId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
 const {rows:[parser]}=await c.query('select * from parsers where id=$1 and workspace_id=$2 and archived=false',[parserId,actor.workspaceId]);
 if(!parser)notFound('Active parser not found');
 return parser;
}
/** Called under the workspace lock before decoding and again before a decision commits. */
async function priorIntake(c:PoolClient,actor:Actor,parserId:string,sha:string,key?:string):Promise<Decision|undefined>{
 if(key){
  const {rows:[prior]}=await c.query('select d.*,e.id event_id,e.document_id prior_document_id,e.rejection_code,e.rejection_format,e.rejection_reason,e.rejection_sha256,e.rejected_parser_id from intake_events e left join documents d on d.id=e.document_id where e.workspace_id=$1 and e.idempotency_key=$2',[actor.workspaceId,key]);
  if(prior){
   if(prior.rejection_code){
    if(prior.rejection_sha256!==sha||prior.rejected_parser_id!==parserId)badRequest('This idempotency key was already used for a different document or parser.',409);
    if(prior.rejection_code==='parser_format_not_allowed')return {rejection:new ParserFormatNotAllowedError(parserId,prior.rejection_format)};
    if(prior.rejection_code==='source_validation_failed'&&isSourceValidationReason(prior.rejection_reason))return {rejection:new SourceIntakeRejectedError(parserId,prior.rejection_reason)};
    throw new Error('Stored intake rejection has an unsupported reason');
   }
   if(!prior.prior_document_id)badRequest('This intake event was already handled and its document was deleted.',410);
   if(prior.sha256!==sha||prior.parser_id!==parserId)badRequest('This idempotency key was already used for a different document or parser.',409);
   return {document:camel(prior),duplicate:true,jobId:null};
  }
 }
 const {rows:[duplicate]}=await c.query('select * from documents where parser_id=$1 and sha256=$2',[parserId,sha]);
 if(duplicate){
  if(key)await c.query('insert into intake_events(workspace_id,idempotency_key,document_id) values($1,$2,$3)',[actor.workspaceId,key,duplicate.id]);
  return {document:camel(duplicate),duplicate:true,jobId:null};
 }
}
function accepted(decision:Decision):IntakeResult{if('rejection' in decision)throw decision.rejection;return decision;}

/** The inspection override is internal test injection; HTTP routes never accept it. */
export async function addDocument(actor:Actor,parserId:string,buffer:Buffer,filename:string,_mimeType?:string,idempotencyKey?:string,options:{inspectSource?:typeof inspectSource}={}):Promise<IntakeResult>{
 if(idempotencyKey&&idempotencyKey.length>200)badRequest('Idempotency key is too long');
 const name=path.basename(filename).replace(/[\u0000-\u001f\u007f]/g,'').slice(0,240)||'document.txt';
 const sha=createHash('sha256').update(buffer).digest('hex');
 const prior=await withWorkspace(actor.workspaceId,async c=>{await lockParser(c,actor,parserId);return priorIntake(c,actor,parserId,sha,idempotencyKey);});
 if(prior)return accepted(prior);
 let source:Awaited<ReturnType<typeof inspectSource>>;
 try{source=await (options.inspectSource??inspectSource)(buffer,name);}
 catch(error){
  // Only explicit, validated source failures are permanent. Decoder crashes,
  // timeouts, invalid IPC and infrastructure failures keep their retry behavior.
  if(!(error instanceof SourceValidationError))throw error;
  const rejection=new SourceIntakeRejectedError(parserId,error.reason);
  const decision=await withWorkspace(actor.workspaceId,async c=>{
   await lockParser(c,actor,parserId);
   const existing=await priorIntake(c,actor,parserId,sha,idempotencyKey);if(existing)return existing;
   if(idempotencyKey)await c.query('insert into intake_events(workspace_id,idempotency_key,rejection_code,rejection_reason,rejection_sha256,rejected_parser_id) values($1,$2,$3,$4,$5,$6)',[actor.workspaceId,idempotencyKey,rejection.code,rejection.reason,sha,parserId]);
   await audit(c,actor.workspaceId,actor.userId,'document.rejected',null,{code:rejection.code,reason:rejection.message,parserId});
   return {rejection};
  });
  return accepted(decision); // Throw only after the receipt and audit commit.
 }
 const format=inspectedFormat(source.mimeType),id=randomUUID(),storageKey=`${actor.workspaceId}/${id}`;
 await withWorkspace(actor.workspaceId,c=>c.query('insert into intake_files(id,workspace_id,storage_key) values($1,$2,$3)',[id,actor.workspaceId,storageKey]));
 const heartbeat=setInterval(()=>{void withWorkspace(actor.workspaceId,c=>c.query("update intake_files set lease_expires_at=now()+interval '5 minutes' where id=$1",[id])).catch(()=>{});},30_000);heartbeat.unref();
 let retained=false,writeAttempted=false,writeCompleted=false;
 try{
  writeAttempted=true;await privateStorage().write(storageKey,buffer);writeCompleted=true;
  const result=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId);
   if(!(await c.query('select id from intake_files where id=$1 for update',[id])).rowCount)badRequest('The original write reservation expired. Retry the upload.',409);
   const existing=await priorIntake(c,actor,parserId,sha,idempotencyKey);if(existing)return existing;
   if(parser.allowed_formats!==null&&parser.allowed_formats!==undefined&&!parser.allowed_formats.includes(format)){
    const rejection=new ParserFormatNotAllowedError(parserId,format);
    if(idempotencyKey)await c.query('insert into intake_events(workspace_id,idempotency_key,rejection_code,rejection_format,rejection_sha256,rejected_parser_id) values($1,$2,$3,$4,$5,$6)',[actor.workspaceId,idempotencyKey,rejection.code,format,sha,parserId]);
    await audit(c,actor.workspaceId,actor.userId,'document.rejected',null,{reason:rejection.message,parserId,format});
    return {rejection};
   }
   const {rows:[workspace]}=await c.query('select plan from workspaces where id=$1',[actor.workspaceId]);
   const plan=workspace.plan;if(buffer.length>plan.maxBytes||source.pageCount>plan.maxPages)badRequest('Document exceeds the workspace file or page limit',413);
   const {rows:[usage]}=await c.query("select coalesce(sum(pages),0)::integer used from usage_ledger where workspace_id=$1 and created_at>=date_trunc('month',now())",[actor.workspaceId]);
   if(usage.used+source.pageCount>plan.monthlyPages)badRequest('Monthly page quota reached. Update the plan before uploading more documents.',429);
   let {rows:[doc]}=await c.query('insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,source_text) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *',[id,actor.workspaceId,parserId,name,source.mimeType,buffer.length,sha,storageKey,'received',source.pageCount,JSON.stringify(source.pages)]);
   const templates=(await c.query('select * from templates where parser_id=$1 order by created_at,id',[parserId])).rows;
   const {rows:[job]}=await c.query('insert into jobs(workspace_id,document_id,schema_version_id,config) values($1,$2,$3,$4) returning id',[actor.workspaceId,id,parser.active_schema_id,JSON.stringify({mode:parser.mode,instructions:parser.instructions,locale:parser.locale,timezone:parser.timezone,templates})]);
   doc=(await c.query("update documents set status='queued',updated_at=clock_timestamp() where id=$1 returning *",[id])).rows[0];
   await c.query('insert into usage_ledger(workspace_id,document_id,event,pages,idempotency_key) values($1,$2,$3,$4,$5)',[actor.workspaceId,id,'upload',source.pageCount,`upload:${id}`]);
   if(idempotencyKey)await c.query('insert into intake_events(workspace_id,idempotency_key,document_id) values($1,$2,$3)',[actor.workspaceId,idempotencyKey,id]);
   await audit(c,actor.workspaceId,actor.userId,'document.uploaded',id,{parserId,pages:source.pageCount});
   return {document:camel(doc),duplicate:false,jobId:job.id};
  });
  const value=accepted(result);retained=!value.duplicate;return value;
 }finally{
  clearInterval(heartbeat);
  await withWorkspace(actor.workspaceId,async c=>{
   if(!retained&&writeAttempted)await c.query("insert into file_deletions(workspace_id,storage_key,available_at) values($1,$2,now()+($3::int*interval '1 second')) on conflict(storage_key) do nothing",[actor.workspaceId,storageKey,!writeCompleted&&privateStorage().kind==='supabase'?300:0]);
   await c.query('delete from intake_files where id=$1',[id]);
  });
  if(!retained&&writeAttempted&&(writeCompleted||privateStorage().kind==='filesystem'))await deleteStoredFile(actor.workspaceId,storageKey);
 }
}
