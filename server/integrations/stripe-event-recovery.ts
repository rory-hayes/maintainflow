import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {adminPool} from '../core/db.js';

const eventId=z.string().regex(/^stripe:evt_[A-Za-z0-9_-]{1,200}$/);
const customerId=z.string().regex(/^cus_[A-Za-z0-9_-]{1,200}$/);
const mode=z.enum(['test','live']);
const binding=z.object({eventId,workspaceId:z.uuid().transform(value=>value.toLowerCase()),customerId,mode}).strict();
const note=z.string().trim().min(1).max(300).regex(/^[^\u0000-\u001f\u007f]+$/u).refine(value=>!/(?:sk|rk)_(?:test|live)_|whsec_|bearer\s/i.test(value));
const execution=binding.extend({expectedDigest:z.string().regex(/^[a-f0-9]{64}$/),operator:note,reason:note}).strict();
const pointer=z.object({
 id:z.string().regex(/^evt_[A-Za-z0-9_-]{1,200}$/),
 type:z.enum(['customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.paused','customer.subscription.resumed','checkout.session.completed','checkout.session.async_payment_succeeded','invoice.paid','invoice.payment_failed','invoice.payment_action_required']),
 created:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),customerId,mode,
 checkout:z.object({contractId:z.uuid(),sessionId:z.string().regex(/^cs_[A-Za-z0-9_-]{1,200}$/),workspaceId:z.uuid(),policySha256:z.string().regex(/^[a-f0-9]{64}$/),consent:z.enum(['accepted']).nullable()}).strict().optional(),
}).strict();
export const stripeEventRecoveryAuditAction='billing.event_recovery_requested';
export type StripeEventRecoveryInput=z.input<typeof binding>;
export type RecoverStripeEventInput=z.input<typeof execution>;
export type StripeEventRecoveryRefusal='not_failed'|'not_exhausted'|'lease_present';
export type StripeEventRecoveryInspection=StripeEventRecoveryInput&{
 status:string;attempts:number;nextAttemptAt:string;leaseUntil:string|null;leaseTokenPresent:boolean;
 recoveryGeneration:number;eligible:boolean;refusalCode:StripeEventRecoveryRefusal|null;snapshotDigest:string;
};
export class StripeEventRecoveryError extends Error {
 constructor(public readonly code:'invalid_input'|'binding_refused'|'invalid_record'|'stale_snapshot'|'ineligible'|'compare_failed'){
  super('Stripe event recovery refused. Inspect the exact event and its current binding before retrying.');
 }
}
function parse<T>(schema:z.ZodType<T>,value:unknown):T {const result=schema.safeParse(value);if(!result.success)throw new StripeEventRecoveryError('invalid_input');return result.data;}
function requireRecord(condition:unknown):asserts condition {if(!condition)throw new StripeEventRecoveryError('invalid_record');}
function instant(value:unknown):string {const date=value instanceof Date?value:typeof value==='string'?new Date(value):null;requireRecord(date&&Number.isFinite(date.getTime()));return date.toISOString();}
function canonical(value:unknown):string {
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>JSON.stringify(key)+':'+canonical(item)).join(',')+'}';
}
async function transaction<T>(pool:Pool,write:boolean,work:(client:PoolClient)=>Promise<T>):Promise<T>{
 const client=await pool.connect();
 try{await client.query(write?'BEGIN':'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');const result=await work(client);await client.query('COMMIT');return result;}
 catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
async function current(client:PoolClient,input:ReturnType<typeof binding.parse>,lock:boolean){
 const {rows:[row]}=await client.query('SELECT id,provider,payload,status,attempts,next_attempt_at,lease_until,lease_token,error,created_at,xmin::text row_version FROM provider_events WHERE id=$1'+(lock?' FOR UPDATE':''),[input.eventId]);
 if(!row||row.provider!=='stripe')throw new StripeEventRecoveryError('binding_refused');
 const decoded=pointer.safeParse(row.payload);
 if(!decoded.success||decoded.data.id!==input.eventId.slice('stripe:'.length)||decoded.data.mode!==input.mode||decoded.data.customerId!==input.customerId||decoded.data.checkout&&decoded.data.checkout.workspaceId.toLowerCase()!==input.workspaceId)throw new StripeEventRecoveryError('binding_refused');
 const {rows:[subscription]}=await client.query('SELECT workspace_id,billing_mode,customer_id,subscription_id,status,price_id,event_created,updated_at,xmin::text row_version FROM subscriptions WHERE workspace_id=$1 AND billing_mode=$2 AND customer_id=$3'+(lock?' FOR UPDATE':''),[input.workspaceId,input.mode,input.customerId]);
 if(!subscription)throw new StripeEventRecoveryError('binding_refused');
 const {rows:links}=await client.query('SELECT workspace_id FROM provider_event_workspaces WHERE event_id=$1 ORDER BY workspace_id',[input.eventId]);
 if(links.some(link=>link.workspace_id!==input.workspaceId))throw new StripeEventRecoveryError('binding_refused');
 const {rows:[history]}=await client.query("SELECT count(*)::int generation FROM audit_events WHERE workspace_id=$1 AND action=$2 AND metadata->>'providerEvent'=$3",[input.workspaceId,stripeEventRecoveryAuditAction,input.eventId]);
 requireRecord(Number.isInteger(row.attempts)&&row.attempts>=0&&['queued','processing','retry','completed','failed'].includes(row.status)&&typeof row.row_version==='string'&&/^\d+$/.test(row.row_version)&&Number.isInteger(history.generation)&&history.generation>=0);
 const event={id:row.id,provider:row.provider,payload:decoded.data,status:row.status,attempts:row.attempts,nextAttemptAt:instant(row.next_attempt_at),leaseUntil:row.lease_until===null?null:instant(row.lease_until),leaseToken:row.lease_token,error:row.error,createdAt:instant(row.created_at),rowVersion:row.row_version};
 const boundSubscription={...subscription,updated_at:instant(subscription.updated_at)};
 const snapshotDigest=createHash('sha256').update(canonical({binding:input,event,subscription:boundSubscription,workspaceLinks:links,recoveryGeneration:history.generation})).digest('hex');
 const refusalCode:StripeEventRecoveryRefusal|null=row.status!=='failed'?'not_failed':row.attempts<5?'not_exhausted':row.lease_until!==null||row.lease_token!==null?'lease_present':null;
 const inspection:StripeEventRecoveryInspection={...input,status:row.status,attempts:row.attempts,nextAttemptAt:event.nextAttemptAt,leaseUntil:event.leaseUntil,leaseTokenPresent:row.lease_token!==null,recoveryGeneration:history.generation,eligible:refusalCode===null,refusalCode,snapshotDigest};
 return {inspection,event};
}
/** Default inspection is a repeatable-read, read-only transaction. No provider or entitlement writes. */
export async function inspectStripeEventRecovery(input:StripeEventRecoveryInput,pool:Pool=adminPool):Promise<StripeEventRecoveryInspection>{
 const checked=parse(binding,input);return transaction(pool,false,async client=>(await current(client,checked,false)).inspection);
}
/** One explicit reviewed request grants a fresh bounded five-attempt worker budget on the SAME event. */
export async function recoverStripeEvent(input:RecoverStripeEventInput,pool:Pool=adminPool){
 const checked=parse(execution,input),target=binding.parse({eventId:checked.eventId,workspaceId:checked.workspaceId,customerId:checked.customerId,mode:checked.mode});
 return transaction(pool,true,async client=>{
  const before=await current(client,target,true);
  if(before.inspection.snapshotDigest!==checked.expectedDigest)throw new StripeEventRecoveryError('stale_snapshot');
  if(!before.inspection.eligible)throw new StripeEventRecoveryError('ineligible');
  const updated=await client.query("UPDATE provider_events SET status='retry',attempts=0,error=NULL,next_attempt_at=clock_timestamp(),lease_until=NULL,lease_token=NULL WHERE id=$1 AND provider='stripe' AND status='failed' AND attempts=$2 AND attempts>=5 AND lease_until IS NULL AND lease_token IS NULL AND xmin::text=$3 AND payload=$4::jsonb RETURNING status,attempts,next_attempt_at",[target.eventId,before.event.attempts,before.event.rowVersion,JSON.stringify(before.event.payload)]);
  if(updated.rowCount!==1)throw new StripeEventRecoveryError('compare_failed');
  const recoveryId=randomUUID(),next={status:'retry',attempts:0,nextAttemptAt:instant(updated.rows[0].next_attempt_at)};
  await client.query('INSERT INTO audit_events(workspace_id,user_id,action,entity_id,metadata) VALUES($1,NULL,$2,NULL,$3)',[target.workspaceId,stripeEventRecoveryAuditAction,JSON.stringify({version:1,recoveryId,providerEvent:target.eventId,operator:checked.operator,reason:checked.reason,binding:target,reviewedSnapshotDigest:checked.expectedDigest,previousGeneration:before.inspection.recoveryGeneration,previous:before.event,next})]);
  return {recovered:true as const,recoveryId,...target,previousAttempts:before.event.attempts,attempts:0,status:'retry' as const,recoveryGeneration:before.inspection.recoveryGeneration+1};
 });
}
