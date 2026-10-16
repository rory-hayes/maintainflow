import test from 'node:test';
import assert from 'node:assert/strict';
import type {PoolClient} from 'pg';
import {deliveryAttemptAuditSchema,recordDeliveryAttemptAudit,deliveryAttemptElapsed,deliveryResponseStatus} from '../server/integrations/delivery-attempt-audit.js';

const identity={workspaceId:'534631dc-88ee-445d-8e28-ac9c378b006f',deliveryId:'55a0be98-11e4-453b-9293-e7706917bfab'};
const common={version:1 as const,integrationId:'ffac6f3c-ece8-4a0e-8431-d8564863e9d0',attemptId:'30f1586b-637d-4ab0-bf2b-e4a0ac143931',attempt:1,elapsedMs:12};
const claimed={...common,phase:'claimed' as const,priorAttempts:0,acquiredFrom:'queued' as const,priorLeaseExpired:false};
const finished={...common,phase:'finished' as const,stage:'delivery_commit' as const,path:'webhook_request' as const,outcome:'delivered' as const,errorKind:'none' as const,responseStatus:204};
function client(query:(sql:string,values?:unknown[])=>Promise<unknown>){return {query} as unknown as Pick<PoolClient,'query'>;}

test('strict attempt shapes preserve counter, expiry and committed-success distinctions',()=>{
 for(const value of [claimed,finished,{...claimed,attempt:2,priorAttempts:1,acquiredFrom:'expired_lease',priorLeaseExpired:true},{...finished,outcome:'fence_lost',responseStatus:503,errorKind:'http_status'},{version:1,integrationId:common.integrationId,phase:'lease_expired',attempt:5,priorLeaseExpired:true}])assert.equal(deliveryAttemptAuditSchema.safeParse(value).success,true);
 for(const value of [{...claimed,priorAttempts:1},{...claimed,priorLeaseExpired:true},{...claimed,acquiredFrom:'expired_lease'},{...finished,responseStatus:503},{...finished,errorKind:'operation_failed'},{...finished,outcome:'retry'},{...finished,responseStatus:'204'},{...finished,elapsedMs:-1},{...finished,elapsedMs:Infinity},{...finished,attempt:6},{...finished,stage:'arbitrary error text'},{...finished,path:'arbitrary provider text'}])assert.equal(deliveryAttemptAuditSchema.safeParse(value).success,false);
});

test('status observations admit only actual bounded integer values and elapsed time stays bounded',()=>{
 for(const value of [undefined,null,'200',NaN,Infinity,99,600,200.5,{}])assert.equal(deliveryResponseStatus(value),null);
 assert.equal(deliveryResponseStatus(100),100);assert.equal(deliveryResponseStatus(599),599);
 assert.equal(deliveryAttemptElapsed(100,112.9),12);assert.equal(deliveryAttemptElapsed(100,99),0);assert.equal(deliveryAttemptElapsed(0,Number.MAX_SAFE_INTEGER),2_147_483_647);
});

test('valid audit serializes only its exact allowlist and uses the existing worker audit boundary',async()=>{
 const calls:Array<{sql:string;values?:unknown[]}>=[];
 const stored=await recordDeliveryAttemptAudit(client(async(sql,values)=>{calls.push({sql,values});return {};}),identity,finished);
 assert.equal(stored,true);assert.deepEqual(calls.map(call=>call.sql.split(' ')[0]),['SAVEPOINT','insert','RELEASE']);
 assert.deepEqual(calls[1].values?.slice(0,3),[identity.workspaceId,'delivery.attempt_finished',identity.deliveryId]);
 assert.deepEqual(JSON.parse(calls[1].values?.[3] as string),finished);assert.ok(Buffer.byteLength(calls[1].values?.[3] as string)<1024);
});

test('diagnostics reject extra capability, payload and error keys before any SQL or serialization',async()=>{
 let calls=0;const db=client(async()=>{calls++;return {};});
 for(const extra of ['lease_token','headers','payload','access_token','refresh_token','error','response']){
  const value={...finished};Object.defineProperty(value,extra,{enumerable:true,get(){throw new Error('SYNTHETIC_PRIVATE_CANARY_MUST_NOT_BE_READ');}});
  assert.equal(await recordDeliveryAttemptAudit(db,identity,value),false);
 }
 assert.equal(await recordDeliveryAttemptAudit(db,{...identity,token:'SYNTHETIC_PRIVATE_CANARY'},finished),false);
 assert.equal(await recordDeliveryAttemptAudit(db,identity,{...finished,attemptId:'not-a-uuid'}),false);assert.equal(calls,0);
});

test('rejected diagnostic INSERT rolls back only its savepoint and leaves the delivery transaction usable',async()=>{
 const sql:string[]=[];let aborted=false;
 const db=client(async statement=>{
  sql.push(statement);
  if(statement.startsWith('insert')){aborted=true;throw new Error('SYNTHETIC_PRIVATE_AUDIT_ERROR');}
  if(statement.startsWith('ROLLBACK TO'))aborted=false;
  else assert.equal(aborted,false,'The failed INSERT must be recovered before continuing.');
  return {};
 });
 assert.equal(await recordDeliveryAttemptAudit(db,identity,finished),false);
 assert.deepEqual(sql.map(value=>value.split(' ')[0]),['SAVEPOINT','insert','ROLLBACK','RELEASE']);assert.equal(aborted,false);
});

test('a broken transaction during savepoint recovery propagates instead of fabricating a committed audit',async()=>{
 const failure=new Error('SYNTHETIC_BROKEN_TRANSACTION');
 await assert.rejects(recordDeliveryAttemptAudit(client(async sql=>{if(sql.startsWith('insert'))throw new Error('SYNTHETIC_INSERT_FAILURE');if(sql.startsWith('ROLLBACK'))throw failure;return {};}),identity,finished),error=>error===failure);
});
