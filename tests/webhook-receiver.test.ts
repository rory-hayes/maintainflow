/** No listener, database, account credentials or external delivery. Receiver persistence is a transactional fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createWebhookRequest} from '../server/integrations/webhook-request.js';
import {verifyParserApprovalDelivery,type ReceiverInput} from '../examples/automations/verify.js';

const fixture=JSON.parse(readFileSync(new URL('../fixtures/automations/document-approved.json',import.meta.url),'utf8'));
const secret='SYNTHETIC_RECEIVER_SECRET_ONLY',now=1_792_238_400;
const signed=(id:string=randomUUID(),payload=fixture,at=now)=>{
 const request=createWebhookRequest({id,payload},secret,String(at));
 return {body:Buffer.from(request.body),headers:request.headers};
};

// Models the required unique receipt + pending outbox transaction. This is not a
// durable receiver implementation: real acceptance must run its actual adapter.
function receiverFixture(){
 const receipts=new Map<string,string>(),outbox=new Map<string,typeof fixture>(),records=new Map<string,typeof fixture>();
 let tail=Promise.resolve(),failCommit=false,loseAcknowledgement=false;
 const accept=async(input:ReceiverInput)=>{
  const verified=verifyParserApprovalDelivery(input,secret,fixture.document.parserId,now);
  const hash=createHash('sha256').update(input.body).digest('hex');
  const transaction=tail.then(()=>{
   const prior=receipts.get(verified.deliveryId);
   if(prior){if(prior!==hash)throw new Error('Delivery identity conflicts with the saved body');return 'duplicate' as const;}
   if(failCommit)throw new Error('Synthetic receiver transaction failed before commit');
   receipts.set(verified.deliveryId,hash);outbox.set(verified.deliveryId,verified.event);
   return 'accepted' as const;
  });
  tail=transaction.then(()=>{},()=>{});
  const outcome=await transaction;
  if(loseAcknowledgement)throw new Error('Synthetic response lost after receiver commit');
  return {status:204,outcome};
 };
 const drain=()=>{
  for(const [id,event] of outbox){records.set(event.id,event);outbox.delete(id);}
 };
 return {accept,drain,receipts,outbox,records,setFailCommit:(value:boolean)=>{failCommit=value;},setLoseAcknowledgement:(value:boolean)=>{loseAcknowledgement=value;}};
}

test('sender request and scoped receiver preserve exact signed bytes and reject foreign parser or signing credentials before acceptance',()=>{
 const input=signed();
 assert.deepEqual(verifyParserApprovalDelivery(input,secret,fixture.document.parserId,now).event,fixture);
 const unicode={...fixture,values:{...fixture.values,supplier:'Éire supplies €'}};
 assert.deepEqual(verifyParserApprovalDelivery(signed(randomUUID(),unicode),secret,fixture.document.parserId,now).event,unicode);
 assert.throws(()=>verifyParserApprovalDelivery(input,secret,randomUUID(),now),/scope/);
 assert.throws(()=>verifyParserApprovalDelivery(input,secret,'not-a-parser-id',now));
 for(const rejectedSecret of ['', 'SYNTHETIC_WRONG_OR_REVOKED_SECRET'])assert.throws(()=>verifyParserApprovalDelivery(input,rejectedSecret,fixture.document.parserId,now),/secret|signature/);
 assert.throws(()=>verifyParserApprovalDelivery({...input,body:Buffer.from(input.body.toString()+' ')},secret,fixture.document.parserId,now),/signature/);
});

test('receiver rejects ambiguous signed headers and invalid clocks while accepting normal case-insensitive headers and exact timestamp bounds',()=>{
 const input=signed(),lower={...input,headers:Object.fromEntries(Object.entries(input.headers).map(([key,value])=>[key.toLowerCase(),value]))};
 assert.equal(verifyParserApprovalDelivery(lower,secret,fixture.document.parserId,now).deliveryId,input.headers['X-Folio-Delivery']);
 for(const key of ['X-Folio-Timestamp','X-Folio-Signature','X-Folio-Delivery','Idempotency-Key'] as const){
  assert.throws(()=>verifyParserApprovalDelivery({...input,headers:{...input.headers,[key.toLowerCase()]:input.headers[key]}},secret,fixture.document.parserId,now),/ambiguous/);
  assert.throws(()=>verifyParserApprovalDelivery({...input,headers:{...input.headers,[key]:[input.headers[key]] as unknown as string}},secret,fixture.document.parserId,now),/invalid/);
 }
 for(const clock of [NaN,Infinity,-1,now+0.5])assert.throws(()=>verifyParserApprovalDelivery(input,secret,fixture.document.parserId,clock),/clock/);
 for(const offset of [-300,300])assert.doesNotThrow(()=>verifyParserApprovalDelivery(signed(randomUUID(),fixture,now+offset),secret,fixture.document.parserId,now));
 for(const offset of [-301,301])assert.throws(()=>verifyParserApprovalDelivery(signed(randomUUID(),fixture,now+offset),secret,fixture.document.parserId,now),/expired/);
});

test('receiver transaction failure returns no acknowledgement; signed retry, lost response and manual replay preserve one pending action',async()=>{
 const receiver=receiverFixture(),input=signed();
 receiver.setFailCommit(true);
 await assert.rejects(receiver.accept(input),/before commit/);
 assert.equal(receiver.receipts.size,0);assert.equal(receiver.outbox.size,0);
 receiver.setFailCommit(false);receiver.setLoseAcknowledgement(true);
 await assert.rejects(receiver.accept(input),/after receiver commit/);
 assert.equal(receiver.receipts.size,1);assert.equal(receiver.outbox.size,1);
 receiver.setLoseAcknowledgement(false);
 assert.deepEqual(await receiver.accept(input),{status:204,outcome:'duplicate'});
 const replay=signed(input.headers['X-Folio-Delivery'],fixture,now+60);
 assert.notEqual(replay.headers['X-Folio-Signature'],input.headers['X-Folio-Signature']);
 assert.deepEqual(await receiver.accept(replay),{status:204,outcome:'duplicate'});
 receiver.drain();assert.equal(receiver.records.size,1);assert.deepEqual(receiver.records.get(fixture.id),fixture);
 assert.deepEqual(await receiver.accept(replay),{status:204,outcome:'duplicate'});
 receiver.drain();assert.equal(receiver.records.size,1);assert.equal(receiver.outbox.size,0);
});

test('receiver duplicate races keep one outbox item and a conflicting saved identity is rejected',async()=>{
 const receiver=receiverFixture(),input=signed();
 const results=await Promise.all(Array.from({length:8},()=>receiver.accept(input)));
 assert.equal(results.filter(result=>result.outcome==='accepted').length,1);
 assert.equal(results.filter(result=>result.outcome==='duplicate').length,7);
 assert.equal(receiver.receipts.size,1);assert.equal(receiver.outbox.size,1);
 const changed=signed(input.headers['X-Folio-Delivery'],{...fixture,values:{...fixture.values,total:999}});
 await assert.rejects(receiver.accept(changed),/conflicts/);
 assert.equal(receiver.outbox.get(input.headers['X-Folio-Delivery']).values.total,fixture.values.total);
 receiver.drain();assert.equal(receiver.records.size,1);
});

test('downstream approval upsert also prevents duplicates when the unsigned delivery header changes',async()=>{
 const receiver=receiverFixture(),input=signed(),changedId=randomUUID();
 await receiver.accept(input);
 // The documented HMAC signs timestamp.body, not the delivery header. Durable
 // delivery receipts alone cannot replace an approval-ID upsert downstream.
 await receiver.accept({...input,headers:{...input.headers,'X-Folio-Delivery':changedId,'Idempotency-Key':changedId}});
 assert.equal(receiver.receipts.size,2);assert.equal(receiver.outbox.size,2);
 receiver.drain();assert.equal(receiver.records.size,1);assert.deepEqual(receiver.records.get(fixture.id),fixture);
});
