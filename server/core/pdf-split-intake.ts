import {createHash,randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {templatePolicy} from '../../shared/template-selection.js';
import {canonicalPdfSplitSpec,PdfSplitValidationError,isPdfSplitValidationReason,pdfSplitLimits,planPdfSplit,type PdfSplitSpec,type PdfSplitReceipt} from '../../shared/pdf-split.js';
import {withWorkspace,badRequest,notFound,audit} from './db.js';
import {splitPdfSource} from './source.js';
import {SourceValidationError,isSourceValidationReason} from './source-validation.js';
import {ParserFormatNotAllowedError,SourceIntakeRejectedError} from './intake-policy.js';
import {privateStorage,safeDownloadName} from './storage.js';
import {findPdfSplitByRequest,readPdfSplitReceipt} from './pdf-split-records.js';

type SplitSource=typeof splitPdfSource;
export type SplitDirectUpload={id:string;owner:string};
type Options={splitSource?:SplitSource;timeoutMs?:number;directUpload?:SplitDirectUpload};
type WrittenObject={id:string;key:string;bytes:Buffer;attempted:boolean;completed:boolean};
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const unavailable=()=>Object.assign(new Error('PDF splitting took too long. Retry the same upload.'),{statusCode:503});

async function lockParser(c:PoolClient,actor:Actor,parserId:string){
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
 const parser=(await c.query('select * from parsers where id=$1 and workspace_id=$2 for update',[parserId,actor.workspaceId])).rows[0];
 if(!parser)notFound('Parser not found');
 return parser;
}
function requireReady(parser:any){
 if(parser.archived)notFound('Active parser not found');
 if(parser.field_setup_state!=='ready')badRequest('Finish parser setup before splitting a PDF.',409);
}
function requirePdf(parser:any){
 if(parser.allowed_formats!==null&&parser.allowed_formats!==undefined&&!parser.allowed_formats.includes('pdf'))throw new ParserFormatNotAllowedError(parser.id,'pdf');
}
function rejection(error:unknown):{code:string;reason:string}|undefined{
 if(error instanceof SourceValidationError&&isSourceValidationReason(error.reason))return {code:error.code,reason:error.reason};
 if(error instanceof PdfSplitValidationError&&isPdfSplitValidationReason(error.reason))return {code:error.code,reason:error.reason};
 if(error instanceof ParserFormatNotAllowedError&&error.format==='pdf')return {code:error.code,reason:'pdf'};
}

/** Every request is a distinct charged operation; only its stable UUID is replayable. */
export async function addSplitDocuments(actor:Actor,parserId:string,bytes:Buffer,filename:string,requestId:string,spec:PdfSplitSpec,options:Options={}):Promise<PdfSplitReceipt>{
 requestId=z.string().uuid().parse(requestId).toLowerCase();parserId=z.string().uuid().parse(parserId).toLowerCase();
 const canonical=canonicalPdfSplitSpec(spec),specHash=sha(canonical),sourceSha=sha(bytes),name=safeDownloadName(filename);
 const timeoutMs=options.timeoutMs??120_000;
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>120_000)throw new Error('Split deadline must be positive and at most 120 seconds');
 const controller=new AbortController(),deadline=Date.now()+timeoutMs;
 const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref();
 const check=()=>{if(controller.signal.aborted||Date.now()>=deadline)throw unavailable();};
 const bounded=<T>(work:Promise<T>):Promise<T>=>new Promise((resolve,reject)=>{
  const abort=()=>reject(unavailable());
  controller.signal.addEventListener('abort',abort,{once:true});
  work.then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
  if(controller.signal.aborted)abort();
 });
 const attemptId=randomUUID(),splitId=randomUUID();
 let files:WrittenObject[]=[],heartbeat:ReturnType<typeof setInterval>|undefined;
 async function prior(c:PoolClient){
  const row=await findPdfSplitByRequest(c,actor.workspaceId,requestId);
  if(row&&(row.parser_id!==parserId||row.source_sha256!==sourceSha||row.spec_hash!==specHash))badRequest('This split request was already used for a different PDF, parser or page selection.',409);
  return row;
 }
 async function direct(c:PoolClient){
  if(!options.directUpload)return;
  const row=(await c.query('select *,finalize_lease_until>clock_timestamp() and expires_at>clock_timestamp() as lease_live from direct_uploads where id=$1 and workspace_id=$2 for update',[options.directUpload.id,actor.workspaceId])).rows[0];
  if(!row||row.created_by!==actor.userId)notFound('Upload reservation not found');
  if(row.state!=='finalizing'||row.finalize_owner!==options.directUpload.owner||!row.lease_live)badRequest('Upload verification changed or expired. Retry the same split request.',409);
  if(row.parser_id!==parserId||row.expected_sha256!==sourceSha||row.expected_bytes!==bytes.length||row.pdf_split_request_id!==requestId||canonicalPdfSplitSpec(row.pdf_split_spec)!==canonical)badRequest('The PDF does not match this split upload reservation.',409);
 }
 async function completeDirect(c:PoolClient,id:string){
  if(!options.directUpload)return;
  const saved=await c.query("update direct_uploads set state='complete',pdf_split_id=$3,document_id=null,job_id=null,finalize_owner=null,finalize_lease_until=null where id=$1 and finalize_owner=$2 and state='finalizing' and finalize_lease_until>clock_timestamp() and expires_at>clock_timestamp()",[options.directUpload.id,options.directUpload.owner,id]);
  if(!saved.rowCount)badRequest('Upload verification changed or expired. Retry the same split request.',409);
 }
 async function replay(c:PoolClient,row:any){
  await direct(c);check();
  // Rejected reads throw the same safe error; no accepted upload is attached.
  const receipt=await readPdfSplitReceipt(c,actor.workspaceId,row.id,true);
  await completeDirect(c,row.id);check();return receipt;
 }
 async function saveRejection(error:unknown):Promise<PdfSplitReceipt>{
  const reason=rejection(error);if(!reason)throw error;
  const result=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),existing=await prior(c);
   if(existing)return {receipt:await replay(c,existing)};
   requireReady(parser);await direct(c);check();
   await c.query("insert into pdf_splits(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,rejection_code,rejection_reason,source_byte_size,created_by) values($1,$2,$3,$4,$5,$6,$7,'rejected',$8,$9,$10,$11)",[splitId,actor.workspaceId,parserId,requestId,sourceSha,canonical,specHash,reason.code,reason.reason,bytes.length,actor.userId]);
   await audit(c,actor.workspaceId,actor.userId,'document.split_rejected',splitId,{parserId,code:reason.code,reason:reason.reason});check();
   return {error:error instanceof SourceValidationError?new SourceIntakeRejectedError(parserId,error.reason):error};
  });
  if('receipt' in result)return result.receipt!;
  throw result.error;
 }
 async function quota(c:PoolClient,sourcePageCount:number,selectedPages:number,parts:Awaited<ReturnType<SplitSource>>['parts']){
  const workspace=(await c.query('select plan from workspaces where id=$1',[actor.workspaceId])).rows[0],plan=workspace.plan;
  if(bytes.length>Math.min(pdfSplitLimits.maxBytes,plan.maxBytes)||sourcePageCount>Math.min(pdfSplitLimits.maxPages,plan.maxPages)||parts.some(p=>p.bytes.length>plan.maxBytes||p.source.pageCount>plan.maxPages))badRequest('Document exceeds the workspace file or page limit',413);
  const usage=(await c.query("select coalesce(sum(pages),0)::integer used from usage_ledger where workspace_id=$1 and created_at>=date_trunc('month',now())",[actor.workspaceId])).rows[0];
  if(usage.used+selectedPages>plan.monthlyPages)badRequest('Monthly page quota reached. Update the plan before uploading more documents.',429);
 }
 try{
  const existing=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),row=await prior(c);check();
   if(row)return replay(c,row);
   requireReady(parser);return undefined;
  });
  if(existing)return existing;
  let decoded:Awaited<ReturnType<SplitSource>>;
  try{check();decoded=await bounded((options.splitSource??splitPdfSource)(bytes,name,JSON.parse(canonical)));check();}
  catch(error){return await saveRejection(error);}
  // This also defends internal adapters against accidentally dropping/reordering parts.
  const planned=planPdfSplit(JSON.parse(canonical),decoded.sourcePageCount);
  if(decoded.parts.length!==planned.ranges.length||decoded.selectedPages!==planned.selectedPages||decoded.parts.some((part,i)=>part.range.start!==planned.ranges[i]!.start||part.range.end!==planned.ranges[i]!.end||part.source.mimeType!=='application/pdf'||part.source.pageCount!==part.range.end-part.range.start+1||!Buffer.isBuffer(part.bytes)||!part.bytes.length||part.bytes.length>pdfSplitLimits.maxBytes)||decoded.parts.reduce((n,p)=>n+p.bytes.length,0)>pdfSplitLimits.maxDerivedBytes)throw Object.assign(new Error('The PDF splitter returned an invalid result. Retry shortly.'),{statusCode:503});
  const sourceId=splitId;
  files=[{id:sourceId,key:`${actor.workspaceId}/${sourceId}`,bytes,attempted:false,completed:false},...decoded.parts.map(part=>{const id=randomUUID();return {id,key:`${actor.workspaceId}/${id}`,bytes:part.bytes,attempted:false,completed:false};})];
  const reserved=await withWorkspace(actor.workspaceId,async c=>{
   const parser=await lockParser(c,actor,parserId),row=await prior(c);if(row)return replay(c,row);
   requireReady(parser);requirePdf(parser);await direct(c);await quota(c,decoded.sourcePageCount,decoded.selectedPages,decoded.parts);check();
   const active=(await c.query('select count(distinct split_attempt_id) filter(where lease_expires_at>now())::int attempts,coalesce(sum(reserved_bytes),0)::bigint bytes from intake_files where workspace_id=$1 and split_attempt_id is not null',[actor.workspaceId])).rows[0];
   const staging=(await c.query("select coalesce(sum(case when state='complete' then expected_bytes else 10485760 end),0)::bigint bytes from direct_uploads where workspace_id=$1 and cleanup_after>now() and state<>'cleaned'",[actor.workspaceId])).rows[0];
   if(active.attempts>=2||Number(active.bytes)+Number(staging.bytes)+files.reduce((sum,file)=>sum+file.bytes.length,0)>250*1024*1024)badRequest('Too many pending PDF uploads. Finish them or retry after their cleanup window.',429);
   for(const file of files)await c.query('insert into intake_files(id,workspace_id,storage_key,split_attempt_id,reserved_bytes) values($1,$2,$3,$4,$5)',[file.id,actor.workspaceId,file.key,attemptId,file.bytes.length]);
   check();return undefined;
  }).catch(error=>{if(rejection(error))return saveRejection(error);throw error;});
  if(reserved)return reserved;
  heartbeat=setInterval(()=>{void withWorkspace(actor.workspaceId,c=>c.query("update intake_files set lease_expires_at=now()+interval '5 minutes' where split_attempt_id=$1 and workspace_id=$2",[attemptId,actor.workspaceId])).catch(()=>{});},30_000);heartbeat.unref();
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
   requireReady(parser);requirePdf(parser);await direct(c);
   const intents=(await c.query('select *,lease_expires_at>clock_timestamp() lease_live from intake_files where workspace_id=$1 and split_attempt_id=$2 order by id for update',[actor.workspaceId,attemptId])).rows;
   if(intents.length!==files.length||intents.some(intent=>!intent.lease_live)||!files.every(file=>intents.some(intent=>intent.id===file.id&&intent.storage_key===file.key))||(await c.query('select 1 from file_deletions where workspace_id=$1 and storage_key=any($2::text[]) limit 1',[actor.workspaceId,files.map(f=>f.key)])).rowCount)badRequest('The PDF write reservation expired. Retry the same split request.',409);
   await quota(c,decoded.sourcePageCount,decoded.selectedPages,decoded.parts);
   if(!(await c.query('select id from schema_versions where id=$1 and parser_id=$2 and workspace_id=$3',[parser.active_schema_id,parserId,actor.workspaceId])).rowCount)badRequest('Save valid parser fields before splitting a PDF.',409);
   const templates=(await c.query('select * from templates where parser_id=$1 order by created_at,id',[parserId])).rows;
   const jobConfig=JSON.stringify({mode:parser.mode,instructions:parser.instructions,locale:parser.locale,timezone:parser.timezone,templates,templatePolicy});check();
   await c.query("insert into pdf_splits(id,workspace_id,parser_id,request_id,source_sha256,canonical_spec,spec_hash,state,source_byte_size,source_page_count,selected_pages,child_count,source_storage_key,source_name,created_by) values($1,$2,$3,$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12,$13,$14)",[splitId,actor.workspaceId,parserId,requestId,sourceSha,canonical,specHash,bytes.length,decoded.sourcePageCount,decoded.selectedPages,decoded.parts.length,files[0]!.key,name,actor.userId]);
   for(const [i,part] of decoded.parts.entries()){
    check();const file=files[i+1]!,jobId=randomUUID(),index=i+1,childSha=sha(part.bytes),childName=safeDownloadName(`${name.replace(/\.pdf$/i,'').slice(0,190)} — pages ${part.range.start}-${part.range.end}.pdf`);
    await c.query('insert into pdf_split_children(split_id,workspace_id,parser_id,child_index,document_id,job_id,start_page,end_page,sha256,byte_size,document_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',[splitId,actor.workspaceId,parserId,index,file.id,jobId,part.range.start,part.range.end,childSha,part.bytes.length,childName]);
    await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,source_text,pdf_split_id,pdf_split_index) values($1,$2,$3,$4,'application/pdf',$5,$6,$7,'received',$8,$9,$10,$11)",[file.id,actor.workspaceId,parserId,childName,part.bytes.length,childSha,file.key,part.source.pageCount,JSON.stringify(part.source.pages),splitId,index]);
    await c.query('insert into jobs(id,workspace_id,document_id,schema_version_id,config,waiting_for_schema) values($1,$2,$3,$4,$5,false)',[jobId,actor.workspaceId,file.id,parser.active_schema_id,jobConfig]);
    await c.query("update documents set status='queued',updated_at=clock_timestamp() where id=$1",[file.id]);
    await c.query("insert into usage_ledger(workspace_id,document_id,event,pages,idempotency_key) values($1,$2,'upload',$3,$4)",[actor.workspaceId,file.id,part.source.pageCount,`upload:${file.id}`]);
    await audit(c,actor.workspaceId,actor.userId,'document.uploaded',file.id,{parserId,pages:part.source.pageCount,splitId,index});
   }
   await audit(c,actor.workspaceId,actor.userId,'document.split',splitId,{parserId,sourcePages:decoded.sourcePageCount,selectedPages:decoded.selectedPages,children:decoded.parts.length});
   await completeDirect(c,splitId);
   await c.query('delete from intake_files where workspace_id=$1 and split_attempt_id=$2',[actor.workspaceId,attemptId]);
   const result=await readPdfSplitReceipt(c,actor.workspaceId,splitId,false);check();return result;
  });}catch(error){return await saveRejection(error);}
 }finally{
  clearTimeout(timer);if(heartbeat)clearInterval(heartbeat);
  if(files.length){
   // Query committed references even after an uncertain COMMIT acknowledgement.
   // If this query cannot run, leave durable intents for reconciliation.
   try{
    await withWorkspace(actor.workspaceId,async c=>{
     await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[actor.workspaceId]);
     await c.query('select id from intake_files where split_attempt_id=$1 and workspace_id=$2 order by id for update',[attemptId,actor.workspaceId]);
     for(const file of files){
      const referenced=(await c.query('select 1 from documents where workspace_id=$1 and storage_key=$2 union all select 1 from pdf_splits where workspace_id=$1 and source_storage_key=$2 limit 1',[actor.workspaceId,file.key])).rowCount;
      if(!referenced&&file.attempted){
       const delay=file.completed?0:300;
       await c.query("insert into file_deletions(workspace_id,storage_key,available_at) values($1,$2,now()+($3::int*interval '1 second')) on conflict(storage_key) do nothing",[actor.workspaceId,file.key,delay]);
       // Failed/uncertain objects still consume temporary storage. Release the
       // active-attempt slot, but only confirmed removal releases their bytes.
       await c.query('update intake_files set lease_expires_at=least(lease_expires_at,now()) where id=$1 and workspace_id=$2 and split_attempt_id=$3',[file.id,actor.workspaceId,attemptId]);
      }else await c.query('delete from intake_files where id=$1 and workspace_id=$2 and split_attempt_id=$3',[file.id,actor.workspaceId,attemptId]);
     }
    });
   }catch{/* The original outcome wins; durable intents preserve cleanup on recovery. */}
  }
 }
}
