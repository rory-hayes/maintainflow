/** Owned disposable database and in-memory storage/provider only; no external requests. */
import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../server/app.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import type {Evidence,ExtractionResult} from '../shared/types.js';
import {assertBankFixtureDatabase,bankRawFixture,cleanupBankFixtures,createBankFixture} from './bank-statement-fixtures.js';

const objects=new Map<string,Buffer>(),originalFetch=globalThis.fetch;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
let app:Awaited<ReturnType<typeof buildApp>>,verified=false,networkCalls=0;
const retryHint='Worker lease expired; retry scheduled';
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
function result():ExtractionResult{
 const raw=bankRawFixture(),evidence:Record<string,Evidence[]>={};
 raw.accounts.forEach((account,index)=>{
  for(const [field,value] of Object.entries(account))if(typeof value==='string')evidence[`accounts[${index}].${field}`]=[{page:1,text:value,source:'matched-text'}];
  account.transactions.forEach((row,position)=>{for(const [field,value] of Object.entries(row))if(value!==null)evidence[`accounts[${index}].transactions[${position}].${field}`]=[{page:1,text:value,source:'matched-text'}];});
 });
 return {rawValues:raw as unknown as Record<string,unknown>,normalizedValues:{},evidence,issues:[],engine:'controlled-core-retry-lifecycle',model:'synthetic'};
}
const rows=async(sql:string,args:unknown[])=>(await adminPool.query(sql,args)).rows;
const events=(workspaceId:string,documentId:string)=>rows('select * from document_events where workspace_id=$1 and document_id=$2 order by sequence',[workspaceId,documentId]);
const usage=(workspaceId:string)=>rows('select * from usage_ledger where workspace_id=$1 order by id',[workspaceId]);
async function job(id:string){return (await rows('select * from jobs where id=$1',[id]))[0];}
async function document(id:string){return (await rows('select * from documents where id=$1',[id]))[0];}
async function oldHistory(documentId:string,jobId:string){
 return {
  runs:await rows('select * from extraction_runs where document_id=$1 order by id',[documentId]),
  corrections:await rows('select c.* from corrections c join extraction_runs r on r.id=c.run_id where r.document_id=$1 order by c.id',[documentId]),
  approvals:await rows('select a.* from approvals a join extraction_runs r on r.id=a.run_id where r.document_id=$1 order by a.id',[documentId]),
  jobs:await rows('select * from jobs where document_id=$1 and id<>$2 order by id',[documentId,jobId]),
 };
}
async function reviewedFixture(){
 const f=await createBankFixture(app);
 await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxConcurrent}','1'::jsonb) where id=$1",[f.actor.workspaceId]);
 const source=await f.upload(),values=structuredClone(source.run.bankValues);
 values.accounts[0].transactions[0].description='Synthetic saved correction before retry';
 const corrected=await f.request('POST',`/api/runs/${source.run.id}/corrections`,{values,expectedRevision:source.run.effectiveRevision});assert.equal(corrected.statusCode,200,corrected.body);
 const approved=await f.approve(corrected.json().run);assert.equal(approved.statusCode,200,approved.body);
 const reprocess=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(reprocess.statusCode,200,reprocess.body);
 return {f,source,approval:approved.json().approval,retryJobId:reprocess.json().job.id};
}
async function blockedRecovery(display:'processing'|'needs_review'|'processed'|'exported'){
 const item=await reviewedFixture(),{f,source,retryJobId}=item,blocker=await f.queue('separate-capacity-blocker');
 const entered=deferred(),release=deferred();let providerCalls=0;
 setExtractionProvider({configured:()=>true,async extract(){if(++providerCalls===1){entered.resolve();await release.promise;}return result();}});
 const blocking=processOneCoreJob(blocker.jobId);
 try{
  await Promise.race([entered.promise,blocking.then(()=>{throw new Error('The separate capacity blocker did not enter its controlled provider.');})]);
  const seeded=await adminPool.query("update jobs set state='processing',attempts=1,lease_owner='synthetic-expired-retry-worker',lease_until=now()-interval '1 second' where id=$1 and workspace_id=$2",[retryJobId,f.actor.workspaceId]);assert.equal(seeded.rowCount,1);
  await adminPool.query('update documents set status=$2,error=$3 where id=$1',[source.document.id,display,'Synthetic display hint to preserve unless still processing']);
  const beforeDoc=await document(source.document.id),beforeEvents=await events(f.actor.workspaceId,source.document.id),beforeUsage=await usage(f.actor.workspaceId),history=await oldHistory(source.document.id,retryJobId);
  assert.equal(history.runs.length,1);assert.equal(history.corrections.length,1);assert.equal(history.approvals.length,1);assert.equal(history.jobs.length,1);
  assert.equal((await job(blocker.jobId)).state,'processing');
  assert.equal(await processOneCoreJob(retryJobId),false,'The separate document consumes this workspace’s only processing slot.');
  const recovered=await job(retryJobId),afterDoc=await document(source.document.id),afterEvents=await events(f.actor.workspaceId,source.document.id);
  assert.equal(recovered.state,'queued');assert.equal(recovered.attempts,1);assert.equal(recovered.error,retryHint);assert.equal(recovered.lease_owner,null);assert.equal(recovered.lease_until,null);assert.equal(providerCalls,1);
  assert.deepEqual(afterEvents.slice(0,beforeEvents.length),beforeEvents);
  if(display==='processing'){
   assert.equal(afterDoc.status,'queued');assert.equal(afterDoc.error,retryHint);assert.equal(afterDoc.latest_run_id,beforeDoc.latest_run_id);assert.equal(afterDoc.approved_run_id,beforeDoc.approved_run_id);
   assert.equal(afterEvents.length,beforeEvents.length+1);const event=afterEvents.at(-1)!;assert.equal(event.phase,'processing');assert.equal(event.state,'queued');assert.equal(event.operation_id,retryJobId);
  }else{
   assert.deepEqual(afterDoc,beforeDoc,'Recovery must not change a nonprocessing reviewed display or its error/timestamp.');assert.deepEqual(afterEvents,beforeEvents);
  }
  assert.deepEqual(await oldHistory(source.document.id,retryJobId),history);assert.deepEqual(await usage(f.actor.workspaceId),beforeUsage);
  assert.equal(await processOneCoreJob(retryJobId),false);assert.deepEqual(await job(retryJobId),recovered);assert.deepEqual(await document(source.document.id),afterDoc);assert.deepEqual(await events(f.actor.workspaceId,source.document.id),afterEvents);assert.equal(providerCalls,1);assert.deepEqual(await usage(f.actor.workspaceId),beforeUsage);
  release.resolve();assert.equal(await blocking,true);
  assert.equal(await processOneCoreJob(retryJobId),true);assert.equal(providerCalls,2);
  const completed=await job(retryJobId),final=await document(source.document.id),finalEvents=await events(f.actor.workspaceId,source.document.id),newEvents=finalEvents.slice(afterEvents.length);
  assert.equal(completed.state,'completed');assert.equal(completed.attempts,2);assert.equal(completed.lease_owner,null);assert.equal(completed.lease_until,null);assert.equal(final.status,'needs_review');assert.equal(final.error,null);assert.equal(final.approved_run_id,item.approval.runId);assert.notEqual(final.latest_run_id,beforeDoc.latest_run_id);
  assert.deepEqual(newEvents.map(event=>[event.phase,event.state,event.operation_id]),[['processing','processing',retryJobId],['processing','needs_review',retryJobId]]);assert.deepEqual(finalEvents.slice(0,afterEvents.length),afterEvents);
  const [newRun]=await rows('select * from extraction_runs where job_id=$1',[retryJobId]);assert.equal(newRun.id,final.latest_run_id);assert.deepEqual(newRun.raw_values,bankRawFixture());assert.deepEqual(newRun.normalized_values.accounts[0].transactions.map((row:any)=>[row.debit,row.credit,row.balance]),[['20.00',null,'980.00'],[null,'50.00','1030.00']]);
  const current=await oldHistory(source.document.id,retryJobId);assert.deepEqual(current.runs.filter(row=>row.id!==newRun.id),history.runs);assert.deepEqual(current.corrections,history.corrections);assert.deepEqual(current.approvals,history.approvals);assert.deepEqual(current.jobs,history.jobs);assert.deepEqual(await usage(f.actor.workspaceId),beforeUsage);
  assert.equal(await processOneCoreJob(retryJobId),false);assert.deepEqual(await events(f.actor.workspaceId,source.document.id),finalEvents);assert.equal(providerCalls,2);assert.equal(networkCalls,0);
 }finally{release.resolve();await blocking;}
}
before(async()=>{await assertBankFixtureDatabase();verified=true;globalThis.fetch=async()=>{networkCalls++;throw new Error('External calls forbidden in retry lifecycle fixtures');};setStorageForTests(storage);app=await buildApp();});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{await app?.close();if(verified)await cleanupBankFixtures();setStorageForTests(undefined);globalThis.fetch=originalFetch;await closeDatabase();});

test('expired processing recovery journals one queued state under blocked capacity and the exact next claim without changing history or usage',{timeout:30_000},async()=>{
 await blockedRecovery('processing');
});

test('expired job recovery preserves nonprocessing reviewed displays until the next actual claim',{timeout:60_000},async()=>{
 for(const display of ['needs_review','processed','exported'] as const)await blockedRecovery(display);
});
