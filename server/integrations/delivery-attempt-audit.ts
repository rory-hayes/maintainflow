import type {PoolClient} from 'pg';
import {z} from 'zod';

const elapsedMs=z.number().int().min(0).max(2_147_483_647);
const attempt=z.number().int().min(1).max(5);
const common={version:z.literal(1),integrationId:z.uuid()};
const running={...common,attemptId:z.uuid(),attempt,elapsedMs};
const sheetsStages=['sheets_reservation','sheets_setup','sheets_access_step','sheets_credential_persist','sheets_range_write','sheets_write_commit'] as const;
export type GoogleSheetsDeliveryStage=typeof sheetsStages[number];
export type GoogleSheetsDeliveryStageObserver=(stage:GoogleSheetsDeliveryStage)=>void|Promise<void>;
/** Internal, best-effort last-entered operation only; no provider values are inspected. */
export function reportGoogleSheetsDeliveryStage(observer:GoogleSheetsDeliveryStageObserver|undefined,stage:unknown){
 if(typeof observer!=='function'||typeof stage!=='string'||!(sheetsStages as readonly string[]).includes(stage))return;
 try{void Promise.resolve(observer(stage as GoogleSheetsDeliveryStage)).catch(()=>{});}catch{/* Diagnostics cannot change delivery. */}
}
const claimed=z.object({
 ...running,phase:z.literal('claimed'),priorAttempts:z.number().int().min(0).max(4),
 acquiredFrom:z.enum(['queued','retry','expired_lease']),priorLeaseExpired:z.boolean(),
}).strict().refine(value=>value.attempt===value.priorAttempts+1&&value.priorLeaseExpired===(value.acquiredFrom==='expired_lease'));
const finished=z.object({
 ...running,phase:z.literal('finished'),
 stage:z.enum(['integration_lookup','sheets_delivery',...sheetsStages,'webhook_request','delivery_commit']),
 path:z.enum(['not_started','webhook_request','sheets_unobserved','sheets_already_delivered','sheets_range_write']),
 outcome:z.enum(['delivered','retry','failed','fence_lost']),
 errorKind:z.enum(['none','http_status','operation_failed','aborted','persistence_error']),
 responseStatus:z.number().int().min(100).max(599).nullable(),
}).strict().refine(value=>value.outcome==='fence_lost'||(value.outcome==='delivered'
 ?value.errorKind==='none'&&value.responseStatus!==null&&value.responseStatus>=200&&value.responseStatus<300
 :value.errorKind!=='none'));
const expired=z.object({
 ...common,phase:z.literal('lease_expired'),attempt:z.number().int().min(5).max(2_147_483_647),priorLeaseExpired:z.literal(true),
}).strict();
export const deliveryAttemptAuditSchema=z.union([claimed,finished,expired]);
export type DeliveryAttemptAudit=z.infer<typeof deliveryAttemptAuditSchema>;
export type DeliveryAttemptStage=z.infer<typeof finished>['stage'];
export type DeliveryAttemptPath=z.infer<typeof finished>['path'];
export type DeliveryAttemptErrorKind=z.infer<typeof finished>['errorKind'];
const context=z.object({workspaceId:z.uuid(),deliveryId:z.uuid()}).strict();
const actions={claimed:'delivery.attempt_claimed',finished:'delivery.attempt_finished',lease_expired:'delivery.lease_expired'} as const;

export function deliveryAttemptElapsed(started:number,now=performance.now()){
 return Math.max(0,Math.min(2_147_483_647,Math.floor(now-started)));
}
/** Only a returned response is observed here; arbitrary error properties are excluded. */
export function deliveryResponseStatus(value:unknown):number|null{
 return typeof value==='number'&&Number.isInteger(value)&&value>=100&&value<=599?value:null;
}

/** Called inside the short state-transition transaction, never around provider I/O.
 * Invalid diagnostics and a rejected audit INSERT cannot change its delivery write.
 * A broken transaction/connection still propagates: it cannot safely be committed. */
export async function recordDeliveryAttemptAudit(client:Pick<PoolClient,'query'>,identity:unknown,event:unknown):Promise<boolean>{
 const target=context.safeParse(identity),metadata=deliveryAttemptAuditSchema.safeParse(event);
 if(!target.success||!metadata.success)return false;
 const bytes=JSON.stringify(metadata.data);
 if(Buffer.byteLength(bytes)>1024)return false;
 await client.query('SAVEPOINT delivery_attempt_audit');
 try{
  await client.query('insert into audit_events(workspace_id,user_id,action,entity_id,metadata) values($1,null,$2,$3,$4)',
   [target.data.workspaceId,actions[metadata.data.phase],target.data.deliveryId,bytes]);
 }catch{
  await client.query('ROLLBACK TO SAVEPOINT delivery_attempt_audit');
  await client.query('RELEASE SAVEPOINT delivery_attempt_audit');
  return false;
 }
 await client.query('RELEASE SAVEPOINT delivery_attempt_audit');
 return true;
}
