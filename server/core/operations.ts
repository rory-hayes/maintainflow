import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import type {Pool,PoolClient} from 'pg';
import {acceptsWorkerBearer} from '../hosted-worker.js';
import {config} from './config.js';
import {assertStorageRestoreReady} from './restore-state.js';
import {installationConfiguration} from './installation.js';
import {ORIGINALS_BUCKET,readBoundedResponse} from './storage.js';

const probeDeadlineMs=3000;
type Check='database'|'storage'|'restore';
export type Readiness={status:'ready'|'not_ready';checkedAt:string;checks:Record<Check,'ok'|'unavailable'>};
export type QueueObservation={lane:string;queued:number;due:number;processing:number;expiredLeases:number;failed:number;oldestDueSeconds:number|null};
export type OperationalServices={database:()=>Promise<void>;storage:()=>Promise<void>;restore:()=>Promise<void>;queues:()=>Promise<QueueObservation[]>};

/** Responses are deadline-bound even if a dependency's promise does not settle. */
async function bounded<T>(work:()=>Promise<T>,milliseconds=probeDeadlineMs):Promise<T>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{return await Promise.race([Promise.resolve().then(work),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Probe unavailable')),milliseconds);})]);}
  finally{clearTimeout(timer);}
}
function cached<T>(work:()=>Promise<T>,ttlMs:number){
  let inFlight:Promise<T>|undefined,value:T|undefined,until=0;
  return ()=>{
    if(value!==undefined&&Date.now()<until)return Promise.resolve(value);
    if(!inFlight)inFlight=work().then(result=>{value=result;until=Date.now()+ttlMs;return result;}).finally(()=>{inFlight=undefined;});
    return inFlight;
  };
}
export function createReadinessProbe(services:Pick<OperationalServices,Check>,options:{deadlineMs?:number;cacheMs?:number}={}){
  return cached(async()=>{
    const checks={} as Readiness['checks'];
    await Promise.all((['database','storage','restore'] as const).map(async name=>{try{await bounded(services[name],options.deadlineMs);checks[name]='ok';}catch{checks[name]='unavailable';}}));
    return {status:Object.values(checks).every(value=>value==='ok')?'ready':'not_ready',checkedAt:new Date().toISOString(),checks} as Readiness;
  },options.cacheMs??15_000);
}

/** A timeout destroys only this probe's checked-out connection, including a late acquisition. */
export async function probeDatabase(pool:Pool,sql:string,deadlineMs=probeDeadlineMs){
  let client:PoolClient|undefined,expired=false,released=false,timer:ReturnType<typeof setTimeout>|undefined;
  const release=(destroy=false)=>{if(client&&!released){released=true;client.release(destroy);}};
  const query=(async()=>{
    client=await pool.connect();
    if(expired){release(true);throw new Error('Probe unavailable');}
    try{
      await client.query('BEGIN READ ONLY');
      await client.query("select set_config('statement_timeout','2000',true),set_config('lock_timeout','1000',true)");
      const result=await client.query(sql);
      await client.query('ROLLBACK');
      return result;
    }catch{release(true);throw new Error('Probe unavailable');}
    finally{release();}
  })();
  try{return await Promise.race([query,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;release(true);reject(new Error('Probe unavailable'));},deadlineMs);})]);}
  finally{clearTimeout(timer);}
}

/** Column existence alone cannot distinguish the pre-regional policy constraint. */
export async function probeNormalizationPolicy(pool:Pool){
  const result=await probeDatabase(pool,`select c.convalidated,pg_get_constraintdef(c.oid) definition
    from pg_catalog.pg_constraint c join pg_catalog.pg_attribute a
      on a.attrelid=c.conrelid and a.attnum=any(c.conkey)
    where c.conrelid='extraction_runs'::regclass and c.conname='extraction_runs_normalization_context_check'
      and c.contype='c' and a.attname='normalization_context' and not a.attisdropped`);
  const row=result.rows[0];
  // PostgreSQL deparses the migration's IN predicate as = ANY (ARRAY[...]).
  // Accept whitespace/cast formatting, but never a mere mention in another clause.
  const predicate=typeof row?.definition==='string'?row.definition.match(/\(\s*normalization_context\s*->>\s*'version'(?:::text)?\s*\)\s*=\s*ANY\s*\(\s*ARRAY\[([^\]]+)\]\s*\)/):null;
  const versions=predicate?.[1].split(',').map((value:string)=>value.trim().match(/^'(timestamp-v1|regional-v2)'(?:::text)?$/)?.[1]);
  if(result.rows.length!==1||row.convalidated!==true||versions?.length!==2||new Set(versions).size!==2||!versions.includes('timestamp-v1')||!versions.includes('regional-v2'))throw new Error('Probe unavailable');
}

export async function probePrivateStorage(options:{env?:Record<string,string|undefined>;directory?:string;fetch?:typeof fetch}={}){
  const env=options.env??process.env,driver=env.STORAGE_DRIVER||'filesystem';
  if(driver==='filesystem'){
    const directory=options.directory??config.storageDir;
    const stat=await fs.lstat(directory);
    if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('Storage unavailable');
    await fs.access(directory,constants.R_OK|constants.W_OK|constants.X_OK);
    return;
  }
  if(driver!=='supabase')throw new Error('Storage unavailable');
  const url=new URL(env.SUPABASE_URL||env.NEXT_PUBLIC_SUPABASE_URL||'');
  if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||url.username||url.password||url.port||!['','/'].includes(url.pathname)||url.search||url.hash)throw new Error('Storage unavailable');
  const key=env.SUPABASE_SERVICE_ROLE_KEY;
  if(!key)throw new Error('Storage unavailable');
  const response=await (options.fetch??fetch)(`${url.origin}/storage/v1/bucket/${ORIGINALS_BUCKET}`,{method:'GET',headers:{apikey:key,Authorization:`Bearer ${key}`},redirect:'error',signal:AbortSignal.timeout(2500)});
  if(!response.ok){await response.body?.cancel();throw new Error('Storage unavailable');}
  const bucket=JSON.parse((await readBoundedResponse(response,64*1024)).toString());
  if(bucket?.id!==ORIGINALS_BUCKET||bucket.public!==false||!Number.isSafeInteger(Number(bucket.file_size_limit))||Number(bucket.file_size_limit)<=0||Number(bucket.file_size_limit)>config.maxBytes)throw new Error('Storage unavailable');
}

// Fixed SQL only. Counts describe queue state, not claim eligibility or an observed worker heartbeat.
const queueRelations=[
  {lane:'extraction',from:'jobs',state:'state',waiting:"state='queued'",working:"state='processing'",due:'available_at',lease:'lease_until'},
  {lane:'field_suggestions',from:'schema_suggestions',state:'state',waiting:"state='queued'",working:"state='processing'",due:'available_at',lease:'lease_until'},
  {lane:'split_suggestions',from:'split_suggestions',state:'state',waiting:"state='queued'",working:"state='processing'",due:'available_at',lease:'lease_until'},
  {lane:'deliveries',from:'webhook_deliveries',state:'status',waiting:"status in ('queued','retry')",working:"status='delivering'",due:'next_attempt_at',lease:'lease_until'},
  {lane:'provider_events',from:'provider_events',state:'status',waiting:"status in ('queued','retry')",working:"status='processing'",due:'next_attempt_at',lease:'lease_until'},
  {lane:'account_email',from:'account_email_outbox',state:'state',waiting:"state='pending'",working:"state='sending'",due:'available_at',lease:'lease_until'},
  {lane:'invitation_email',from:'invitation_email_outbox',state:'state',waiting:"state='pending'",working:"state='sending'",due:'available_at',lease:'lease_until'},
  {lane:'object_deletion',from:'file_deletions',state:'status',waiting:"status='pending'",working:'false',due:'available_at',lease:'null::timestamptz'},
] as const;
const queuesSql=queueRelations.map(q=>`select '${q.lane}' lane,
 count(*) filter(where ${q.waiting})::integer queued,
 count(*) filter(where (${q.waiting}) and ${q.due}<=now())::integer due,
 count(*) filter(where ${q.working})::integer processing,
 count(*) filter(where (${q.working}) and ${q.lease}<=now())::integer expired_leases,
 count(*) filter(where ${q.state}='failed')::integer failed,
 extract(epoch from now()-min(${q.due}) filter(where (${q.waiting}) and ${q.due}<=now()))::double precision oldest_due_seconds
 from ${q.from}`).join('\nunion all\n');

function productionServices():OperationalServices{
  return {
    database:async()=>{
      const {adminPool,appPool}=await import('./db.js');
      await Promise.all([
        // Runtime roles cannot read the migration journal. These zero-row queries verify current capabilities.
        probeDatabase(adminPool,'select j.config,d.mime_type,r.template_snapshot,r.normalization_context,r.bank_statement_context,a.bank_review,s.confirmed_request_id,t.revision,b.billing_mode,c.billing_mode,c.idempotency_version from jobs j,documents d,extraction_runs r,approvals a,split_suggestions s,templates t,subscriptions b,billing_checkouts c where false'),
        probeDatabase(appPool,'select a.account_key,a.revision,t.fingerprint,u.bank_locale from bank_statement_accounts a,bank_statement_transactions t,direct_uploads u where false'),
        probeDatabase(appPool,'select d.id,d.workspace_id,b.billing_mode,c.billing_mode,c.idempotency_version from documents d,subscriptions b,billing_checkouts c where false'),
        probeNormalizationPolicy(adminPool),
      ]);
    },
    storage:()=>probePrivateStorage(),
    restore:()=>assertStorageRestoreReady(config.storageDir,process.env.STORAGE_DRIVER||'filesystem'),
    queues:async()=>{
      const {adminPool}=await import('./db.js');
      return (await probeDatabase(adminPool,queuesSql)).rows.map(row=>({lane:row.lane,queued:row.queued,due:row.due,processing:row.processing,expiredLeases:row.expired_leases,failed:row.failed,oldestDueSeconds:row.oldest_due_seconds}));
    },
  };
}

export function registerOperationalHealth(app:FastifyInstance,options:{services?:OperationalServices;secret?:()=>string|undefined;monitorSecret?:()=>string|undefined;deadlineMs?:number;cacheMs?:number}={}){
  const services=options.services??productionServices(),readiness=createReadinessProbe(services,options);
  const queueSnapshot=cached(()=>bounded(services.queues,options.deadlineMs),options.cacheMs??15_000);
  // The global limiter persists counters in PostgreSQL. These probes must reach
  // their own deadline/authentication boundary even when that database is down.
  app.get('/api/ready',{config:{rateLimit:false}},async(_request,reply)=>{
    const result=await readiness();
    return reply.header('Cache-Control','private, no-store').code(result.status==='ready'?200:503).send(result);
  });
  app.get('/api/internal/diagnostics',{config:{rateLimit:false}},async(request,reply)=>{
    reply.header('Cache-Control','private, no-store');
    const secret=options.secret?.()??process.env.FOLIO_WORKER_SECRET;
    // A monitor can inspect health without receiving permission to wake workers.
    // Only this read-only route recognizes FOLIO_MONITOR_SECRET.
    const monitorSecret=options.monitorSecret?.()??process.env.FOLIO_MONITOR_SECRET;
    const configured=[secret,monitorSecret].filter((value):value is string=>Boolean(value&&value.length>=32));
    if(!configured.length)return reply.code(503).send({error:'diagnostics_unconfigured'});
    if(!configured.some(value=>acceptsWorkerBearer(request.headers.authorization,value)))return reply.code(401).send({error:'unauthorized'});
    const [dependencies,queues]=await Promise.all([readiness(),queueSnapshot().catch(()=>null)]);
    const status=dependencies.status==='ready'&&queues!==null?'available':'unavailable';
    return reply.code(status==='available'?200:503).send({status,dependencies,worker:{observation:'durable_queue_snapshot',heartbeatVerified:false,queueEligibilityVerified:false,queues},operator:installationConfiguration().readiness,backup:{hostedRecoveryVerified:false,scheduledBackupVerified:false},alerts:{deliveryVerified:false}});
  });
}
