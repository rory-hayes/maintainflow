import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Stripe from 'stripe';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool,closeDatabase} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {validatePreviewConfiguration} from '../server/core/preview.js';
import {registerProviders,reconcileStripeCustomer,storeProviderEvent} from '../server/integrations/providers.js';
import {stripeMode,stripeConfiguration,requireStripeKey,verifyStripePayload,stripePlan,stripePriceMatches,assertStripePortalConfiguration,type StripeMode} from '../server/integrations/provider-policy.js';

const keys=['STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','STRIPE_TEST_CLOCK_ID','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_MODE','FOLIO_PREVIEW_STRIPE_TEST','FOLIO_PREVIEW_INVITE_CODE','APP_ORIGIN','RESEND_API_KEY','RESEND_INBOUND_ENABLED'] as const;
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalOrigin=config.origin;
const signing='whsec_owned_billing_mode_fixture';
const accounts:any[]=[],events:string[]=[],sessions=new Map<string,any>(),customers=new Map<string,any>();
const calls:{operation:string;mode:StripeMode;input:any;options?:any}[]=[];
let app:FastifyInstance,actor:any,outsider:any,reader:any,fault='',loseResponse=false;
function mode(value:StripeMode){
 Object.assign(process.env,{STRIPE_MODE:value,STRIPE_SECRET_KEY:`sk_${value}_controlled`,STRIPE_WEBHOOK_SECRET:signing,STRIPE_PRICE_STANDARD:`price_${value}_standard`,STRIPE_PRICE_TEAM:`price_${value}_team`,STRIPE_ACCOUNT_ID:'acct_approved',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_approved',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_MODE:'false',RESEND_INBOUND_ENABLED:'false'});
 delete process.env.RESEND_API_KEY;delete process.env.STRIPE_TEST_CLOCK_ID;delete process.env.FOLIO_PREVIEW_STRIPE_TEST;delete process.env.FOLIO_PREVIEW_INVITE_CODE;
 if(original.APP_ORIGIN===undefined)delete process.env.APP_ORIGIN;else process.env.APP_ORIGIN=original.APP_ORIGIN;
}
function price(id:string,live:boolean){return {id,livemode:live,active:true,currency:'eur',unit_amount:id.endsWith('team')?4900:1900,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',transform_quantity:null} as Stripe.Price;}
function subscription(customer:string,value:StripeMode,status='active'){return {id:`sub_${value}_${customer}`,customer,created:100,livemode:value==='live',status,items:{data:[{quantity:1,price:price(`price_${value}_standard`,value==='live')}]}} as Stripe.Subscription;}
function portalConfiguration(value:StripeMode){return {id:'bpc_approved',active:true,livemode:value==='live',features:{subscription_cancel:{enabled:true},subscription_update:{enabled:true,default_allowed_updates:['price'],products:[{product:'prod_approved',prices:[`price_${value}_standard`,`price_${value}_team`]}]}}} as Stripe.BillingPortal.Configuration;}
function client(value:StripeMode):Stripe {
 const call=(operation:string,input:any,options?:any)=>calls.push({operation,mode:value,input,options});
 return {
  accounts:{retrieve:async()=>{call('account',null);return {id:fault==='account'?'acct_wrong':'acct_approved',charges_enabled:!['disabled','charges-disabled','not-live-ready'].includes(fault),payouts_enabled:!['payouts-disabled','not-live-ready'].includes(fault),details_submitted:!['details-missing','not-live-ready'].includes(fault)};}},
  prices:{retrieve:async(id:string)=>{call('price',id);return price(id,fault==='price-mode'?value!=='live':value==='live');}},
  customers:{create:async(input:any,options:any)=>{call('customer-create',input,options);const id=`cus_${value}_${input.metadata.folio_workspace}`;const customer={id,livemode:value==='live',metadata:input.metadata,...(input.test_clock?{test_clock:fault==='created-clock-missing'?null:fault==='created-clock-wrong'?'clock_other':input.test_clock}:{})};customers.set(id,customer);return customer;},retrieve:async(id:string)=>{call('customer-read',id);const result=customers.get(id);return fault==='customer-mode'?{...result,livemode:value!=='live'}:result;}},
  subscriptions:{list:async(input:any)=>{call('subscriptions',input);return {data:fault==='active'?[subscription(input.customer,value)]:[],has_more:false};}},
  checkout:{sessions:{
   create:async(input:any,options:any)=>{call('checkout-create',input,options);let result=sessions.get(options.idempotencyKey);if(!result){result={id:`cs_${randomUUID()}`,livemode:value==='live',status:'open',customer:input.customer,client_reference_id:input.client_reference_id,url:'https://checkout.stripe.com/c/pay/controlled'};sessions.set(options.idempotencyKey,result);}if(loseResponse){loseResponse=false;throw new Error('Controlled lost Checkout response');}return fault==='session-mode'?{...result,livemode:value!=='live'}:result;},
   retrieve:async(id:string)=>{call('checkout-read',id);return [...sessions.values()].find(s=>s.id===id);},expire:async(id:string)=>{call('checkout-expire',id);const s=[...sessions.values()].find(s=>s.id===id);s.status='expired';return s;},
  }},
  billingPortal:{configurations:{retrieve:async()=>{call('portal-config',null);const result=portalConfiguration(value);if(fault==='portal-price')result.features.subscription_update.products![0]!.prices=['price_unapproved'];return result;}},sessions:{create:async(input:any)=>{call('portal-create',input);return {url:'https://billing.stripe.com/p/session/controlled',livemode:value==='live',customer:input.customer};}}},
 } as unknown as Stripe;
}
const request=(url:string,payload:unknown={},account=actor,headers:Record<string,string>={})=>app.inject({method:'POST',url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin,...headers}});
async function signup(inviteCode?:string){const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Controlled billing fixture',email:`billing-${randomUUID()}@example.test`,password:'controlled billing fixture password',workspaceName:'Controlled billing fixture',...(inviteCode===undefined?{}:{inviteCode})}});assert.equal(response.statusCode,201,response.body);const value={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(value);return value;}
before(async()=>{
 config.origin='https://folio-billing.example.test';mode('test');
 app=Fastify({logger:false});await app.register(cookie);await app.register(multipart);
 app.setErrorHandler((error:any,_request,reply)=>reply.code(error instanceof ZodError?400:error.statusCode||500).send({error:error.message}));
 await registerCore(app);await registerProviders(app,{stripeClient:settings=>client(settings.mode)});await app.ready();
 actor=await signup();outsider=await signup();reader=await signup();
 await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')",[actor.workspace.id,reader.user.id]);
});
after(async()=>{
 await app?.close();for(const account of accounts)await adminPool.query('delete from workspaces where id=$1',[account.workspace.id]);
 for(const account of accounts)await adminPool.query('delete from users where id=$1',[account.user.id]);
 if(events.length)await adminPool.query('delete from provider_events where id=any($1)',[events]);
 for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}config.origin=originalOrigin;await closeDatabase();
});

test('billing mode is explicit, defaults to test, and mismatched/unsafe live configuration fails closed',()=>{
 assert.equal(stripeMode({}),'test');assert.throws(()=>stripeMode({STRIPE_MODE:'LIVE'}));
 for(const selected of ['test','live'] as const){assert.equal(requireStripeKey(`rk_${selected}_fixture`,selected),`rk_${selected}_fixture`);assert.throws(()=>requireStripeKey(`sk_${selected==='live'?'test':'live'}_fixture`,selected));}
 mode('live');const valid={...process.env};assert.equal(stripeConfiguration(valid,config.origin).mode,'live');
 for(const patch of [{STRIPE_MODE:undefined},{STRIPE_SECRET_KEY:'sk_test_fixture'},{FOLIO_BILLING_MOCK:'true'},{FOLIO_PREVIEW_MODE:'true'},{STRIPE_ACCOUNT_ID:undefined},{STRIPE_PORTAL_CONFIGURATION_ID:undefined},{STRIPE_PRICE_TEAM:undefined},{STRIPE_PRICE_TEAM:valid.STRIPE_PRICE_STANDARD}])assert.throws(()=>stripeConfiguration({...valid,...patch},config.origin));
 for(const origin of ['http://example.test','https://localhost','https://example.test/path','https://example.test/?redirect=bad'])assert.throws(()=>stripeConfiguration(valid,origin));mode('test');
});
test('exact plan and portal mappings work for live and test without widening prices or quantities',()=>{
 for(const value of ['test','live'] as const){const prices={standard:`price_${value}_standard`,team:`price_${value}_team`},s=subscription('cus_fixture',value);assert.equal(stripePlan(s,prices,value),'standard');assert.equal(stripePlan(s,prices,value==='live'?'test':'live'),null);
 for(const patch of [{currency:'usd'},{unit_amount:1},{transform_quantity:{divide_by:2,round:'up'}},{recurring:{interval:'year',interval_count:1}},{recurring:{interval:'month',interval_count:1,usage_type:'metered'}}])assert.equal(stripePriceMatches({...s.items.data[0]!.price,...patch} as Stripe.Price,'standard',prices,value),false);
 const portal=portalConfiguration(value);assert.doesNotThrow(()=>assertStripePortalConfiguration(portal,prices,value));portal.features.subscription_update.default_allowed_updates.push('quantity');assert.throws(()=>assertStripePortalConfiguration(portal,prices,value));}
});
test('retired preview prices cannot grant the new paid entitlements',()=>{
 for(const value of ['test','live'] as const){
  const prices={standard:`price_${value}_standard`,team:`price_${value}_team`};
  for(const [plan,oldAmount] of [['standard',2900],['team',7900]] as const){
   const oldPrice={...price(prices[plan],value==='live'),unit_amount:oldAmount};
   assert.equal(stripePriceMatches(oldPrice,plan,prices,value),false);
   const active=subscription('cus_fixture',value);
   active.items.data[0]!.price=oldPrice;
   assert.equal(stripePlan(active,prices,value),null);
  }
 }
});
test('signed webhooks require mode and reject altered, stale, missing-mode and Connect payloads',()=>{
 for(const value of ['test','live'] as const){const payload={id:`evt_${randomUUID()}`,type:'customer.subscription.updated',created:100,livemode:value==='live',data:{object:{customer:'cus_fixture'}}};
 const check=(body:any,expected:StripeMode=value)=>{const raw=JSON.stringify(body),signature=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing});return verifyStripePayload(Buffer.from(raw),signature,signing,expected);};
 assert.equal(check(payload).livemode,value==='live');assert.throws(()=>check(payload,value==='test'?'live':'test'));assert.throws(()=>check({...payload,livemode:undefined}));assert.throws(()=>check({...payload,account:'acct_connected'}));
 const raw=JSON.stringify(payload),signature=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing});assert.throws(()=>verifyStripePayload(Buffer.from(raw+' '),signature,signing,value));const stale=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing,timestamp:1});assert.throws(()=>verifyStripePayload(Buffer.from(raw),stale,signing,value));}
});
test('opted-in private TEST preview keeps registration invite-gated and Checkout unentitled',async()=>{
 mode('test');const invite='owned-private-stripe-test-preview-'.repeat(2);
 Object.assign(process.env,{FOLIO_PREVIEW_MODE:'true',FOLIO_PREVIEW_STRIPE_TEST:'true',FOLIO_PREVIEW_INVITE_CODE:invite,APP_ORIGIN:config.origin});
 try{
  assert.doesNotThrow(()=>validatePreviewConfiguration());
  const counts=async()=>(await adminPool.query('select (select count(*)::int from users) users,(select count(*)::int from workspaces) workspaces,(select count(*)::int from memberships) memberships')).rows[0];
  const beforeCounts=await counts(),beforeCalls=calls.length;
  for(const inviteCode of [undefined,invite+'wrong']){
   const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Denied private TEST preview fixture',workspaceName:'Denied private TEST preview workspace',email:`denied-preview-${randomUUID()}@example.test`,password:'controlled private preview password',...(inviteCode===undefined?{}:{inviteCode})}});
   assert.equal(response.statusCode,403,response.body);assert.match(response.json().error,/invite code is required/);
   assert.deepEqual(await counts(),beforeCounts);assert.equal(calls.length,beforeCalls);
  }
  const owner=await signup(invite);
  assert.deepEqual(await counts(),{users:beforeCounts.users+1,workspaces:beforeCounts.workspaces+1,memberships:beforeCounts.memberships+1});
  assert.equal(owner.workspace.role,'owner');assert.equal(owner.workspace.plan.id,'explore');assert.equal(calls.length,beforeCalls);
  const planBefore=(await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows;
  const usageResponse=await app.inject({method:'GET',url:'/api/workspace/usage',headers:{cookie:owner.cookie,origin:config.origin}});assert.equal(usageResponse.statusCode,200,usageResponse.body);const usageBefore=usageResponse.json();
  fault='account';let start=calls.length;
  let response=await request('/api/billing/checkout',{planId:'standard'},owner);
  assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/approved billing account/);assert.deepEqual(calls.slice(start).map(call=>call.operation),['account']);
  assert.deepEqual((await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows,[]);assert.deepEqual((await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows,[]);
  fault='not-live-ready';start=calls.length;
  response=await request('/api/billing/checkout',{planId:'standard'},owner);
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().mode,'test');
  const observed=calls.slice(start);assert.deepEqual(observed.map(call=>call.operation),['account','price','customer-create','subscriptions','checkout-create']);assert.ok(observed.every(call=>call.mode==='test'));
  assert.equal(observed.find(call=>call.operation==='price')!.input,'price_test_standard');
  const created=observed.find(call=>call.operation==='customer-create')!;assert.equal(created.input.metadata.folio_workspace,owner.workspace.id);assert.equal(created.options.idempotencyKey,`folio-customer:test:${owner.workspace.id}`);
  const checkouts=(await adminPool.query('select billing_mode,request_id,session_id from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows;assert.equal(checkouts.length,1);assert.equal(checkouts[0].billing_mode,'test');assert.ok(checkouts[0].session_id);
  assert.equal(observed.find(call=>call.operation==='checkout-create')!.options.idempotencyKey,`folio-checkout:test:${checkouts[0].request_id}`);
  assert.deepEqual((await adminPool.query('select billing_mode,customer_id from subscriptions where workspace_id=$1',[owner.workspace.id])).rows,[{billing_mode:'test',customer_id:`cus_test_${owner.workspace.id}`}]);
  assert.deepEqual((await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows,planBefore);
  const usageAfter=await app.inject({method:'GET',url:'/api/workspace/usage',headers:{cookie:owner.cookie,origin:config.origin}});assert.equal(usageAfter.statusCode,200,usageAfter.body);assert.deepEqual(usageAfter.json(),usageBefore);
 }finally{fault='';mode('test');}
});
test('test and live Checkouts have separate customers, reservations and durable retry keys',async()=>{
 mode('test');let response=await request('/api/billing/checkout',{planId:'standard'});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().mode,'test');
 mode('live');response=await request('/api/billing/checkout',{planId:'standard'});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().mode,'live');
 const rows=(await adminPool.query('select billing_mode,customer_id from subscriptions where workspace_id=$1 order by billing_mode',[actor.workspace.id])).rows;assert.deepEqual(rows.map(r=>r.billing_mode),['live','test']);assert.notEqual(rows[0].customer_id,rows[1].customer_id);
 assert.equal((await adminPool.query('select count(*)::int n from billing_checkouts where workspace_id=$1',[actor.workspace.id])).rows[0].n,2);
 const before=calls.filter(c=>c.operation==='checkout-create').length;response=await request('/api/billing/checkout',{planId:'standard'});assert.equal(response.statusCode,200);assert.equal(calls.filter(c=>c.operation==='checkout-create').length,before);
 assert.ok(calls.filter(c=>c.operation==='checkout-create').every(c=>c.options.idempotencyKey.startsWith(`folio-checkout:${c.mode}:`)));
});
test('lost Checkout response replays the persisted nonce once, and legacy test nonce retains its original key',async()=>{
 mode('test');const owner=await signup();loseResponse=true;assert.equal((await request('/api/billing/checkout',{planId:'team'},owner)).statusCode,500);
 const before=(await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows[0];assert.equal(before.session_id,null);
 assert.equal((await request('/api/billing/checkout',{planId:'team'},owner)).statusCode,200);
 const created=calls.filter(c=>c.operation==='checkout-create'&&c.input.client_reference_id===owner.workspace.id);assert.equal(created.length,2);assert.equal(created[0].options.idempotencyKey,created[1].options.idempotencyKey);
 const legacy=await signup(),customerId=`cus_test_${legacy.workspace.id}`,requestId=randomUUID();customers.set(customerId,{id:customerId,livemode:false,metadata:{folio_workspace:legacy.workspace.id}});
 await adminPool.query('insert into subscriptions(workspace_id,customer_id) values($1,$2)',[legacy.workspace.id,customerId]);await adminPool.query("insert into billing_checkouts(workspace_id,plan_id,request_id,idempotency_version) values($1,'standard',$2,1)",[legacy.workspace.id,requestId]);
 assert.equal((await request('/api/billing/checkout',{planId:'standard'},legacy)).statusCode,200);assert.equal(calls.at(-1)!.options.idempotencyKey,`folio-checkout:${requestId}`);
});
test('an opt-in test clock binds new customers and accepts the same expanded clock without changing retry identities',async()=>{
 mode('test');const ordinary=await signup();
 assert.equal((await request('/api/billing/checkout',{planId:'standard'},ordinary)).statusCode,200);
 const ordinaryCreate=calls.find(c=>c.operation==='customer-create'&&c.input.metadata.folio_workspace===ordinary.workspace.id)!;
 assert.equal(Object.hasOwn(ordinaryCreate.input,'test_clock'),false);
 const owner=await signup(),clock='clock_OwnedSandbox123';process.env.STRIPE_TEST_CLOCK_ID=clock;
 try{
  assert.equal((await request('/api/billing/checkout',{planId:'standard'},owner)).statusCode,200);
  const created=calls.filter(c=>c.operation==='customer-create'&&c.input.metadata.folio_workspace===owner.workspace.id);
  assert.equal(created.length,1);assert.equal(created[0]!.input.test_clock,clock);assert.equal(created[0]!.options.idempotencyKey,`folio-customer:test:${owner.workspace.id}`);
  const checkout=(await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows;
  const customerId=`cus_test_${owner.workspace.id}`,customer=customers.get(customerId);customers.set(customerId,{...customer,test_clock:{id:clock}});
  const before=calls.length;assert.equal((await request('/api/billing/checkout',{planId:'standard'},owner)).statusCode,200);
  assert.deepEqual(calls.slice(before).map(c=>c.operation),['account','price','customer-read','subscriptions','checkout-read']);
  assert.deepEqual((await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows,checkout);
  assert.equal((await request('/api/billing/portal',{},owner)).statusCode,200);
  assert.equal(calls.filter(c=>c.operation==='customer-create'&&c.input.metadata.folio_workspace===owner.workspace.id).length,1);
 }finally{mode('test');}
});
test('missing or mismatched clocks returned by customer creation are not persisted or used for Checkout',async()=>{
 mode('test');process.env.STRIPE_TEST_CLOCK_ID='clock_OwnedSandbox123';
 try{
  for(const issue of ['created-clock-missing','created-clock-wrong']){
   const owner=await signup(),before=calls.length;fault=issue;
   const response=await request('/api/billing/checkout',{planId:'standard'},owner);assert.equal(response.statusCode,500,response.body);assert.match(response.json().error,/test clock/);
   assert.deepEqual(calls.slice(before).map(c=>c.operation),['account','price','customer-create']);
   assert.equal((await adminPool.query('select count(*)::int n from subscriptions where workspace_id=$1',[owner.workspace.id])).rows[0].n,0);
   assert.equal((await adminPool.query('select count(*)::int n from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows[0].n,0);
  }
 }finally{fault='';mode('test');}
});
test('existing customers cannot be rebound to a missing or different clock by Checkout or portal',async()=>{
 mode('test');const owner=await signup();assert.equal((await request('/api/billing/checkout',{planId:'standard'},owner)).statusCode,200);
 const customerId=`cus_test_${owner.workspace.id}`,customer=customers.get(customerId);
 const beforeSubscriptions=(await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows;
 const beforeCheckouts=(await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows;
 process.env.STRIPE_TEST_CLOCK_ID='clock_OwnedSandbox123';
 try{
  for(const test_clock of [undefined,null,'clock_other',{id:'clock_other'}]){
   customers.set(customerId,{...customer,test_clock});
   for(const [path,payload,operations] of [['/api/billing/checkout',{planId:'standard'},['account','price','customer-read']],['/api/billing/portal',{},['account','customer-read']]] as const){
    const before=calls.length,response=await request(path,payload,owner);assert.equal(response.statusCode,500,response.body);assert.match(response.json().error,/test clock/);
    assert.deepEqual(calls.slice(before).map(c=>c.operation),operations);
   }
   assert.deepEqual((await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows,beforeSubscriptions);
   assert.deepEqual((await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows,beforeCheckouts);
  }
  // A matching clock cannot substitute for the existing mode or workspace checks.
  customers.set(customerId,{...customer,test_clock:'clock_OwnedSandbox123',metadata:{folio_workspace:outsider.workspace.id}});
  assert.equal((await request('/api/billing/portal',{},owner)).statusCode,409);
  customers.set(customerId,{...customer,test_clock:'clock_OwnedSandbox123',livemode:true});
  assert.equal((await request('/api/billing/checkout',{planId:'standard'},owner)).statusCode,500);
 }finally{customers.set(customerId,customer);mode('test');}
});
test('live clocks and public clock selection fail before Stripe transport',async()=>{
 mode('live');process.env.STRIPE_TEST_CLOCK_ID='clock_OwnedSandbox123';let before=calls.length;
 assert.equal((await request('/api/billing/checkout',{planId:'standard'})).statusCode,503);
 assert.equal((await request('/api/billing/portal')).statusCode,503);assert.equal(calls.length,before);
 mode('test');before=calls.length;
 for(const field of ['testClockId','test_clock']){
  assert.equal((await request('/api/billing/checkout',{planId:'standard',[field]:'clock_untrusted'})).statusCode,400);
  assert.equal((await request('/api/billing/portal',{[field]:'clock_untrusted'})).statusCode,400);
 }
 assert.equal(calls.length,before);
});
test('clock-bound reconciliation refuses mismatched customers without persisting entitlement or event bindings',async()=>{
 mode('test');const owner=await signup();assert.equal((await request('/api/billing/checkout',{planId:'standard'},owner)).statusCode,200);
 const customerId=`cus_test_${owner.workspace.id}`,customer=customers.get(customerId),clock='clock_OwnedSandbox123';
 const pointer={id:`evt_${randomUUID()}`,type:'customer.subscription.updated',created:200,customerId,mode:'test' as const};events.push(`stripe:${pointer.id}`);await storeProviderEvent('stripe',pointer.id,pointer);
 const beforeSubscription=(await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows;
 const beforePlan=(await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows;
 process.env.STRIPE_TEST_CLOCK_ID=clock;
 try{
  const before=calls.length;await assert.rejects(reconcileStripeCustomer(pointer,client('test')),/test clock/);
  assert.deepEqual(calls.slice(before).map(c=>c.operation),['account','customer-read']);
  assert.deepEqual((await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows,beforeSubscription);
  assert.deepEqual((await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows,beforePlan);
  assert.equal((await adminPool.query('select count(*)::int n from provider_event_workspaces where event_id=$1',[`stripe:${pointer.id}`])).rows[0].n,0);
  customers.set(customerId,{...customer,test_clock:{id:clock}});fault='active';await reconcileStripeCustomer(pointer,client('test'));
  assert.equal((await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows[0].plan.id,'standard');
 }finally{fault='';customers.set(customerId,customer);mode('test');}
});
test('matching test account can create sandbox Checkout before live activation without granting paid entitlements',async()=>{
 mode('test');const owner=await signup();
 const planBefore=(await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows;
 const usageBefore=(await adminPool.query('select * from usage_ledger where workspace_id=$1',[owner.workspace.id])).rows;
 const before=calls.length;fault='not-live-ready';
 try{
  const response=await request('/api/billing/checkout',{planId:'standard'},owner);
  assert.equal(response.statusCode,200,response.body);assert.equal(response.json().mode,'test');
  const observed=calls.slice(before);assert.deepEqual(observed.map(call=>call.operation),['account','price','customer-create','subscriptions','checkout-create']);assert.ok(observed.every(call=>call.mode==='test'));
  assert.equal(observed.find(call=>call.operation==='customer-create')!.options.idempotencyKey,`folio-customer:test:${owner.workspace.id}`);
  const stored=(await adminPool.query('select billing_mode,customer_id from subscriptions where workspace_id=$1',[owner.workspace.id])).rows;
  assert.deepEqual(stored,[{billing_mode:'test',customer_id:`cus_test_${owner.workspace.id}`}]);
  const checkout=(await adminPool.query('select billing_mode,request_id,session_id from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows;assert.equal(checkout.length,1);assert.equal(checkout[0].billing_mode,'test');assert.ok(checkout[0].session_id);
  assert.equal(observed.find(call=>call.operation==='checkout-create')!.options.idempotencyKey,`folio-checkout:test:${checkout[0].request_id}`);
  assert.deepEqual((await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows,planBefore);
  assert.deepEqual((await adminPool.query('select * from usage_ledger where workspace_id=$1',[owner.workspace.id])).rows,usageBefore);
 }finally{fault='';mode('test');}
});
test('live Checkout rejects each missing activation flag and all flags missing before customer or reservation creation',async()=>{
 mode('live');const owner=await signup();
 const planBefore=(await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows;
 try{
  for(const issue of ['charges-disabled','payouts-disabled','details-missing','not-live-ready']){
   const before=calls.length;fault=issue;const response=await request('/api/billing/checkout',{planId:'standard'},owner);
   assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/not ready to accept payments/);
   assert.deepEqual(calls.slice(before).map(call=>call.operation),['account']);
  }
  assert.deepEqual((await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows,[]);
  assert.deepEqual((await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows,[]);
  assert.deepEqual((await adminPool.query('select * from audit_events where workspace_id=$1',[owner.workspace.id])).rows,[]);
  assert.deepEqual((await adminPool.query('select plan from workspaces where id=$1',[owner.workspace.id])).rows,planBefore);
 }finally{fault='';mode('test');}
});
test('test and live Checkout both reject the wrong account before customer or reservation creation',async()=>{
 try{
  for(const selected of ['test','live'] as const){
   mode(selected);const owner=await signup(),before=calls.length;fault='account';
   const response=await request('/api/billing/checkout',{planId:'standard'},owner);
   assert.equal(response.statusCode,503,response.body);assert.match(response.json().error,/approved billing account/);
   assert.deepEqual(calls.slice(before).map(call=>call.operation),['account']);
   assert.deepEqual((await adminPool.query('select * from subscriptions where workspace_id=$1',[owner.workspace.id])).rows,[]);
   assert.deepEqual((await adminPool.query('select * from billing_checkouts where workspace_id=$1',[owner.workspace.id])).rows,[]);
   assert.deepEqual((await adminPool.query('select * from audit_events where workspace_id=$1',[owner.workspace.id])).rows,[]);
   fault='';
  }
 }finally{fault='';mode('test');}
});
test('live account eligibility, exact price and customer mode fail before Checkout creation',async()=>{
 mode('live');const before=calls.filter(c=>c.operation==='checkout-create').length;
 for(const issue of ['account','disabled','price-mode','customer-mode']){fault=issue;assert.notEqual((await request('/api/billing/checkout',{planId:'team'})).statusCode,200);}
 fault='';assert.equal(calls.filter(c=>c.operation==='checkout-create').length,before);
 process.env.STRIPE_SECRET_KEY='sk_test_fixture';const transportBefore=calls.length;assert.equal((await request('/api/billing/checkout',{planId:'standard'})).statusCode,503);assert.equal(calls.length,transportBefore);mode('live');
});
test('live portal uses the mode customer and validated approved configuration',async()=>{
 mode('live');const result=await request('/api/billing/portal');assert.equal(result.statusCode,200,result.body);assert.equal(result.json().mode,'live');const last=calls.at(-1)!;assert.equal(last.operation,'portal-create');assert.equal(last.input.configuration,'bpc_approved');assert.match(last.input.customer,/^cus_live_/);
 const before=calls.filter(c=>c.operation==='portal-create').length;fault='portal-price';assert.equal((await request('/api/billing/portal')).statusCode,500);fault='';assert.equal(calls.filter(c=>c.operation==='portal-create').length,before);
 // Read/manage remains available when charging is disabled, so existing customers can cancel.
 fault='disabled';assert.equal((await request('/api/billing/portal')).statusCode,200);fault='';
});
test('live routes retain session, role, tenant and mock protection before transport',async()=>{
 mode('live');const before=calls.length;
 assert.equal((await request('/api/billing/checkout',{planId:'standard'},reader,{'x-workspace-id':actor.workspace.id})).statusCode,403);
 assert.equal((await request('/api/billing/portal',{},outsider,{'x-workspace-id':actor.workspace.id})).statusCode,403);
 assert.equal((await request('/api/billing/checkout',{planId:'standard',priceId:'price_unapproved'})).statusCode,400);
 assert.equal((await request('/api/billing/checkout',{planId:'standard'},actor,{origin:'https://attacker.example.test'})).statusCode,403);
 process.env.FOLIO_BILLING_MOCK='true';assert.equal((await request('/api/billing/checkout',{planId:'standard'})).statusCode,409);assert.equal((await request('/api/billing/portal')).statusCode,409);process.env.FOLIO_BILLING_MOCK='false';assert.equal(calls.length,before);
});
test('live signed webhook durably carries mode; wrong mode is never queued',async()=>{
 mode('live');const id=`evt_${randomUUID()}`,raw=JSON.stringify({id,type:'invoice.paid',created:100,livemode:true,data:{object:{customer:`cus_live_${actor.workspace.id}`}}}),headers={'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing})};events.push(`stripe:${id}`);
 const result=await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers});assert.equal(result.statusCode,202,result.body);assert.equal(result.json().duplicate,false);assert.equal((await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers})).json().duplicate,true);
 assert.equal((await adminPool.query('select payload from provider_events where id=$1',[`stripe:${id}`])).rows[0].payload.mode,'live');mode('test');assert.equal((await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers})).statusCode,400);mode('live');
});
test('late test events cannot overwrite live entitlements; live cancellation reconciles current state',async()=>{
 mode('live');const customer=`cus_live_${actor.workspace.id}`,pointer={id:`evt_${randomUUID()}`,type:'customer.subscription.updated',created:200,customerId:customer,mode:'live' as const};events.push(`stripe:${pointer.id}`);await storeProviderEvent('stripe',pointer.id,pointer);
 let current=subscription(customer,'live');const controlled=client('live');controlled.subscriptions.list=(async()=>({data:[current],has_more:false})) as any;
 await reconcileStripeCustomer(pointer,controlled);let plan=(await adminPool.query('select plan from workspaces where id=$1',[actor.workspace.id])).rows[0].plan;assert.equal(plan.id,'standard');assert.equal(plan.billingMode,'live');
 const before=calls.length;await reconcileStripeCustomer({...pointer,mode:'test'},controlled);await reconcileStripeCustomer({...pointer,mode:undefined},controlled);assert.equal(calls.length,before);assert.deepEqual((await adminPool.query('select plan from workspaces where id=$1',[actor.workspace.id])).rows[0].plan,plan);
 current=subscription(customer,'live','canceled');await reconcileStripeCustomer({...pointer,created:100},controlled);plan=(await adminPool.query('select plan from workspaces where id=$1',[actor.workspace.id])).rows[0].plan;assert.equal(plan.id,'explore');assert.equal(plan.billingMode,'live');assert.equal(Number((await adminPool.query("select event_created from subscriptions where workspace_id=$1 and billing_mode='live'",[actor.workspace.id])).rows[0].event_created),200);
});
test('mode schema preserves distinct rows and rejects invalid live legacy replay identity',async()=>{
 await assert.rejects(adminPool.query("update subscriptions set billing_mode='invalid' where workspace_id=$1",[actor.workspace.id]),/check constraint/);
 await assert.rejects(adminPool.query("update billing_checkouts set idempotency_version=1 where workspace_id=$1 and billing_mode='live'",[actor.workspace.id]),/check constraint/);
 assert.equal((await adminPool.query('select count(*)::int n from usage_ledger where workspace_id=any($1)',[accounts.map(a=>a.workspace.id)])).rows[0].n,0);
});
