import {randomBytes,randomUUID} from 'node:crypto';
import type {FastifyInstance,FastifyRequest} from 'fastify';
import Stripe from 'stripe';
import {Resend} from 'resend';
import {OAuth2Client,CodeChallengeMethod,type Credentials} from 'google-auth-library';
import {z} from 'zod';
import type {Actor} from '../../shared/types.js';
import {PLANS} from '../../shared/plans.js';
import {requireActor,requireSession,admins,hashToken} from '../core/auth.js';
import {adminPool,withWorkspace,transaction,audit,badRequest,notFound} from '../core/db.js';
import {config} from '../core/config.js';
import {requireWorkBudget,WorkBudgetExhausted,type WorkBudget} from '../core/work-budget.js';
import {addDocument} from '../core/intake.js';
import {encryptSecret,decryptSecret} from './secrets.js';
import {publicRequest} from './network.js';
import {mockBillingEnabled,mockBillingStatus,registerMockBilling,requireRealBilling} from './mock-billing.js';
import {
 SHEETS_SCOPE,requireTestStripeKey,verifyStripePayload,verifyResendPayload,
 publicProviderError,emailAddress,deliveredRecipients,verifiedReceivingDomain,managedReceivingProbe,verifiedManagedReceivingProbe,
 stripePlan,selectStripeSubscription,sheetConfigSchema,sheetRows,sheetRanges,
 writeSheetRange,receivedEmailBody,type PriceMap,type PaidPlanId,type ApprovalPayload,
} from './provider-policy.js';

type Integration={id:string;workspace_id:string;parser_id:string|null;kind:string;config:Record<string,unknown>;secret_ciphertext:string|null;enabled:boolean};
type StripePointer={id:string;type:string;created:number;customerId:string};
type ResendPointer={emailId:string;recipients:string[]};
const uuid=z.string().uuid();
const priceMap=():PriceMap=>({standard:process.env.STRIPE_PRICE_STANDARD,team:process.env.STRIPE_PRICE_TEAM});
const stripeClient=()=>{requireRealBilling();return new Stripe(requireTestStripeKey(process.env.STRIPE_SECRET_KEY),{timeout:15_000,maxNetworkRetries:2});};
class TimedResend extends Resend {
 override fetchRequest<T>(path:string,options:object={}){return super.fetchRequest<T>(path,{...options,signal:AbortSignal.timeout(15_000)});}
}
function resendClient(){if(!process.env.RESEND_API_KEY)badRequest('Resend API credentials are not configured',503);return new TimedResend(process.env.RESEND_API_KEY);}
function googleClient(){
 if(!process.env.GOOGLE_CLIENT_ID||!process.env.GOOGLE_CLIENT_SECRET||!process.env.GOOGLE_REDIRECT_URI)badRequest('Google OAuth requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI',503);
 const redirect=new URL(process.env.GOOGLE_REDIRECT_URI);
 if(redirect.protocol!=='https:'&&!['localhost','127.0.0.1'].includes(redirect.hostname))badRequest('Google redirect URI must use HTTPS outside localhost',503);
 return new OAuth2Client({clientId:process.env.GOOGLE_CLIENT_ID,clientSecret:process.env.GOOGLE_CLIENT_SECRET,redirectUri:process.env.GOOGLE_REDIRECT_URI,transporterOptions:{timeout:15_000}});
}
const header=(req:FastifyRequest,name:string)=>typeof req.headers[name]==='string'?req.headers[name] as string:'';
async function sessionAdmin(request:FastifyRequest){const actor=await requireActor(request,{roles:admins});requireSession(actor);return actor;}
function stripeConfigured(){return process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')&&!!process.env.STRIPE_WEBHOOK_SECRET&&Object.values(priceMap()).some(p=>p?.startsWith('price_'));}
function sheetsConfigured(){return !!(process.env.GOOGLE_CLIENT_ID&&process.env.GOOGLE_CLIENT_SECRET&&process.env.GOOGLE_REDIRECT_URI);}
let domainCache:{key:string;at:number;verified:boolean}|undefined;
type ReceivingStatus={configured:boolean;verified:boolean;mode:'custom'|'managed'|'invalid';verification:'custom-mx'|'managed-probe'|null;deliveryVerified:false;providerDomainId?:string;reason:string|null};
type ReceivingStatusDependencies={environment:Record<string,string|undefined>;client:Pick<Resend,'domains'|'emails'>};
export async function receivingStatus(force=false,dependencies?:ReceivingStatusDependencies):Promise<ReceivingStatus>{
 const environment=dependencies?.environment||process.env;
 const domain=environment.RESEND_INBOUND_DOMAIN?.trim().toLowerCase();
 const id=environment.RESEND_DOMAIN_ID;
 const mode=environment.RESEND_RECEIVING_MODE||'custom';
 if(mode!=='custom'&&mode!=='managed')return {configured:false,verified:false,mode:'invalid',verification:null,deliveryVerified:false,reason:'RESEND_RECEIVING_MODE must be custom or managed.'};
 const details:Pick<ReceivingStatus,'mode'|'verification'|'deliveryVerified'>={mode,verification:mode==='managed'?'managed-probe':'custom-mx',deliveryVerified:false};
 if(mode==='managed'){
  const probe=managedReceivingProbe(environment);
  if(!environment.RESEND_API_KEY||!environment.RESEND_WEBHOOK_SECRET||environment.RESEND_INBOUND_ENABLED!=='true'||!probe)return {...details,configured:false,verified:false,reason:'Managed receiving requires RESEND_API_KEY, RESEND_WEBHOOK_SECRET, RESEND_INBOUND_ENABLED=true, a one-label RESEND_INBOUND_DOMAIN ending .resend.app, and valid RESEND_MANAGED_PROBE_EMAIL_ID, RESEND_MANAGED_PROBE_RECIPIENT and RESEND_MANAGED_PROBE_NONCE.'};
  // A namespaced local reference, never a fabricated Resend custom-domain ID.
  const providerDomainId=`managed:${probe.domain}`;
  const key=hashToken(JSON.stringify([mode,environment.RESEND_API_KEY,environment.RESEND_WEBHOOK_SECRET,probe]));
  const result=(verified:boolean):ReceivingStatus=>({...details,configured:true,verified,providerDomainId,reason:verified?'The managed inbox probe is verified. Signed webhook delivery and parser intake still require a delivered test email.':'The retrieved managed inbox probe did not match its configured message ID, recipient, subject and body.'});
  if(!force&&domainCache?.key===key&&Date.now()-domainCache.at<60_000)return result(domainCache.verified);
  try{
   const {data,error}=await (dependencies?.client||resendClient()).emails.receiving.get(probe.emailId,{html_format:'cid'});
   if(error||!data)throw new Error('Probe lookup failed');
   const verified=verifiedManagedReceivingProbe(data,probe);
   domainCache={key,at:Date.now(),verified};
   return result(verified);
  }catch{
   domainCache={key,at:Date.now(),verified:false};
   return {...details,configured:true,verified:false,providerDomainId,reason:'Could not retrieve the managed inbox probe from Resend. Check the server credentials and received email ID.'};
  }
 }
 if(!environment.RESEND_API_KEY||!environment.RESEND_WEBHOOK_SECRET||!domain||!id||environment.RESEND_INBOUND_ENABLED!=='true')return {...details,configured:false,verified:false,reason:'Configure RESEND_API_KEY, RESEND_WEBHOOK_SECRET, RESEND_DOMAIN_ID, RESEND_INBOUND_DOMAIN and explicitly enable provisioned receiving.'};
 const key=hashToken(JSON.stringify([mode,environment.RESEND_API_KEY,environment.RESEND_WEBHOOK_SECRET,id,domain]));
 if(!force&&domainCache?.key===key&&Date.now()-domainCache.at<60_000)return {...details,configured:true,verified:domainCache.verified,providerDomainId:id,reason:domainCache.verified?null:'Resend receiving MX verification is incomplete.'};
 try{
  const {data,error}=await (dependencies?.client||resendClient()).domains.get(id);
  if(error||!data)throw new Error('Domain lookup failed');
  const verified=verifiedReceivingDomain(data,domain);
  domainCache={key,at:Date.now(),verified};
  return {...details,configured:true,verified,providerDomainId:id,reason:verified?null:'The configured domain must have receiving enabled and a verified receiving MX record.'};
 }catch{return {...details,configured:true,verified:false,providerDomainId:id,reason:'Could not verify the receiving domain with Resend. Check the server credentials and domain ID.'};}
}

/** Durable acknowledgement precedes processing; duplicate deliveries never enqueue twice. */
export async function storeProviderEvent(provider:'stripe'|'resend',id:string,payload:unknown){
 const result=await adminPool.query('insert into provider_events(id,provider,payload) values($1,$2,$3) on conflict(id) do nothing returning id',[`${provider}:${id}`,provider,JSON.stringify(payload)]);
 return {received:true,duplicate:result.rowCount===0};
}
function stripePointer(event:Stripe.Event):StripePointer|null {
 if(!['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','invoice.payment_action_required'].includes(event.type))return null;
 const object=event.data.object as unknown as {customer?:string|{id:string}};
 const customerId=typeof object.customer==='string'?object.customer:object.customer?.id;
 return customerId?{id:event.id,type:event.type,created:event.created,customerId}:null;
}

/** Reconcile current provider state under the customer lock, including older event deliveries. */
export async function reconcileStripeCustomer(pointer:StripePointer,client:Stripe=stripeClient()) {
 requireRealBilling();
 await transaction(adminPool,async c=>{
  const {rows:[local]}=await c.query('select * from subscriptions where customer_id=$1 for update',[pointer.customerId]);
  if(!local)return; // Never trust workspace/plan metadata from an incoming event.
  await c.query('insert into provider_event_workspaces(event_id,workspace_id) values($1,$2) on conflict do nothing',[`stripe:${pointer.id}`,local.workspace_id]);
  const current=await client.subscriptions.list({customer:pointer.customerId,status:'all',limit:100});
  if(current.has_more)throw new Error('Subscription reconciliation exceeded the supported customer subscription limit.');
  const subscription=selectStripeSubscription(current.data,priceMap());
  const planId=subscription?stripePlan(subscription,priceMap()):null;
  const plan=PLANS.find(p=>p.id===(planId||'explore'))!;
  const limits={id:plan.id,name:plan.name,monthlyPages:plan.monthlyPages,maxParsers:plan.maxParsers,maxConcurrent:plan.maxConcurrent,maxBytes:config.maxBytes,maxPages:config.maxPages};
  await c.query('update subscriptions set subscription_id=$2,status=$3,price_id=$4,event_created=greatest(event_created,$5),updated_at=now() where workspace_id=$1',[local.workspace_id,subscription?.id||null,subscription?.status||'inactive',subscription?.items.data[0]?.price.id||null,pointer.created]);
  await c.query('update workspaces set plan=$2 where id=$1',[local.workspace_id,JSON.stringify(limits)]);
  await audit(c,local.workspace_id,null,'billing.reconciled',null,{providerEvent:pointer.id,plan:plan.id,mode:'test'});
 });
}

export type ResendDependencies={client:Resend;download:typeof publicRequest;intake:typeof addDocument};
export async function processResendEvent(eventId:string,pointer:ResendPointer,dependencies?:ResendDependencies,budget:WorkBudget={}){
 requireWorkBudget(budget,40_000);
 if(!dependencies&&!(await receivingStatus()).verified)throw new Error('Inbound receiving is disabled or the domain cannot be verified.');
 const client=dependencies?.client||resendClient();
 const download=dependencies?.download||publicRequest;
 const intake=dependencies?.intake||addDocument;
 requireWorkBudget(budget,20_000);
 const {data:email,error}=await client.emails.receiving.get(pointer.emailId,{html_format:'cid'});
 if(error||!email)throw new Error('Resend could not retrieve the received email content.');
 const recipients=deliveredRecipients(pointer.recipients,email);
 if(!recipients.length)throw new Error('The signed and retrieved delivery envelopes did not match.');
 const {rows:routes}=await adminPool.query('select r.*,p.archived from email_routes r join parsers p on p.id=r.parser_id and p.workspace_id=r.workspace_id where r.address=any($1) and r.enabled=true and p.archived=false',[recipients]);
 if(!routes.length)return;
 if(email.attachments.length>20)throw new Error('Inbound emails are limited to 20 attachments.');
 // Count every attachment on every continuation, including already committed
 // items, so splitting an email into invocations cannot bypass the aggregate cap.
 let combinedBytes=Buffer.byteLength(email.text||email.html||'')+email.attachments.filter(a=>a.content_disposition!=='inline').reduce((sum,a)=>sum+a.size,0);
 if(combinedBytes>25*1024*1024)throw new Error('Inbound email content exceeds the 25 MiB aggregate limit.');
 const attachmentCache=new Map<string,Buffer>();
 // Existing intake receipts are the checkpoint. Never decode completed items again
 // merely because a bounded function yielded halfway through a larger email.
 const received=async(workspaceId:string,key:string)=>Boolean((await withWorkspace(workspaceId,c=>c.query('select id from intake_events where workspace_id=$1 and idempotency_key=$2',[workspaceId,key]))).rowCount);
 for(const route of routes){
  requireWorkBudget(budget,10_000);
  await adminPool.query('insert into provider_event_workspaces(event_id,workspace_id) values($1,$2) on conflict do nothing',[eventId,route.workspace_id]);
  const sender=emailAddress(email.from);
  if(route.allowed_senders.length&&!route.allowed_senders.includes(sender)){
   await withWorkspace(route.workspace_id,c=>audit(c,route.workspace_id,null,'email.rejected',route.id,{reason:'Sender not on allowlist'}));continue;
  }
  const {rows:[member]}=await adminPool.query("select user_id,role from memberships where workspace_id=$1 and role in('owner','admin') order by (role='owner') desc,created_at limit 1",[route.workspace_id]);
  if(!member)throw new Error('Inbound email requires an active workspace administrator.');
  const actor:Actor={userId:member.user_id,workspaceId:route.workspace_id,role:member.role,authType:'api',scopes:['documents:write']};
  if(route.parse_body){
   const key=`resend:${pointer.emailId}:${route.parser_id}:body`;
   if(!await received(route.workspace_id,key)){
    requireWorkBudget(budget,80_000);
    const body=await receivedEmailBody(email,config.maxBytes);
    await intake(actor,route.parser_id,body,`${email.subject.slice(0,180)||'Received email'}.eml`,'message/rfc822',key);
   }
  }
  if(route.parse_attachments){for(const attachment of email.attachments){
   if(attachment.content_disposition==='inline')continue;
   const key=`resend:${pointer.emailId}:${route.parser_id}:${attachment.id}`;
   if(await received(route.workspace_id,key))continue;
   if(attachment.size>config.maxBytes)throw new Error('An email attachment exceeds the document byte limit.');
   let bytes=attachmentCache.get(attachment.id);
   if(!bytes){
    requireWorkBudget(budget,120_000);
    const result=await client.emails.receiving.attachments.get({emailId:pointer.emailId,id:attachment.id});
    if(result.error||!result.data)throw new Error('Resend could not retrieve attachment metadata.');
    if(result.data.size>config.maxBytes)throw new Error('An email attachment exceeds the document byte limit.');
    const response=await download(result.data.download_url,{method:'GET',maxBytes:config.maxBytes});
    if(response.status<200||response.status>=300)throw Object.assign(new Error('Attachment download failed.'),{status:response.status});
    bytes=response.bytes;combinedBytes+=Math.max(0,bytes.length-attachment.size);
    if(combinedBytes>25*1024*1024)throw new Error('Inbound email exceeds the 25 MiB aggregate limit.');
    attachmentCache.set(attachment.id,bytes);
   }
   requireWorkBudget(budget,80_000);
   await intake(actor,route.parser_id,bytes,attachment.filename||`attachment-${attachment.id}.bin`,attachment.content_type,key);
  }}
  await withWorkspace(route.workspace_id,async c=>{
   await c.query('update email_routes set last_received_at=now() where id=$1',[route.id]);
   await audit(c,route.workspace_id,null,'email.received',route.id,{emailId:pointer.emailId});
  });
 }
}

/** Called by the root worker. Leases, bounded attempts and persistent errors survive restarts. */
export async function tickProviders(budget:WorkBudget={}){
 if(budget.signal?.aborted||(budget.deadlineAt!==undefined&&Date.now()+140_000>=budget.deadlineAt))return false;
 await adminPool.query("update provider_events set status='failed',error='Provider processing lease expired after the final attempt.',lease_until=null,lease_token=null where status='processing' and lease_until<now() and attempts>=5");
 const token=randomUUID();
 const {rows:[event]}=await adminPool.query(`with candidate as (
  select id from provider_events where ($2::boolean=false or provider<>'stripe') and attempts<5 and ((status in('queued','retry') and next_attempt_at<=now()) or (status='processing' and lease_until<now()))
  order by created_at for update skip locked limit 1
 ) update provider_events p set status='processing',attempts=p.attempts+1,lease_token=$1,lease_until=now()+interval '5 minutes'
 from candidate where p.id=candidate.id returning p.*`,[token,mockBillingEnabled()]);
 if(!event)return false;
 const heartbeat=setInterval(()=>{void adminPool.query("update provider_events set lease_until=now()+interval '5 minutes' where id=$1 and lease_token=$2 and status='processing'",[event.id,token]).catch(()=>{});},30_000);
 heartbeat.unref();
 try{
  if(event.provider==='stripe')await reconcileStripeCustomer(event.payload);
  else if(event.provider==='resend')await processResendEvent(event.id,event.payload,undefined,budget);
  else throw new Error('Unsupported provider event.');
  await adminPool.query("update provider_events set status='completed',error=null,lease_until=null,lease_token=null where id=$1 and lease_token=$2",[event.id,token]);
 }catch(error){
  const yielded=error instanceof WorkBudgetExhausted;
  await adminPool.query("update provider_events set status=$3,error=$4,next_attempt_at=now()+($5*interval '1 second'),attempts=greatest(0,attempts-$6),lease_until=null,lease_token=null where id=$1 and lease_token=$2",[event.id,token,!yielded&&event.attempts>=5?'failed':'retry',yielded?error.message:publicProviderError(event.provider,error),yielded?5:Math.min(3600,30*2**event.attempts),yielded?1:0]);
 }finally{clearInterval(heartbeat);}
 return true;
}

export async function reserveSheetWrite(integration:Integration,delivery:{id:string;payload:ApprovalPayload}){
 return withWorkspace(integration.workspace_id,async c=>{
  const {rows:[stored]}=await c.query("select * from integrations where id=$1 and kind='google_sheets' and enabled=true for update",[integration.id]);
  if(!stored?.secret_ciphertext)throw new Error('Google Sheets is disconnected.');
  const eventKey=delivery.payload.id;
  if(!eventKey||eventKey.length>200)throw new Error('Approval event ID is missing or invalid.');
  const {rows:[previous]}=await c.query('select * from sheet_writes where integration_id=$1 and event_key=$2',[integration.id,eventKey]);
  if(previous)return {write:previous,integration:stored as Integration};
  const mapping=sheetConfigSchema.parse(stored.config);
  const cells=sheetRows(delivery.payload,mapping);
  await c.query('insert into sheet_cursors(integration_id,workspace_id) values($1,$2) on conflict do nothing',[integration.id,integration.workspace_id]);
  const {rows:[cursor]}=await c.query('update sheet_cursors set next_row=next_row+$2 where integration_id=$1 returning next_row-$2 as start_row',[integration.id,cells.length]);
  const ranges=sheetRanges(mapping,cursor.start_row,cells.length);
  const {rows:[write]}=await c.query('insert into sheet_writes(integration_id,workspace_id,event_key,spreadsheet_id,header_range,data_range,headers,cells) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[integration.id,integration.workspace_id,eventKey,mapping.spreadsheetId,ranges.headerRange,ranges.dataRange,JSON.stringify(mapping.columns.map(x=>x.label)),JSON.stringify(cells)]);
  return {write,integration:stored as Integration};
 });
}
export async function sendGoogleSheets(integration:Integration,delivery:{id:string;payload:ApprovalPayload},options:{signal?:AbortSignal}={}) {
 options.signal?.throwIfAborted();
 const {write,integration:current}=await reserveSheetWrite(integration,delivery);
 if(write.status==='delivered')return {status:200};
 const client=googleClient();
 const credentials=JSON.parse(decryptSecret(current.secret_ciphertext!)) as Credentials;
 client.setCredentials(credentials);
 try{
  // Refresh explicitly and persist any replacement token before the range write.
  await client.getAccessToken();
  options.signal?.throwIfAborted();
  const persisted=await withWorkspace(current.workspace_id,c=>c.query('update integrations set secret_ciphertext=$2 where id=$1 and enabled=true and secret_ciphertext=$3',[current.id,encryptSecret(JSON.stringify({...credentials,...client.credentials})),current.secret_ciphertext]));
  if(!persisted.rowCount)throw new Error('Sheets connection changed during delivery. Retry with the current connection.');
  const result=await writeSheetRange(request=>client.request({...request,signal:options.signal}),write);
  await withWorkspace(current.workspace_id,async c=>{
   await c.query("update sheet_writes set status='delivered',delivered_at=now() where integration_id=$1 and event_key=$2",[current.id,write.event_key]);
   await audit(c,current.workspace_id,null,'google_sheets.delivered',current.id,{eventId:write.event_key,range:write.data_range});
  });
  return result;
 }catch(error){throw Object.assign(new Error(publicProviderError('Google Sheets',error)),{status:(error as {status?:number}).status});}
}

export async function registerProviders(app:FastifyInstance){
 await registerMockBilling(app);
 app.get('/api/providers/status',async request=>{
  const actor=await requireActor(request);requireSession(actor);
  const receiving=await receivingStatus();
  return {
   stripe:mockBillingEnabled()?await mockBillingStatus(actor.workspaceId):{configured:!!stripeConfigured(),mode:'test',verified:false,reason:stripeConfigured()?'Test credentials configured; Checkout and subscription-event verification still require test-mode evidence.':'Set a sk_test_ key, webhook signing secret and server-mapped STRIPE_PRICE_STANDARD / STRIPE_PRICE_TEAM.'},
   resend:{...receiving,addressAvailable:receiving.verified,reason:receiving.reason||'Domain receiving is verified. End-to-end delivery is a separate release check.'},
   googleSheets:{configured:sheetsConfigured(),verified:false,reason:sheetsConfigured()?'Google OAuth configured; connect a workspace account and verify a delivery.':'Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.'},
  };
 });
 app.get('/api/providers/events',async request=>{
  const actor=await sessionAdmin(request);
  const {rows}=await adminPool.query('select p.id,p.provider,p.status,p.attempts,p.error,p.created_at from provider_events p join provider_event_workspaces w on w.event_id=p.id where w.workspace_id=$1 order by p.created_at desc limit 50',[actor.workspaceId]);
  return {events:rows};
 });
 app.get('/api/providers/email-routes',async request=>{
  const actor=await requireActor(request);requireSession(actor);
  const receiving=await receivingStatus();
  const routes=await withWorkspace(actor.workspaceId,async c=>(await c.query('select id,parser_id,address,parse_body,parse_attachments,allowed_senders,enabled,last_received_at from email_routes order by created_at desc')).rows);
  return {receiving,routes:routes.map(r=>({...r,address:receiving.verified&&r.enabled?r.address:null,status:receiving.verified&&r.enabled?'configured':'blocked'}))};
 });
 app.post('/api/providers/email-routes',async request=>{
  const actor=await sessionAdmin(request);
  const input=z.object({parserId:uuid,parseBody:z.boolean().default(true),parseAttachments:z.boolean().default(true),allowedSenders:z.array(z.email()).max(100).default([])}).strict().refine(v=>v.parseBody||v.parseAttachments).parse(request.body);
  const receiving=await receivingStatus(true);if(!receiving.verified)badRequest(receiving.reason||'Receiving domain is not verified',503);
  const address=`in-${randomBytes(12).toString('hex')}@${process.env.RESEND_INBOUND_DOMAIN!.trim().toLowerCase()}`;
  return withWorkspace(actor.workspaceId,async c=>{
   const parser=await c.query('select id from parsers where id=$1 and archived=false',[input.parserId]);if(!parser.rowCount)notFound('Active parser not found');
   const {rows:[route]}=await c.query('insert into email_routes(workspace_id,parser_id,address,provider_domain_id,parse_body,parse_attachments,allowed_senders,created_by,domain_verified_at) values($1,$2,$3,$4,$5,$6,$7,$8,now()) returning id,address,parser_id,enabled',[actor.workspaceId,input.parserId,address,receiving.providerDomainId,input.parseBody,input.parseAttachments,JSON.stringify(input.allowedSenders.map(s=>s.toLowerCase())),actor.userId]);
   await audit(c,actor.workspaceId,actor.userId,'email_route.created',route.id,{parserId:input.parserId});return {route,status:'configured',deliveryVerified:false};
  });
 });
 app.delete('/api/providers/email-routes/:id',async request=>{
  const actor=await sessionAdmin(request),id=uuid.parse((request.params as {id:string}).id);
  await withWorkspace(actor.workspaceId,async c=>{const result=await c.query('update email_routes set enabled=false where id=$1 returning id',[id]);if(!result.rowCount)notFound();await audit(c,actor.workspaceId,actor.userId,'email_route.disabled',id);});return {disabled:true};
 });
 app.post('/api/billing/checkout',async request=>{
  const actor=await sessionAdmin(request);
  requireRealBilling();
  const {planId}=z.object({planId:z.enum(['standard','team'])}).strict().parse(request.body);
  if(!stripeConfigured())badRequest('Stripe test-mode Checkout is not configured',503);
  const client=stripeClient(),priceId=priceMap()[planId];if(!priceId)badRequest('This plan has no configured Stripe test price',503);
  const price=await client.prices.retrieve(priceId),plan=PLANS.find(p=>p.id===planId)!;
  if(price.livemode||!price.active||price.currency!=='eur'||price.unit_amount!==plan.monthlyPrice*100||price.recurring?.interval!=='month'||price.recurring.interval_count!==1)badRequest('Configured Stripe price does not match the Folio monthly plan',503);
  const reservation=await transaction(adminPool,async c=>{
   await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`billing:${actor.workspaceId}`]);
   let {rows:[subscription]}=await c.query('select * from subscriptions where workspace_id=$1 for update',[actor.workspaceId]);
   if(!subscription?.customer_id){
    const customer=await client.customers.create({metadata:{folio_workspace:actor.workspaceId}},{idempotencyKey:`folio-customer:${actor.workspaceId}`});
    await c.query('insert into subscriptions(workspace_id,customer_id) values($1,$2) on conflict(workspace_id) do update set customer_id=excluded.customer_id',[actor.workspaceId,customer.id]);
    subscription={customer_id:customer.id,status:'inactive'};
   }
   const active=await client.subscriptions.list({customer:subscription.customer_id,status:'all',limit:100});
   if(active.has_more||active.data.some(s=>!['canceled','incomplete_expired'].includes(s.status)))badRequest('Use the billing portal to manage the existing subscription',409);
   let {rows:[checkout]}=await c.query('select * from billing_checkouts where workspace_id=$1',[actor.workspaceId]);
   if(checkout?.session_id){const existing=await client.checkout.sessions.retrieve(checkout.session_id);if(existing.status==='open'&&checkout.plan_id===planId)return {url:existing.url};if(existing.status==='open')await client.checkout.sessions.expire(existing.id);checkout=null;}
   if(checkout&&checkout.plan_id!==planId)badRequest('A different Checkout is being prepared. Retry that plan before changing plans.',409);
   if(checkout&&Date.now()-new Date(checkout.created_at).getTime()>23*60*60*1000)badRequest('An unresolved Checkout reservation requires operator reconciliation before another Checkout can be created.',409);
   if(!checkout){const result=await c.query('insert into billing_checkouts(workspace_id,plan_id) values($1,$2) on conflict(workspace_id) do update set request_id=gen_random_uuid(),session_id=null,plan_id=excluded.plan_id,created_at=now() returning *',[actor.workspaceId,planId]);checkout=result.rows[0];}
   return {requestId:checkout.request_id as string,customerId:subscription.customer_id as string};
  });
  if('url' in reservation)return {url:reservation.url,mode:'test'};
  // The idempotency key is committed before the external side effect. A process crash
  // after Stripe creates the Session can safely recover that same Session on retry.
  const session=await client.checkout.sessions.create({customer:reservation.customerId,mode:'subscription',line_items:[{price:priceId,quantity:1}],success_url:`${config.origin}/app/usage?checkout=returned`,cancel_url:`${config.origin}/app/usage?checkout=canceled`,client_reference_id:actor.workspaceId},{idempotencyKey:`folio-checkout:${reservation.requestId}`});
  await withWorkspace(actor.workspaceId,async c=>{
   const result=await c.query('update billing_checkouts set session_id=$3 where workspace_id=$1 and request_id=$2',[actor.workspaceId,reservation.requestId,session.id]);if(!result.rowCount)throw new Error('Checkout reservation changed.');
   await audit(c,actor.workspaceId,actor.userId,'billing.checkout_created',null,{planId,mode:'test'});
  });
  return {url:session.url,mode:'test'};
 });
 app.post('/api/billing/portal',async request=>{
  const actor=await sessionAdmin(request);requireRealBilling();if(!stripeConfigured())badRequest('Stripe test-mode billing is not configured',503);
  const local=await withWorkspace(actor.workspaceId,async c=>(await c.query('select customer_id from subscriptions where workspace_id=$1',[actor.workspaceId])).rows[0]);
  if(!local?.customer_id)badRequest('No Stripe test customer exists for this workspace',409);
  const session=await stripeClient().billingPortal.sessions.create({customer:local.customer_id,return_url:`${config.origin}/app/usage`});return {url:session.url,mode:'test'};
 });
 await app.register(async raw=>{
  raw.removeContentTypeParser('application/json');
  raw.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
  raw.post('/api/billing/webhook',{bodyLimit:1024*1024,config:{providerWebhook:true}},async(request,reply)=>{
   requireRealBilling();
   if(!process.env.STRIPE_WEBHOOK_SECRET||!process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))badRequest('Stripe test webhooks are not configured',503);
   let pointer:StripePointer|null;
   try{pointer=stripePointer(verifyStripePayload(request.body as Buffer,header(request,'stripe-signature'),process.env.STRIPE_WEBHOOK_SECRET));}catch{badRequest('Invalid Stripe test webhook signature or payload',400);}
   if(!pointer!)return {received:true,ignored:true};
   return reply.code(202).send(await storeProviderEvent('stripe',pointer!.id,pointer!));
  });
  raw.post('/api/providers/resend/webhook',{bodyLimit:1024*1024,config:{providerWebhook:true}},async(request,reply)=>{
   if(!process.env.RESEND_WEBHOOK_SECRET)badRequest('Resend webhooks are not configured',503);
   let event:ReturnType<typeof verifyResendPayload>;
   try{event=verifyResendPayload(request.body as Buffer,{'svix-id':header(request,'svix-id'),'svix-timestamp':header(request,'svix-timestamp'),'svix-signature':header(request,'svix-signature')},process.env.RESEND_WEBHOOK_SECRET);}catch{badRequest('Invalid Resend webhook signature or payload',400);}
   return reply.code(202).send(await storeProviderEvent('resend',header(request,'svix-id'),{emailId:event!.data.email_id,recipients:event!.data.received_for}));
  });
 });
 await registerGoogleRoutes(app);
}

async function registerGoogleRoutes(app:FastifyInstance){
 app.post('/api/google/start',async request=>{
  const actor=await sessionAdmin(request),client=googleClient();
  const body=z.object({integrationId:uuid.optional(),parserId:uuid.optional(),name:z.string().min(1).max(80).default('Google Sheets'),spreadsheetId:z.string().optional(),sheetName:z.string().optional(),columns:z.array(z.object({source:z.string(),label:z.string()})).optional(),lineItems:z.string().optional()}).strict().parse(request.body);
  const state=randomBytes(32).toString('base64url'),codes=await client.generateCodeVerifierAsync();
  const integration=await withWorkspace(actor.workspaceId,async c=>{
   let id=body.integrationId;
   if(id){const {rows:[existing]}=await c.query("select * from integrations where id=$1 and kind='google_sheets' for update",[id]);if(!existing)notFound('Sheets integration not found');}
   else{
    if(!body.parserId)badRequest('Choose a parser for the Sheets integration');
    const {rows:[parser]}=await c.query('select s.schema from parsers p join schema_versions s on s.id=p.active_schema_id where p.id=$1 and p.archived=false',[body.parserId]);if(!parser)notFound('Active parser not found');
    const columns=body.columns||[{source:'$documentId',label:'Document ID'},...parser.schema.fields.map((field:{key:string;label:string})=>({source:field.key,label:field.label}))];
    const mapping=sheetConfigSchema.parse({spreadsheetId:body.spreadsheetId,sheetName:body.sheetName,columns,...(body.lineItems?{lineItems:body.lineItems}:{})});
    id=randomUUID();await c.query("insert into integrations(id,workspace_id,parser_id,name,kind,config,enabled) values($1,$2,$3,$4,'google_sheets',$5,false)",[id,actor.workspaceId,body.parserId,body.name,JSON.stringify(mapping)]);
   }
   await c.query('delete from oauth_states where integration_id=$1',[id]);
   await c.query('insert into oauth_states(state_hash,workspace_id,user_id,integration_id,verifier_ciphertext,expires_at) values($1,$2,$3,$4,$5,now()+interval \'10 minutes\')',[hashToken(state),actor.workspaceId,actor.userId,id,encryptSecret(codes.codeVerifier)]);
   await audit(c,actor.workspaceId,actor.userId,'google_sheets.authorization_started',id!);return id!;
  });
  const authorizationUrl=client.generateAuthUrl({access_type:'offline',prompt:'consent',scope:[SHEETS_SCOPE],state,code_challenge:codes.codeChallenge,code_challenge_method:CodeChallengeMethod.S256});
  return {integrationId:integration,authorizationUrl,scope:SHEETS_SCOPE};
 });
 app.get('/api/google/callback',{logLevel:'silent'},async(request,reply)=>{
  const actor=await requireActor(request);requireSession(actor);
  const query=z.object({state:z.string().min(20).max(200),code:z.string().max(4000).optional(),error:z.string().max(100).optional()}).parse(request.query);
  const {rows:[state]}=await adminPool.query(`update oauth_states s set consumed_at=now()
   where state_hash=$1 and user_id=$2 and consumed_at is null and expires_at>now()
   and exists(select 1 from memberships m where m.workspace_id=s.workspace_id and m.user_id=$2 and m.role in('owner','admin')) returning s.*`,[hashToken(query.state),actor.userId]);
  if(!state)badRequest('Google authorization state expired, was already used, or belongs to another account',400);
  if(query.error||!query.code)return reply.redirect(`${config.origin}/app/integrations?google=denied`);
  const client=googleClient();
  try{
   const {tokens}=await client.getToken({code:query.code,codeVerifier:decryptSecret(state.verifier_ciphertext)});
   if(!tokens.scope?.split(' ').includes(SHEETS_SCOPE))badRequest('Google Sheets permission was not granted',400);
   if(!tokens.refresh_token)badRequest('Google did not return offline access. Reconnect with consent to allow background delivery.',400);
   await withWorkspace(state.workspace_id,async c=>{
    await c.query('select id from integrations where id=$1 for update',[state.integration_id]);
    const current=await c.query('delete from oauth_states where state_hash=$1 and consumed_at is not null returning state_hash',[hashToken(query.state)]);
    if(!current.rowCount)badRequest('Google authorization was superseded or the integration was disconnected. Start again.',400);
    await c.query('update integrations set secret_ciphertext=$2,enabled=true where id=$1',[state.integration_id,encryptSecret(JSON.stringify(tokens))]);
    await audit(c,state.workspace_id,actor.userId,'google_sheets.connected',state.integration_id);
   });
   return reply.redirect(`${config.origin}/app/integrations?google=connected`);
  }catch(error){if((error as {statusCode?:number}).statusCode===400)throw error;badRequest(publicProviderError('Google OAuth',error),502);}
 });
 app.post('/api/google/:id/disconnect',async request=>{
  const actor=await sessionAdmin(request),id=uuid.parse((request.params as {id:string}).id);
  const row=await withWorkspace(actor.workspaceId,async c=>{const result=await c.query("select * from integrations where id=$1 and kind='google_sheets' for update",[id]);if(!result.rows[0])notFound();await c.query('update integrations set enabled=false,secret_ciphertext=null where id=$1',[id]);await c.query('delete from oauth_states where integration_id=$1',[id]);await audit(c,actor.workspaceId,actor.userId,'google_sheets.disconnected',id);return result.rows[0];});
  let providerRevoked=false;
  if(row.secret_ciphertext){const token=JSON.parse(decryptSecret(row.secret_ciphertext)) as Credentials;const revoke=token.refresh_token||token.access_token;if(revoke){try{await googleClient().revokeToken(revoke);providerRevoked=true;}catch{ /* Local disconnection remains effective; user can revoke in Google account settings. */ }}}
  return {disconnected:true,providerRevoked,reason:providerRevoked?null:'Local delivery is disabled. Revoke Folio access in your Google account if provider revocation could not complete.'};
 });
}
