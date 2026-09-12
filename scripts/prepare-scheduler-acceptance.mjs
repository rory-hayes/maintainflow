import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';

// Preparation only: no environment credentials, database connection or HTTP call.
const marker=randomUUID(),workspaceId=randomUUID(),parserId=randomUUID(),schemaId=randomUUID();
const output=path.resolve(process.argv[2]||`.local/scheduler-acceptance/${marker}`);
await fs.mkdir(output,{recursive:true});
const literal=value=>`'${String(value).replaceAll("'","''")}'`;
const json=value=>`${literal(JSON.stringify(value))}::jsonb`;
const cases=['queued','expired-lease'].map(kind=>{
 const id=randomUUID(),jobId=randomUUID(),proof=`${marker}:${kind}`;
 const source=`Proof: ${proof}\nTotal: 12.34`;
 return {kind,documentId:id,jobId,proof,source,sha256:createHash('sha256').update(source).digest('hex'),bytes:Buffer.byteLength(source)};
});
const selector=`id=${literal(workspaceId)}::uuid AND settings->>'qaSchedulerAcceptance'=${literal(marker)}`;
const canonical=await fs.readFile('deploy/supabase-worker.sql','utf8');
const original=canonical.split('$folio_cron$')[1]?.trim().replace(/;\s*$/,'');
if(!original?.startsWith('SELECT net.http_post(')||!original.includes('WHERE folio.worker_has_runnable_work()'))throw new Error('Review changed watchdog SQL before generating acceptance instrumentation.');
const dispatch=original.replace(/\)\s+WHERE folio\.worker_has_runnable_work\(\)/,') AS request_id WHERE folio.worker_has_runnable_work()');
if(dispatch===original)throw new Error('Could not identify watchdog request result.');
const preflight=`-- Read-only. Empty/runnable=false is required for an unambiguous quiet-window test.
SELECT jsonb_build_object(
 'observedAt',clock_timestamp(),
 'scheduler',coalesce((SELECT jsonb_agg(jsonb_build_object('jobId',jobid,'name',jobname,'schedule',schedule,'active',active)) FROM cron.job WHERE jobname='folio-worker-watchdog'),'[]'::jsonb),
 'vaultUrlConfigured',(SELECT count(*)=1 FROM vault.decrypted_secrets WHERE name='folio_worker_url' AND decrypted_secret ~ '^https://[^/]+/api/internal/worker$'),
 'vaultSecretConfigured',(SELECT count(*)=1 FROM vault.decrypted_secrets WHERE name='folio_worker_secret' AND length(decrypted_secret)>=32),
 'runnable',folio.worker_has_runnable_work(),
 'activeCoreLeases',(SELECT count(*) FROM folio.jobs WHERE state='processing' AND lease_until>now()),
 'activeProviderLeases',(SELECT count(*) FROM folio.provider_events WHERE provider<>'stripe' AND status='processing' AND lease_until>now()),
 'activeDeliveryLeases',(SELECT count(*) FROM folio.webhook_deliveries WHERE status='delivering' AND lease_until>now()),
 'runtimeRoles',(SELECT jsonb_agg(jsonb_build_object('role',rolname,'superuser',rolsuper,'bypassRls',rolbypassrls)) FROM pg_roles WHERE rolname IN ('folio_admin','folio_app'))
) AS scheduler_preflight;\n`;
const instrument=`-- Temporary instrumentation of the same named production watchdog.
-- HTTP scheduling retains the canonical predicate, URL, secret and request body.
-- Only the marked QA workspace receives request IDs, for ten minutes after creation.
-- Even after cleanup/expiry the canonical HTTP dispatch still executes normally.
SELECT cron.schedule('folio-worker-watchdog','* * * * *',$qa_cron$
WITH dispatched AS MATERIALIZED (
 ${dispatch}
), recorded AS (
 INSERT INTO folio.audit_events(workspace_id,action,metadata)
 SELECT w.id,'qa.scheduler.dispatched',jsonb_build_object('marker',${literal(marker)},'requestId',d.request_id,'dispatchAt',clock_timestamp())
 FROM dispatched d CROSS JOIN folio.workspaces w
 WHERE w.${selector} AND w.created_at>now()-interval '10 minutes'
 RETURNING id
)
SELECT request_id,(SELECT count(*) FROM recorded) AS qa_records FROM dispatched;
$qa_cron$);\n`;
const schema={fields:[{key:'proof',label:'Proof',type:'string',required:true},{key:'total',label:'Total',type:'currency',required:true}]};
const plan={id:'explore',name:'Scheduler QA only',monthlyPages:50,maxParsers:1,maxConcurrent:1,maxBytes:10485760,maxPages:30};
const fixture=`-- SQL Editor migration identity only. Creates one marked, backend-only fixture workspace.
-- No users, memberships, provider connections, original files or storage objects are created.
-- The two document rows deliberately test only the rules worker, not upload/decoder acceptance.
BEGIN;
SET LOCAL search_path=pg_catalog;
DO $qa_guard$ BEGIN
 IF folio.worker_has_runnable_work() OR EXISTS(SELECT 1 FROM folio.jobs WHERE state='processing' AND lease_until>now())
 OR EXISTS(SELECT 1 FROM folio.provider_events WHERE provider<>'stripe' AND status='processing' AND lease_until>now())
 OR EXISTS(SELECT 1 FROM folio.webhook_deliveries WHERE status='delivering' AND lease_until>now()) THEN
  RAISE EXCEPTION 'Wait for a quiet Folio worker window before creating scheduler fixtures.';
 END IF;
END $qa_guard$;
INSERT INTO folio.workspaces(id,name,slug,settings,plan)
 VALUES(${literal(workspaceId)},${literal(`Scheduler QA ${marker}`)},${literal(`scheduler-qa-${marker}`)},${json({retentionDays:90,notifications:false,qaSchedulerAcceptance:marker})},${json(plan)});
INSERT INTO folio.parsers(id,workspace_id,name,mode,use_case,locale) VALUES(${literal(parserId)},${literal(workspaceId)},'Deterministic scheduler acceptance','rules','custom','en-IE');
INSERT INTO folio.schema_versions(id,workspace_id,parser_id,version,schema) VALUES(${literal(schemaId)},${literal(workspaceId)},${literal(parserId)},1,${json(schema)});
UPDATE folio.parsers SET active_schema_id=${literal(schemaId)} WHERE id=${literal(parserId)} AND workspace_id=${literal(workspaceId)};
${cases.map(item=>`INSERT INTO folio.documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count,source_text)
 VALUES(${literal(item.documentId)},${literal(workspaceId)},${literal(parserId)},${literal(`NO-ORIGINAL-SCHEDULER-QA-${item.kind}.txt`)},'text/plain',${item.bytes},${literal(item.sha256)},${literal(`${workspaceId}/${item.documentId}`)},'received',1,${json([{page:1,text:item.source}])});
INSERT INTO folio.jobs(id,workspace_id,document_id,schema_version_id,config,state,attempts,available_at,lease_owner,lease_until)
 VALUES(${literal(item.jobId)},${literal(workspaceId)},${literal(item.documentId)},${literal(schemaId)},${json({mode:'rules',instructions:'',locale:'en-IE',templates:[]})},${literal(item.kind==='queued'?'queued':'processing')},${item.kind==='queued'?0:1},now()+interval '90 seconds',${item.kind==='queued'?'NULL':literal(`qa-abandoned:${marker}`)},${item.kind==='queued'?'NULL':"now()+interval '90 seconds'"});
UPDATE folio.documents SET status=${literal(item.kind==='queued'?'queued':'processing')} WHERE id=${literal(item.documentId)} AND workspace_id=${literal(workspaceId)};
INSERT INTO folio.usage_ledger(workspace_id,document_id,event,pages,idempotency_key)
 VALUES(${literal(workspaceId)},${literal(item.documentId)},'qa.scheduler.fixture',1,${literal(`qa.scheduler:${item.documentId}`)});`).join('\n')}
INSERT INTO folio.audit_events(workspace_id,action,metadata)
 VALUES(${literal(workspaceId)},'qa.scheduler.prepared',jsonb_build_object('marker',${literal(marker)},'runnableAfter',now()+interval '90 seconds','httpIdBefore',coalesce((SELECT max(id) FROM net._http_response),0),'cronRunBefore',coalesce((SELECT max(runid) FROM cron.job_run_details WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='folio-worker-watchdog')),0),'scope','rules worker only; no original objects'));
COMMIT;
SELECT ${literal(marker)} AS marker,${literal(workspaceId)} AS workspace_id,metadata FROM folio.audit_events WHERE workspace_id=${literal(workspaceId)} AND action='qa.scheduler.prepared';\n`;
const expected=`CASE j.id ${cases.map(item=>`WHEN ${literal(item.jobId)}::uuid THEN ${json({proof:item.proof,total:12.34})}`).join(' ')} END`;
const observe=`-- Read-only. No URL, bearer token, database password or decrypted Vault value is returned.
SELECT jsonb_build_object(
 'marker',${literal(marker)},'workspaceId',${literal(workspaceId)},'observedAt',clock_timestamp(),
 'baseline',(SELECT metadata FROM folio.audit_events WHERE workspace_id=${literal(workspaceId)} AND action='qa.scheduler.prepared'),
 'jobs',(SELECT jsonb_agg(jsonb_build_object(
   'jobId',j.id,'document',d.name,'state',j.state,'attempts',j.attempts,
   'leaseCleared',j.lease_owner IS NULL AND j.lease_until IS NULL,'error',j.error,
   'runCount',(SELECT count(*) FROM folio.extraction_runs r WHERE r.job_id=j.id),
   'runId',r.id,'engine',r.engine,'model',r.model,'values',r.normalized_values,
   'expectedValues',r.normalized_values=${expected},'costUsd',r.cost_usd,'tokenUsage',r.token_usage,
   'documentState',d.status,'latestRunMatches',d.latest_run_id=r.id,'completedAt',j.updated_at))
  FROM folio.jobs j JOIN folio.documents d ON d.id=j.document_id
  LEFT JOIN folio.extraction_runs r ON r.job_id=j.id WHERE j.workspace_id=${literal(workspaceId)}),
 'dispatches',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'requestId',(a.metadata->>'requestId')::bigint,'dispatchAt',a.metadata->>'dispatchAt',
   'cronRunId',c.runid,'cronStatus',c.status,'cronStart',c.start_time,'cronEnd',c.end_time,
   'httpStatus',h.status_code,'timedOut',h.timed_out,'httpError',h.error_msg,
   'expectedAcknowledgement',h.content ~ '"accepted"[[:space:]]*:[[:space:]]*true','httpObservedAt',h.created))
  FROM folio.audit_events a
  LEFT JOIN net._http_response h ON h.id=(a.metadata->>'requestId')::bigint
  LEFT JOIN LATERAL (SELECT runid,status,start_time,end_time FROM cron.job_run_details
   WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='folio-worker-watchdog')
    AND start_time<=(a.metadata->>'dispatchAt')::timestamptz
    AND (end_time IS NULL OR end_time>=(a.metadata->>'dispatchAt')::timestamptz-interval '1 second')
   ORDER BY start_time DESC LIMIT 1) c ON true
  WHERE a.workspace_id=${literal(workspaceId)} AND a.action='qa.scheduler.dispatched'),'[]'::jsonb),
 'usage',(SELECT jsonb_build_object('entries',count(*),'pages',coalesce(sum(pages),0)) FROM folio.usage_ledger WHERE workspace_id=${literal(workspaceId)}),
 'unexpectedSideEffects',jsonb_build_object(
  'memberships',(SELECT count(*) FROM folio.memberships WHERE workspace_id=${literal(workspaceId)}),
  'integrations',(SELECT count(*) FROM folio.integrations WHERE workspace_id=${literal(workspaceId)}),
  'subscriptions',(SELECT count(*) FROM folio.subscriptions WHERE workspace_id=${literal(workspaceId)}),
  'intakeFiles',(SELECT count(*) FROM folio.intake_files WHERE workspace_id=${literal(workspaceId)}),
  'directUploads',(SELECT count(*) FROM folio.direct_uploads WHERE workspace_id=${literal(workspaceId)}))
) AS scheduler_acceptance;\n`;
const cleanup=`-- Restore 05-restore.sql BEFORE removing the fixture, and save evidence first.
BEGIN;
DO $qa_cleanup$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM folio.workspaces WHERE ${selector}) THEN
  RAISE EXCEPTION 'The exact marked QA workspace does not exist; nothing was removed.';
 END IF;
 IF EXISTS(SELECT 1 FROM folio.jobs WHERE workspace_id=${literal(workspaceId)} AND state='processing' AND lease_until>now()) THEN
  RAISE EXCEPTION 'Wait for the active QA lease to settle before cleanup.';
 END IF;
 IF EXISTS(SELECT 1 FROM folio.memberships WHERE workspace_id=${literal(workspaceId)})
 OR EXISTS(SELECT 1 FROM folio.integrations WHERE workspace_id=${literal(workspaceId)})
 OR EXISTS(SELECT 1 FROM folio.subscriptions WHERE workspace_id=${literal(workspaceId)})
 OR EXISTS(SELECT 1 FROM folio.direct_uploads WHERE workspace_id=${literal(workspaceId)})
 OR EXISTS(SELECT 1 FROM folio.intake_files WHERE workspace_id=${literal(workspaceId)}) THEN
  RAISE EXCEPTION 'Fixture scope changed; inspect instead of deleting.';
 END IF;
 DELETE FROM folio.workspaces WHERE ${selector};
END $qa_cleanup$;
COMMIT;
SELECT count(*)=0 AS fixture_removed FROM folio.workspaces WHERE id=${literal(workspaceId)};
-- No Storage objects were created, so no remote file deletion is required.\n`;
const manifest={preparedAt:new Date().toISOString(),status:'prepared_not_executed',marker,workspaceId,parserId,schemaId,cases:cases.map(({source,...item})=>item),expected:{queuedAttempts:1,expiredLeaseAttempts:2,runsPerJob:1,totalUsageEntries:2,totalUsagePages:2,engine:'text-anchors',model:'deterministic-v2',costUsd:0},output};
for(const [name,content]of Object.entries({'01-preflight.sql':preflight,'02-instrument.sql':instrument,'03-fixture.sql':fixture,'04-observe.sql':observe,'05-restore.sql':canonical,'06-cleanup.sql':cleanup,'manifest.json':JSON.stringify(manifest,null,2)+'\n'}))await fs.writeFile(path.join(output,name),content);
console.log(JSON.stringify({status:manifest.status,output,marker,workspaceId,files:7}));
