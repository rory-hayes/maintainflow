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

test('exhausted lease records a terminal reason and only explicit reprocessing adds a new charged attempt',{timeout:30_000},async()=>{
 const f=await createBankFixture(app),source=await f.queue(),terminalHint='Worker lease expired; automatic retry limit reached. Reprocess the document to try again.';
 let providerCalls=0;setExtractionProvider({configured:()=>true,async extract(){providerCalls++;return result();}});
 await adminPool.query("update jobs set state='processing',attempts=max_attempts,lease_owner='synthetic-exhausted-worker',lease_until=now()-interval '1 second' where id=$1",[source.jobId]);
 await adminPool.query("update documents set status='processing' where id=$1",[source.document.id]);
 const beforeUsage=await usage(f.actor.workspaceId),beforeEvents=await events(f.actor.workspaceId,source.document.id);
 assert.equal(beforeUsage.length,1);assert.equal(beforeUsage[0].event,'upload');
 assert.equal(await processOneCoreJob(source.jobId),false);
 const failed=await job(source.jobId),failedDoc=await document(source.document.id),failedEvents=await events(f.actor.workspaceId,source.document.id);
 assert.equal(failed.state,'failed');assert.equal(failed.attempts,failed.max_attempts);assert.equal(failed.error,terminalHint);assert.equal(failed.lease_owner,null);assert.equal(failed.lease_until,null);
 assert.equal(failedDoc.status,'failed');assert.equal(failedDoc.error,terminalHint);assert.equal(failedDoc.latest_run_id,null);assert.equal(providerCalls,0);
 assert.deepEqual(failedEvents.slice(0,beforeEvents.length),beforeEvents);assert.equal(failedEvents.length,beforeEvents.length+1);assert.equal(failedEvents.at(-1)!.state,'failed');assert.equal(failedEvents.at(-1)!.operation_id,source.jobId);
 assert.deepEqual(await usage(f.actor.workspaceId),beforeUsage);assert.equal((await oldHistory(source.document.id,source.jobId)).runs.length,0);
 assert.equal(await processOneCoreJob(source.jobId),false);assert.deepEqual(await job(source.jobId),failed);assert.deepEqual(await document(source.document.id),failedDoc);assert.deepEqual(await events(f.actor.workspaceId,source.document.id),failedEvents);assert.deepEqual(await usage(f.actor.workspaceId),beforeUsage);
 const manual=await f.request('POST',`/api/documents/${source.document.id}/reprocess`,{});assert.equal(manual.statusCode,200,manual.body);const newJobId=manual.json().job.id;assert.notEqual(newJobId,source.jobId);
 const charged=await usage(f.actor.workspaceId);assert.equal(charged.length,2);assert.deepEqual(charged.filter(row=>row.event==='upload'),beforeUsage);const [charge]=charged.filter(row=>row.event==='reprocess');assert.equal(charge.document_id,source.document.id);assert.equal(charge.pages,beforeUsage[0].pages);
 assert.equal(await processOneCoreJob(newJobId),true);assert.equal(providerCalls,1);assert.equal((await job(newJobId)).state,'completed');assert.deepEqual(await job(source.jobId),failed);assert.deepEqual(await usage(f.actor.workspaceId),charged);
 const completed=await f.detail(source.document.id);assert.equal(completed.document.status,'needs_review');assert.equal(completed.runs.length,1);assert.equal(completed.runs[0].jobId,newJobId);
 const finalEvents=await events(f.actor.workspaceId,source.document.id);assert.deepEqual(finalEvents.slice(0,failedEvents.length),failedEvents);assert.equal(finalEvents.filter(event=>event.state==='failed'&&event.operation_id===source.jobId).length,1);
 assert.equal(await processOneCoreJob(source.jobId),false);assert.equal(await processOneCoreJob(newJobId),false);assert.equal(providerCalls,1);assert.deepEqual(await events(f.actor.workspaceId,source.document.id),finalEvents);assert.deepEqual(await usage(f.actor.workspaceId),charged);
});

test('exhausted retry preserves prior corrected approval and exact CSV snapshots without another page charge',{timeout:30_000},async()=>{
 const {f,source,approval,retryJobId}=await reviewedFixture(),terminalHint='Worker lease expired; automatic retry limit reached. Reprocess the document to try again.';
 const exportInput={documentIds:[source.document.id],format:'csv',workflow:'bank_statement',revisions:[{documentId:source.document.id,approvalId:approval.id}]};
 const created=await f.request('POST','/api/exports',exportInput);assert.equal(created.statusCode,200,created.body);const first=created.json();
 const downloaded=await f.request('GET',first.downloadUrl);assert.equal(downloaded.statusCode,200,downloaded.body);const originalCsv=Buffer.from(downloaded.rawPayload);
 assert.match(originalCsv.toString('utf8'),/Synthetic saved correction before retry/);assert.ok(originalCsv.toString('utf8').includes(approval.id));
 const snapshots=()=>rows('select * from export_snapshots where workspace_id=$1 order by id',[f.actor.workspaceId]);
 const beforeSnapshots=await snapshots();assert.equal(beforeSnapshots.length,1);assert.equal(beforeSnapshots[0].id,first.id);assert.deepEqual(beforeSnapshots[0].bytes,originalCsv);assert.deepEqual(beforeSnapshots[0].records[0].values,approval.values);
 const immutableDocument=(value:any)=>Object.fromEntries(Object.entries(value).filter(([key])=>!['status','error','updated_at'].includes(key)));
 const wholeUsage=async()=>{const response=await f.request('GET','/api/workspace/usage');assert.equal(response.statusCode,200,response.body);return response.json();};
 const original=await f.request('GET',`/api/documents/${source.document.id}/original`);assert.equal(original.statusCode,200,original.body);const originalBytes=Buffer.from(original.rawPayload);
 await adminPool.query("update jobs set state='processing',attempts=max_attempts,lease_owner='synthetic-reviewed-exhausted-worker',lease_until=now()-interval '1 second' where id=$1",[retryJobId]);
 await adminPool.query("update documents set status='processing' where id=$1",[source.document.id]);
 const beforeDoc=await document(source.document.id),beforeHistory=await oldHistory(source.document.id,retryJobId),beforeEvents=await events(f.actor.workspaceId,source.document.id),beforeLedger=await usage(f.actor.workspaceId),beforeUsage=await wholeUsage();
 assert.equal(beforeHistory.runs.length,1);assert.equal(beforeHistory.corrections.length,1);assert.equal(beforeHistory.approvals.length,1);assert.equal(beforeHistory.jobs.length,1);assert.equal(beforeSnapshots[0].records[0].correctionId,beforeHistory.corrections[0].id);assert.equal(beforeUsage.usage.failed,0);
 let providerCalls=0;setExtractionProvider({configured:()=>true,async extract(){providerCalls++;return result();}});
 assert.equal(await processOneCoreJob(retryJobId),false);
 const failed=await job(retryJobId),failedDoc=await document(source.document.id),failedEvents=await events(f.actor.workspaceId,source.document.id),expectedUsage=structuredClone(beforeUsage);expectedUsage.usage.failed=1;
 assert.equal(failed.state,'failed');assert.equal(failed.attempts,failed.max_attempts);assert.equal(failed.error,terminalHint);assert.equal(failed.lease_owner,null);assert.equal(failed.lease_until,null);assert.equal(providerCalls,0);
 assert.equal(failedDoc.status,'failed');assert.equal(failedDoc.error,terminalHint);assert.deepEqual(immutableDocument(failedDoc),immutableDocument(beforeDoc));assert.deepEqual(await oldHistory(source.document.id,retryJobId),beforeHistory);assert.deepEqual(await snapshots(),beforeSnapshots);assert.deepEqual(await usage(f.actor.workspaceId),beforeLedger);assert.deepEqual(await wholeUsage(),expectedUsage);
 assert.deepEqual(failedEvents.slice(0,beforeEvents.length),beforeEvents);assert.equal(failedEvents.length,beforeEvents.length+1);assert.equal(failedEvents.at(-1)!.state,'failed');assert.equal(failedEvents.at(-1)!.operation_id,retryJobId);
 assert.equal(await processOneCoreJob(retryJobId),false);assert.deepEqual(await job(retryJobId),failed);assert.deepEqual(await document(source.document.id),failedDoc);assert.deepEqual(await events(f.actor.workspaceId,source.document.id),failedEvents);assert.deepEqual(await wholeUsage(),expectedUsage);
 const repeated=await f.request('POST','/api/exports',exportInput);assert.equal(repeated.statusCode,200,repeated.body);const second=repeated.json();assert.notEqual(second.id,first.id);
 for(const url of [first.downloadUrl,second.downloadUrl]){const response=await f.request('GET',url);assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.rawPayload,originalCsv);}
 const afterSnapshots=await snapshots();assert.equal(afterSnapshots.length,2);assert.deepEqual(afterSnapshots.filter(snapshot=>snapshot.id===first.id),beforeSnapshots);const newSnapshot=afterSnapshots.find(snapshot=>snapshot.id===second.id);assert.ok(newSnapshot);assert.deepEqual(newSnapshot.records,beforeSnapshots[0].records);assert.deepEqual(newSnapshot.bytes,originalCsv);
 const finalDoc=await document(source.document.id);assert.equal(finalDoc.status,'failed');assert.equal(finalDoc.error,terminalHint);assert.deepEqual(immutableDocument(finalDoc),immutableDocument(beforeDoc));assert.deepEqual(await oldHistory(source.document.id,retryJobId),beforeHistory);assert.deepEqual(await job(retryJobId),failed);assert.deepEqual(await usage(f.actor.workspaceId),beforeLedger);assert.deepEqual(await wholeUsage(),expectedUsage);assert.equal(providerCalls,0);
 const finalOriginal=await f.request('GET',`/api/documents/${source.document.id}/original`);assert.equal(finalOriginal.statusCode,200,finalOriginal.body);assert.deepEqual(finalOriginal.rawPayload,originalBytes);
 const finalEvents=await events(f.actor.workspaceId,source.document.id);assert.deepEqual(finalEvents.slice(0,failedEvents.length),failedEvents);assert.deepEqual(finalEvents.slice(failedEvents.length).map(event=>[event.phase,event.state,event.operation_id]),[['export','exporting',second.id],['export','exported',second.id]]);
 assert.equal(await processOneCoreJob(retryJobId),false);assert.deepEqual(await events(f.actor.workspaceId,source.document.id),finalEvents);assert.deepEqual(await snapshots(),afterSnapshots);assert.deepEqual(await wholeUsage(),expectedUsage);assert.equal(providerCalls,0);
});
