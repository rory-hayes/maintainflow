import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adminPool,withWorkspace,closeDatabase} from '../server/core/db.js';
import {createAIUsageObserver} from '../server/core/ai-usage.js';
import type {AIUsageKind,AIUsageObservation} from '../shared/ai-usage.js';

const workspace=randomUUID(),other=randomUUID();
const facts:AIUsageObservation={model:'gpt-5.4-mini-2026-03-17',requestId:'req_synthetic',responseId:'resp_synthetic',httpStatus:200,responseStatus:'incomplete',usageState:'reported_priced',inputTokens:100,cachedInputTokens:20,outputTokens:10,reasoningTokens:2,costUsd:0.0001065,pricingBasis:'synthetic test estimate'};
const read=async(id:string)=>(await adminPool.query('select * from ai_usage_attempts where id=$1',[id])).rows[0];
before(async()=>{for(const id of [workspace,other])await adminPool.query('insert into workspaces(id,name,slug) values($1,$2,$3)',[id,'Synthetic usage attempts',`usage-${id}`]);});
after(async()=>{await adminPool.query('delete from workspaces where id=any($1::uuid[])',[[workspace,other]]);await closeDatabase();});

test('three operation kinds retain intent, immutable identity, idempotent response and late usage after interruption',async t=>{
 t.mock.method(console,'warn',()=>{});
 for(const kind of ['extraction','schema_suggestion','split_suggestion'] as AIUsageKind[]){
  const operationId=randomUUID(),observer=createAIUsageObserver({workspaceId:workspace,kind,operationId,attempt:1});
  const id=await observer.start();assert.equal((await read(id)).usage_state,'unknown');assert.equal((await read(id)).cost_usd,null);
  await observer.finish();assert.equal((await read(id)).outcome,'interrupted');
  await observer.observe(facts);const recorded=await read(id);assert.equal(recorded.usage_state,'reported_priced');assert.equal(recorded.kind,kind);assert.equal(recorded.operation_id,operationId);
  await observer.observe(facts);await observer.finish();assert.deepEqual(await read(id),recorded);
  await observer.observe({...facts,responseId:'resp_conflicting'});assert.deepEqual(await read(id),recorded);
  await assert.rejects(adminPool.query('update ai_usage_attempts set operation_id=$2 where id=$1',[id,randomUUID()]),/immutable/);
  await assert.rejects(adminPool.query('update ai_usage_attempts set cost_usd=99 where id=$1',[id]),/immutable/);
  const duplicate=createAIUsageObserver({workspaceId:workspace,kind,operationId,attempt:1});await assert.rejects(duplicate.start(),/could not be reserved/);
  const retry=createAIUsageObserver({workspaceId:workspace,kind,operationId,attempt:2}),retryId=await retry.start();assert.notEqual(retryId,id);await retry.finish();
 }
});

test('observations are tenant-readable but server-written, with no cross-workspace visibility',async()=>{
 const observer=createAIUsageObserver({workspaceId:workspace,kind:'extraction',operationId:randomUUID(),attempt:1}),id=await observer.start();
 assert.equal(await withWorkspace(workspace,async c=>(await c.query('select id from ai_usage_attempts where id=$1',[id])).rowCount),1);
 assert.equal(await withWorkspace(other,async c=>(await c.query('select id from ai_usage_attempts where id=$1',[id])).rowCount),0);
 for(const sql of ['delete from ai_usage_attempts where id=$1','update ai_usage_attempts set attempt=2 where id=$1',"insert into ai_usage_attempts(id,workspace_id,kind,operation_id,attempt) select gen_random_uuid(),workspace_id,kind,operation_id,99 from ai_usage_attempts where id=$1"]){
  await assert.rejects(withWorkspace(workspace,c=>c.query(sql,[id])),/permission denied/);
 }
 await observer.finish();
});

test('intent is recorded before authority recheck, and interrupted/unknown rows cannot masquerade as zero cost',async()=>{
 let dispatched=false;const operationId=randomUUID();
 const observer=createAIUsageObserver({workspaceId:workspace,kind:'split_suggestion',operationId,attempt:1},async()=>{assert.equal((await adminPool.query('select count(*)::int n from ai_usage_attempts where operation_id=$1',[operationId])).rows[0].n,1);throw new Error('Synthetic authority revoked');});
 await assert.rejects(observer.start().then(()=>{dispatched=true;}),/revoked/);assert.equal(dispatched,false);await observer.finish();
 const row=(await adminPool.query('select * from ai_usage_attempts where operation_id=$1',[operationId])).rows[0];assert.equal(row.outcome,'interrupted');assert.equal(row.cost_usd,null);
 await assert.rejects(adminPool.query('update ai_usage_attempts set cost_usd=0 where id=$1',[row.id]),/check constraint/);
});

test('workspace deletion removes cost metadata while operation tombstones need no live job or document',async()=>{
 const temporary=randomUUID();await adminPool.query('insert into workspaces(id,name,slug) values($1,$2,$3)',[temporary,'Synthetic deleted usage',`usage-${temporary}`]);
 const observer=createAIUsageObserver({workspaceId:temporary,kind:'schema_suggestion',operationId:randomUUID(),attempt:1}),id=await observer.start();await observer.observe(facts);await observer.finish();
 assert.ok(await read(id));await adminPool.query('delete from workspaces where id=$1',[temporary]);assert.equal(await read(id),undefined);
});


test('closing an attempt during the awaited authority check prevents later provider dispatch',async()=>{
 let enter!:()=>void,release!:()=>void,requests=0;
 const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
 const operationId=randomUUID(),observer=createAIUsageObserver({workspaceId:workspace,kind:'split_suggestion',operationId,attempt:1},async()=>{enter();await gate;});
 const start=observer.start();const rejected=assert.rejects(start,/interrupted/);await entered;await observer.finish();release();await rejected;
 await start.then(()=>{requests++;},()=>{});assert.equal(requests,0);
 const row=(await adminPool.query('select outcome,usage_state,cost_usd from ai_usage_attempts where operation_id=$1',[operationId])).rows[0];
 assert.deepEqual(row,{outcome:'interrupted',usage_state:'unknown',cost_usd:null});
});
