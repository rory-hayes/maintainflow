import {isDeepStrictEqual} from 'node:util';
import {bankStatementWorkflow,bankStatementSchema} from '../../shared/bank-statement-preset.js';
import {bankPdfLayoutVersion,serializeBankPdfLayout,type BankPdfLayoutInput,type BankPdfLayoutProvenance} from '../../shared/bank-pdf-layout.js';
import {PdfGeometryError,pdfRegionLimits} from '../../shared/pdf-regions.js';
import {createBankStatementResult} from './bank-statement-domain.js';
import {indexBankStatement} from './bank-statement-service.js';
import {createHash,randomUUID} from 'node:crypto';
import {readStoredObject} from './storage.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {adminPool,appPool,transaction,withWorkspace} from './db.js';
import {config} from './config.js';
import {assertStorageRestoreReady} from './restore-state.js';
import {prepareVisualDocument,visualRenderingMetadata} from './visual-source.js';
import {lockParserForDocument,runnableAiWorkSql} from './parser-setup.js';
import type {NormalizationContext} from './timestamps.js';
import {resolveJobNormalizationPolicy,assertJobSourceFormats} from '../../shared/source-formats.js';
import {extractRules} from './extraction.js';
import {selectTemplateExtraction} from './template-selection.js';
import {needsPdfGeometry,selectCurrentTemplateExtraction} from './template-region-selection.js';
import {readPdfGeometry,type DecoderOptions} from './source.js';
import {templatePolicy,regionTemplatePolicy,type TemplateSelection} from '../../shared/template-selection.js';
import {hasWorkspaceExtractionCapacity,processOneSchemaSuggestion,setSchemaSuggestionProvider} from './schema-suggestions.js';
import {processOneSplitSuggestion,reconcileExpiredSplitSuggestions,setSplitSuggestionProvider} from './split-suggestions.js';
import {reconcileInterruptedIntake} from './object-reconciliation.js';
import {purgeDocument,deleteStoredFiles,processOneFileDeletion} from './retention.js';
import type {ExtractionProvider,ExtractionResult} from '../../shared/types.js';
let provider:ExtractionProvider|undefined;
export function setExtractionProvider(value:ExtractionProvider|undefined){provider=value;}
export function aiConfigured(){return provider?.configured()===true;}
const providerDeadlineMs=90_000;
interface JobOptions {signal?:AbortSignal;providerTimeoutMs?:number;pdfGeometryOptions?:Pick<DecoderOptions,'spawnChild'|'timeoutMs'>;}

async function extractWithDeadline<T>(work:(signal:AbortSignal)=>Promise<T>,options:JobOptions):Promise<T>{
  const timeoutMs=options.providerTimeoutMs??providerDeadlineMs;
  const controller=new AbortController();
  let timeout:ReturnType<typeof setTimeout>|undefined;
  let rejectPending!:(reason:Error)=>void;
  const interrupted=new Promise<never>((_,reject)=>{rejectPending=reject;});
  const abort=()=>{
    rejectPending(new Error('Extraction interrupted by worker shutdown; retry scheduled'));
    controller.abort();
  };
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)abort();
  else timeout=setTimeout(()=>{
    rejectPending(new Error('Extraction provider exceeded the 90-second timeout'));
    controller.abort();
  },timeoutMs);
  try{
    // The rejected race prevents an uncooperative or late provider from saving a run.
    const extraction=controller.signal.aborted?interrupted:work(controller.signal);
    return await Promise.race([extraction,interrupted]);
  }finally{
    if(timeout)clearTimeout(timeout);
    options.signal?.removeEventListener('abort',abort);
  }
}

/** Recover interrupted extraction under the same lock used by deletion and setup. */
async function recoverExpiredCoreJobs(onlyJobId?:string){
 const candidates=(await adminPool.query("select id,workspace_id,document_id from jobs where state='processing' and lease_until<now() and ($1::uuid is null or id=$1) order by lease_until,id limit 20",[onlyJobId??null])).rows;
 for(const candidate of candidates)await transaction(adminPool,async c=>{
  await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[candidate.workspace_id]);
  const {rows:[job]}=await c.query("update jobs set state=case when attempts>=max_attempts then 'failed' else 'queued' end,lease_owner=null,lease_until=null,error='Worker lease expired; retry scheduled',updated_at=now() where id=$1 and state='processing' and lease_until<now() returning *",[candidate.id]);
  // Reviewing the previous successful run can change the document's display
  // status during extraction. The fenced terminal job still owns this failure.
  if(job?.state==='failed')await c.query("update documents d set status='failed',error=$2,updated_at=now() where d.id=$1 and not exists(select 1 from jobs active where active.document_id=d.id and active.state in('queued','processing'))",[job.document_id,job.error]);
 });
}

export async function processOneCoreJob(onlyJobId?:string,options:JobOptions={}){
await assertStorageRestoreReady(config.storageDir,process.env.STORAGE_DRIVER||'filesystem');
// Each claim needs its own fence, including overlapping invocations in a warm function.
const owner=randomUUID();
// The optional shorter deadline is an internal controlled-test seam, never an API parameter.
if(options.providerTimeoutMs!==undefined&&(!Number.isFinite(options.providerTimeoutMs)||options.providerTimeoutMs<=0||options.providerTimeoutMs>providerDeadlineMs))throw new Error('Provider deadline must be positive and at most 90 seconds');
if(options.signal?.aborted)return false;
await recoverExpiredCoreJobs(onlyJobId);
if(options.signal?.aborted)return false;
const job=await transaction(adminPool,async c=>{
const {rows}=await c.query(`select j.* from jobs j join workspaces w on w.id=j.workspace_id
 where j.state='queued' and not j.waiting_for_schema and j.available_at<=now() and j.attempts<j.max_attempts
 and ($1::uuid is not null or not exists(select 1 from (${runnableAiWorkSql}) earlier where earlier.workspace_id=j.workspace_id and (earlier.created_at,earlier.id,earlier.lane)<(j.created_at,j.id,0)))
 and ($1::uuid is null or j.id=$1)
 and ((select count(*) from jobs running where running.workspace_id=j.workspace_id and running.state='processing')+(select count(*) from schema_suggestions s where s.workspace_id=j.workspace_id and s.state='processing')+(select count(*) from split_suggestions s where s.workspace_id=j.workspace_id and s.state='processing'))<coalesce((w.plan->>'maxConcurrent')::int,2)
 order by j.created_at,j.id for update of j,w skip locked limit 1`,[onlyJobId||null]);
if(!rows[0])return null;
const selected=rows[0];
// Never wait for an intake/setup/delete lock while holding the claimed job.
if(!(await c.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[selected.workspace_id])).rows[0].acquired)return null;
if(!await hasWorkspaceExtractionCapacity(c,selected.workspace_id,onlyJobId?undefined:{id:selected.id,createdAt:selected.created_at,lane:0})||options.signal?.aborted)return null;
await c.query("update jobs set state='processing',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '120 seconds',updated_at=now() where id=$1",[selected.id,owner]);
await c.query("update documents set status='processing',error=null,updated_at=now() where id=$1",[selected.document_id]);
return {...selected,attempts:selected.attempts+1};});
if(!job)return false;
try{
const attempt=await extractWithDeadline(async signal=>{
 const data=await withWorkspace(job.workspace_id,async c=>{const doc=(await c.query('select * from documents where id=$1',[job.document_id])).rows[0];const schema=(await c.query('select schema from schema_versions where id=$1',[job.schema_version_id])).rows[0]?.schema;return {doc,schema};});
 if(!data.doc)return undefined;signal.throwIfAborted();
 let result:ExtractionResult;
 let selection:TemplateSelection|null=null;
 const policy=job.config.templatePolicy;
 const bank=job.config.useCase==='bank_statement';
 if(Object.hasOwn(job.config,'bankPdfLayoutVersion')&&(!bank||job.config.bankPdfLayoutVersion!==bankPdfLayoutVersion))throw Object.assign(new Error('This job uses an unsupported bank PDF input version. Reprocess with current saved settings.'),{permanent:true});
 if(job.config.bankWorkflow!=null&&job.config.bankWorkflow!==bankStatementWorkflow||bank&&job.config.bankWorkflow!==bankStatementWorkflow||job.config.bankWorkflow===bankStatementWorkflow&&!bank)throw Object.assign(new Error('This job uses an unsupported bank statement workflow. Reprocess with current saved settings.'),{permanent:true});
 if(bank&&(job.config.mode!=='ai'||!isDeepStrictEqual(data.schema,bankStatementSchema)))throw Object.assign(new Error('This bank statement job has incompatible extraction settings. Reprocess with the bank statement workflow.'),{permanent:true});
 const valuePolicy=resolveJobNormalizationPolicy(job.config.normalizationPolicy);assertJobSourceFormats(data.schema,valuePolicy);
 if(policy!=null&&policy!==templatePolicy&&policy!==regionTemplatePolicy)throw Object.assign(new Error('This job uses an unsupported template version. Reprocess the document with current saved settings.'),{permanent:true});
 let sourceBytes:Buffer|undefined,geometry:Awaited<ReturnType<typeof readPdfGeometry>>|undefined;
 let bankPdfLayout:BankPdfLayoutInput|undefined,bankPdfLayoutInput:(BankPdfLayoutProvenance&{sourceByteSize:number;pageCountVerification:'geometry'|'intake_source_hash'})|undefined;
 if(bank&&job.config.bankPdfLayoutVersion===bankPdfLayoutVersion&&data.doc.mime_type==='application/pdf'){
  sourceBytes=await readStoredObject(data.doc.storage_key);signal.throwIfAborted();
  const sourceSha256=createHash('sha256').update(sourceBytes).digest('hex'),pageCount=data.doc.page_count,byteSize=Number(data.doc.byte_size);
  if(!sourceBytes.length||!Number.isSafeInteger(byteSize)||byteSize!==sourceBytes.length||byteSize>pdfRegionLimits.maxBytes||!sourceBytes.subarray(0,5).equals(Buffer.from('%PDF-'))||sourceSha256!==data.doc.sha256||!Number.isInteger(pageCount)||pageCount<1||pageCount>pdfRegionLimits.maxPages||!Array.isArray(data.doc.source_text)||data.doc.source_text.length!==pageCount||data.doc.source_text.some((page:any,index:number)=>!page||page.page!==index+1||typeof page.text!=='string'))throw Object.assign(new Error('The original bank PDF no longer matches its verified intake. Reprocess a verified source.'),{permanent:true});
  try{
   geometry=await readPdfGeometry(sourceBytes,{...options.pdfGeometryOptions,signal});signal.throwIfAborted();
   if(geometry.sourceSha256!==sourceSha256||geometry.pageCount!==pageCount)throw Object.assign(new Error('The original bank PDF page count or source identity changed. Reprocess a verified source.'),{permanent:true});
   bankPdfLayout={version:bankPdfLayoutVersion,geometry};
  }catch(error){
   signal.throwIfAborted();
   // Only this stricter geometry limit may retain the already verified intake.
   // Operational failures and malformed geometry never become visual fallbacks.
   if(!(error instanceof PdfGeometryError)||error.reason!=='geometry_limit')throw error;
   bankPdfLayout={version:bankPdfLayoutVersion,unavailableReason:'geometry_limit',sourceSha256,pageCount};
  }
  bankPdfLayoutInput={...serializeBankPdfLayout(bankPdfLayout,{sourceSha256,pageCount}).provenance,sourceByteSize:byteSize,pageCountVerification:geometry?'geometry':'intake_source_hash'};
 }
 if(policy===regionTemplatePolicy&&needsPdfGeometry(job.config.templates??[])&&data.doc.mime_type==='application/pdf'){
  sourceBytes=await readStoredObject(data.doc.storage_key);signal.throwIfAborted();
  geometry=await readPdfGeometry(sourceBytes,{signal});signal.throwIfAborted();
  if(geometry.sourceSha256!==data.doc.sha256||geometry.pageCount!==data.doc.page_count||sourceBytes.length!==Number(data.doc.byte_size))throw Object.assign(new Error('The original PDF changed and its template regions could not be verified. Reprocess a verified source.'),{permanent:true});
 }
 const decision=bank?undefined:policy===templatePolicy
  ?selectTemplateExtraction(data.doc.source_text,data.schema,job.config.locale,job.config.templates??[],job.config.mode,job.config.timezone,valuePolicy)
  :policy===regionTemplatePolicy?selectCurrentTemplateExtraction(data.doc.source_text,data.schema,job.config.locale,job.config.templates??[],job.config.mode,geometry,job.config.timezone,valuePolicy):undefined;
 if(decision)selection=decision.selection;
 if(decision?.selection.outcome==='failed'){
  const messages={no_readable_text:'This document has no readable text. Scans and images require a configured OCR/AI provider.',limit:'Template checking exceeded a supported limit. Reduce the templates or document size, or enable AI extraction, then reprocess.',no_match:'No saved template fully matches this document. Check the template anchors and required fields, or enable AI extraction, then reprocess.'};
  throw Object.assign(new Error(messages[decision.selection.reason as keyof typeof messages]??messages.no_match),{permanent:true});
 }
 if(decision?.result)result=decision.result;
 else if(job.config.mode==='ai'){
  const activeProvider=provider;if(!activeProvider?.configured())throw Object.assign(new Error(bank?'Bank statement extraction is unavailable because the AI provider is not configured. Ask your administrator to enable it, then retry the statement.':'AI extraction is not configured. Configure the server provider or choose text-anchor rules.'),{permanent:true});
  const bytes=sourceBytes??await readStoredObject(data.doc.storage_key);signal.throwIfAborted();
  const input={bytes,mimeType:data.doc.mime_type,pages:data.doc.source_text,schema:data.schema,instructions:job.config.instructions,locale:job.config.locale,timezone:job.config.timezone,normalizationPolicy:valuePolicy,signal,...(bankPdfLayout?{bankPdfLayout}:{})};
  const visualDocument=await prepareVisualDocument(input,{signal,expectedSha256:data.doc.sha256});signal.throwIfAborted();
  result=await activeProvider.extract({...input,...(visualDocument?{visualDocument}:{})});
  if(visualDocument)result={...result,tokenUsage:{...(result.tokenUsage&&typeof result.tokenUsage==='object'&&!Array.isArray(result.tokenUsage)?result.tokenUsage:{}),sourceRendering:visualRenderingMetadata(visualDocument)}};
  if(bankPdfLayoutInput)result={...result,tokenUsage:{...(result.tokenUsage&&typeof result.tokenUsage==='object'&&!Array.isArray(result.tokenUsage)?result.tokenUsage:{}),bankPdfLayoutInput}};
 }else{
  if(!data.doc.source_text.some((p:any)=>p.text.trim()))throw Object.assign(new Error('This document has no readable text. Scans and images require a configured OCR/AI provider.'),{permanent:true});
  result=extractRules(data.doc.source_text,data.schema,job.config.locale,decision?[]:job.config.templates||[],job.config.timezone,valuePolicy);
 }
 let bankContext=null;
 if(bank){try{const statement=createBankStatementResult(result.rawValues,result.evidence,job.config.locale);bankContext=statement.context;result={...result,normalizedValues:statement.values as unknown as Record<string,unknown>,issues:[...result.issues,...statement.issues.map(issue=>({field:issue.field??issue.transactionId??issue.accountId??'accounts',code:issue.code,message:issue.message}))]};}catch(error){throw Object.assign(error instanceof Error?error:new Error('Bank statement extraction is invalid'),{permanent:true});}}
 signal.throwIfAborted();return {data,result,selection,bankContext,valuePolicy,sourceVerified:Boolean(geometry||bankPdfLayoutInput),templateSnapshot:decision?.result?.templateSnapshot??null};
},options);
if(!attempt)return true;const {data,result,selection,bankContext,valuePolicy,sourceVerified,templateSnapshot}=attempt;
const normalizationContext:NormalizationContext={version:valuePolicy,locale:job.config.locale,timezone:job.config.timezone??null,tzdbVersion:process.versions.tz??null};
await withWorkspace(job.workspace_id,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[job.workspace_id]);const lock=(await c.query('select * from jobs where id=$1 and lease_owner=$2 and state=$3 for update',[job.id,owner,'processing'])).rows[0];if(!lock)return;if(sourceVerified){const current=(await c.query('select sha256,storage_key,mime_type,page_count,byte_size from documents where id=$1 for update',[job.document_id])).rows[0];if(!current||current.sha256!==data.doc.sha256||current.storage_key!==data.doc.storage_key||current.mime_type!==data.doc.mime_type||current.page_count!==data.doc.page_count||String(current.byte_size)!==String(data.doc.byte_size))throw Object.assign(new Error('The original PDF changed before its extraction result could be saved. Reprocess a verified source.'),{permanent:true});}const {rows:[run]}=await c.query('insert into extraction_runs(workspace_id,document_id,schema_version_id,job_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues,token_usage,cost_usd,selection,template_snapshot,normalization_context,bank_statement_context) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id',[job.workspace_id,job.document_id,job.schema_version_id,job.id,result.engine,result.model,result.promptVersion??'folio-extraction-v1',data.doc.sha256,JSON.stringify(result.rawValues),JSON.stringify(result.normalizedValues),JSON.stringify(result.evidence),JSON.stringify(result.issues),JSON.stringify(result.tokenUsage??{}),result.costUsd??0,selection?JSON.stringify(selection):null,templateSnapshot?JSON.stringify(templateSnapshot):null,JSON.stringify(normalizationContext),bankContext?JSON.stringify(bankContext):null]);await c.query("update documents set latest_run_id=$2,status='needs_review',error=null,updated_at=now() where id=$1",[job.document_id,run.id]);if(bankContext)await indexBankStatement(c,job.workspace_id,job.document_id,run.id,result.normalizedValues as any);await c.query("update jobs set state='completed',lease_until=null,lease_owner=null,updated_at=now() where id=$1",[job.id]);});
}catch(e){const permanent=(e as any).permanent||job.attempts>=job.max_attempts;const message=e instanceof Error?e.message.slice(0,500):'Processing failed';await withWorkspace(job.workspace_id,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[job.workspace_id]);const changed=await c.query("update jobs set state=$3,error=$4,available_at=now()+($5 * interval '1 second'),lease_owner=null,lease_until=null,updated_at=now() where id=$1 and lease_owner=$2 and state='processing' returning id",[job.id,owner,permanent?'failed':'queued',message,Math.min(60,2**job.attempts)]);if(changed.rowCount)await c.query('update documents set status=$2,error=$3,updated_at=now() where id=$1',[job.document_id,permanent?'failed':'queued',message]);});}
return true;
}
export async function enforceRetention(onlyWorkspaceId?:string,options:{signal?:AbortSignal;limit?:number}={}){
 const limit=Math.max(1,Math.min(100,Math.floor(options.limit??100)));
 if(options.signal?.aborted)return {removed:0};
 const {rows}=await adminPool.query("select d.id,d.workspace_id from documents d join workspaces w on w.id=d.workspace_id where ($1::uuid is null or d.workspace_id=$1) and d.created_at < now()-((w.settings->>'retentionDays')::integer*interval '1 day') and not exists(select 1 from jobs j where j.document_id=d.id and j.state in('queued','processing')) and not exists(select 1 from schema_suggestions s where s.document_id=d.id and s.state in('queued','processing')) and not exists(select 1 from split_suggestions s where s.source_document_id=d.id and s.state in('queued','processing')) order by d.created_at,d.id limit $2",[onlyWorkspaceId||null,limit]);
 let removed=0;
 for(const candidate of rows){
  if(options.signal?.aborted)break;
  const document=await withWorkspace(candidate.workspace_id,async c=>{
   // Recheck under the same workspace/parser/document ordering as intake and setup.
   await lockParserForDocument(c,candidate.workspace_id,candidate.id);
   await c.query('select id from documents where id=$1 for update',[candidate.id]);
   const eligible=await c.query("select d.id from documents d join workspaces w on w.id=d.workspace_id where d.id=$1 and d.created_at < now()-((w.settings->>'retentionDays')::integer*interval '1 day') and not exists(select 1 from jobs j where j.document_id=d.id and j.state in('queued','processing')) and not exists(select 1 from schema_suggestions s where s.document_id=d.id and s.state in('queued','processing')) and not exists(select 1 from split_suggestions s where s.source_document_id=d.id and s.state in('queued','processing'))",[candidate.id]);
   return eligible.rowCount?purgeDocument(c,candidate.workspace_id,candidate.id):undefined;
  });
  if(document){await deleteStoredFiles(candidate.workspace_id,document.storageKeys);removed++;}
 }
 return {removed};
}
export async function startWorker(tick?:()=>Promise<unknown>){
  await assertStorageRestoreReady(config.storageDir,process.env.STORAGE_DRIVER||'filesystem');
  const shutdown=new AbortController();
  const stop=()=>shutdown.abort();
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let cycles=0;
  console.log('Folio durable worker started');
  const {runAccountEmailWorker}=await import('./account-email-worker.js');
  const emailWork=runAccountEmailWorker(shutdown.signal,{onError:()=>console.error('Account email worker failed; durable work remains queued.')});
  try{
    while(!shutdown.signal.aborted){
      try{
        const lanes=['extraction','field suggestion','split suggestion'] as const;
        const work=await Promise.allSettled([
          processOneCoreJob(undefined,{signal:shutdown.signal}),
          processOneSchemaSuggestion(undefined,{signal:shutdown.signal}),
          processOneSplitSuggestion(undefined,{signal:shutdown.signal}),
        ]);
        work.forEach((result,index)=>{if(result.status==='rejected')console.error(`Worker ${lanes[index]} failed; durable work remains queued.`);});
        if(shutdown.signal.aborted)break;
        await processOneFileDeletion();
        if(tick)await tick();
        if(++cycles%120===0){
          const maintenance=await Promise.allSettled([enforceRetention(undefined,{signal:shutdown.signal}),reconcileInterruptedIntake(undefined,{signal:shutdown.signal}),reconcileExpiredSplitSuggestions(undefined,{signal:shutdown.signal})]);
          if(maintenance.some(result=>result.status==='rejected'))console.error('Worker maintenance failed; durable cleanup remains queued.');
        }
        if(!work.some(result=>result.status==='fulfilled'&&result.value))await new Promise(r=>setTimeout(r,1000));
      }catch(e){
        console.error('Worker tick failed:',e instanceof Error?e.message:'unknown error');
        if(!shutdown.signal.aborted)await new Promise(r=>setTimeout(r,2000));
      }
    }
  }finally{
    shutdown.abort();
    await emailWork;
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    await Promise.all([adminPool.end(),appPool.end()]);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {createOpenAIProvider}=await import('./openai-provider.js');
  setExtractionProvider(createOpenAIProvider());
  const {createOpenAISchemaSuggestionProvider}=await import('./openai-schema-suggestions.js');
  setSchemaSuggestionProvider(createOpenAISchemaSuggestionProvider());
  const {createOpenAISplitSuggestionProvider}=await import('./openai-split-suggestions.js');
  setSplitSuggestionProvider(createOpenAISplitSuggestionProvider());
  await startWorker();
}
