import test,{before,after,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {buildApp} from '../server/app.js';
import {adminPool,appPool,closeDatabase} from '../server/core/db.js';
import {processOneCoreJob,setExtractionProvider} from '../server/core/worker.js';
import type {WorkerAttemptEvent} from '../server/core/worker-attempt-events.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import type {ExtractionResult} from '../shared/types.js';
import {assertBankFixtureDatabase,bankRawFixture,cleanupBankFixtures,createBankFixture} from './bank-statement-fixtures.js';

// Owned synthetic database/storage and in-memory provider only. No external request is permitted.
const objects=new Map<string,Buffer>();
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
const originalFetch=globalThis.fetch;
let app:Awaited<ReturnType<typeof buildApp>>,verified=false,networkCalls=0;
const result=():ExtractionResult=>({rawValues:bankRawFixture() as unknown as Record<string,unknown>,normalizedValues:{},evidence:{},issues:[],engine:'synthetic-attempt-diagnostics',model:'synthetic'});
const provider=(extract:()=>Promise<ExtractionResult>=async()=>result())=>setExtractionProvider({configured:()=>true,extract});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}
async function state(jobId:string){return (await adminPool.query('select state,attempts,lease_owner,lease_until from jobs where id=$1',[jobId])).rows[0];}
async function counts(documentId:string){return (await adminPool.query('select (select count(*)::int from extraction_runs where document_id=$1) runs,(select count(*)::int from usage_ledger where document_id=$1) usage',[documentId])).rows[0];}
function phases(events:WorkerAttemptEvent[]){return events.map(event=>[event.stage,'outcome' in event?event.outcome:null]);}
function assertBounded(events:WorkerAttemptEvent[],jobId:string,attempt:number){
 let previous=0;
 for(const event of events){
  assert.deepEqual(Object.keys(event).sort(),['attempt','elapsedMs','jobId','stage',...('outcome' in event?['outcome']:[])].sort());
  assert.equal(event.jobId,jobId);assert.equal(event.attempt,attempt);
  assert.ok(Number.isSafeInteger(event.elapsedMs)&&event.elapsedMs>=previous);previous=event.elapsedMs;
 }
}
// Fail the actual persistence COMMIT before it reaches PostgreSQL. Preserve callback-style pool users.
function rejectPersistenceCommits(remaining:number,armed:()=>boolean){
 const original=appPool.connect.bind(appPool);
 (appPool as any).connect=(callback?:any)=>{
  const pending=original().then(client=>new Proxy(client,{get(target,key){
   if(key==='query')return (...args:any[])=>{
    if(armed()&&String(args[0]).trim()==='COMMIT'&&remaining-->0){
     const error=new Error('SYNTHETIC_PRIVATE_COMMIT_ERROR');const cb=typeof args.at(-1)==='function'?args.at(-1):undefined;
     if(cb){queueMicrotask(()=>cb(error));return;}return Promise.reject(error);
    }
    return (target.query as any)(...args);
   };
   const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
  }}));
  if(callback){void pending.then(client=>callback(null,client,client.release),error=>callback(error));return;}
  return pending;
 };
 return ()=>{appPool.connect=original;};
}
before(async()=>{await assertBankFixtureDatabase();verified=true;globalThis.fetch=async()=>{networkCalls++;throw new Error('External calls forbidden in worker diagnostics fixtures');};setStorageForTests(storage);app=await buildApp();});
afterEach(()=>{setExtractionProvider(undefined);assert.equal(networkCalls,0);});
after(async()=>{await app?.close();if(verified)await cleanupBankFixtures();setStorageForTests(undefined);globalThis.fetch=originalFetch;await closeDatabase();});

test('successful attempt exposes bounded ordered phases and one committed result, while unclaimed work emits nothing',async()=>{
 const f=await createBankFixture(app),source=await f.queue(),events:WorkerAttemptEvent[]=[];
 provider(async()=>{assert.deepEqual(phases(events),[['claimed',null]]);assert.equal((await state(source.jobId)).state,'processing');assert.deepEqual(await counts(source.document.id),{runs:0,usage:1});await new Promise(resolve=>setTimeout(resolve,15));return result();});
 assert.equal(await processOneCoreJob(source.jobId,{onAttemptEvent:event=>{events.push(event);}}),true);
 assertBounded(events,source.jobId,1);
 assert.deepEqual(phases(events),[['claimed',null],['extraction_finished','succeeded'],['persistence_started','completed'],['finished','completed']]);
 assert.ok(events[1].elapsedMs-events[0].elapsedMs>=10);
 assert.deepEqual(await counts(source.document.id),{runs:1,usage:1});assert.equal((await state(source.jobId)).state,'completed');
 const quiet:WorkerAttemptEvent[]=[];assert.equal(await processOneCoreJob(randomUUID(),{onAttemptEvent:event=>{quiet.push(event);}}),false);assert.deepEqual(quiet,[]);
});

test('transient and permanent provider failures report fixed outcomes without their secret or identity-bearing error text',async()=>{
 for(const permanent of [false,true]){
  const f=await createBankFixture(app),source=await f.queue(),events:WorkerAttemptEvent[]=[];
  const sensitive=`SYNTHETIC_PRIVATE_ERROR ${f.actor.userId} ${f.actor.workspaceId} ${source.document.id} bearer=SYNTHETIC_ONLY`;
  provider(async()=>{throw Object.assign(new Error(sensitive),{permanent,response:{sensitive}});});
  await processOneCoreJob(source.jobId,{onAttemptEvent:event=>{events.push(event);}});
  assertBounded(events,source.jobId,1);
  assert.deepEqual(phases(events),[['claimed',null],['extraction_finished','failed'],['persistence_started',permanent?'failed':'retry'],['finished',permanent?'failed':'retry']]);
  assert.deepEqual(await counts(source.document.id),{runs:0,usage:1});assert.equal((await state(source.jobId)).state,permanent?'failed':'queued');
 }
});

test('throwing and asynchronously rejecting observers cannot alter committed outcomes or usage',async()=>{
 for(const asynchronous of [false,true]){
  const f=await createBankFixture(app),source=await f.queue();provider();let observed=0;
  await processOneCoreJob(source.jobId,{onAttemptEvent:()=>{observed++;const error=new Error('SYNTHETIC_OBSERVER_FAILURE');if(asynchronous)return Promise.reject(error);throw error;}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(observed,4);
  assert.equal((await state(source.jobId)).state,'completed');assert.deepEqual(await counts(source.document.id),{runs:1,usage:1});
 }
});

test('reclaimed lease reports old-owner fence loss and only the current owner reports committed completion',async()=>{
 const f=await createBankFixture(app),source=await f.queue(),oldEvents:WorkerAttemptEvent[]=[],newEvents:WorkerAttemptEvent[]=[];
 const first=deferred(),second=deferred(),oldGate=deferred(),newGate=deferred();let calls=0;
 provider(async()=>{if(++calls===1){first.resolve();await oldGate.promise;}else{second.resolve();await newGate.promise;}return result();});
 const old=processOneCoreJob(source.jobId,{onAttemptEvent:event=>{oldEvents.push(event);}});await first.promise;
 await adminPool.query("update jobs set lease_until=now()-interval '1 second' where id=$1",[source.jobId]);
 const current=processOneCoreJob(source.jobId,{onAttemptEvent:event=>{newEvents.push(event);}});await second.promise;
 try{
  oldGate.resolve();await old;assert.deepEqual(phases(oldEvents).at(-1),['finished','fence_lost']);assertBounded(oldEvents,source.jobId,1);
  assert.equal((await state(source.jobId)).state,'processing');assert.deepEqual(await counts(source.document.id),{runs:0,usage:1});
  newGate.resolve();await current;assert.deepEqual(phases(newEvents).at(-1),['finished','completed']);assertBounded(newEvents,source.jobId,2);
  assert.deepEqual(await counts(source.document.id),{runs:1,usage:1});
 }finally{oldGate.resolve();newGate.resolve();await Promise.allSettled([old,current]);}
});

test('late provider resolution after deadline adds neither success events nor a saved run',async()=>{
 const f=await createBankFixture(app),source=await f.queue(),events:WorkerAttemptEvent[]=[],entered=deferred(),gate=deferred();
 provider(async()=>{entered.resolve();await gate.promise;return result();});
 const processing=processOneCoreJob(source.jobId,{providerTimeoutMs:500,onAttemptEvent:event=>{events.push(event);}});
 try{
  await entered.promise;await processing;assertBounded(events,source.jobId,1);
  assert.deepEqual(phases(events),[['claimed',null],['extraction_finished','failed'],['persistence_started','retry'],['finished','retry']]);
  const before=structuredClone(events);gate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,before);
  assert.equal((await state(source.jobId)).state,'queued');assert.deepEqual(await counts(source.document.id),{runs:0,usage:1});
 }finally{gate.resolve();await processing;}
});

test('rolled-back result COMMIT cannot report completed, and failed retry persistence is distinguished',async()=>{
 for(const failures of [1,2]){
  const f=await createBankFixture(app),source=await f.queue(),events:WorkerAttemptEvent[]=[];provider();let armed=false;
  const restore=rejectPersistenceCommits(failures,()=>armed);
  try{
   const processing=processOneCoreJob(source.jobId,{onAttemptEvent:event=>{events.push(event);if(event.stage==='persistence_started')armed=true;}});
   if(failures===2)await assert.rejects(processing,{message:'SYNTHETIC_PRIVATE_COMMIT_ERROR'});else await processing;
  }finally{restore();}
  assertBounded(events,source.jobId,1);
  assert.deepEqual(phases(events),[['claimed',null],['extraction_finished','succeeded'],['persistence_started','completed'],['persistence_started','retry'],['finished',failures===1?'retry':'persistence_error']]);
  assert.deepEqual(await counts(source.document.id),{runs:0,usage:1});assert.equal((await state(source.jobId)).state,failures===1?'queued':'processing');
 }
});
