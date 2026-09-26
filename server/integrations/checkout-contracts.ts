import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type Stripe from 'stripe';
import {z} from 'zod';
import type {CheckoutTermsList,CheckoutTermsRecord,CheckoutTermsSummary} from '../../shared/checkout-contracts.js';
import {PLANS} from '../../shared/plans.js';
import {monthlyAiSuggestionLimit} from '../../shared/ai-suggestion-allowances.js';
import {adminPool,badRequest,notFound,transaction,withWorkspace} from '../core/db.js';

const boundedText=(max:number)=>z.string().min(1).max(max).refine(value=>!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value));
const shortText=(max:number)=>boundedText(max).refine(value=>!/[\r\n\t]/.test(value));
const identifier=(prefix:string)=>z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_-]{1,200}$`));
const httpsUrl=z.string().max(2048).url().refine(value=>{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash;});
const policyInput=z.object({version:shortText(80),language:z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/).max(35),title:shortText(160),text:boundedText(16000),url:httpsUrl,agreementText:shortText(1000)}).strict();
/** No production catalogue is supplied. Only the internal dependency seam can enable capture. */
export type CheckoutPolicyInput=z.input<typeof policyInput>;
type Policy=CheckoutPolicyInput&{sha256:string};
const policySchema=policyInput.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/)});
const hash=(value:string)=>createHash('sha256').update(value,'utf8').digest('hex');
const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const notice='This Checkout terms record preserves the presented terms and recorded acceptance evidence. It does not confirm payment, entitlement, delivery of contractual information, or legal completeness.';
const markdownText=(text:string)=>text.replace(/[\\`*_{}\[\]()#+.!|>-]/g,'\\$&');
function agreementMessage(policy:CheckoutPolicyInput){
 const url=new URL(policy.url).href.replace(/[()]/g,char=>char==='('?'%28':'%29');
 const message=`${markdownText(policy.agreementText)} [${markdownText(policy.title)}](${url})`;
 if(message.length>1200||url.length>2048)badRequest('Checkout terms configuration is unavailable.',503);
 return message;
}
export function validateCheckoutPolicy(input:unknown):Policy{
 const parsed=policyInput.safeParse(input);
 if(!parsed.success||Buffer.byteLength(parsed.data.text,'utf8')>60000)badRequest('Checkout terms configuration is unavailable.',503);
 agreementMessage(parsed.data); // Stripe limits the final custom message to 1200 characters.
 return {...parsed.data,sha256:hash(parsed.data.text)};
}
type ContractRow={id:string;workspace_id:string;initiated_by:string|null;billing_mode:'test'|'live';customer_id:string;plan_id:'standard'|'team';policy:Policy;offer:CheckoutTermsRecord['offer'];create_params:Stripe.Checkout.SessionCreateParams;params_sha256:string;session_id:string|null;created_at:Date;created_cursor?:string;completion_state?:'accepted'|'not_recorded'|null;provider_event_created_at?:Date;observed_at?:Date};
const offerSchema=z.object({planName:shortText(80),currency:z.literal('eur'),amountMinor:z.number().int().positive(),interval:z.literal('month'),pagesPerCalendarMonth:z.number().int().positive(),aiSuggestionsPerCalendarMonth:z.number().int().positive()}).strict();
function checked(row:ContractRow){
 const policy=policySchema.parse(row.policy);offerSchema.parse(row.offer);
 if(hash(policy.text)!==policy.sha256||hash(stable(row.create_params))!==row.params_sha256)throw new Error('Stored Checkout terms record failed its integrity check.');
 return row;
}
export async function readCheckoutContract(c:PoolClient,id:string){
 const {rows:[row]}=await c.query<ContractRow>('SELECT * FROM checkout_contracts WHERE id=$1',[id]);
 return row?checked(row):null;
}
export async function reserveCheckoutContract(c:PoolClient,input:{id:string;workspaceId:string;userId:string|null;mode:'test'|'live';customerId:string;planId:'standard'|'team';priceId:string;origin:string;policy:Policy}){
 const {id,workspaceId,userId,mode,customerId,planId,priceId,origin,policy}=input;
 const plan=PLANS.find(plan=>plan.id===planId)!;
 const offer:CheckoutTermsRecord['offer']={planName:plan.name,currency:'eur',amountMinor:plan.monthlyPrice*100,interval:'month',pagesPerCalendarMonth:plan.monthlyPages,aiSuggestionsPerCalendarMonth:monthlyAiSuggestionLimit(planId)};
 // Every parameter (including URLs and price) is durable before any transport.
 const params:Stripe.Checkout.SessionCreateParams={customer:customerId,mode:'subscription',line_items:[{price:priceId,quantity:1}],success_url:`${origin}/app/usage?checkout=returned`,cancel_url:`${origin}/app/usage?checkout=canceled`,client_reference_id:workspaceId,consent_collection:{terms_of_service:'required'},custom_text:{terms_of_service_acceptance:{message:agreementMessage(policy)}},metadata:{folio_contract:id,folio_contract_sha256:policy.sha256}};
 if(Buffer.byteLength(JSON.stringify(params))>10000)badRequest('Checkout terms configuration is unavailable.',503);
 const {rows:[row]}=await c.query<ContractRow>('INSERT INTO checkout_contracts(id,workspace_id,initiated_by,billing_mode,customer_id,plan_id,policy,offer,create_params,params_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',[id,workspaceId,userId,mode,customerId,planId,JSON.stringify(policy),JSON.stringify(offer),JSON.stringify(params),hash(stable(params))]);
 return checked(row);
}
export function contractSessionKey(row:ContractRow){return `folio-checkout-contract:v1:${row.billing_mode}:${row.id}`;}
function sessionBinding(row:ContractRow,session:Stripe.Checkout.Session){
 const agreement=row.create_params.custom_text?.terms_of_service_acceptance;
 if(!identifier('cs').safeParse(session.id).success||session.livemode!==(row.billing_mode==='live')||session.mode!=='subscription'||(typeof session.customer==='string'?session.customer:session.customer?.id)!==row.customer_id||session.client_reference_id!==row.workspace_id||session.metadata?.folio_contract!==row.id||session.metadata?.folio_contract_sha256!==row.policy.sha256||session.consent_collection?.terms_of_service!=='required'||session.success_url!==row.create_params.success_url||session.cancel_url!==row.create_params.cancel_url||!agreement||session.custom_text?.terms_of_service_acceptance?.message!==agreement.message)throw new Error('Stripe Checkout does not match its terms record.');
 if(row.session_id&&row.session_id!==session.id)throw new Error('Stripe Checkout terms record is already bound.');
}
export async function bindCheckoutContract(c:PoolClient,row:ContractRow,session:Stripe.Checkout.Session){
 sessionBinding(row,session);
 const result=await c.query('UPDATE checkout_contracts SET session_id=$2 WHERE id=$1 AND (session_id IS NULL OR session_id=$2)',[row.id,session.id]);
 if(!result.rowCount)throw new Error('Stripe Checkout terms record changed.');
}
export type CheckoutCompletionPointer={contractId:string;sessionId:string;workspaceId:string;policySha256:string;consent:'accepted'|null};
const completionPointerSchema=z.object({contractId:z.string().uuid(),sessionId:identifier('cs'),workspaceId:z.string().uuid(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),consent:z.enum(['accepted']).nullable()}).strict();
/** A tiny allowlist copied only after signature/mode verification, never a raw payload. */
export function checkoutCompletionPointer(event:Stripe.Event):CheckoutCompletionPointer|undefined{
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded'].includes(event.type))return;
 const session=event.data.object as Stripe.Checkout.Session;
 if(!session.metadata?.folio_contract)return;
 const parsed=completionPointerSchema.safeParse({contractId:session.metadata.folio_contract,sessionId:session.id,workspaceId:session.client_reference_id,policySha256:session.metadata.folio_contract_sha256,consent:session.consent?.terms_of_service??null});
 if(!parsed.success)throw new Error('Stripe Checkout completion pointer is invalid.');
 return parsed.data;
}
/** Uses only a durable, signature-verified pointer and independently retrieved Session. */
export async function captureCheckoutCompletion(event:{id:string;created:number;customerId:string;mode?:'test'|'live';checkout?:CheckoutCompletionPointer},client:Pick<Stripe,'checkout'>){
 if(!event.checkout)return;
 const pointer=completionPointerSchema.parse(event.checkout),id=pointer.contractId;
 const row=await transaction(adminPool,c=>readCheckoutContract(c,id));
 if(!row)return; // Arbitrary provider metadata cannot create a local contract.
 if(event.mode!==row.billing_mode||event.customerId!==row.customer_id||pointer.workspaceId!==row.workspace_id||pointer.policySha256!==row.policy.sha256||!identifier('evt').safeParse(event.id).success||!Number.isSafeInteger(event.created)||event.created<0||event.created>253402300799)throw new Error('Stripe Checkout completion evidence is invalid.');
 // Retrieve the bound Session, including its actual price/quantity. Do not rely
 // on event metadata to assert what was purchased, or store the raw event.
 const session=await client.checkout.sessions.retrieve(pointer.sessionId,{expand:['line_items']});
 sessionBinding(row,session);
 const lines=session.line_items;
 if(session.status!=='complete'||!lines||lines.has_more||lines.data.length!==1||lines.data[0].quantity!==1||lines.data[0].price?.id!==row.create_params.line_items?.[0]?.price||session.amount_subtotal!==row.offer.amountMinor||session.currency!==row.offer.currency)throw new Error('Stripe Checkout completed offer does not match its terms record.');
 if((session.consent?.terms_of_service??null)!==pointer.consent)throw new Error('Stripe Checkout acceptance evidence changed.');
 await transaction(adminPool,async c=>{
  const {rows:[locked]}=await c.query<ContractRow>('SELECT * FROM checkout_contracts WHERE id=$1 FOR UPDATE',[id]);
  if(!locked)return; // Workspace may have been deleted during retrieval.
  checked(locked);await bindCheckoutContract(c,locked,session);
  await c.query("INSERT INTO checkout_contract_receipts(contract_id,workspace_id,session_id,event_id,state,provider_event_created_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6)) ON CONFLICT(contract_id) DO NOTHING",[locked.id,locked.workspace_id,session.id,event.id,session.consent?.terms_of_service==='accepted'?'accepted':'not_recorded',event.created]);
 });
}
const joined=`SELECT c.*,to_char(c.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_cursor,r.state AS completion_state,r.provider_event_created_at,r.observed_at FROM checkout_contracts c LEFT JOIN checkout_contract_receipts r ON r.contract_id=c.id`;
function summary(row:ContractRow):CheckoutTermsSummary{return {id:row.id,mode:row.billing_mode,planId:row.plan_id,policyVersion:row.policy.version,language:row.policy.language,createdAt:row.created_at.toISOString(),completion:row.completion_state?{state:row.completion_state,providerEventCreatedAt:row.provider_event_created_at!.toISOString(),observedAt:row.observed_at!.toISOString(),source:'verified_stripe_checkout_session'}:null};}
const cursorSchema=z.object({at:z.string().datetime(),id:z.string().uuid()}).strict();
function decodeCursor(input:unknown){
 if(input===undefined)return null;
 if(typeof input!=='string'||input.length>256||!/^[A-Za-z0-9_-]+$/.test(input))badRequest('Invalid terms record cursor.');
 try{return cursorSchema.parse(JSON.parse(Buffer.from(input,'base64url').toString('utf8')));}catch{badRequest('Invalid terms record cursor.');}
}
export async function listCheckoutContracts(workspaceId:string,captureEnabled:boolean,mode:'test'|'live'|null,cursorInput?:unknown):Promise<CheckoutTermsList>{
 const cursor=decodeCursor(cursorInput);
 return withWorkspace(workspaceId,async c=>{
  const {rows}=await c.query<ContractRow>(`${joined} WHERE c.workspace_id=$1 AND ($2::timestamptz IS NULL OR (c.created_at,c.id)<($2::timestamptz,$3::uuid)) ORDER BY c.created_at DESC,c.id DESC LIMIT 21`,[workspaceId,cursor?.at??null,cursor?.id??null]);
  const records=rows.slice(0,20).map(row=>summary(checked(row))),last=rows[19];
  const legacy=(await c.query('SELECT 1 FROM billing_checkouts b WHERE b.workspace_id=$1 AND b.billing_mode=$2 AND NOT EXISTS(SELECT 1 FROM checkout_contracts c WHERE c.id=b.request_id)',[workspaceId,mode])).rowCount;
  return {captureEnabled,records,nextCursor:rows.length>20&&last?Buffer.from(JSON.stringify({at:last.created_cursor,id:last.id})).toString('base64url'):null,legacyCheckout:legacy&&mode?{mode,state:'unknown'}:null};
 });
}
export async function getCheckoutContract(workspaceId:string,id:string):Promise<CheckoutTermsRecord>{
 return withWorkspace(workspaceId,async c=>{
  const {rows:[row]}=await c.query<ContractRow>(`${joined} WHERE c.workspace_id=$1 AND c.id=$2`,[workspaceId,id]);
  if(!row)notFound();checked(row);
  const {agreementText,...policy}=row.policy;
  return {...summary(row),policy,offer:row.offer,agreementText,evidenceNotice:notice};
 });
}
export function renderCheckoutTermsRecord(record:CheckoutTermsRecord){
 return ['Checkout terms record',notice,'',`Record: ${record.id}`,`Billing mode: ${record.mode}`,`Prepared at: ${record.createdAt}`,`Plan: ${record.offer.planName}`,`Recurring price: ${(record.offer.amountMinor/100).toFixed(2)} EUR per month`,`Page allowance: ${record.offer.pagesPerCalendarMonth} per calendar month (UTC)`,`AI field/split suggestion allowance: ${record.offer.aiSuggestionsPerCalendarMonth} per calendar month (UTC)`,`Policy version: ${record.policy.version}`,`Language: ${record.policy.language}`,`Policy content SHA256: ${record.policy.sha256}`,`Presented policy link: ${record.policy.url}`,`Acceptance state: ${record.completion?.state??'awaiting_record'}`,...(record.completion?[`Provider completion event created at: ${record.completion.providerEventCreatedAt}`,`Evidence observed at: ${record.completion.observedAt}`,'These timestamps are event/observation times, not a measured checkbox-click time.']:[]),'',record.agreementText,'',record.policy.title,record.policy.text,''].join('\n');
}
