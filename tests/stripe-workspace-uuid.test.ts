import test,{after,type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import type Stripe from 'stripe';
import {adminPool,appPool,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {registerProviders} from '../server/integrations/providers.js';
import {PLANS} from '../shared/plans.js';

// Synthetic legacy billing state and controlled transports only: no actual DB,
// Stripe customer, Checkout, payment or hosted request is created by this file.
const workspace='abcdefab-cdef-4abc-8def-abcdefabcdef',foreign='01234567-89ab-4cde-8fab-0123456789ab';
const user='12345678-1234-4123-8123-123456789abc',requestId='87654321-4321-4321-8321-cba987654321';
const variants=[workspace,workspace.toUpperCase(),'Abcdefab-cdef-4abc-8def-abcdefabcdef'];
const invalid:unknown[]=[foreign.toUpperCase(),`${workspace}\n`,` ${workspace}`,`${workspace} `,`${workspace}/..`,workspace.slice(0,-1)+'g','',null,undefined,[workspace],{toString:()=>workspace}];
const environmentKeys=['STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_MODE'] as const;
after(closeDatabase);

async function legacyBilling(context:TestContext){
 const original=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{STRIPE_MODE:'test',STRIPE_SECRET_KEY:'sk_test_synthetic_case_fixture',STRIPE_WEBHOOK_SECRET:'whsec_synthetic_case_fixture',STRIPE_PRICE_STANDARD:'price_synthetic_standard',STRIPE_PRICE_TEAM:'price_synthetic_team',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_MODE:'false'});
 delete process.env.STRIPE_ACCOUNT_ID;delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;
 context.after(()=>{for(const key of environmentKeys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}});
 const customer={id:'cus_owned_case_fixture',livemode:false,deleted:false,metadata:{folio_workspace:workspace as unknown}};
 const session={id:'cs_owned_case_fixture',livemode:false,status:'open',customer:customer.id,client_reference_id:workspace as unknown,url:'https://checkout.stripe.com/c/pay/synthetic-case-fixture'};
 const checkout={request_id:requestId,session_id:session.id as string|null,plan_id:'standard',contract_capture:false,idempotency_version:1,created_at:new Date()};
 const calls:string[]=[],locks:string[]=[],savedSessions:string[]=[];
 const replay={enabled:false};
 // This literal is controlled prior payload evidence, not a claim about a real
 // unresolved Stripe nonce or the ability to reconstruct its missing parameters.
 const priorParams={customer:customer.id,mode:'subscription',line_items:[{price:'price_synthetic_standard',quantity:1}],success_url:`${config.origin}/app/usage?checkout=returned`,cancel_url:`${config.origin}/app/usage?checkout=canceled`,client_reference_id:workspace};
 const query=async(sql:unknown,parameters:unknown[]=[])=>{
  assert.equal(typeof sql,'string');
  if(['BEGIN','COMMIT','ROLLBACK'].includes(String(sql)))return {rows:[],rowCount:0};
  if(String(sql).startsWith('select s.* from sessions'))return {rows:[{user_id:user,workspace_id:workspace}],rowCount:1};
  if(sql==='select role from memberships where user_id=$1 and workspace_id=$2'){assert.deepEqual(parameters,[user,workspace]);return {rows:[{role:'owner'}],rowCount:1};}
  if(sql==="select set_config('app.workspace_id',$1,true)"){assert.deepEqual(parameters,[workspace]);return {rows:[],rowCount:1};}
  if(sql==='select pg_advisory_xact_lock(hashtextextended($1,0))'){assert.deepEqual(parameters,[`billing:${workspace}`]);locks.push(String(parameters[0]));return {rows:[],rowCount:1};}
  if(sql==='select * from subscriptions where workspace_id=$1 and billing_mode=$2 for update'){assert.deepEqual(parameters,[workspace,'test']);return {rows:[{customer_id:customer.id,status:'inactive'}],rowCount:1};}
  if(sql==='select customer_id from subscriptions where workspace_id=$1 and billing_mode=$2'){assert.deepEqual(parameters,[workspace,'test']);return {rows:[{customer_id:customer.id}],rowCount:1};}
  if(sql==='select * from billing_checkouts where workspace_id=$1 and billing_mode=$2'){assert.deepEqual(parameters,[workspace,'test']);return {rows:[checkout],rowCount:1};}
  if(sql==='SELECT * FROM checkout_contracts WHERE id=$1'){assert.deepEqual(parameters,[requestId]);return {rows:[],rowCount:0};}
  if(replay.enabled&&sql==='update billing_checkouts set session_id=$4 where workspace_id=$1 and billing_mode=$2 and request_id=$3'){assert.deepEqual(parameters,[workspace,'test',requestId,session.id]);savedSessions.push(String(parameters[3]));return {rows:[],rowCount:1};}
  if(replay.enabled&&sql==='insert into audit_events(workspace_id,user_id,action,entity_id,metadata) values($1,$2,$3,$4,$5)'){assert.deepEqual(parameters,[workspace,user,'billing.checkout_created',null,JSON.stringify({planId:'standard',mode:'test'})]);return {rows:[],rowCount:1};}
  throw new Error('Unexpected database statement in controlled legacy billing fixture');
 };
 for(const pool of [adminPool,appPool]){
  context.mock.method(pool,'query',query);
  context.mock.method(pool,'connect',async()=>({query,release(){}}));
 }
 context.mock.method(globalThis,'fetch',async()=>{throw new Error('Network is prohibited in the controlled billing fixture');});
 const client={
  prices:{retrieve:async(id:string)=>{calls.push('price-read');const plan=PLANS.find(p=>p.id==='standard')!;return {id,livemode:false,active:true,currency:'eur',unit_amount:plan.monthlyPrice*100,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',transform_quantity:null};}},
  customers:{retrieve:async(id:string)=>{assert.equal(id,customer.id);calls.push('customer-read');return customer;},create:async()=>{calls.push('customer-create');throw new Error('Must reuse the legacy customer');}},
  subscriptions:{list:async(input:{customer:string})=>{assert.equal(input.customer,customer.id);calls.push('subscriptions-read');return {data:[],has_more:false};}},
  checkout:{sessions:{retrieve:async(id:string)=>{assert.equal(id,session.id);calls.push('checkout-read');return session;},create:async(input:unknown,options:unknown)=>{calls.push('checkout-create');assert.equal(replay.enabled,true,'Must reuse the existing legacy Checkout');assert.deepEqual(input,priorParams);assert.deepEqual(options,{idempotencyKey:`folio-checkout:${requestId}`});return session;},expire:async()=>{calls.push('checkout-expire');throw new Error('Must preserve the legacy Checkout');}}},
  billingPortal:{sessions:{create:async(input:{customer:string;return_url:string})=>{assert.deepEqual(input,{customer:customer.id,return_url:`${config.origin}/app/usage`});calls.push('portal-create');return {customer:customer.id,livemode:false,url:'https://billing.stripe.com/p/session/synthetic-case-fixture'};}}},
 } as unknown as Stripe;
 const app=Fastify({logger:false});await app.register(cookie);await registerProviders(app,{stripeClient:()=>client});
 context.after(()=>app.close());
 const request=(route:'checkout'|'portal')=>app.inject({method:'POST',url:`/api/billing/${route}`,headers:{cookie:'folio_session=synthetic-owned-case-session','x-workspace-id':workspace.toUpperCase(),origin:config.origin},payload:route==='checkout'?{planId:'standard'}:{}});
 return {customer,session,checkout,calls,locks,savedSessions,replay,priorParams,request};
}

test('legacy customer UUID casing preserves Checkout reuse and portal access without rewriting provider state',async context=>{
 const fixture=await legacyBilling(context);
 for(const value of variants){
  fixture.customer.metadata.folio_workspace=value;
  const before=JSON.stringify({customer:fixture.customer,session:fixture.session,checkout:fixture.checkout});
  const checkout=await fixture.request('checkout');assert.equal(checkout.statusCode,200,checkout.body);assert.equal(checkout.json().url,fixture.session.url);
  const portal=await fixture.request('portal');assert.equal(portal.statusCode,200,portal.body);
  assert.equal(JSON.stringify({customer:fixture.customer,session:fixture.session,checkout:fixture.checkout}),before);
 }
 assert.equal(fixture.locks.length,variants.length);
 assert.equal(fixture.calls.filter(call=>call==='portal-create').length,variants.length);
 assert.ok(!fixture.calls.some(call=>['customer-create','checkout-create','checkout-expire'].includes(call)));
});

test('legacy Checkout UUID casing reuses the exact stored session and original nonce',async context=>{
 const fixture=await legacyBilling(context);
 for(const value of variants){
  fixture.session.client_reference_id=value;
  const before=JSON.stringify(fixture.checkout);
  const response=await fixture.request('checkout');assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().url,fixture.session.url);assert.equal(fixture.session.client_reference_id,value);
  assert.equal(JSON.stringify(fixture.checkout),before);
 }
 assert.equal(fixture.calls.filter(call=>call==='checkout-read').length,variants.length);
 assert.ok(!fixture.calls.some(call=>['customer-create','checkout-create','checkout-expire','portal-create'].includes(call)));
});

test('legacy UUID compatibility rejects foreign and malformed customer or Checkout workspace bindings',async context=>{
 const fixture=await legacyBilling(context);
 for(const value of invalid){
  fixture.customer.metadata.folio_workspace=value;
  const checkout=await fixture.request('checkout');assert.equal(checkout.statusCode,409,checkout.body);
  const portal=await fixture.request('portal');assert.equal(portal.statusCode,409,portal.body);
 }
 assert.equal(fixture.calls.filter(call=>call==='checkout-read').length,0,'Customer identity must fail before Checkout retrieval');
 fixture.customer.metadata.folio_workspace=workspace;
 for(const value of invalid){fixture.session.client_reference_id=value;const response=await fixture.request('checkout');assert.equal(response.statusCode,500,response.body);}
 assert.ok(!fixture.calls.some(call=>['customer-create','checkout-create','checkout-expire','portal-create'].includes(call)));
});

test('same-workspace UUID casing does not relax Stripe mode or exact customer binding',async context=>{
 const fixture=await legacyBilling(context);
 fixture.customer.metadata.folio_workspace=workspace.toUpperCase();fixture.session.client_reference_id=workspace.toUpperCase();
 fixture.customer.livemode=true;
 assert.equal((await fixture.request('checkout')).statusCode,500);assert.equal((await fixture.request('portal')).statusCode,500);
 fixture.customer.livemode=false;fixture.session.livemode=true;
 assert.equal((await fixture.request('checkout')).statusCode,500);
 fixture.session.livemode=false;fixture.session.customer='cus_foreign_case_fixture';
 assert.equal((await fixture.request('checkout')).statusCode,500);
 assert.ok(!fixture.calls.some(call=>['customer-create','checkout-create','checkout-expire','portal-create'].includes(call)));
});

test('durable Checkout nonce replay preserves the known prior payload while checking returned UUID identity',async context=>{
 const fixture=await legacyBilling(context);fixture.replay.enabled=true;fixture.checkout.session_id=null;
 const prior=JSON.stringify({params:fixture.priorParams,requestId:fixture.checkout.request_id,version:fixture.checkout.idempotency_version});
 for(const value of variants){
  fixture.session.client_reference_id=value;
  const response=await fixture.request('checkout');assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().url,fixture.session.url);assert.equal(fixture.session.client_reference_id,value);
  assert.equal(JSON.stringify({params:fixture.priorParams,requestId:fixture.checkout.request_id,version:fixture.checkout.idempotency_version}),prior);
 }
 assert.deepEqual(fixture.savedSessions,variants.map(()=>fixture.session.id));
 for(const value of invalid){fixture.session.client_reference_id=value;const response=await fixture.request('checkout');assert.equal(response.statusCode,500,response.body);}
 assert.equal(fixture.savedSessions.length,variants.length,'Foreign or malformed responses must never bind a local session');
 fixture.session.client_reference_id=workspace;fixture.session.customer='cus_foreign_case_fixture';
 assert.equal((await fixture.request('checkout')).statusCode,500);
 fixture.session.customer=fixture.customer.id;fixture.session.livemode=true;
 assert.equal((await fixture.request('checkout')).statusCode,500);
 assert.equal(fixture.savedSessions.length,variants.length);
 assert.ok(!fixture.calls.some(call=>['customer-create','checkout-expire','checkout-read','portal-create'].includes(call)));
});
