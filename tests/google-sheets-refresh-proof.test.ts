import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {OAuth2Client} from 'google-auth-library';
import {
 observeGoogleSheetsAccessStep,googleSheetsDeliveredRefreshProof,
 googleSheetsAccessStepSchema,googleSheetsRefreshProofSchema,
 type GoogleSheetsAccessClient,
} from '../server/integrations/google-sheets-refresh-proof.js';

type AccessResponse=Awaited<ReturnType<GoogleSheetsAccessClient['getAccessToken']>>;
const deliveryId='a1295a54-191d-4d50-9a36-7b19e6da8182';
const instant=Date.parse('2026-10-16T22:00:00.000Z');
class FixtureClient extends EventEmitter implements GoogleSheetsAccessClient{
 credentials:{expiry_date?:number|null};
 constructor(expiry:number|null|undefined,private request:()=>Promise<AccessResponse>){super();this.credentials={expiry_date:expiry};}
 getAccessToken(){return this.request();}
}
function sdkClient(expiry:number|undefined){
 const client=new OAuth2Client();let requests=0;
 client.setCredentials({access_token:'SYNTHETIC_ACCESS_CANARY',refresh_token:'SYNTHETIC_REFRESH_CANARY',...(expiry===undefined?{}:{expiry_date:expiry})});
 // Run the real locked SDK branch with a local transport, never the network.
 client.transporter.request=async()=>{
  requests++;
  return {status:200,data:{access_token:'SYNTHETIC_REPLACEMENT_CANARY',expires_in:3600,token_type:'Bearer'}} as never;
 };
 return {client,requests:()=>requests};
}

test('locked SDK expired-access step observes its actual refresh response and tokens event',async()=>{
 const locked=JSON.parse(readFileSync(new URL('../node_modules/google-auth-library/package.json',import.meta.url),'utf8'));
 assert.equal(locked.version,'11.0.2');
 const fixture=sdkClient(Date.now()-60_000),step=await observeGoogleSheetsAccessStep(fixture.client);
 assert.equal(fixture.requests(),1);
 assert.equal(step.expiryKnown,true);assert.equal(step.accessExpiredAtStepStart,true);
 assert.equal(step.sdkTokensEventObserved,true);assert.equal(step.sdkRefreshResponseObserved,true);assert.equal(step.sdkRefreshResponseStatus,200);
 assert.equal(fixture.client.listenerCount('tokens'),0);
 const proof=googleSheetsDeliveredRefreshProof(step,deliveryId,200),serialized=JSON.stringify(proof);
 assert.equal(proof.step,'pre_range_get_access_token');assert.equal(proof.credentialPersistence,'updated');assert.equal(proof.rangeWriteStatus,200);
 for(const canary of ['SYNTHETIC_ACCESS_CANARY','SYNTHETIC_REFRESH_CANARY','SYNTHETIC_REPLACEMENT_CANARY'])assert.ok(!serialized.includes(canary));
});

test('locked SDK eager refresh does not become an expired-at-start claim',async()=>{
 const fixture=sdkClient(Date.now()+60_000),step=await observeGoogleSheetsAccessStep(fixture.client);
 assert.equal(fixture.requests(),1);assert.equal(step.accessExpiredAtStepStart,false);
 assert.equal(step.sdkTokensEventObserved,true);assert.equal(step.sdkRefreshResponseObserved,true);assert.equal(step.sdkRefreshResponseStatus,200);
});

test('locked SDK cached access has neither a refresh response nor an event',async()=>{
 const fixture=sdkClient(Date.now()+3_600_000),step=await observeGoogleSheetsAccessStep(fixture.client);
 assert.equal(fixture.requests(),0);assert.equal(step.accessExpiredAtStepStart,false);
 assert.equal(step.sdkTokensEventObserved,false);assert.equal(step.sdkRefreshResponseObserved,false);assert.equal(step.sdkRefreshResponseStatus,null);
});

test('locked SDK access with unknown expiry remains unknown',async()=>{
 const fixture=sdkClient(undefined),step=await observeGoogleSheetsAccessStep(fixture.client);
 assert.equal(fixture.requests(),0);assert.equal(step.expiryKnown,false);assert.equal(step.accessExpiredAtStepStart,null);
 assert.equal(step.sdkRefreshResponseObserved,false);assert.equal(step.sdkTokensEventObserved,false);
});

test('only finite positive numeric expiry is evidence of expiry at step start',async()=>{
 for(const expiry of [undefined,null,0,NaN,Infinity,-1]){
  const step=await observeGoogleSheetsAccessStep(new FixtureClient(expiry,async()=>({})),()=>instant);
  assert.equal(step.expiryKnown,false);assert.equal(step.accessExpiredAtStepStart,null);
 }
 const step=await observeGoogleSheetsAccessStep(new FixtureClient(instant,async()=>({})),()=>instant);
 assert.equal(step.accessExpiredAtStepStart,true);
 assert.equal(step.stepStartedAt,'2026-10-16T22:00:00.000Z');
});

test('observer ignores token/event/response contents and removes only its own listener',async()=>{
 const forbidden=()=>{throw new Error('Forbidden fixture content was read');};
 const client=new FixtureClient(instant-1,async()=>{
  client.emit('tokens',{get access_token(){return forbidden();},get refresh_token(){return forbidden();}});
  return {get token(){return forbidden();},res:{status:200,get data(){return forbidden();},get headers(){return forbidden();},get config(){return forbidden();}}};
 });
 Object.defineProperties(client.credentials,{access_token:{get:forbidden},refresh_token:{get:forbidden}});
 let existingEvents=0;const existing=()=>{existingEvents++;};client.on('tokens',existing);
 const step=await observeGoogleSheetsAccessStep(client,()=>instant);
 assert.equal(step.sdkTokensEventObserved,true);assert.equal(existingEvents,1);
 assert.deepEqual(client.listeners('tokens'),[existing]);
 // A later range-request token event cannot alter the completed explicit step.
 client.emit('tokens',{get access_token(){return forbidden();}});
 assert.equal(existingEvents,2);assert.equal(step.sdkTokensEventObserved,true);
});

test('SDK failure propagates unchanged with listener cleanup and no proof',async()=>{
 const failure=new Error('Synthetic SDK failure'),client=new FixtureClient(instant-1,async()=>{throw failure;});
 const existing=()=>{};client.on('tokens',existing);
 await assert.rejects(observeGoogleSheetsAccessStep(client,()=>instant),error=>error===failure);
 assert.deepEqual(client.listeners('tokens'),[existing]);
});

test('response and range status metadata accepts only bounded integer HTTP codes',async()=>{
 for(const status of [undefined,null,'200',NaN,Infinity,99,600,200.5]){
  const step=await observeGoogleSheetsAccessStep(new FixtureClient(instant+1,async()=>({res:{status}})),()=>instant);
  assert.equal(step.sdkRefreshResponseObserved,true);assert.equal(step.sdkRefreshResponseStatus,null);
  assert.equal(googleSheetsDeliveredRefreshProof(step,deliveryId,status).rangeWriteStatus,null);
 }
 const step=await observeGoogleSheetsAccessStep(new FixtureClient(instant+1,async()=>({res:{status:201}})),()=>instant);
 assert.equal(step.sdkRefreshResponseStatus,201);assert.equal(googleSheetsDeliveredRefreshProof(step,deliveryId,204).rangeWriteStatus,204);
 assert.equal(googleSheetsDeliveredRefreshProof(step,deliveryId,429).rangeWriteStatus,null);
});

test('strict proof rejects extra keys and inconsistent or fabricated status claims',async()=>{
 const step=await observeGoogleSheetsAccessStep(new FixtureClient(undefined,async()=>({})),()=>instant);
 const proof=googleSheetsDeliveredRefreshProof(step,deliveryId,200);
 assert.deepEqual(Object.keys(proof).sort(),['version','step','stepStartedAt','stepCompletedAt','expiryKnown','accessExpiredAtStepStart','sdkTokensEventObserved','sdkRefreshResponseObserved','sdkRefreshResponseStatus','deliveryId','credentialPersistence','rangeWriteStatus'].sort());
 assert.equal(JSON.stringify(proof).length<1024,true);
 for(const value of [{...proof,token:'SYNTHETIC_EXTRA_CANARY'},{...proof,credentials:{}},{...proof,credentialPersistence:'changed'},{...proof,deliveryId:'not-a-uuid'},{...proof,expiryKnown:true},{...proof,sdkRefreshResponseStatus:200},{...proof,rangeWriteStatus:429},{...proof,stepStartedAt:'2026-10-16T22:00:00.'+'0'.repeat(100)+'Z'}]){
  assert.equal(googleSheetsRefreshProofSchema.safeParse(value).success,false);
 }
 assert.equal(googleSheetsAccessStepSchema.safeParse({...step,response:{}}).success,false);
});

test('completed step ignores subsequent token events rather than claiming whole-request observation',async()=>{
 const client=new FixtureClient(instant+3_600_000,async()=>({}));
 const step=await observeGoogleSheetsAccessStep(client,()=>instant);
 client.emit('tokens',{access_token:'SYNTHETIC_LATER_RANGE_CANARY'});
 assert.equal(step.sdkTokensEventObserved,false);assert.equal(step.sdkRefreshResponseObserved,false);
 assert.equal(client.listenerCount('tokens'),0);
});
