/** Pure pool-client fixtures: no connection, provider request or environment file is needed. */
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {PoolClient,QueryResult} from 'pg';
import {adminPool,closeDatabase,databaseSchema} from '../server/core/db.js';
import {createAIUsageObserver} from '../server/core/ai-usage.js';

after(closeDatabase);
const turn=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
const result:QueryResult={command:'SELECT',rowCount:1,oid:0,rows:[{id:'synthetic'}],fields:[]};
const identity=()=>({workspaceId:randomUUID(),kind:'extraction' as const,operationId:randomUUID(),attempt:1});
function client(query:(sql:string)=>Promise<QueryResult>){
 const releases:boolean[]=[];
 return {value:{query,release:(destroy=false)=>{releases.push(Boolean(destroy));}} as unknown as PoolClient,releases};
}

test('AI usage destroys a late pool acquisition exactly once and never starts SQL',async t=>{
 assert.equal(databaseSchema,'public');assert.equal(adminPool.totalCount,0);
 t.mock.timers.enable({apis:['setTimeout']});
 const acquired=deferred<PoolClient>(),calls:string[]=[];
 const connection=client(async sql=>{calls.push(sql);return result;});
 t.mock.method(adminPool,'connect',()=>acquired.promise);
 const observer=createAIUsageObserver(identity());
 const refused=assert.rejects(observer.start(),/could not be reserved/);
 t.mock.timers.tick(1000);await refused;
 assert.deepEqual(connection.releases,[]);assert.deepEqual(calls,[]);
 acquired.resolve(connection.value);await turn();
 assert.deepEqual(connection.releases,[true]);assert.deepEqual(calls,[]);
 await observer.finish();assert.deepEqual(connection.releases,[true]);
});

for(const stalled of ['BEGIN','insert into ai_usage_attempts','COMMIT','ROLLBACK']){
 test(`AI usage total deadline destroys a stalled ${stalled} and refuses late admission`,async t=>{
  assert.equal(databaseSchema,'public');assert.equal(adminPool.totalCount,0);
  t.mock.timers.enable({apis:['setTimeout']});
  const entered=deferred<void>(),late=deferred<QueryResult>(),calls:string[]=[];
  const connection=client(async sql=>{
   calls.push(sql);
   if(stalled==='ROLLBACK'&&sql.startsWith('insert into'))throw new Error('Synthetic intent failure');
   if(sql.startsWith(stalled)){entered.resolve();return late.promise;}
   return result;
  });
  t.mock.method(adminPool,'connect',async()=>connection.value);
  const observer=createAIUsageObserver(identity());let dispatches=0;
  const refused=assert.rejects(observer.start().then(()=>{dispatches++;}),/could not be reserved/);
  await entered.promise;t.mock.timers.tick(3000);await refused;
  assert.equal(dispatches,0);assert.deepEqual(connection.releases,[true]);
  const atDeadline=[...calls];late.resolve(result);await turn();
  assert.deepEqual(calls,atDeadline,'A late query must not continue to more SQL or COMMIT');
  assert.deepEqual(connection.releases,[true]);await observer.finish();
  assert.equal(dispatches,0);assert.deepEqual(connection.releases,[true]);
 });
}

test('AI usage post-result flush settles on its total deadline without retrying or throwing',async t=>{
 assert.equal(databaseSchema,'public');assert.equal(adminPool.totalCount,0);
 t.mock.timers.enable({apis:['setTimeout']});t.mock.method(console,'warn',()=>{});
 const admitted=client(async()=>result),entered=deferred<void>(),late=deferred<QueryResult>(),calls:string[]=[];
 const flushing=client(async sql=>{calls.push(sql);if(sql.startsWith('update ai_usage_attempts')){entered.resolve();return late.promise;}return result;});
 let acquisitions=0;t.mock.method(adminPool,'connect',async()=>++acquisitions===1?admitted.value:flushing.value);
 const observer=createAIUsageObserver(identity());const id=await observer.start();assert.match(id,/^[a-f0-9-]{36}$/);
 assert.deepEqual(admitted.releases,[false]);
 await observer.observe({model:'synthetic',requestId:null,responseId:null,httpStatus:200,responseStatus:'completed',usageState:'reported_priced',inputTokens:1,cachedInputTokens:0,outputTokens:1,reasoningTokens:0,costUsd:0.01,pricingBasis:'Synthetic fixture'});
 const finished=observer.finish();await entered.promise;t.mock.timers.tick(3000);await assert.doesNotReject(finished);
 assert.deepEqual(flushing.releases,[true]);const atDeadline=[...calls];
 late.resolve(result);await turn();assert.deepEqual(calls,atDeadline);
 await observer.finish();assert.equal(acquisitions,2);assert.deepEqual(flushing.releases,[true]);
});
