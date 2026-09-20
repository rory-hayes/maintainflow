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
import {registerProviders,reconcileStripeCustomer,storeProviderEvent} from '../server/integrations/providers.js';
import {stripeMode,stripeConfiguration,requireStripeKey,verifyStripePayload,stripePlan,stripePriceMatches,assertStripePortalConfiguration,type StripeMode} from '../server/integrations/provider-policy.js';

const keys=['STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_MODE','RESEND_API_KEY','RESEND_INBOUND_ENABLED'] as const;
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalOrigin=config.origin;
const signing='whsec_owned_billing_mode_fixture';
const accounts:any[]=[],events:string[]=[],sessions=new Map<string,any>(),customers=new Map<string,any>();
const calls:{operation:string;mode:StripeMode;input:any;options?:any}[]=[];
let app:FastifyInstance,actor:any,outsider:any,reader:any,fault='',loseResponse=false;
function mode(value:StripeMode){
 Object.assign(process.env,{STRIPE_MODE:value,STRIPE_SECRET_KEY:`sk_${value}_controlled`,STRIPE_WEBHOOK_SECRET:signing,STRIPE_PRICE_STANDARD:`price_${value}_standard`,STRIPE_PRICE_TEAM:`price_${value}_team`,STRIPE_ACCOUNT_ID:'acct_approved',STRIPE_PORTAL_CONFIGURATION_ID:'bpc_approved',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_MODE:'false',RESEND_INBOUND_ENABLED:'false'});
 delete process.env.RESEND_API_KEY;
}
function price(id:string,live:boolean){return {id,livemode:live,active:true,currency:'eur',unit_amount:id.endsWith('team')?7900:2900,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',transform_quantity:null} as Stripe.Price;}
function subscription(customer:string,value:StripeMode,status='active'){return {id:`sub_${value}_${customer}`,customer,created:100,livemode:value==='live',status,items:{data:[{quantity:1,price:price(`price_${value}_standard`,value==='live')}]}} as Stripe.Subscription;}
function portalConfiguration(value:StripeMode){return {id:'bpc_approved',active:true,livemode:value==='live',features:{subscription_cancel:{enabled:true},subscription_update:{enabled:true,default_allowed_updates:['price'],products:[{product:'prod_approved',prices:[`price_${value}_standard`,`price_${value}_team`]}]}}} as Stripe.BillingPortal.Configuration;}
function client(value:StripeMode):Stripe {
 const call=(operation:string,input:any,options?:any)=>calls.push({operation,mode:value,input,options});
 return {
  accounts:{retrieve:async()=>{call('account',null);return {id:fault==='account'?'acct_wrong':'acct_approved',charges_enabled:fault!=='disabled',payouts_enabled:true,details_submitted:true};}},
  prices:{retrieve:async(id:string)=>{call('price',id);return price(id,fault==='price-mode'?value!=='live':value==='live');}},
  customers:{create:async(input:any,options:any)=>{call('customer-create',input,options);const id=`cus_${value}_${input.metadata.folio_workspace}`;const customer={id,livemode:value==='live',metadata:input.metadata};customers.set(id,customer);return customer;},retrieve:async(id:string)=>{call('customer-read',id);const result=customers.get(id);return fault==='customer-mode'?{...result,livemode:value!=='live'}:result;}},
  subscriptions:{list:async(input:any)=>{call('subscriptions',input);return {data:fault==='active'?[subscription(input.customer,value)]:[],has_more:false};}},
  checkout:{sessions:{
   create:async(input:any,options:any)=>{call('checkout-create',input,options);let result=sessions.get(options.idempotencyKey);if(!result){result={id:`cs_${randomUUID()}`,livemode:value==='live',status:'open',customer:input.customer,client_reference_id:input.client_reference_id,url:'https://checkout.stripe.com/c/pay/controlled'};sessions.set(options.idempotencyKey,result);}if(loseResponse){loseResponse=false;throw new Error('Controlled lost Checkout response');}return fault==='session-mode'?{...result,livemode:value!=='live'}:result;},
   retrieve:async(id:string)=>{call('checkout-read',id);return [...sessions.values()].find(s=>s.id===id);},expire:async(id:string)=>{call('checkout-expire',id);const s=[...sessions.values()].find(s=>s.id===id);s.status='expired';return s;},
  }},
  billingPortal:{configurations:{retrieve:async()=>{call('portal-config',null);const result=portalConfiguration(value);if(fault==='portal-price')result.features.subscription_update.products![0]!.prices=['price_unapproved'];return result;}},sessions:{create:async(input:any)=>{call('portal-create',input);return {url:'https://billing.stripe.com/p/session/controlled',livemode:value==='live',customer:input.customer};}}},
 } as unknown as Stripe;
}
const request=(url:string,payload:unknown={},account=actor,headers:Record<string,string>={})=>app.inject({method:'POST',url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin,...headers}});
async function signup(){const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Controlled billing fixture',email:`billing-${randomUUID()}@example.test`,password:'controlled billing fixture password',workspaceName:'Controlled billing fixture'}});assert.equal(response.statusCode,201,response.body);const value={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(value);return value;}
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
test('signed webhooks require mode and reject altered, stale, missing-mode and Connect payloads',()=>{
 for(const value of ['test','live'] as const){const payload={id:`evt_${randomUUID()}`,type:'customer.subscription.updated',created:100,livemode:value==='live',data:{object:{customer:'cus_fixture'}}};
 const check=(body:any,expected:StripeMode=value)=>{const raw=JSON.stringify(body),signature=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing});return verifyStripePayload(Buffer.from(raw),signature,signing,expected);};
 assert.equal(check(payload).livemode,value==='live');assert.throws(()=>check(payload,value==='test'?'live':'test'));assert.throws(()=>check({...payload,livemode:undefined}));assert.throws(()=>check({...payload,account:'acct_connected'}));
 const raw=JSON.stringify(payload),signature=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing});assert.throws(()=>verifyStripePayload(Buffer.from(raw+' '),signature,signing,value));const stale=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:signing,timestamp:1});assert.throws(()=>verifyStripePayload(Buffer.from(raw),stale,signing,value));}
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
