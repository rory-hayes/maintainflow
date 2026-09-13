import {randomUUID} from 'node:crypto';
import {readStoredObject} from './storage.js';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {adminPool,appPool,transaction,withWorkspace} from './db.js';
import {config} from './config.js';
import {lockParserForDocument} from './parser-setup.js';
import {extractRules} from './extraction.js';
import {hasWorkspaceExtractionCapacity,processOneSchemaSuggestion,setSchemaSuggestionProvider} from './schema-suggestions.js';
import {reconcileInterruptedIntake} from './object-reconciliation.js';
import {purgeDocument,deleteStoredFile,processOneFileDeletion} from './retention.js';
import type {ExtractionProvider,ExtractionResult} from '../../shared/types.js';
let provider:ExtractionProvider|undefined;
export function setExtractionProvider(value:ExtractionProvider|undefined){provider=value;}
export function aiConfigured(){return provider?.configured()===true;}
const providerDeadlineMs=90_000;
interface JobOptions {signal?:AbortSignal;providerTimeoutMs?:number;}

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
  if(job?.state==='failed')await c.query("update documents d set status='failed',error=$2,updated_at=now() where d.id=$1 and d.status='processing' and not exists(select 1 from jobs active where active.document_id=d.id and active.state in('queued','processing'))",[job.document_id,job.error]);
 });
}

export async function processOneCoreJob(onlyJobId?:string,options:JobOptions={}){
// Each claim needs its own fence, including overlapping invocations in a warm function.
const owner=randomUUID();
// The optional shorter deadline is an internal controlled-test seam, never an API parameter.
if(options.providerTimeoutMs!==undefined&&(!Number.isFinite(options.providerTimeoutMs)||options.providerTimeoutMs<=0||options.providerTimeoutMs>providerDeadlineMs))throw new Error('Provider deadline must be positive and at most 90 seconds');
if(options.signal?.aborted)return false;
await recoverExpiredCoreJobs(onlyJobId);
if(options.signal?.aborted)return false;
const job=await transaction(adminPool,async c=>{
const {rows}=await c.query("select j.* from jobs j join workspaces w on w.id=j.workspace_id where j.state='queued' and not j.waiting_for_schema and j.available_at<=now() and ($1::uuid is not null or not exists(select 1 from schema_suggestions earlier where earlier.workspace_id=j.workspace_id and earlier.state='queued' and earlier.available_at<=now() and earlier.created_at<j.created_at)) and ($1::uuid is null or j.id=$1) and ((select count(*) from jobs running where running.workspace_id=j.workspace_id and running.state='processing')+(select count(*) from schema_suggestions s where s.workspace_id=j.workspace_id and s.state='processing')) < coalesce((w.plan->>'maxConcurrent')::int,2) order by j.created_at for update of j,w skip locked limit 1",[onlyJobId||null]);if(!rows[0])return null;const selected=rows[0];/* Never wait for an intake/setup/delete lock while holding the claimed job. */if(!(await c.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) acquired',[selected.workspace_id])).rows[0].acquired)return null;if(!await hasWorkspaceExtractionCapacity(c,selected.workspace_id))return null;await c.query("update jobs set state='processing',attempts=attempts+1,lease_owner=$2,lease_until=now()+interval '120 seconds',updated_at=now() where id=$1",[selected.id,owner]);await c.query("update documents set status='processing',error=null,updated_at=now() where id=$1",[selected.document_id]);return {...selected,attempts:selected.attempts+1};});
if(!job)return false;
try{
const attempt=await extractWithDeadline(async signal=>{
 const data=await withWorkspace(job.workspace_id,async c=>{const doc=(await c.query('select * from documents where id=$1',[job.document_id])).rows[0];const schema=(await c.query('select schema from schema_versions where id=$1',[job.schema_version_id])).rows[0]?.schema;return {doc,schema};});
 if(!data.doc)return undefined;signal.throwIfAborted();
 let result:ExtractionResult;
 if(job.config.mode==='ai'){
  const activeProvider=provider;if(!activeProvider?.configured())throw Object.assign(new Error('AI extraction is not configured. Configure the server provider or choose text-anchor rules.'),{permanent:true});
  const bytes=await readStoredObject(data.doc.storage_key);signal.throwIfAborted();
  result=await activeProvider.extract({bytes,mimeType:data.doc.mime_type,pages:data.doc.source_text,schema:data.schema,instructions:job.config.instructions,locale:job.config.locale,signal});
 }else{
  if(!data.doc.source_text.some((p:any)=>p.text.trim()))throw Object.assign(new Error('This document has no readable text. Scans and images require a configured OCR/AI provider.'),{permanent:true});
  result=extractRules(data.doc.source_text,data.schema,job.config.locale,job.config.templates||[]);
 }
 signal.throwIfAborted();return {data,result};
},options);
if(!attempt)return true;const {data,result}=attempt;
await withWorkspace(job.workspace_id,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[job.workspace_id]);const lock=(await c.query('select * from jobs where id=$1 and lease_owner=$2 and state=$3 for update',[job.id,owner,'processing'])).rows[0];if(!lock)return;const {rows:[run]}=await c.query('insert into extraction_runs(workspace_id,document_id,schema_version_id,job_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues,token_usage,cost_usd) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id',[job.workspace_id,job.document_id,job.schema_version_id,job.id,result.engine,result.model,result.promptVersion??'folio-extraction-v1',data.doc.sha256,JSON.stringify(result.rawValues),JSON.stringify(result.normalizedValues),JSON.stringify(result.evidence),JSON.stringify(result.issues),JSON.stringify(result.tokenUsage??{}),result.costUsd??0]);await c.query("update documents set latest_run_id=$2,status='needs_review',error=null,updated_at=now() where id=$1",[job.document_id,run.id]);await c.query("update jobs set state='completed',lease_until=null,lease_owner=null,updated_at=now() where id=$1",[job.id]);});
}catch(e){const permanent=(e as any).permanent||job.attempts>=job.max_attempts;const message=e instanceof Error?e.message.slice(0,500):'Processing failed';await withWorkspace(job.workspace_id,async c=>{await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[job.workspace_id]);const changed=await c.query("update jobs set state=$3,error=$4,available_at=now()+($5 * interval '1 second'),lease_owner=null,lease_until=null,updated_at=now() where id=$1 and lease_owner=$2 and state='processing' returning id",[job.id,owner,permanent?'failed':'queued',message,Math.min(60,2**job.attempts)]);if(changed.rowCount)await c.query('update documents set status=$2,error=$3,updated_at=now() where id=$1',[job.document_id,permanent?'failed':'queued',message]);});}
return true;
}
export async function enforceRetention(onlyWorkspaceId?:string,options:{signal?:AbortSignal;limit?:number}={}){
 const limit=Math.max(1,Math.min(100,Math.floor(options.limit??100)));
 if(options.signal?.aborted)return {removed:0};
 const {rows}=await adminPool.query("select d.id,d.workspace_id from documents d join workspaces w on w.id=d.workspace_id where ($1::uuid is null or d.workspace_id=$1) and d.created_at < now()-((w.settings->>'retentionDays')::integer*interval '1 day') and not exists(select 1 from jobs j where j.document_id=d.id and j.state in('queued','processing')) and not exists(select 1 from schema_suggestions s where s.document_id=d.id and s.state in('queued','processing')) order by d.created_at,d.id limit $2",[onlyWorkspaceId||null,limit]);
 let removed=0;
 for(const candidate of rows){
  if(options.signal?.aborted)break;
  const document=await withWorkspace(candidate.workspace_id,async c=>{
   // Recheck under the same workspace/parser/document ordering as intake and setup.
   await lockParserForDocument(c,candidate.workspace_id,candidate.id);
   await c.query('select id from documents where id=$1 for update',[candidate.id]);
   const eligible=await c.query("select d.id from documents d join workspaces w on w.id=d.workspace_id where d.id=$1 and d.created_at < now()-((w.settings->>'retentionDays')::integer*interval '1 day') and not exists(select 1 from jobs j where j.document_id=d.id and j.state in('queued','processing')) and not exists(select 1 from schema_suggestions s where s.document_id=d.id and s.state in('queued','processing'))",[candidate.id]);
   return eligible.rowCount?purgeDocument(c,candidate.workspace_id,candidate.id):undefined;
  });
  if(document){await deleteStoredFile(candidate.workspace_id,document.storage_key);removed++;}
 }
 return {removed};
}
export async function startWorker(tick?:()=>Promise<unknown>){
  const shutdown=new AbortController();
  const stop=()=>shutdown.abort();
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  let cycles=0;
  console.log('Folio durable worker started');
  try{
    while(!shutdown.signal.aborted){
      try{
        const worked=await processOneCoreJob(undefined,{signal:shutdown.signal});
        const suggested=await processOneSchemaSuggestion(undefined,{signal:shutdown.signal});
        if(shutdown.signal.aborted)break;
        await processOneFileDeletion();
        if(tick)await tick();
        if(++cycles%120===0){await enforceRetention();await reconcileInterruptedIntake();}
        if(!worked&&!suggested)await new Promise(r=>setTimeout(r,1000));
      }catch(e){
        console.error('Worker tick failed:',e instanceof Error?e.message:'unknown error');
        if(!shutdown.signal.aborted)await new Promise(r=>setTimeout(r,2000));
      }
    }
  }finally{
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
    await Promise.all([adminPool.end(),appPool.end()]);
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {createOpenAIProvider}=await import('./openai-provider.js');
  setExtractionProvider(createOpenAIProvider());
  const {createOpenAISchemaSuggestionProvider}=await import('./openai-schema-suggestions.js');
  setSchemaSuggestionProvider(createOpenAISchemaSuggestionProvider());
  await startWorker();
}
