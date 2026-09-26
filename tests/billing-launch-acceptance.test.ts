/** Controlled billing lifecycle only. Requires a disposable copied database or CI. */
import test,{before,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Stripe from 'stripe';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool,appPool,closeDatabase,databaseSchema} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {setStorageForTests,type PrivateStorage} from '../server/core/storage.js';
import {registerProviders,reconcileStripeCustomer} from '../server/integrations/providers.js';
import {PLANS} from '../shared/plans.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
const envKeys=['STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_MODE','RESEND_API_KEY','RESEND_INBOUND_ENABLED'] as const;
const original=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const accounts:Account[]=[],eventIds:string[]=[],objects=new Map<string,Buffer>(),customers=new Map<string,Stripe.Customer>(),snapshots=new Map<string,Stripe.Subscription[]>();
const calls:string[]=[],secret='whsec_owned_billing_launch_fixture',originalOrigin=config.origin;
let app:FastifyInstance,localVerified=false,networkCalls=0,hasMore=false;
const storage:PrivateStorage={kind:'supabase',async write(key,bytes){objects.set(key,Buffer.from(bytes));},async read(key){const bytes=objects.get(key);assert.ok(bytes);return Buffer.from(bytes);},async remove(key){objects.delete(key);}};
function price(planId:'standard'|'team'):Stripe.Price{const plan=PLANS.find(p=>p.id===planId)!;return {id:`price_launch_${planId}`,livemode:false,active:true,currency:'eur',unit_amount:plan.monthlyPrice*100,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',transform_quantity:null} as Stripe.Price;}
function subscription(customer:string,status:Stripe.Subscription.Status,planId:'standard'|'team'='standard',cancelAtPeriodEnd=false):Stripe.Subscription{return {id:`sub_${customer}`,customer,created:100,livemode:false,status,cancel_at_period_end:cancelAtPeriodEnd,items:{data:[{quantity:1,price:price(planId)}]}} as Stripe.Subscription;}
const client={
 prices:{retrieve:async(id:string)=>{calls.push('price');return price(id.endsWith('team')?'team':'standard');}},
 customers:{create:async(input:any)=>{calls.push('customer-create');const result={id:`cus_${input.metadata.folio_workspace}`,livemode:false,metadata:input.metadata} as Stripe.Customer;customers.set(result.id,result);return result;},retrieve:async(id:string)=>{calls.push('customer-read');return customers.get(id);}},
 subscriptions:{list:async({customer}:{customer:string})=>{calls.push('subscriptions');return {data:snapshots.get(customer)??[],has_more:hasMore};}},
 checkout:{sessions:{create:async(input:any)=>{calls.push('checkout-create');return {id:`cs_${randomUUID()}`,livemode:false,status:'open',customer:input.customer,client_reference_id:input.client_reference_id,url:'https://checkout.stripe.com/c/pay/owned-controlled-fixture'};}}},
} as unknown as Stripe;
const request=(account:Account,method:'GET'|'POST',url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method,url,payload:payload as any,headers:{cookie:account.cookie,origin:config.origin,...headers}});
async function signup():Promise<Account>{const response=await app.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned billing launch fixture',workspaceName:'Owned billing launch workspace',email:`billing-launch-${randomUUID()}@example.test`,password:'Owned billing launch fixture password'}});assert.equal(response.statusCode,201,response.body);const account={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(account);return account;}
async function usage(account:Account){const response=await request(account,'GET','/api/workspace/usage');assert.equal(response.statusCode,200,response.body);return response.json();}
async function checkout(account:Account){const response=await request(account,'POST','/api/billing/checkout',{planId:'standard'});assert.equal(response.statusCode,200,response.body);return `cus_${account.workspace.id}`;}
async function event(customerId:string,type:string,created:number){
 const id=`evt_${randomUUID()}`,raw=JSON.stringify({id,type,created,livemode:false,data:{object:{customer:customerId,metadata:{plan:'team',workspace_id:'untrusted-event-metadata'}}}}),headers={'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload:raw,secret})};eventIds.push(`stripe:${id}`);
 const response=await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().duplicate,false);
 const pointer=(await adminPool.query('select payload from provider_events where id=$1',[`stripe:${id}`])).rows[0].payload;
 assert.deepEqual(Object.keys(pointer).sort(),['created','customerId','id','mode','type']);
 return {id,pointer,replay:()=>app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers})};
}
before(async()=>{
 assert.equal(databaseSchema,'public');assert.equal(process.env.NODE_ENV,'test');
 const pools=[[adminPool,'folio_admin'],[appPool,'folio_app']] as const,urlMode=Boolean(adminPool.options.connectionString||appPool.options.connectionString);
 if(urlMode){assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');for(const [pool,role]of pools){assert.equal(typeof pool.options.connectionString,'string');const url=new URL(pool.options.connectionString!);assert.ok(['postgres:','postgresql:'].includes(url.protocol));assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/folio');assert.equal(url.port||'5432','5432');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');assert.equal(url.hash,'');}}
 else{assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'),'Requires an isolated copied checkout, never the normal database');for(const [pool,role]of pools){assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}}
 for(const [pool,role]of pools){const row=(await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);assert.equal(row.port,urlMode?5432:55432);if(!urlMode)assert.equal(row.address,null);}
 localVerified=true;setStorageForTests(storage);config.origin='https://billing-launch.example.test';
 const deny=()=>{networkCalls++;throw new Error('External requests are forbidden in the billing launch fixture');};mock.method(globalThis,'fetch',deny);mock.method(http,'request',deny);mock.method(https,'request',deny);
 Object.assign(process.env,{STRIPE_MODE:'test',STRIPE_SECRET_KEY:'sk_test_owned_launch_fixture',STRIPE_WEBHOOK_SECRET:secret,STRIPE_PRICE_STANDARD:'price_launch_standard',STRIPE_PRICE_TEAM:'price_launch_team',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_MODE:'false',RESEND_INBOUND_ENABLED:'false'});
 delete process.env.STRIPE_ACCOUNT_ID;delete process.env.STRIPE_PORTAL_CONFIGURATION_ID;delete process.env.RESEND_API_KEY;
 app=Fastify({logger:false});await app.register(cookie);await app.register(multipart);app.setErrorHandler((error:any,_request,reply)=>reply.code(error instanceof ZodError?400:error.statusCode||500).send({message:error.message}));
 await registerCore(app);await registerProviders(app,{stripeClient:()=>client});await app.ready();
});
after(async()=>{
 try{await app?.close();if(localVerified){for(const a of accounts)await adminPool.query('delete from workspaces where id=$1',[a.workspace.id]);for(const a of accounts)await adminPool.query('delete from users where id=$1',[a.user.id]);if(eventIds.length)await adminPool.query('delete from provider_events where id=any($1)',[eventIds]);}assert.equal(networkCalls,0);}
 finally{mock.restoreAll();setStorageForTests(undefined);objects.clear();for(const key of envKeys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}config.origin=originalOrigin;await closeDatabase();}
});

test('renewal failure, recovery, pending cancellation and final cancellation change limits without deleting sources or resetting usage',async()=>{
 const owner=await signup(),outsider=await signup(),customer=await checkout(owner);
 assert.equal((await usage(owner)).plan.id,'explore','Checkout creation alone grants no paid access');
 const status=await request(owner,'GET','/api/providers/status');assert.equal(status.json().stripe.configured,true);assert.equal(status.json().stripe.verified,false);
 snapshots.set(customer,[subscription(customer,'active')]);const first=await event(customer,'checkout.session.completed',100);await reconcileStripeCustomer(first.pointer,client);
 assert.equal((await usage(owner)).plan.id,'standard');
 const parsers=[];for(let i=0;i<2;i++){const r=await request(owner,'POST','/api/parsers',{name:`Owned retained parser ${i}`,useCase:'receipt'});assert.equal(r.statusCode,201,r.body);parsers.push(r.json().parser.id);}
 const boundary=`owned-${randomUUID()}`,source=Buffer.from('SYNTHETIC BILLING LIFECYCLE\nReference: 000042\nAmount: 12.50');
 const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned-billing.txt"\r\nContent-Type: text/plain\r\n\r\n`),source,Buffer.from(`\r\n--${boundary}--\r\n`)]);
 const upload=await request(owner,'POST',`/api/parsers/${parsers[0]}/documents`,payload,{'content-type':`multipart/form-data; boundary=${boundary}`});assert.equal(upload.statusCode,202,upload.body);
 const initial=await usage(owner),document=upload.json().document;assert.equal(initial.usage.pages,1);assert.equal(initial.usage.events,1);assert.equal(initial.usage.documents,1);
 const unchanged=async()=>{const now=await usage(owner);assert.deepEqual(now.usage,initial.usage);assert.deepEqual(now.ledger,initial.ledger);const original=await request(owner,'GET',`/api/documents/${document.id}/original`);assert.equal(original.statusCode,200,original.body);assert.deepEqual(original.rawPayload,source);assert.equal((await adminPool.query('select count(*)::int n from parsers where workspace_id=$1 and archived=false',[owner.workspace.id])).rows[0].n,2);assert.equal((await usage(outsider)).plan.id,'explore');};
 // A failure event is a prompt to read current state, not proof of past_due.
 const failureWhileActive=await event(customer,'invoice.payment_failed',200);await reconcileStripeCustomer(failureWhileActive.pointer,client);assert.equal((await usage(owner)).plan.id,'standard');await unchanged();
 snapshots.set(customer,[subscription(customer,'past_due')]);const failure=await event(customer,'invoice.payment_failed',300);await reconcileStripeCustomer(failure.pointer,client);assert.equal((await usage(owner)).plan.id,'explore');
 const refused=await request(owner,'POST','/api/parsers',{name:'Must not fit downgraded quota',useCase:'receipt'});assert.equal(refused.statusCode,429,refused.body);await unchanged();
 const repeated=await failure.replay();assert.equal(repeated.statusCode,202);assert.equal(repeated.json().duplicate,true);assert.equal((await adminPool.query('select count(*)::int n from provider_events where id=$1',[`stripe:${failure.id}`])).rows[0].n,1);
 snapshots.set(customer,[subscription(customer,'active','team')]);const paid=await event(customer,'invoice.paid',400);await reconcileStripeCustomer(paid.pointer,client);assert.equal((await usage(owner)).plan.id,'team');await unchanged();
 await reconcileStripeCustomer(failure.pointer,client);assert.equal((await usage(owner)).plan.id,'team','Old failure delivery reads current provider state');await unchanged();
 snapshots.set(customer,[subscription(customer,'active','team',true)]);const scheduledCancel=await event(customer,'customer.subscription.updated',500);await reconcileStripeCustomer(scheduledCancel.pointer,client);assert.equal((await usage(owner)).plan.id,'team','Cancellation at period end retains active access');
 snapshots.set(customer,[subscription(customer,'canceled','team')]);const canceled=await event(customer,'customer.subscription.deleted',600);await reconcileStripeCustomer(canceled.pointer,client);assert.equal((await usage(owner)).plan.id,'explore');await unchanged();
 await reconcileStripeCustomer(first.pointer,client);assert.equal((await usage(owner)).plan.id,'explore','An old success does not resurrect a canceled subscription');
 const stored=(await adminPool.query("select status,event_created from subscriptions where workspace_id=$1 and billing_mode='test'",[owner.workspace.id])).rows[0];assert.equal(stored.status,'canceled');assert.equal(Number(stored.event_created),600);
});

test('incomplete, action-required and unpaid subscription states fail closed; unsafe provider snapshots cannot partially rewrite entitlements',async()=>{
 const owner=await signup(),customer=await checkout(owner);
 for(const state of ['incomplete','incomplete_expired','past_due','unpaid','paused','canceled'] as const){snapshots.set(customer,[subscription(customer,state)]);const queued=await event(customer,'invoice.payment_action_required',100);await reconcileStripeCustomer(queued.pointer,client);assert.equal((await usage(owner)).plan.id,'explore',state);}
 snapshots.set(customer,[subscription(customer,'trialing')]);const trial=await event(customer,'customer.subscription.updated',200);await reconcileStripeCustomer(trial.pointer,client);assert.equal((await usage(owner)).plan.id,'standard');
 const before=await usage(owner),auditBefore=(await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='billing.reconciled'",[owner.workspace.id])).rows[0].n;
 const rejected=await event(customer,'invoice.paid',300);
 for(const invalid of [{...subscription(customer,'active'),customer:'cus_wrong_fixture'},{...subscription(customer,'active'),livemode:true},{...subscription(customer,'active'),items:{data:[{quantity:1,price:{...price('standard'),livemode:true}}]}}]){snapshots.set(customer,[invalid as Stripe.Subscription]);await assert.rejects(reconcileStripeCustomer(rejected.pointer,client));assert.deepEqual(await usage(owner),before);}
 snapshots.set(customer,[subscription(customer,'active')]);hasMore=true;try{await assert.rejects(reconcileStripeCustomer(rejected.pointer,client),/subscription limit/);}finally{hasMore=false;}
 assert.deepEqual(await usage(owner),before);assert.equal((await adminPool.query("select count(*)::int n from audit_events where workspace_id=$1 and action='billing.reconciled'",[owner.workspace.id])).rows[0].n,auditBefore);
});
