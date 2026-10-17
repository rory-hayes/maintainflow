import type {FastifyInstance} from 'fastify';
import {randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireActor} from '../core/auth.js';
import {adminPool,transaction,withWorkspace,audit,notFound,camel,badRequest} from '../core/db.js';
import {encryptSecret,decryptSecret} from './secrets.js';
import {validateDestination,publicRequest} from './network.js';
import {webhookEvents} from '../../shared/webhook-events.js';
import {recordDeliveryAttemptAudit,deliveryAttemptElapsed,deliveryResponseStatus,type DeliveryAttemptStage,type DeliveryAttemptPath,type DeliveryAttemptErrorKind} from './delivery-attempt-audit.js';
import {createWebhookRequest} from './webhook-request.js';
export {signDelivery} from './webhook-request.js';

const eventsInput=z.array(z.enum(webhookEvents)).min(1).max(webhookEvents.length)
  .refine(events=>new Set(events).size===events.length,'Choose each webhook event only once.');
const uuidPattern='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
type EnqueueOptions={workspaceId?:string;limit?:number};
function batchLimit(options:EnqueueOptions){
  const limit=options.limit??200;
  if(!Number.isInteger(limit)||limit<1||limit>500)throw new Error('Delivery enqueue batch must be between 1 and 500.');
  return limit;
}

export async function registerIntegrations(app:FastifyInstance,services:{validateDestination?:typeof validateDestination}={}) {
  app.get('/api/integrations',async request=> {
    const actor=await requireActor(request,{scope:'results:read'});
    return withWorkspace(actor.workspaceId,async c=>({integrations:(await c.query('SELECT id,parser_id,name,kind,config,enabled,created_at FROM integrations WHERE workspace_id=$1 ORDER BY created_at DESC',[actor.workspaceId])).rows.map(camel)}));
  });
  app.post('/api/integrations/webhooks',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin'],scope:'integrations:write'});
    const input=z.object({name:z.string().min(1).max(100),url:z.url().max(2048),parserId:z.uuid().optional(),events:eventsInput.default(['document.approved'])}).parse(request.body);
    try{await (services.validateDestination??validateDestination)(input.url);}catch(error){badRequest(error instanceof Error?error.message:'Invalid destination');}
    const secret=randomBytes(32).toString('base64url');
    const result=await withWorkspace(actor.workspaceId,async c=> {
      if(input.parserId&&!(await c.query('SELECT id FROM parsers WHERE id=$1 AND workspace_id=$2',[input.parserId,actor.workspaceId])).rowCount)notFound();
      const row=(await c.query("INSERT INTO integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext) VALUES($1,$2,$3,$4,'webhook',$5,$6) RETURNING id,name,kind,config,enabled",[randomUUID(),actor.workspaceId,input.parserId||null,input.name,JSON.stringify({url:input.url,events:input.events}),encryptSecret(secret)])).rows[0];
      await audit(c,actor.workspaceId,actor.userId,'integration.created',row.id,{kind:'webhook',events:input.events});
      return camel(row);
    });
    return {...result,secret};
  });
  app.patch<{Params:{id:string}}>('/api/integrations/:id',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin'],scope:'integrations:write'});
    const input=z.object({enabled:z.boolean()}).parse(request.body);
    return withWorkspace(actor.workspaceId,async c=> {
      const row=(await c.query('UPDATE integrations SET enabled=$1 WHERE id=$2 AND workspace_id=$3 RETURNING id,enabled',[input.enabled,z.uuid().parse(request.params.id),actor.workspaceId])).rows[0];
      if(!row)notFound();return row;
    });
  });
  app.delete<{Params:{id:string}}>('/api/integrations/:id',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin'],scope:'integrations:write'});
    return withWorkspace(actor.workspaceId,async c=>({deleted:Boolean((await c.query('DELETE FROM integrations WHERE id=$1 AND workspace_id=$2',[z.uuid().parse(request.params.id),actor.workspaceId])).rowCount)}));
  });
  app.get('/api/deliveries',async request=> {
    const actor=await requireActor(request,{scope:'results:read'});
    return withWorkspace(actor.workspaceId,async c=>({deliveries:(await c.query("SELECT d.id,d.integration_id,i.name,d.status,d.attempts,d.response_status,d.error,d.created_at,d.delivered_at,d.payload->>'event' event,d.payload->'document'->>'id' document_id,d.payload->'document'->>'name' document_name FROM webhook_deliveries d JOIN integrations i ON i.id=d.integration_id WHERE d.workspace_id=$1 ORDER BY d.created_at DESC LIMIT 100",[actor.workspaceId])).rows.map(camel)}));
  });
  app.post<{Params:{id:string}}>('/api/deliveries/:id/replay',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin'],scope:'integrations:write'});
    return withWorkspace(actor.workspaceId,async c=> {
      const row=(await c.query("UPDATE webhook_deliveries SET status='queued',attempts=0,next_attempt_at=now(),error=null,response_status=null,delivered_at=null,lease_token=null,lease_until=null WHERE id=$1 AND workspace_id=$2 AND status IN ('failed','delivered') RETURNING id,status",[z.uuid().parse(request.params.id),actor.workspaceId])).rows[0];
      if(!row)badRequest('Only failed or delivered events can be replayed.');
      await audit(c,actor.workspaceId,actor.userId,'delivery.replayed',row.id);return row;
    });
  });
}

export async function enqueueApprovals(options:EnqueueOptions={}) {
  await adminPool.query(`INSERT INTO webhook_deliveries(id,workspace_id,integration_id,event_key,payload)
    SELECT gen_random_uuid(),a.workspace_id,i.id,'approval:'||a.id::text,
      jsonb_build_object('event','document.approved','id',a.id,'document',jsonb_build_object('id',d.id,'name',d.name,'parserId',d.parser_id),'runId',a.run_id,'revision',(SELECT count(*)::int FROM corrections c WHERE c.run_id=a.run_id AND c.created_at<=a.created_at),'correctionId',a.correction_id,'values',a.values,'approvedAt',a.created_at)
    FROM approvals a JOIN extraction_runs r ON r.id=a.run_id JOIN documents d ON d.id=r.document_id
    JOIN integrations i ON i.workspace_id=a.workspace_id AND (i.parser_id IS NULL OR i.parser_id=d.parser_id)
    WHERE i.enabled AND a.created_at>=i.created_at AND ($1::uuid IS NULL OR a.workspace_id=$1)
      AND (i.kind='google_sheets' OR (i.kind='webhook' AND
        (NOT (i.config ? 'events') OR (jsonb_typeof(i.config->'events')='array' AND (i.config->'events') ? 'document.approved'))))
      AND NOT EXISTS(SELECT 1 FROM webhook_deliveries sent WHERE sent.integration_id=i.id AND sent.event_key='approval:'||a.id::text)
    ORDER BY a.created_at,a.id,i.id LIMIT $2
    FOR KEY SHARE OF d SKIP LOCKED
    ON CONFLICT(integration_id,event_key) DO NOTHING`,[options.workspaceId??null,batchLimit(options)]);
}

/** Reconcile committed history, not current status: later processing cannot erase a failure episode. */
export async function enqueueFailureEvents(options:EnqueueOptions={}) {
  await adminPool.query(`INSERT INTO webhook_deliveries(id,workspace_id,integration_id,event_key,payload)
    SELECT gen_random_uuid(),e.workspace_id,i.id,'document-event:'||e.id::text,
      jsonb_build_object('event',CASE e.phase WHEN 'processing' THEN 'document.extraction_failed' ELSE 'document.export_failed' END,
        'id',e.id,'document',jsonb_build_object('id',d.id,'name',d.name,'parserId',d.parser_id),'failedAt',e.created_at)
      || CASE e.phase WHEN 'processing' THEN jsonb_build_object('jobId',e.operation_id,
        'error',jsonb_build_object('code','extraction_failed','message','Document processing failed. Open the document to review the failure and retry.'))
      ELSE jsonb_build_object('exportId',e.operation_id,'runId',e.details->>'runId','approvalId',e.details->>'approvalId','format',e.details->>'format',
        'error',jsonb_build_object('code',CASE WHEN e.details->>'reason' IN
          ('This export is too large to download here. Select fewer documents and export again.','This export exceeds the supported size limits. Export a smaller selection.')
          THEN 'export_size_limit' ELSE 'export_generation_failed' END,
        'message',CASE WHEN e.details->>'reason' IN
          ('This export is too large to download here. Select fewer documents and export again.','This export exceeds the supported size limits. Export a smaller selection.')
          THEN e.details->>'reason' ELSE 'Export generation failed. Try again or select another format.' END)) END
    FROM document_events e JOIN documents d ON d.id=e.document_id AND d.workspace_id=e.workspace_id
    JOIN integrations i ON i.workspace_id=e.workspace_id AND (i.parser_id IS NULL OR i.parser_id=d.parser_id)
    WHERE e.state='failed' AND e.operation_id IS NOT NULL AND i.enabled AND i.kind='webhook'
      AND e.created_at>=i.created_at AND ($1::uuid IS NULL OR e.workspace_id=$1)
      AND jsonb_typeof(i.config->'events')='array' AND (i.config->'events') ?
        (CASE e.phase WHEN 'processing' THEN 'document.extraction_failed' WHEN 'export' THEN 'document.export_failed' END)
      AND (e.phase='processing' OR (e.phase='export' AND e.details->>'format' IN ('csv','xlsx','json')
        AND e.details->>'runId' ~* $3 AND e.details->>'approvalId' ~* $3))
      AND NOT EXISTS(SELECT 1 FROM webhook_deliveries sent WHERE sent.integration_id=i.id AND sent.event_key='document-event:'||e.id::text)
    ORDER BY e.created_at,e.id,i.id LIMIT $2
    FOR KEY SHARE OF d SKIP LOCKED
    ON CONFLICT(integration_id,event_key) DO NOTHING`,[options.workspaceId??null,batchLimit(options),uuidPattern]);
}

export async function enqueueIntegrationEvents(options:EnqueueOptions={}) {
  await enqueueApprovals(options);
  await enqueueFailureEvents(options);
}

export async function processOneDelivery(options: {transport?: typeof publicRequest; workspaceId?: string;signal?:AbortSignal} = {}) {
  if(options.signal?.aborted)return false;
  await transaction(adminPool,async client=>{
    // Bound diagnostic work and locks per invocation. The scheduled watchdog
    // still sees remaining expired leases, including disabled integrations.
    const expired=await client.query(`WITH expired_candidates AS MATERIALIZED (
      SELECT id FROM webhook_deliveries
      WHERE status='delivering' AND lease_until<now() AND attempts>=5 AND ($1::uuid IS NULL OR workspace_id=$1)
      ORDER BY lease_until,id FOR UPDATE SKIP LOCKED LIMIT 25
    ) UPDATE webhook_deliveries d SET status='failed',error='The final delivery attempt expired before completion.',lease_until=null,lease_token=null
      FROM expired_candidates e WHERE d.id=e.id RETURNING d.id,d.workspace_id,d.integration_id,d.attempts`,[options.workspaceId||null]);
    for(const row of expired.rows)await recordDeliveryAttemptAudit(client,{workspaceId:row.workspace_id,deliveryId:row.id},{version:1,integrationId:row.integration_id,phase:'lease_expired',attempt:row.attempts,priorLeaseExpired:true});
  });
  const token=randomUUID();let attemptId=randomUUID();while(attemptId===token)attemptId=randomUUID();
  const started=performance.now();
  const delivery=await transaction(adminPool,async client=>{
    const found=await client.query(`WITH candidate AS MATERIALIZED (
      SELECT d.id,d.status prior_status,d.attempts prior_attempts,
        coalesce(d.status='delivering' AND d.lease_until<now(),false) prior_lease_expired
      FROM webhook_deliveries d JOIN integrations i ON i.id=d.integration_id
      WHERE i.enabled AND ($2::uuid IS NULL OR d.workspace_id=$2) AND ((d.status IN ('queued','retry') AND d.next_attempt_at<=now()) OR (d.status='delivering' AND d.lease_until<now())) AND d.attempts<5
      ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1
    ) UPDATE webhook_deliveries d SET status='delivering',attempts=d.attempts+1,lease_token=$1,lease_until=now()+interval '90 seconds'
      FROM candidate WHERE d.id=candidate.id RETURNING d.*,candidate.prior_status,candidate.prior_attempts,candidate.prior_lease_expired`,[token,options.workspaceId||null]);
    const row=found.rows[0];
    if(row)await recordDeliveryAttemptAudit(client,{workspaceId:row.workspace_id,deliveryId:row.id},{version:1,integrationId:row.integration_id,attemptId,attempt:row.attempts,elapsedMs:deliveryAttemptElapsed(started),phase:'claimed',priorAttempts:row.prior_attempts,acquiredFrom:row.prior_status==='delivering'?'expired_lease':row.prior_status,priorLeaseExpired:row.prior_lease_expired});
    return row;
  });
  if(!delivery)return false;
  const identity={workspaceId:delivery.workspace_id,deliveryId:delivery.id};
  let stage:DeliveryAttemptStage='integration_lookup',path:DeliveryAttemptPath='not_started',errorKind:DeliveryAttemptErrorKind='none',observedStatus:number|null=null;
  const finish=async(client:Parameters<typeof recordDeliveryAttemptAudit>[0],changed:boolean,outcome:'delivered'|'retry'|'failed')=>recordDeliveryAttemptAudit(client,identity,{version:1,integrationId:delivery.integration_id,attemptId,attempt:delivery.attempts,elapsedMs:deliveryAttemptElapsed(started),phase:'finished',stage,path,outcome:changed?outcome:'fence_lost',errorKind,responseStatus:observedStatus});
  try {
    options.signal?.throwIfAborted();
    const integration=(await adminPool.query('SELECT * FROM integrations WHERE id=$1',[delivery.integration_id])).rows[0];
    if(!integration?.enabled)throw new Error('Integration is disabled.');
    let status:number;
    if(integration.kind==='google_sheets') {
      // This encompasses the delivered-reservation shortcut too; it is not proof of provider I/O.
      stage='sheets_delivery';path='sheets_unobserved';
      // Failure notifications must never become spreadsheet rows, even if an
      // invalid outbox row was restored or inserted outside the normal enqueue.
      if(delivery.payload.event!=='document.approved')throw new Error('Google Sheets accepts document approval events only.');
      const {sendGoogleSheets}=await import('./providers.js');
      const result=await sendGoogleSheets(integration,delivery,{signal:options.signal,observeStage:value=>{stage=value;}}) as {status:number;deliveryPath?:unknown};
      status=result.status;
      if(result.deliveryPath==='sheets_already_delivered'||result.deliveryPath==='sheets_range_write')path=result.deliveryPath;
    } else {
      stage='webhook_request';path='webhook_request';
      const request=createWebhookRequest(delivery,decryptSecret(integration.secret_ciphertext));
      const response=await (options.transport||publicRequest)(integration.config.url,{...request,signal:options.signal});
      status=response.status;
    }
    observedStatus=deliveryResponseStatus(status);
    if(status<200||status>=300){errorKind='http_status';throw Object.assign(new Error(`Destination returned HTTP ${status}.`),{status});}
    stage='delivery_commit';
    await transaction(adminPool,async client=>{
      const changed=await client.query("UPDATE webhook_deliveries SET status='delivered',delivered_at=now(),response_status=$1,error=null,lease_until=null,lease_token=null WHERE id=$2 AND lease_token=$3",[status,delivery.id,token]);
      await finish(client,Boolean(changed.rowCount),'delivered');
    });
  }catch(error) {
    if(errorKind==='none')errorKind=options.signal?.aborted?'aborted':stage==='delivery_commit'?'persistence_error':'operation_failed';
    const status=(error as {status?:number}).status||null;
    const message=error instanceof Error?error.message:'Delivery failed.';
    await transaction(adminPool,async client=>{
      const outcome=delivery.attempts>=5?'failed':'retry';
      const changed=await client.query("UPDATE webhook_deliveries SET status=$1,error=$2,response_status=$3,next_attempt_at=now()+($4::int*interval '1 second'),lease_until=null,lease_token=null WHERE id=$5 AND lease_token=$6",[outcome,message.slice(0,300),status,Math.min(3600,30*2**delivery.attempts),delivery.id,token]);
      await finish(client,Boolean(changed.rowCount),outcome);
    });
  }
  return true;
}
