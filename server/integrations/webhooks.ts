import type {FastifyInstance} from 'fastify';
import {createHmac,randomBytes,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {requireActor} from '../core/auth.js';
import {adminPool,withWorkspace,audit,notFound,camel,badRequest} from '../core/db.js';
import {encryptSecret,decryptSecret} from './secrets.js';
import {validateDestination,publicRequest} from './network.js';

export function signDelivery(secret:string,timestamp:string,body:string) {
  return createHmac('sha256',secret).update(`${timestamp}.${body}`).digest('hex');
}

export async function registerIntegrations(app:FastifyInstance) {
  app.get('/api/integrations',async request=> {
    const actor=await requireActor(request,{scope:'results:read'});
    return withWorkspace(actor.workspaceId,async c=>({integrations:(await c.query('SELECT id,parser_id,name,kind,config,enabled,created_at FROM integrations WHERE workspace_id=$1 ORDER BY created_at DESC',[actor.workspaceId])).rows.map(camel)}));
  });
  app.post('/api/integrations/webhooks',async request=> {
    const actor=await requireActor(request,{roles:['owner','admin'],scope:'integrations:write'});
    const input=z.object({name:z.string().min(1).max(100),url:z.url().max(2048),parserId:z.uuid().optional()}).parse(request.body);
    try{await validateDestination(input.url);}catch(error){badRequest(error instanceof Error?error.message:'Invalid destination');}
    const secret=randomBytes(32).toString('base64url');
    const result=await withWorkspace(actor.workspaceId,async c=> {
      if(input.parserId&&!(await c.query('SELECT id FROM parsers WHERE id=$1 AND workspace_id=$2',[input.parserId,actor.workspaceId])).rowCount)notFound();
      const row=(await c.query("INSERT INTO integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext) VALUES($1,$2,$3,$4,'webhook',$5,$6) RETURNING id,name,kind,config,enabled",[randomUUID(),actor.workspaceId,input.parserId||null,input.name,JSON.stringify({url:input.url}),encryptSecret(secret)])).rows[0];
      await audit(c,actor.workspaceId,actor.userId,'integration.created',row.id,{kind:'webhook'});
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
    return withWorkspace(actor.workspaceId,async c=>({deliveries:(await c.query('SELECT d.id,d.integration_id,i.name,d.status,d.attempts,d.response_status,d.error,d.created_at,d.delivered_at FROM webhook_deliveries d JOIN integrations i ON i.id=d.integration_id WHERE d.workspace_id=$1 ORDER BY d.created_at DESC LIMIT 100',[actor.workspaceId])).rows.map(camel)}));
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

export async function enqueueApprovals() {
  await adminPool.query(`INSERT INTO webhook_deliveries(id,workspace_id,integration_id,event_key,payload)
    SELECT gen_random_uuid(),a.workspace_id,i.id,'approval:'||a.id::text,
      jsonb_build_object('event','document.approved','id',a.id,'document',jsonb_build_object('id',d.id,'name',d.name,'parserId',d.parser_id),'runId',a.run_id,'revision',(SELECT count(*)::int FROM corrections c WHERE c.run_id=a.run_id AND c.created_at<=a.created_at),'correctionId',a.correction_id,'values',a.values,'approvedAt',a.created_at)
    FROM approvals a JOIN extraction_runs r ON r.id=a.run_id JOIN documents d ON d.id=r.document_id
    JOIN integrations i ON i.workspace_id=a.workspace_id AND (i.parser_id IS NULL OR i.parser_id=d.parser_id)
    WHERE i.enabled AND a.created_at>=i.created_at
    FOR KEY SHARE OF d
    ON CONFLICT(integration_id,event_key) DO NOTHING`);
}

export async function processOneDelivery(options: {transport?: typeof publicRequest; workspaceId?: string} = {}) {
  await adminPool.query("UPDATE webhook_deliveries SET status='failed',error='The final delivery attempt expired before completion.',lease_until=null,lease_token=null WHERE status='delivering' AND lease_until<now() AND attempts>=5 AND ($1::uuid IS NULL OR workspace_id=$1)",[options.workspaceId||null]);
  const token=randomUUID();
  const found=await adminPool.query(`UPDATE webhook_deliveries SET status='delivering',attempts=attempts+1,lease_token=$1,lease_until=now()+interval '90 seconds'
    WHERE id=(SELECT d.id FROM webhook_deliveries d JOIN integrations i ON i.id=d.integration_id
      WHERE i.enabled AND ($2::uuid IS NULL OR d.workspace_id=$2) AND ((d.status IN ('queued','retry') AND d.next_attempt_at<=now()) OR (d.status='delivering' AND d.lease_until<now())) AND d.attempts<5
      ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1) RETURNING *`,[token,options.workspaceId||null]);
  const delivery=found.rows[0];
  if(!delivery)return false;
  try {
    const integration=(await adminPool.query('SELECT * FROM integrations WHERE id=$1',[delivery.integration_id])).rows[0];
    if(!integration?.enabled)throw new Error('Integration is disabled.');
    let status:number;
    if(integration.kind==='google_sheets') {
      const {sendGoogleSheets}=await import('./providers.js');
      status=(await sendGoogleSheets(integration,delivery)).status;
    } else {
      const body=JSON.stringify(delivery.payload), timestamp=String(Math.floor(Date.now()/1000));
      const response=await (options.transport||publicRequest)(integration.config.url,{body,headers:{'Content-Type':'application/json','User-Agent':'Folio-Webhooks/1.0','X-Folio-Delivery':delivery.id,'X-Folio-Timestamp':timestamp,'X-Folio-Signature':`v1=${signDelivery(decryptSecret(integration.secret_ciphertext),timestamp,body)}`,'Idempotency-Key':delivery.id}});
      status=response.status;
    }
    if(status<200||status>=300)throw Object.assign(new Error(`Destination returned HTTP ${status}.`),{status});
    await adminPool.query("UPDATE webhook_deliveries SET status='delivered',delivered_at=now(),response_status=$1,error=null,lease_until=null,lease_token=null WHERE id=$2 AND lease_token=$3",[status,delivery.id,token]);
  }catch(error) {
    const status=(error as {status?:number}).status||null;
    const message=error instanceof Error?error.message:'Delivery failed.';
    await adminPool.query("UPDATE webhook_deliveries SET status=$1,error=$2,response_status=$3,next_attempt_at=now()+($4::int*interval '1 second'),lease_until=null,lease_token=null WHERE id=$5 AND lease_token=$6",[delivery.attempts>=5?'failed':'retry',message.slice(0,300),status,Math.min(3600,30*2**delivery.attempts),delivery.id,token]);
  }
  return true;
}
