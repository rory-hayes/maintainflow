import Stripe from 'stripe';
import { Webhook } from 'svix';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import type { GetReceivingEmailResponseSuccess, GetDomainResponseSuccess } from 'resend';
import { PLANS } from '../../shared/plans.js';

export type PaidPlanId = 'standard' | 'team';
export type PriceMap = Partial<Record<PaidPlanId,string>>;
export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
export const columnSchema=z.object({source:z.string().min(1).max(100),label:z.string().min(1).max(100)}).strict();
export const sheetConfigSchema=z.object({
 spreadsheetId:z.string().regex(/^[A-Za-z0-9_-]{15,150}$/),
 sheetName:z.string().min(1).max(80).refine(s=>!/[\[\]:*?\/\\\u0000-\u001f]/.test(s),'Use a valid worksheet title'),
 columns:z.array(columnSchema).min(1).max(50), lineItems:z.string().min(1).max(100).optional(),
}).strict();
export type SheetConfig=z.infer<typeof sheetConfigSchema>;
export type ApprovalPayload={id:string;document:{id:string;name:string};runId:string;revision:number;values:Record<string,unknown>};
export type SheetCells=(string|number|boolean)[][];

export function requireTestStripeKey(key:string|undefined):string {
 if(!key?.startsWith('sk_test_')) throw new Error('Stripe test mode requires STRIPE_SECRET_KEY beginning sk_test_. Live keys are disabled.');
 return key;
}
export function verifyStripePayload(raw:Buffer,signature:string,secret:string) {
 const event=Stripe.webhooks.constructEvent(raw,signature,secret);
 if(event.livemode) throw new Error('Live Stripe events are disabled.');
 return event;
}
export const resendEventSchema=z.object({type:z.literal('email.received'),data:z.object({
 email_id:z.string().uuid(),received_for:z.array(z.string()).max(50),
})});
export function verifyResendPayload(raw:Buffer,headers:Record<string,string>,secret:string) {
 const payload=raw.toString('utf8');
 new Webhook(secret).verify(payload,headers);
 return resendEventSchema.parse(JSON.parse(payload));
}
export function publicProviderError(provider:string,error:unknown) {
 const candidate=error as {status?:number;statusCode?:number;code?:string};
 const status=Number(candidate?.status||candidate?.statusCode);
 if(status===401||status===403) return `${provider} authorization failed. Check credentials and permissions.`;
 if(status===429) return `${provider} rate limit reached. The worker will retry within its configured limit.`;
 return `${provider} operation failed. Check provider configuration and the documented release gates.`;
}
export function emailAddress(value:string) {
 const address=(value.match(/<([^<>]+)>/)?.[1]||value).trim().toLowerCase();
 return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address)?address:null;
}
/**
 * Intersect provider-supplied received_for values; visible To/CC never authorizes routing.
 * Resend derives received_for from Received headers, so this is not independently
 * verified SMTP-envelope provenance.
 */
export function deliveredRecipients(signedRecipients:string[],email:Pick<GetReceivingEmailResponseSuccess,'received_for'>) {
 const signed=new Set(signedRecipients.map(emailAddress).filter(Boolean));
 return [...new Set((email.received_for||[]).map(emailAddress).filter((x):x is string=>!!x&&signed.has(x)))];
}
export function verifiedReceivingDomain(domain:GetDomainResponseSuccess,expectedName:string) {
 return domain.name.toLowerCase()===expectedName.toLowerCase()
  && domain.capabilities.receiving==='enabled'
  && domain.records.some(r=>r.record==='Receiving'&&r.type==='MX'&&r.status==='verified');
}
const managedReceivingDomain=z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.resend\.app$/);
const managedProbeSchema=z.object({
 domain:managedReceivingDomain,
 emailId:z.string().uuid(),
 recipient:z.string().regex(/^folio-probe-[a-f0-9]{32}@[a-z0-9.-]+$/),
 nonce:z.string().regex(/^[a-f0-9]{32,64}$/),
}).refine(probe=>probe.recipient.split('@')[1]===probe.domain);
export type ManagedReceivingProbe=z.infer<typeof managedProbeSchema>;
/** Operator-created probe values bind a managed inbox check to one intended message. */
export function managedReceivingProbe(environment:Record<string,string|undefined>):ManagedReceivingProbe|null {
 const parsed=managedProbeSchema.safeParse({
  domain:environment.RESEND_INBOUND_DOMAIN?.trim().toLowerCase(),
  emailId:environment.RESEND_MANAGED_PROBE_EMAIL_ID?.trim().toLowerCase(),
  recipient:environment.RESEND_MANAGED_PROBE_RECIPIENT?.trim().toLowerCase(),
  nonce:environment.RESEND_MANAGED_PROBE_NONCE?.trim(),
 });
 return parsed.success?parsed.data:null;
}
/** This proves retrieval of the configured probe, not custom-domain MX or webhook delivery. */
export function verifiedManagedReceivingProbe(email:unknown,probe:ManagedReceivingProbe):boolean {
 const parsed=z.object({object:z.literal('email'),id:z.string().uuid(),received_for:z.array(z.string()).max(50),subject:z.string(),text:z.string().max(10_000)}).safeParse(email);
 if(!parsed.success)return false;
 const message=parsed.data,recipients=message.received_for.map(value=>value.trim().toLowerCase());
 const expected=`Folio receiving probe ${probe.nonce}`;
 return message.id.toLowerCase()===probe.emailId && recipients.length===1 && recipients[0]===probe.recipient
  && message.subject===expected && message.text.trim()===expected;
}
export function stripePlan(subscription:Stripe.Subscription,prices:PriceMap):PaidPlanId|null {
 if(subscription.livemode||!['active','trialing'].includes(subscription.status)||subscription.items.data.length!==1)return null;
 const item=subscription.items.data[0]!;
 if(item.quantity!==1)return null;
 const plan=PLANS.find(p=>p.id!=='explore'&&prices[p.id as PaidPlanId]===item.price.id);
 if(!plan||item.price.livemode||item.price.currency!=='eur'||item.price.unit_amount!==plan.monthlyPrice*100||item.price.recurring?.interval!=='month'||item.price.recurring.interval_count!==1)return null;
 return plan.id as PaidPlanId;
}
export function selectStripeSubscription(subscriptions:Stripe.Subscription[],prices:PriceMap) {
 return subscriptions.filter(s=>stripePlan(s,prices)).sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id))[0]
  || subscriptions.slice().sort((a,b)=>b.created-a.created||a.id.localeCompare(b.id))[0] || null;
}
export function sheetColumn(index:number) {
 if(!Number.isInteger(index)||index<1||index>50)throw new Error('Spreadsheet column limit exceeded.');
 let name='';while(index){index--;name=String.fromCharCode(65+index%26)+name;index=Math.floor(index/26);}return name;
}
function valueAt(object:unknown,path:string):unknown {
 return path.split('.').reduce<unknown>((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?(v as Record<string,unknown>)[k]:null,object);
}
/** RAW prevents formula interpretation without altering identifiers or user strings. */
function rawCell(value:unknown):string|number|boolean {
 if(value===null||value===undefined)return '';
 if(typeof value==='number')return Number.isFinite(value)?value:'';
 if(typeof value==='boolean')return value;
 const text=typeof value==='object'?JSON.stringify(value):String(value);
 if(text.length>49_000)throw new Error('A Sheets value exceeds the 49,000-character export limit.');
 return text;
}
export function sheetRows(payload:ApprovalPayload,config:SheetConfig):SheetCells {
 const items=config.lineItems?valueAt(payload.values,config.lineItems):null;
 const rows=Array.isArray(items)&&items.length?items:[null];
 if(rows.length>1000)throw new Error('One Sheets event is limited to 1,000 rows.');
 return rows.map(item=>config.columns.map(column=>{
  if(column.source==='$documentId')return payload.document.id;
  if(column.source==='$filename')return rawCell(payload.document.name);
  if(column.source==='$runId')return payload.runId;
  if(column.source==='$revision')return payload.revision;
  if(column.source.startsWith('$item.'))return rawCell(valueAt(item,column.source.slice(6)));
  return rawCell(valueAt(payload.values,column.source));
 }));
}
export function sheetRanges(config:SheetConfig,startRow:number,rowCount:number) {
 if(!Number.isInteger(startRow)||startRow<2||startRow+rowCount>1_000_000)throw new Error('Sheets row reservation exceeds the supported limit.');
 const tab=`'${config.sheetName.replaceAll("'","''")}'`;
 const last=sheetColumn(config.columns.length);
 return {headerRange:`${tab}!A1:${last}1`,dataRange:`${tab}!A${startRow}:${last}${startRow+rowCount-1}`};
}
export type SheetsTransport=(request:{url:string;method:'POST';data:unknown;timeout:number;retry:boolean})=>Promise<{status:number}>;
export async function writeSheetRange(transport:SheetsTransport,write:{spreadsheet_id:string;header_range:string;data_range:string;headers:string[];cells:SheetCells}) {
 const response=await transport({url:`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(write.spreadsheet_id)}/values:batchUpdate`,method:'POST',timeout:15_000,retry:false,data:{valueInputOption:'RAW',includeValuesInResponse:false,data:[
  {range:write.header_range,majorDimension:'ROWS',values:[write.headers]},
  {range:write.data_range,majorDimension:'ROWS',values:write.cells},
 ]}});
 if(response.status<200||response.status>=300)throw Object.assign(new Error('Google Sheets rejected the reserved range write.'),{status:response.status});
 return {status:response.status};
}
export async function receivedEmailBody(email:GetReceivingEmailResponseSuccess,maxBytes:number) {
 let body=email.text;
 if(body===null&&email.html){
  if(Buffer.byteLength(email.html)>maxBytes)throw new Error('Email body exceeds the intake byte limit.');
  const parsed=await simpleParser(Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${email.html}`),{skipHtmlToText:false});
  body=parsed.text||'';
 }
 const cleanHeader=(s:string)=>s.replace(/[\r\n\u0000]/g,' ').slice(0,500);
 const eml=Buffer.from(`From: ${cleanHeader(email.from)}\r\nTo: ${email.received_for.map(cleanHeader).join(', ')}\r\nSubject: ${cleanHeader(email.subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body||''}`);
 if(eml.length>maxBytes)throw new Error('Email body exceeds the intake byte limit.');
 return eml;
}
