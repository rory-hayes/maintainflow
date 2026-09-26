/** Synthetic terms and controlled Stripe only. Run in a disposable copied DB/CI. */
import test,{before,after,beforeEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Stripe from 'stripe';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool,appPool,databaseSchema,closeDatabase,transaction,withWorkspace} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {registerProviders,reconcileStripeCustomer,processStripeEvent} from '../server/integrations/providers.js';
import {validateCheckoutPolicy,reserveCheckoutContract,type CheckoutPolicyInput} from '../server/integrations/checkout-contracts.js';

type Account={user:{id:string};workspace:{id:string};cookie:string};
const keys=['STRIPE_MODE','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','FOLIO_BILLING_MOCK','FOLIO_PREVIEW_MODE','RESEND_API_KEY','RESEND_INBOUND_ENABLED','FOLIO_REQUIRE_EMAIL_VERIFICATION'] as const;
const original=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalOrigin=config.origin;
const secret='whsec_owned_terms_fixture',accounts:Account[]=[],eventIds:string[]=[],apps:FastifyInstance[]=[];
const customers=new Map<string,any>(),sessions=new Map<string,any>(),calls:{params:any;key:string}[]=[];
const fixture:CheckoutPolicyInput={version:'synthetic-v1',language:'en-IE',title:'Synthetic test terms',text:'SYNTHETIC FIXTURE — not customer terms.\nPrice and cancellation text here is a controlled placeholder.\n<script>untrusted-looking text stays plain text</script>',url:'https://terms.example.test/policies/synthetic-v1',agreementText:'I accept these synthetic test terms.'};
let app:FastifyInstance,policy:CheckoutPolicyInput|null=null,verified=false,networkCalls=0,loseResponse=false;
let onCreate:((session:any,params:any)=>Promise<void>)|null=null;
function reset(){policy=null;loseResponse=false;onCreate=null;config.origin='https://terms.example.test';Object.assign(process.env,{STRIPE_MODE:'test',STRIPE_SECRET_KEY:'sk_test_owned_terms_fixture',STRIPE_WEBHOOK_SECRET:secret,STRIPE_PRICE_STANDARD:'price_terms_standard',STRIPE_PRICE_TEAM:'price_terms_team',FOLIO_BILLING_MOCK:'false',FOLIO_PREVIEW_MODE:'false',FOLIO_REQUIRE_EMAIL_VERIFICATION:'false',RESEND_INBOUND_ENABLED:'false'});for(const key of ['STRIPE_ACCOUNT_ID','STRIPE_PORTAL_CONFIGURATION_ID','RESEND_API_KEY'])delete process.env[key];}
const price=(id:string)=>({id,livemode:false,active:true,currency:'eur',unit_amount:id.includes('team')?4900:1900,recurring:{interval:'month',interval_count:1,usage_type:'licensed'},billing_scheme:'per_unit',transform_quantity:null});
const client={
 prices:{retrieve:async(id:string)=>price(id)},
 customers:{create:async(input:any)=>{const id=`cus_${input.metadata.folio_workspace}`;const customer={id,livemode:false,metadata:input.metadata};customers.set(id,customer);return customer;},retrieve:async(id:string)=>customers.get(id)},
 subscriptions:{list:async()=>({data:[],has_more:false})},
 checkout:{sessions:{create:async(params:any,options:any)=>{
  calls.push({params:structuredClone(params),key:options.idempotencyKey});
  let session=sessions.get(options.idempotencyKey);
  if(!session){session={...structuredClone(params),id:`cs_${randomUUID()}`,livemode:false,status:'open',consent:null,currency:'eur',amount_subtotal:price(params.line_items[0].price).unit_amount,url:'https://checkout.stripe.com/c/pay/synthetic',line_items:{data:[{quantity:1,price:price(params.line_items[0].price)}],has_more:false}};sessions.set(options.idempotencyKey,session);}
  else assert.deepEqual(params,calls.find(call=>call.key===options.idempotencyKey)!.params,'A replay must preserve exact Stripe parameters');
  if(onCreate)await onCreate(session,params);
  if(loseResponse){loseResponse=false;throw new Error('Controlled lost response');}
  return structuredClone(session);
 },retrieve:async(id:string)=>structuredClone([...sessions.values()].find(s=>s.id===id)),expire:async(id:string)=>{const session=[...sessions.values()].find(s=>s.id===id);session.status='expired';return structuredClone(session);}}},
} as unknown as Stripe;
async function build(withPolicy=true){const instance=Fastify({logger:false});await instance.register(cookie);await instance.register(multipart);instance.setErrorHandler((error:any,_req,reply)=>reply.code(error instanceof ZodError?400:error.statusCode||500).send({message:error.message}));await registerCore(instance);await registerProviders(instance,{stripeClient:()=>client,...(withPolicy?{checkoutPolicy:()=>policy}:{})});await instance.ready();apps.push(instance);return instance;}
async function signup(instance=app):Promise<Account>{const response=await instance.inject({method:'POST',url:'/api/auth/register',headers:{origin:config.origin},payload:{name:'Owned terms fixture',workspaceName:'Owned terms workspace',email:`terms-${randomUUID()}@example.test`,password:'Owned terms fixture password'}});assert.equal(response.statusCode,201,response.body);const account={...response.json(),cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};accounts.push(account);return account;}
const request=(account:Account,method:'GET'|'POST',url:string,payload?:unknown,instance=app)=>instance.inject({method,url,headers:{cookie:account.cookie,origin:config.origin},...(payload===undefined?{}:{payload:payload as any})});
async function create(account:Account,planId='standard'){const response=await request(account,'POST','/api/billing/checkout',{planId});assert.equal(response.statusCode,200,response.body);return [...sessions.values()].findLast(s=>s.client_reference_id===account.workspace.id)!;}
async function event(session:any,options:{id?:string;created?:number;type?:string;patch?:Record<string,unknown>;rawPatch?:Record<string,unknown>}={}){
 const id=options.id??`evt_${randomUUID()}`,payload={id,type:options.type??'checkout.session.completed',created:options.created??Math.floor(Date.now()/1000),livemode:false,data:{object:{...structuredClone(session),...options.patch}},...options.rawPatch};
 eventIds.push(`stripe:${id}`);const raw=JSON.stringify(payload);
 const response=await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers:{'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload:raw,secret})}});
 return {response,id,payload};
}
async function processStored(id:string,transport=client){const pointer=(await adminPool.query('SELECT payload FROM provider_events WHERE id=$1',[`stripe:${id}`])).rows[0].payload;await processStripeEvent(pointer,transport);return pointer;}
async function complete(session:any,accepted=true){session.status='complete';session.consent={terms_of_service:accepted?'accepted':null,promotions:null};const result=await event(session);if(result.response.statusCode===202)await processStored(result.id);return result;}
async function rows(account:Account){return (await adminPool.query('SELECT * FROM checkout_contracts WHERE workspace_id=$1 ORDER BY created_at,id',[account.workspace.id])).rows;}

before(async()=>{
 assert.equal(databaseSchema,'public');assert.equal(process.env.NODE_ENV,'test');
 const pools=[[adminPool,'folio_admin'],[appPool,'folio_app']] as const,urlMode=Boolean(adminPool.options.connectionString||appPool.options.connectionString);
 if(urlMode){assert.ok(process.env.CI==='true'||process.env.GITHUB_ACTIONS==='true');for(const [pool,role]of pools){const url=new URL(pool.options.connectionString!);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/folio');assert.equal(url.port||'5432','5432');assert.equal(decodeURIComponent(url.username),role);assert.equal(url.search,'');}}
 else{assert.ok(config.root.startsWith('/private/tmp/')||config.root.startsWith('/tmp/'),'Requires copied disposable checkout');for(const [pool,role]of pools){assert.equal(path.resolve(pool.options.host!),path.resolve(config.root,'.local/socket'));assert.equal(pool.options.port,55432);assert.equal(pool.options.database,'folio');assert.equal(pool.options.user,role);}}
 for(const [pool,role]of pools){const row=(await pool.query('SELECT current_database() db,current_schema() schema,current_user role,inet_server_addr()::text address')).rows[0];assert.equal(row.db,'folio');assert.equal(row.schema,'public');assert.equal(row.role,role);if(!urlMode)assert.equal(row.address,null);}
 verified=true;const deny=()=>{networkCalls++;throw new Error('No external requests in terms evidence test');};mock.method(globalThis,'fetch',deny);mock.method(http,'request',deny);mock.method(https,'request',deny);reset();app=await build();
});
beforeEach(reset);
after(async()=>{
 try{for(const instance of apps)await instance.close();if(verified){for(const account of accounts)await adminPool.query('DELETE FROM workspaces WHERE id=$1',[account.workspace.id]);for(const account of accounts)await adminPool.query('DELETE FROM users WHERE id=$1',[account.user.id]);if(eventIds.length)await adminPool.query('DELETE FROM provider_events WHERE id=ANY($1)',[eventIds]);}assert.equal(networkCalls,0);}
 finally{mock.restoreAll();for(const key of keys){if(original[key]===undefined)delete process.env[key];else process.env[key]=original[key];}config.origin=originalOrigin;await closeDatabase();}
});

test('production has no policy catalogue; normal Checkout and mock behavior remain legacy',async()=>{
 const dormant=await build(false),owner=await signup(dormant);policy=fixture;
 const response=await request(owner,'POST','/api/billing/checkout',{planId:'standard'},dormant);assert.equal(response.statusCode,200,response.body);
 assert.deepEqual(Object.keys(calls.at(-1)!.params).sort(),['cancel_url','client_reference_id','customer','line_items','mode','success_url']);assert.equal((await rows(owner)).length,0);
 const list=(await request(owner,'GET','/api/billing/contracts',undefined,dormant)).json();assert.deepEqual(list,{captureEnabled:false,records:[],nextCursor:null,legacyCheckout:{mode:'test',state:'unknown'}});
 const empty=await signup(dormant),before=calls.length;process.env.FOLIO_BILLING_MOCK='true';assert.equal((await request(empty,'POST','/api/billing/checkout',{planId:'standard'},dormant)).statusCode,409);assert.equal(calls.length,before);assert.equal((await rows(empty)).length,0);
});
test('policy bounds and unsafe configuration fail closed without creating a Checkout or evidence',async()=>{
 const owner=await signup(),before=calls.length;
 for(const patch of [{text:''},{text:'x'.repeat(16001)},{text:'bad\u0000text'},{url:'javascript:alert(1)'},{url:'https://user:password@example.test/terms'},{language:'bad language'},{version:'version\nforged'},{unknown:'field'},{agreementText:'x'.repeat(1000),url:`https://terms.example.test/${'a'.repeat(500)}`}]){policy={...fixture,...patch} as CheckoutPolicyInput;assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'standard'})).statusCode,503);}
 assert.equal(calls.length,before);assert.equal((await rows(owner)).length,0);assert.equal((await adminPool.query('SELECT count(*)::int n FROM billing_checkouts WHERE workspace_id=$1',[owner.workspace.id])).rows[0].n,0);
});
test('operator text cannot change the Markdown link target through title or URL punctuation',async()=>{
 const owner=await signup();policy={...fixture,title:'Terms [link](other)',url:'https://terms.example.test/version(1)',agreementText:'Read *synthetic* terms.'};await create(owner);const message=calls.at(-1)!.params.custom_text.terms_of_service_acceptance.message;assert.ok(message.includes('Terms \\[link\\]\\(other\\)'));assert.ok(message.endsWith('(https://terms.example.test/version%281%29)'));assert.ok(message.length<=1200);
});
test('policy bytes, offer and exact request are committed before transport; Session binding is one-time',async()=>{
 const owner=await signup();policy=fixture;
 onCreate=async(session,params)=>{const [row]=await rows(owner);assert.equal(row.session_id,null);assert.deepEqual(row.create_params,params);assert.equal(row.policy.text,fixture.text);assert.equal(row.policy.sha256,createHash('sha256').update(fixture.text).digest('hex'));assert.equal(row.offer.pagesPerCalendarMonth,300);assert.equal(row.offer.aiSuggestionsPerCalendarMonth,5);assert.equal(row.initiated_by,owner.user.id);assert.equal(session.consent,null);};
 const session=await create(owner),[row]=await rows(owner);assert.equal(row.session_id,session.id);assert.equal(row.policy.version,'synthetic-v1');assert.equal(row.create_params.consent_collection.terms_of_service,'required');assert.equal(row.create_params.metadata.folio_contract,row.id);
 for(const sql of ["UPDATE checkout_contracts SET policy=policy||'{\"version\":\"changed\"}' WHERE id=$1","UPDATE checkout_contracts SET session_id='cs_replacement' WHERE id=$1"]){await assert.rejects(adminPool.query(sql,[row.id]),/immutable/);}
});
test('lost response and changed policy, origin and price replay identical pinned parameters and key',async()=>{
 const owner=await signup();policy=fixture;loseResponse=true;
 assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'team'})).statusCode,500);const [before]=await rows(owner);assert.equal(before.session_id,null);
 policy={...fixture,version:'synthetic-v2',text:'New synthetic bytes',url:'https://changed.example.test/terms'};config.origin='https://changed.example.test';process.env.STRIPE_PRICE_TEAM='price_replacement_team';
 assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'team'})).statusCode,200);
 const relevant=calls.filter(c=>c.params.client_reference_id===owner.workspace.id);assert.equal(relevant.length,2);assert.deepEqual(relevant[1],relevant[0]);assert.equal((await rows(owner))[0].policy.text,fixture.text);assert.equal((await rows(owner)).length,1);
});
test('removed or invalid current policy does not prevent pinned retry or historical reads; invalid billing config blocks transport',async()=>{
 for(const unavailable of [null,{...fixture,text:''}]){const owner=await signup();policy=fixture;loseResponse=true;assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'standard'})).statusCode,500);policy=unavailable;
 const [row]=await rows(owner);const before=calls.length;process.env.STRIPE_SECRET_KEY='sk_live_wrong_mode';assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'standard'})).statusCode,503);assert.equal(calls.length,before);process.env.STRIPE_SECRET_KEY='sk_test_owned_terms_fixture';
 assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'standard'})).statusCode,200);process.env.STRIPE_MODE='invalid';const list=await request(owner,'GET','/api/billing/contracts');assert.equal(list.statusCode,200,list.body);assert.equal(list.json().captureEnabled,false);assert.equal(list.json().legacyCheckout,null);assert.equal((await request(owner,'GET',`/api/billing/contracts/${row.id}`)).statusCode,200);assert.equal((await request(owner,'GET',`/api/billing/contracts/${row.id}/download`)).statusCode,200);process.env.STRIPE_MODE='test';}
});
test('pre-existing v1 and v2 unresolved attempts preserve original params and keys after enabling capture',async()=>{
 for(const version of [1,2]){const owner=await signup(),id=randomUUID(),customer=`cus_${owner.workspace.id}`;customers.set(customer,{id:customer,livemode:false,metadata:{folio_workspace:owner.workspace.id}});await adminPool.query('INSERT INTO subscriptions(workspace_id,customer_id) VALUES($1,$2)',[owner.workspace.id,customer]);await adminPool.query("INSERT INTO billing_checkouts(workspace_id,plan_id,request_id,idempotency_version) VALUES($1,'standard',$2,$3)",[owner.workspace.id,id,version]);policy=fixture;await create(owner);const last=calls.at(-1)!;assert.equal(last.key,version===1?`folio-checkout:${id}`:`folio-checkout:test:${id}`);assert.equal(last.params.consent_collection,undefined);assert.equal(last.params.metadata,undefined);assert.equal((await rows(owner)).length,0);}
});
test('missing evidence cannot switch an unresolved contract attempt back to a legacy transport key',async()=>{
 const owner=await signup();policy=fixture;loseResponse=true;assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'standard'})).statusCode,500);const [row]=await rows(owner),before=calls.length;
 assert.equal((await adminPool.query('SELECT contract_capture FROM billing_checkouts WHERE workspace_id=$1',[owner.workspace.id])).rows[0].contract_capture,true);
 await adminPool.query('DELETE FROM checkout_contracts WHERE id=$1',[row.id]);assert.equal((await request(owner,'POST','/api/billing/checkout',{planId:'standard'})).statusCode,409);assert.equal(calls.length,before);
});
test('concurrent creates share one immutable attempt and one provider Session',async()=>{
 const owner=await signup();policy=fixture;
 const responses=await Promise.all(Array.from({length:4},()=>request(owner,'POST','/api/billing/checkout',{planId:'standard'})));for(const response of responses)assert.equal(response.statusCode,200,response.body);
 const relevant=calls.filter(c=>c.params.client_reference_id===owner.workspace.id);assert.equal(new Set(relevant.map(c=>c.key)).size,1);assert.equal((await rows(owner)).length,1);assert.equal([...sessions.values()].filter(s=>s.client_reference_id===owner.workspace.id).length,1);
});
test('completion before Session save captures once and does not grant entitlements or depend on event order',async()=>{
 const owner=await signup();policy=fixture;let completionId='';
 onCreate=async session=>{session.status='complete';session.consent={terms_of_service:'accepted',promotions:null};const first=await event(session,{created:100});completionId=first.id;assert.equal(first.response.statusCode,202,first.response.body);await processStored(first.id);const [row]=await rows(owner);assert.equal(row.session_id,session.id);};
 const session=await create(owner);onCreate=null;
 const replay=await event(session,{id:completionId,created:100});assert.equal(replay.response.statusCode,202);assert.equal(replay.response.json().duplicate,true);await processStored(replay.id);
 const later=await event(session,{created:50,type:'checkout.session.async_payment_succeeded'});assert.equal(later.response.statusCode,202);await processStored(later.id);
 const [row]=await rows(owner),receipts=(await adminPool.query('SELECT * FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows;assert.equal(receipts.length,1);assert.equal(receipts[0].event_id,completionId);assert.equal(receipts[0].state,'accepted');assert.equal(receipts[0].provider_event_created_at.toISOString(),'1970-01-01T00:01:40.000Z');
 assert.equal((await adminPool.query('SELECT plan FROM workspaces WHERE id=$1',[owner.workspace.id])).rows[0].plan.id,'explore');
 const pointer=(await adminPool.query('SELECT payload FROM provider_events WHERE id=$1',[`stripe:${completionId}`])).rows[0].payload;await reconcileStripeCustomer(pointer,client);assert.equal((await adminPool.query('SELECT count(*)::int n FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows[0].n,1);
 assert.equal(JSON.stringify(pointer).includes(fixture.text),false);assert.equal(JSON.stringify(pointer).includes('terms_of_service'),false);
});
test('foreign bindings, mode, price and quantity cannot forge an accepted record',async()=>{
 const owner=await signup();policy=fixture;const session=await create(owner);session.status='complete';session.consent={terms_of_service:'accepted',promotions:null};
 for(const patch of [{customer:'cus_foreign'},{client_reference_id:randomUUID()},{metadata:{folio_contract:session.metadata.folio_contract,folio_contract_sha256:'0'.repeat(64)}}]){const result=await event(session,{patch});assert.equal(result.response.statusCode,202,result.response.body);await assert.rejects(processStored(result.id),/processing is incomplete/);}
 const originalLines=structuredClone(session.line_items);session.line_items.data[0].quantity=2;await assert.rejects(processStored((await event(session)).id),/processing is incomplete/);session.line_items=structuredClone(originalLines);session.line_items.data[0].price.id='price_unrelated';await assert.rejects(processStored((await event(session)).id),/processing is incomplete/);session.line_items=originalLines;
 const [row]=await rows(owner);assert.equal((await adminPool.query('SELECT count(*)::int n FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows[0].n,0);
 const forged=await event(session,{patch:{metadata:{folio_contract:randomUUID(),folio_contract_sha256:'0'.repeat(64)}}});assert.equal(forged.response.statusCode,202);assert.equal((await rows(owner)).length,1);
 const rawMode=await event(session,{rawPatch:{livemode:true}});assert.equal(rawMode.response.statusCode,400);
});
test('durable evidence failure does not starve entitlements, and entitlement failure does not discard accepted evidence',async()=>{
 const owner=await signup();policy=fixture;const session=await create(owner);session.status='complete';session.consent={terms_of_service:'accepted',promotions:null};
 const queued=await event(session);assert.equal(queued.response.statusCode,202);const [row]=await rows(owner);assert.equal((await adminPool.query('SELECT count(*)::int n FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows[0].n,0);
 const active={id:'sub_owned_terms',customer:session.customer,created:100,livemode:false,status:'active',items:{data:[{quantity:1,price:price('price_terms_standard')}]}};
 const paid={...client,subscriptions:{list:async()=>({data:[active],has_more:false})}} as unknown as Stripe;
 session.line_items.data[0].quantity=2;await assert.rejects(processStored(queued.id,paid),/processing is incomplete/);assert.equal((await adminPool.query('SELECT plan FROM workspaces WHERE id=$1',[owner.workspace.id])).rows[0].plan.id,'standard');
 assert.equal((await adminPool.query('SELECT count(*)::int n FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows[0].n,0);
 session.line_items.data[0].quantity=1;const failedSubscription={...client,subscriptions:{list:async()=>{throw new Error('Controlled subscription outage');}}} as unknown as Stripe;
 await assert.rejects(processStored(queued.id,failedSubscription),/processing is incomplete/);assert.equal((await adminPool.query('SELECT state FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows[0].state,'accepted');
 await processStored(queued.id,paid);assert.equal((await adminPool.query('SELECT count(*)::int n FROM checkout_contract_receipts WHERE contract_id=$1',[row.id])).rows[0].n,1);
});
test('missing acceptance stays not_recorded, with provider and observation timestamps distinguished',async()=>{
 const owner=await signup();policy=fixture;const session=await create(owner),completed=await complete(session,false);assert.equal(completed.response.statusCode,202,completed.response.body);
 const [row]=await rows(owner),response=await request(owner,'GET',`/api/billing/contracts/${row.id}`),record=response.json();assert.equal(record.completion.state,'not_recorded');assert.equal(record.completion.source,'verified_stripe_checkout_session');assert.ok(record.completion.observedAt);assert.match(record.evidenceNotice,/does not confirm payment/);
 await assert.rejects(adminPool.query("UPDATE checkout_contract_receipts SET state='accepted' WHERE contract_id=$1",[row.id]),/immutable/);
 policy=null;assert.equal((await request(owner,'GET','/api/billing/contracts')).json().captureEnabled,false);assert.equal((await request(owner,'GET','/api/billing/contracts')).json().records.length,1);
});
test('read/download require owner or admin session and preserve foreign-workspace isolation',async()=>{
 const owner=await signup(),outsider=await signup(),member=await signup();policy=fixture;await create(owner);const [row]=await rows(owner);
 for(const suffix of ['', '/download']){const url=`/api/billing/contracts/${row.id}${suffix}`;assert.equal((await app.inject({method:'GET',url})).statusCode,401);assert.equal((await request(outsider,'GET',url)).statusCode,404);}
 await adminPool.query("INSERT INTO memberships(workspace_id,user_id,role) VALUES($1,$2,'viewer')",[owner.workspace.id,member.user.id]);
 for(const role of ['viewer','editor','admin']){await adminPool.query('UPDATE memberships SET role=$3 WHERE workspace_id=$1 AND user_id=$2',[owner.workspace.id,member.user.id,role]);for(const url of ['/api/billing/contracts',`/api/billing/contracts/${row.id}`,`/api/billing/contracts/${row.id}/download`]){const r=await app.inject({method:'GET',url,headers:{cookie:member.cookie,'x-workspace-id':owner.workspace.id}});assert.equal(r.statusCode,role==='admin'?200:403,r.body);}}
 const key=await request(owner,'POST','/api/workspace/api-keys',{name:'Owned terms read rejection',scopes:['results:read','exports:read']});assert.equal(key.statusCode,200,key.body);assert.equal((await app.inject({method:'GET',url:'/api/billing/contracts',headers:{authorization:`Bearer ${key.json().token}`}})).statusCode,403);
 const download=await request(owner,'GET',`/api/billing/contracts/${row.id}/download`);assert.equal(download.statusCode,200);assert.match(download.headers['content-type']!,/^text\/plain/);assert.equal(download.headers['x-content-type-options'],'nosniff');assert.equal(download.headers['cache-control'],'private, no-store');assert.match(download.headers['content-disposition']!,/^attachment; filename="checkout-terms-[a-f0-9-]+\.txt"$/);assert.ok(download.body.includes(fixture.text));assert.match(download.body,/awaiting_record/);assert.match(download.body,/does not confirm payment/);
 assert.equal((await withWorkspace(outsider.workspace.id,c=>c.query('SELECT * FROM checkout_contracts WHERE id=$1',[row.id]))).rowCount,0);assert.equal((await withWorkspace(owner.workspace.id,c=>c.query("UPDATE checkout_contracts SET session_id='cs_forbidden' WHERE id=$1",[row.id]))).rowCount,0);
});
test('paginated history keeps every record across sub-millisecond timestamps and later attempts',async()=>{
 const owner=await signup();policy=fixture;const ids:string[]=[];
 await transaction(adminPool,async c=>{for(let i=0;i<23;i++){const row=await reserveCheckoutContract(c,{id:randomUUID(),workspaceId:owner.workspace.id,userId:owner.user.id,mode:'test',customerId:`cus_${owner.workspace.id}`,planId:'standard',priceId:'price_terms_standard',origin:config.origin,policy:validateCheckoutPolicy(fixture)});ids.push(row.id);}});
 const first=await request(owner,'GET','/api/billing/contracts');assert.equal(first.statusCode,200);assert.equal(first.json().records.length,20);assert.ok(first.json().nextCursor);const second=await request(owner,'GET',`/api/billing/contracts?cursor=${first.json().nextCursor}`);assert.equal(second.statusCode,200);assert.equal(second.json().records.length,3);assert.equal(second.json().nextCursor,null);assert.deepEqual(new Set([...first.json().records,...second.json().records].map(r=>r.id)),new Set(ids));
 for(const cursor of ['!','x'.repeat(257),Buffer.from(JSON.stringify({at:'bad',id:randomUUID()})).toString('base64url')])assert.equal((await request(owner,'GET',`/api/billing/contracts?cursor=${cursor}`)).statusCode,400);
 const session=await create(owner);session.status='expired';await create(owner);assert.equal((await rows(owner)).length,25);assert.ok((await rows(owner)).some(r=>r.session_id===session.id));
});
