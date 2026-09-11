-- Run as the Supabase SQL Editor migration identity AFTER Folio migrations.
-- This installs a conditional watchdog, not an always-on worker or paid service.
-- Create these two Vault secrets first (never commit values to this file):
--   folio_worker_url     https://<stable-deployment-host>/api/internal/worker
--   folio_worker_secret  same >=32-character random value as FOLIO_WORKER_SECRET
-- If deployment protection is enabled, permit this authenticated endpoint or use
-- a deployment protection bypass configured separately; a 401/403 must be fixed.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

CREATE OR REPLACE FUNCTION folio.worker_has_runnable_work()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog AS $folio_work$
 SELECT
 EXISTS(SELECT 1 FROM folio.jobs j JOIN folio.workspaces w ON w.id=j.workspace_id
   WHERE (j.state='processing' AND j.lease_until<now())
   OR (j.state='queued' AND j.available_at<=now() AND
      (SELECT count(*) FROM folio.jobs running WHERE running.workspace_id=j.workspace_id AND running.state='processing')
       <coalesce((w.plan->>'maxConcurrent')::int,2)))
 OR EXISTS(SELECT 1 FROM folio.webhook_deliveries d LEFT JOIN folio.integrations i ON i.id=d.integration_id
   WHERE (d.status='delivering' AND d.lease_until<now() AND (i.enabled OR d.attempts>=5))
   OR (i.enabled AND d.attempts<5 AND d.status IN ('queued','retry') AND d.next_attempt_at<=now()))
 OR EXISTS(SELECT 1 FROM folio.approvals a JOIN folio.extraction_runs r ON r.id=a.run_id
   JOIN folio.documents d ON d.id=r.document_id
   JOIN folio.integrations i ON i.workspace_id=a.workspace_id AND (i.parser_id IS NULL OR i.parser_id=d.parser_id)
   WHERE i.enabled AND a.created_at>=i.created_at
   AND NOT EXISTS(SELECT 1 FROM folio.webhook_deliveries sent WHERE sent.integration_id=i.id AND sent.event_key='approval:'||a.id::text))
 -- Preview billing stays mocked: no Stripe provider work is scheduled.
 OR EXISTS(SELECT 1 FROM folio.provider_events p WHERE p.provider<>'stripe' AND
   ((p.status='processing' AND p.lease_until<now()) OR
    (p.attempts<5 AND p.status IN ('queued','retry') AND p.next_attempt_at<=now())))
 OR EXISTS(SELECT 1 FROM folio.file_deletions WHERE status='pending' AND available_at<=now())
 OR EXISTS(SELECT 1 FROM folio.documents d JOIN folio.workspaces w ON w.id=d.workspace_id
   WHERE d.created_at<now()-((w.settings->>'retentionDays')::integer*interval '1 day')
   AND NOT EXISTS(SELECT 1 FROM folio.jobs j WHERE j.document_id=d.id AND j.state IN ('queued','processing')))
 OR EXISTS(SELECT 1 FROM folio.intake_files WHERE lease_expires_at<now()-interval '1 hour')
 OR EXISTS(SELECT 1 FROM folio.direct_uploads WHERE state<>'cleaned' AND cleanup_after<now()
   AND (finalize_lease_until IS NULL OR finalize_lease_until<now()));
$folio_work$;
REVOKE ALL ON FUNCTION folio.worker_has_runnable_work() FROM PUBLIC,folio_app,folio_admin;

-- Named scheduling is idempotent: re-running updates this job, not a duplicate.
SELECT cron.schedule('folio-worker-watchdog','* * * * *',$folio_cron$
 SELECT net.http_post(
   url:=(SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='folio_worker_url'),
   headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||
     (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='folio_worker_secret')),
   body:='{}'::jsonb,
   timeout_milliseconds:=15000
 ) WHERE folio.worker_has_runnable_work()
 AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='folio_worker_url' AND decrypted_secret ~ '^https://[^/]+/api/internal/worker$')
 AND EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='folio_worker_secret' AND length(decrypted_secret)>=32);
$folio_cron$);

-- Verification (does not display decrypted secrets):
-- SELECT jobid,jobname,schedule,active FROM cron.job WHERE jobname='folio-worker-watchdog';
-- SELECT status,return_message,start_time,end_time FROM cron.job_run_details
--   WHERE jobid=(SELECT jobid FROM cron.job WHERE jobname='folio-worker-watchdog') ORDER BY start_time DESC LIMIT 5;
-- SELECT id,status_code,timed_out,error_msg,created FROM net._http_response ORDER BY created DESC LIMIT 5;
-- SELECT folio.worker_has_runnable_work();
-- A successful cron SQL invocation alone does not prove the HTTP response or queue recovery.
-- Rollback scheduler only (preserves queue/data):
-- SELECT cron.unschedule('folio-worker-watchdog');
