import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify,{type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import Stripe from 'stripe';
import {Webhook} from 'svix';
import {Resend,type GetReceivingEmailResponseSuccess,type GetDomainResponseSuccess} from 'resend';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool,appPool,withWorkspace,closeDatabase} from '../server/core/db.js';
import {hashToken} from '../server/core/auth.js';
import {addDocument} from '../server/core/intake.js';
import {config} from '../server/core/config.js';
import {encryptSecret,decryptSecret} from '../server/integrations/secrets.js';
import {registerProviders,storeProviderEvent,processResendEvent,reconcileStripeCustomer,reserveSheetWrite} from '../server/integrations/providers.js';
import {requireTestStripeKey,verifyStripePayload,verifyResendPayload,deliveredRecipients,verifiedReceivingDomain,stripePlan,sheetRows,sheetRanges,writeSheetRange,receivedEmailBody,type ApprovalPayload,type SheetConfig} from '../server/integrations/provider-policy.js';

const suffix=randomUUID();
const stripeSecret='whsec_controlled_fixture';
const svixSecret=`whsec_${randomBytes(32).toString('base64')}`;
const environmentKeys=['FOLIO_BILLING_MOCK','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET','STRIPE_PRICE_STANDARD','STRIPE_PRICE_TEAM','RESEND_API_KEY','RESEND_WEBHOOK_SECRET','RESEND_INBOUND_ENABLED','GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET','GOOGLE_REDIRECT_URI'];
const originalEnv=Object.fromEntries(environmentKeys.map(key=>[key,process.env[key]]));
const fixtureEvents:string[]=[];
let app:FastifyInstance,account:any,other:any,parser:any;
const workspaceIds:string[]=[],userIds:string[]=[];
function subscription(overrides:Record<string,unknown>={}):Stripe.Subscription{return {id:'sub_fixture',created:100,livemode:false,status:'active',metadata:{plan:'team'},items:{data:[{quantity:1,price:{id:'price_fixture_standard',livemode:false,currency:'eur',unit_amount:2900,recurring:{interval:'month',interval_count:1}}}]},...overrides} as unknown as Stripe.Subscription;}
function received(overrides:Record<string,unknown>={}):GetReceivingEmailResponseSuccess{return {id:randomUUID(),from:'Supplier <supplier@example.test>',to:['forged@example.test'],cc:[],bcc:[],received_for:[`in-${suffix}@example.test`],subject:'Fixture invoice',text:'Invoice number: 00042\nTotal: 29.00',html:null,attachments:[],headers:{},created_at:new Date().toISOString(),message_id:`fixture-${suffix}`,reply_to:[],...overrides} as unknown as GetReceivingEmailResponseSuccess;}
async function request(method:any,url:string,payload?:unknown,actor=account){return app.inject({method,url,payload:payload as any,headers:{cookie:actor.cookie,origin:config.origin}});}
async function signup(name:string){const response=await app.inject({method:'POST',url:'/api/auth/register',payload:{name,email:`${name}-${suffix}@example.test`,password:'controlled fixture password',workspaceName:`Provider ${name}`},headers:{origin:config.origin}});assert.equal(response.statusCode,201,response.body);const value=response.json();workspaceIds.push(value.workspace.id);userIds.push(value.user.id);return {...value,cookie:response.cookies.map(c=>`${c.name}=${c.value}`).join('; ')};}
async function event(provider:'stripe'|'resend',id:string,payload:unknown){fixtureEvents.push(`${provider}:${id}`);return storeProviderEvent(provider,id,payload);}
before(async()=>{
 delete process.env.FOLIO_BILLING_MOCK; // This suite verifies the real adapter with controlled transport fixtures.
 process.env.STRIPE_SECRET_KEY='sk_test_controlled_fixture';process.env.STRIPE_WEBHOOK_SECRET=stripeSecret;
 process.env.STRIPE_PRICE_STANDARD='price_fixture_standard';process.env.STRIPE_PRICE_TEAM='price_fixture_team';
 delete process.env.RESEND_API_KEY;process.env.RESEND_INBOUND_ENABLED='false';process.env.RESEND_WEBHOOK_SECRET=svixSecret;
 process.env.GOOGLE_CLIENT_ID='fixture.apps.googleusercontent.com';process.env.GOOGLE_CLIENT_SECRET='controlled-fixture-secret';process.env.GOOGLE_REDIRECT_URI=`${config.origin}/api/google/callback`;
 app=Fastify({logger:false});await app.register(cookie);await app.register(multipart);
 app.setErrorHandler((error:any,_req,reply)=>reply.code(error instanceof ZodError?400:error.statusCode||500).send({error:error.message}));
 await registerCore(app);await registerProviders(app);await app.ready();
 account=await signup('primary');other=await signup('secondary');
 const response=await request('POST','/api/parsers',{name:'Provider fixtures',useCase:'invoice'});assert.equal(response.statusCode,201,response.body);parser=response.json().parser;
});
after(async()=>{
 await app?.close();
 for(const id of workspaceIds){await adminPool.query('delete from workspaces where id=$1',[id]);await fs.rm(path.join(config.storageDir,id),{recursive:true,force:true});}
 for(const id of userIds)await adminPool.query('delete from users where id=$1',[id]);
 await adminPool.query('delete from provider_events where id=any($1)',[fixtureEvents]);
 for(const key of environmentKeys){const original=originalEnv[key];if(original===undefined)delete process.env[key];else process.env[key]=original;}
 await closeDatabase();
});

test('Stripe raw signature rejects mutation, stale timestamps, and all live credentials/events',()=>{
 const raw=JSON.stringify({id:`evt_${suffix}`,type:'customer.subscription.updated',created:100,livemode:false,data:{object:{customer:'cus_fixture'}}});
 const signature=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:stripeSecret});
 assert.equal(verifyStripePayload(Buffer.from(raw),signature,stripeSecret).livemode,false);
 assert.throws(()=>verifyStripePayload(Buffer.from(raw+' '),signature,stripeSecret));
 const expired=Stripe.webhooks.generateTestHeaderString({payload:raw,secret:stripeSecret,timestamp:1});assert.throws(()=>verifyStripePayload(Buffer.from(raw),expired,stripeSecret));
 const live=raw.replace('"livemode":false','"livemode":true');const liveSignature=Stripe.webhooks.generateTestHeaderString({payload:live,secret:stripeSecret});assert.throws(()=>verifyStripePayload(Buffer.from(live),liveSignature,stripeSecret),/Live/);
 assert.throws(()=>requireTestStripeKey('sk_live_fixture'));assert.throws(()=>requireTestStripeKey(undefined));
});
test('entitlements require the mapped exact recurring price and ignore plan metadata',()=>{
 const prices={standard:'price_fixture_standard',team:'price_fixture_team'};
 assert.equal(stripePlan(subscription(),prices),'standard');
 for(const overrides of [{status:'past_due'},{livemode:true},{items:{data:[]}},{items:{data:[{quantity:2,price:subscription().items.data[0]!.price}]}},{items:{data:[{quantity:1,price:{...subscription().items.data[0]!.price,id:'price_unmapped'}}]}}])assert.equal(stripePlan(subscription(overrides),prices),null);
 assert.equal(stripePlan(subscription({items:{data:[{quantity:1,price:{...subscription().items.data[0]!.price,currency:'usd'}}]}}),prices),null);
});
test('signed provider HTTP endpoints persist exactly once and preserve raw signature validation',async()=>{
 const id=`evt_${randomUUID()}`;fixtureEvents.push(`stripe:${id}`);
 const raw=JSON.stringify({id,type:'customer.subscription.updated',created:100,livemode:false,data:{object:{customer:'cus_fixture'}}});
 const headers={'content-type':'application/json','stripe-signature':Stripe.webhooks.generateTestHeaderString({payload:raw,secret:stripeSecret})};
 const first=await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers});assert.equal(first.statusCode,202,first.body);assert.equal(first.json().duplicate,false);
 const repeat=await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw,headers});assert.equal(repeat.statusCode,202);assert.equal(repeat.json().duplicate,true);
 assert.equal((await app.inject({method:'POST',url:'/api/billing/webhook',payload:raw+' ',headers})).statusCode,400);
 const row=(await adminPool.query('select payload from provider_events where id=$1',[`stripe:${id}`])).rows[0];assert.deepEqual(Object.keys(row.payload).sort(),['created','customerId','id','type']);
 const messageId=`msg_${randomUUID()}`;fixtureEvents.push(`resend:${messageId}`);const timestamp=new Date();
 const emailRaw=JSON.stringify({type:'email.received',data:{email_id:randomUUID(),received_for:['in-fixture@example.test'],subject:'DO NOT PERSIST BODY'}});
 const signed={'svix-id':messageId,'svix-timestamp':String(Math.floor(timestamp.getTime()/1000)),'svix-signature':new Webhook(svixSecret).sign(messageId,timestamp,emailRaw)};
 assert.equal(verifyResendPayload(Buffer.from(emailRaw),signed,svixSecret).type,'email.received');assert.throws(()=>verifyResendPayload(Buffer.from(emailRaw+' '),signed,svixSecret));
 const emailResponse=await app.inject({method:'POST',url:'/api/providers/resend/webhook',payload:emailRaw,headers:{...signed,'content-type':'application/json'}});assert.equal(emailResponse.statusCode,202,emailResponse.body);
 assert.equal((await adminPool.query('select payload::text as payload from provider_events where id=$1',[`resend:${messageId}`])).rows[0].payload.includes('DO NOT PERSIST'),false);
 await assert.rejects(appPool.query('select * from provider_events'),/permission denied/);
});
test('an old Stripe event reconciles current subscription state and cannot restore stale access',async()=>{
 const customer=`cus_${suffix}`;await adminPool.query('insert into subscriptions(workspace_id,customer_id) values($1,$2)',[account.workspace.id,customer]);
 const newer={id:`evt_new_${suffix}`,type:'customer.subscription.updated',created:200,customerId:customer};await event('stripe',newer.id,newer);
 let current=subscription();const client={subscriptions:{list:async()=>({data:[current],has_more:false})}} as unknown as Stripe;
 await reconcileStripeCustomer(newer,client);assert.equal((await adminPool.query('select plan from workspaces where id=$1',[account.workspace.id])).rows[0].plan.id,'standard');
 const older={...newer,id:`evt_old_${suffix}`,created:100};await event('stripe',older.id,older);current=subscription({status:'canceled'});
 await reconcileStripeCustomer(older,client);assert.equal((await adminPool.query('select plan from workspaces where id=$1',[account.workspace.id])).rows[0].plan.id,'explore');
 assert.equal(Number((await adminPool.query('select event_created from subscriptions where workspace_id=$1',[account.workspace.id])).rows[0].event_created),200);
});
test('inbound routing uses matched provider envelopes and verified receiving MX only',async()=>{
 assert.deepEqual(deliveredRecipients(['first@example.test'],received({received_for:['second@example.test'],to:['first@example.test']})),[]);
 assert.deepEqual(deliveredRecipients(['FIRST@example.test'],received({received_for:['first@example.test','first@example.test']})),['first@example.test']);
 const domain={name:'in.example.test',capabilities:{receiving:'enabled'},records:[{record:'Receiving',type:'MX',status:'verified'}]} as GetDomainResponseSuccess;
 assert.equal(verifiedReceivingDomain(domain,'in.example.test'),true);assert.equal(verifiedReceivingDomain(domain,'other.example.test'),false);assert.equal(verifiedReceivingDomain({...domain,records:[]},'in.example.test'),false);
 const body=await receivedEmailBody(received({text:null,html:'<p>Invoice <b>00042</b></p>',subject:'Subject\r\nBcc: injected@example.test'}),10000);
 assert.match(body.toString(),/00042/);assert.ok(!body.toString().includes('\r\nBcc:'));
 const status=await request('GET','/api/providers/status');assert.equal(status.json().resend.addressAvailable,false);
 const blocked=await request('POST','/api/providers/email-routes',{parserId:parser.id});assert.equal(blocked.statusCode,503);
});
test('managed route creation persists its local provider reference and rechecks the received probe',async()=>{
 const keys=['RESEND_RECEIVING_MODE','RESEND_API_KEY','RESEND_WEBHOOK_SECRET','RESEND_INBOUND_ENABLED','RESEND_INBOUND_DOMAIN','RESEND_DOMAIN_ID','RESEND_MANAGED_PROBE_EMAIL_ID','RESEND_MANAGED_PROBE_RECIPIENT','RESEND_MANAGED_PROBE_NONCE'];
 const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]])),originalFetch=Resend.prototype.fetchRequest;
 const domain='controlled-fixture.resend.app',emailId=randomUUID(),recipient=`folio-probe-${randomBytes(16).toString('hex')}@${domain}`,nonce=randomBytes(24).toString('hex');
 let calls=0,valid=true;
 try{
  Object.assign(process.env,{RESEND_RECEIVING_MODE:'managed',RESEND_API_KEY:'re_controlled_fixture',RESEND_WEBHOOK_SECRET:svixSecret,RESEND_INBOUND_ENABLED:'true',RESEND_INBOUND_DOMAIN:domain,RESEND_MANAGED_PROBE_EMAIL_ID:emailId,RESEND_MANAGED_PROBE_RECIPIENT:recipient,RESEND_MANAGED_PROBE_NONCE:nonce});delete process.env.RESEND_DOMAIN_ID;
  Resend.prototype.fetchRequest=(async(requestPath:string)=>{
   calls++;assert.equal(requestPath,`/emails/receiving/${emailId}?html_format=cid`);
   return {data:received({object:'email',id:emailId,received_for:[recipient],subject:`Folio receiving probe ${nonce}`,text:valid?`Folio receiving probe ${nonce}`:'Wrong probe body'}),error:null};
  }) as typeof originalFetch;
  const status=(await request('GET','/api/providers/status')).json().resend;
  assert.equal(status.addressAvailable,true);assert.equal(status.verification,'managed-probe');assert.equal(status.deliveryVerified,false);assert.equal(calls,1);
  const created=await request('POST','/api/providers/email-routes',{parserId:parser.id});assert.equal(created.statusCode,200,created.body);assert.equal(calls,2,'Creation must force a fresh provider check');
  assert.match(created.json().route.address,/^in-[a-f0-9]{24}@controlled-fixture\.resend\.app$/);assert.equal(created.json().deliveryVerified,false);
  const stored=(await adminPool.query('select provider_domain_id,domain_verified_at from email_routes where id=$1',[created.json().route.id])).rows[0];assert.equal(stored.provider_domain_id,`managed:${domain}`);assert.ok(stored.domain_verified_at);
  valid=false;
  const blocked=await request('POST','/api/providers/email-routes',{parserId:parser.id});assert.equal(blocked.statusCode,503);assert.equal(calls,3);
  const hidden=(await request('GET','/api/providers/email-routes')).json();assert.equal(hidden.receiving.verified,false);assert.equal(hidden.routes.find((route:any)=>route.id===created.json().route.id).address,null);
 }finally{Resend.prototype.fetchRequest=originalFetch;for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}}
});
test('retrieved inbound body and attachments survive replay without duplicate documents or usage',async()=>{
 const emailId=randomUUID(),attachmentId=randomUUID(),messageId=`msg_intake_${suffix}`;
 const pointer={emailId,recipients:[`in-${suffix}@example.test`]};await event('resend',messageId,pointer);
 await adminPool.query('insert into email_routes(workspace_id,parser_id,address,provider_domain_id,created_by,domain_verified_at) values($1,$2,$3,$4,$5,now())',[account.workspace.id,parser.id,pointer.recipients[0],'fixture-domain',account.user.id]);
 const email=received({id:emailId,attachments:[{id:attachmentId,filename:'attachment.txt',content_type:'text/plain',content_disposition:'attachment',size:50}]});
 let metadataCalls=0,downloads=0;
 const client={emails:{receiving:{get:async()=>({data:email,error:null}),attachments:{get:async()=>{metadataCalls++;return {data:{download_url:'https://download.example.test/fixture',size:50},error:null};}}}}} as unknown as Resend;
 const dependencies={client,download:async()=>{downloads++;return {status:200,bytes:Buffer.from('Invoice number: 00127\nTotal: 55.30\nAttachment fixture')};},intake:addDocument};
 await processResendEvent(`resend:${messageId}`,pointer,dependencies);
 await processResendEvent(`resend:${messageId}`,pointer,dependencies);
 assert.equal(metadataCalls,1);assert.equal(downloads,1); // Durable intake receipts skip completed work on replay.
 assert.equal((await adminPool.query('select count(*)::int n from documents where parser_id=$1',[parser.id])).rows[0].n,2);
 assert.equal((await adminPool.query('select count(*)::int n from usage_ledger where workspace_id=$1',[account.workspace.id])).rows[0].n,2);
 await assert.rejects(processResendEvent(`resend:${messageId}`,{...pointer,recipients:['spoof@example.test']},dependencies),/envelopes/);
 const otherRows=await withWorkspace(other.workspace.id,c=>c.query('select * from email_routes where parser_id=$1',[parser.id]));assert.equal(otherRows.rowCount,0);
});
const mapping:SheetConfig={spreadsheetId:'fixture_spreadsheet_12345',sheetName:"Supplier's invoices",columns:[{source:'invoice_number',label:'Invoice'},{source:'formula',label:'Literal'},{source:'$item.sku',label:'SKU'}],lineItems:'line_items'};
const approval:ApprovalPayload={id:randomUUID(),document:{id:randomUUID(),name:'fixture.txt'},runId:randomUUID(),revision:1,values:{invoice_number:'00042',formula:'=1+1',line_items:[{sku:'0001'},{sku:'0002'}]}};
test('Sheets uses RAW exact ranges; retry does not append or coerce identifiers/formulas',async()=>{
 const cells=sheetRows(approval,mapping);assert.deepEqual(cells,[['00042','=1+1','0001'],['00042','=1+1','0002']]);
 const ranges=sheetRanges(mapping,2,cells.length);assert.equal(ranges.dataRange,"'Supplier''s invoices'!A2:C3");
 const write={spreadsheet_id:mapping.spreadsheetId,header_range:ranges.headerRange,data_range:ranges.dataRange,headers:mapping.columns.map(c=>c.label),cells};
 const requests:unknown[]=[];const transport=async(request:unknown)=>{requests.push(request);return {status:200};};
 await writeSheetRange(transport,write);await writeSheetRange(transport,write);assert.deepEqual(requests[0],requests[1]);assert.equal((requests[0] as any).data.valueInputOption,'RAW');assert.ok(!(requests[0] as any).url.includes('append'));
 await assert.rejects(writeSheetRange(async()=>({status:429}),write),/rejected/);
});
test('concurrent Sheets reservations deduplicate approval IDs and isolate workspaces',async()=>{
 const id=randomUUID();const secret=encryptSecret(JSON.stringify({refresh_token:'fixture-token'}));assert.equal(decryptSecret(secret),' {"refresh_token":"fixture-token"}'.trim());
 await adminPool.query("insert into integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext) values($1,$2,$3,'Fixture Sheets','google_sheets',$4,$5)",[id,account.workspace.id,parser.id,JSON.stringify(mapping),secret]);
 const integration=(await adminPool.query('select * from integrations where id=$1',[id])).rows[0];
 const results=await Promise.all(Array.from({length:4},()=>reserveSheetWrite(integration,{id:randomUUID(),payload:approval})));
 assert.equal(new Set(results.map(r=>r.write.data_range)).size,1);assert.equal((await adminPool.query('select next_row from sheet_cursors where integration_id=$1',[id])).rows[0].next_row,4);
 const next=await reserveSheetWrite(integration,{id:randomUUID(),payload:{...approval,id:randomUUID()}});assert.equal(next.write.data_range,"'Supplier''s invoices'!A4:C5");
 assert.equal((await withWorkspace(other.workspace.id,c=>c.query('select * from sheet_writes where integration_id=$1',[id]))).rowCount,0);
 await assert.rejects(reserveSheetWrite({...integration,workspace_id:other.workspace.id},{id:randomUUID(),payload:approval}),/disconnected/);
});
test('Google OAuth states are hashed, tied to the user, expiring, single-use, and invalidated on disconnect',async()=>{
 const started=await request('POST','/api/google/start',{parserId:parser.id,name:'OAuth fixture',spreadsheetId:mapping.spreadsheetId,sheetName:'Folio'});assert.equal(started.statusCode,200,started.body);
 const {authorizationUrl,integrationId}=started.json(),url=new URL(authorizationUrl),state=url.searchParams.get('state')!;
 assert.equal(url.origin,'https://accounts.google.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('access_type'),'offline');
 const stored=(await adminPool.query('select * from oauth_states where state_hash=$1',[hashToken(state)])).rows[0];assert.ok(stored);assert.notEqual(stored.verifier_ciphertext,url.searchParams.get('code_challenge'));assert.equal(stored.user_id,account.user.id);
 const wrong=await request('GET',`/api/google/callback?state=${encodeURIComponent(state)}&error=access_denied`,undefined,other);assert.equal(wrong.statusCode,400);
 const denied=await request('GET',`/api/google/callback?state=${encodeURIComponent(state)}&error=access_denied`);assert.equal(denied.statusCode,302);
 assert.equal((await request('GET',`/api/google/callback?state=${encodeURIComponent(state)}&error=access_denied`)).statusCode,400);
 const restart=await request('POST','/api/google/start',{integrationId});const nextState=new URL(restart.json().authorizationUrl).searchParams.get('state')!;
 await adminPool.query("update oauth_states set expires_at=now()-interval '1 second' where state_hash=$1",[hashToken(nextState)]);
 assert.equal((await request('GET',`/api/google/callback?state=${encodeURIComponent(nextState)}&error=access_denied`)).statusCode,400);
 const final=await request('POST','/api/google/start',{integrationId});const finalState=new URL(final.json().authorizationUrl).searchParams.get('state')!;
 assert.equal((await request('POST',`/api/google/${integrationId}/disconnect`,{})).statusCode,200);
 assert.equal((await adminPool.query('select * from oauth_states where integration_id=$1',[integrationId])).rowCount,0);
 assert.equal((await request('GET',`/api/google/callback?state=${encodeURIComponent(finalState)}&error=access_denied`)).statusCode,400);
});

test('bounded inbound continuation resumes after a committed body without decoding it twice',async()=>{
 const {WorkBudgetExhausted}=await import('../server/core/work-budget.js');
 const emailId=randomUUID(),attachmentId=randomUUID(),messageId=`msg_continuation_${suffix}`;
 const pointer={emailId,recipients:[`continue-${suffix}@example.test`]};await event('resend',messageId,pointer);
 await adminPool.query('insert into email_routes(workspace_id,parser_id,address,provider_domain_id,created_by,domain_verified_at) values($1,$2,$3,$4,$5,now())',[account.workspace.id,parser.id,pointer.recipients[0],'fixture-domain',account.user.id]);
 const bytes=Buffer.from(`Invoice number: continuation attachment ${suffix}\nTotal: 63.00`);
 const email=received({id:emailId,received_for:pointer.recipients,text:`Invoice number: continuation body ${suffix}\nTotal: 61.00`,attachments:[{id:attachmentId,filename:'continue.txt',content_type:'text/plain',content_disposition:'attachment',size:bytes.length}]});
 const controller=new AbortController();let intakes=0,downloads=0;
 const client={emails:{receiving:{get:async()=>({data:email,error:null}),attachments:{get:async()=>({data:{download_url:'https://download.example.test/fixture',size:bytes.length},error:null})}}}} as unknown as Resend;
 const dependencies={client,download:async()=>{downloads++;return {status:200,bytes};},intake:async(...args:Parameters<typeof addDocument>)=>{intakes++;const result=await addDocument(...args);if(intakes===1)controller.abort();return result;}};
 await assert.rejects(processResendEvent(`resend:${messageId}`,pointer,dependencies,{signal:controller.signal,deadlineAt:Date.now()+210_000}),WorkBudgetExhausted);
 assert.equal(intakes,1);assert.equal(downloads,0);
 // New invocation: persisted intake_events, not an in-memory cursor, skips the body.
 await processResendEvent(`resend:${messageId}`,pointer,dependencies,{deadlineAt:Date.now()+210_000});
 assert.equal(intakes,2);assert.equal(downloads,1);
 await processResendEvent(`resend:${messageId}`,pointer,dependencies,{deadlineAt:Date.now()+210_000});
 assert.equal(intakes,2);assert.equal(downloads,1);
 assert.equal((await adminPool.query('select count(*)::int n from intake_events where workspace_id=$1 and idempotency_key like $2',[account.workspace.id,`resend:${emailId}:%`])).rows[0].n,2);
});
