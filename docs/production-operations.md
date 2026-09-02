# Production operations and incident response

This runbook is executable preparation, not hosted-production evidence. It can
be used after a distinct MaintainFlow Ads staging project, hosted PostgreSQL,
Clerk tenant, and monitored contacts exist. A green local build or GitHub run
does not prove a deployment, backup restore, alert delivery, or real OpenAI Ads
behavior.

## Secret-safe event contract

Server failures use one-line JSON events with a stable event name, fixed scope,
release stage, compiled Git revision, generated run ID, bounded status/duration,
allowlisted aggregate counts, and a fixed error classification. They do not log
error messages, stacks, causes, database URLs, request headers or bodies, public
audit URLs, account/operator/approval identifiers, provider payloads, or
credentials.

Treat these as immediate operator alerts:

- `deployment.readiness.failed` or `deployment.readiness.unconfigured`;
- a missing daily `monitoring.run.completed` event;
- `monitoring.run.completed_with_failures` or `monitoring.run.failed`;
- `ads.apply.execution_fence_lost` or
  `ads.rollback.execution_fence_lost` once live writes are enabled;
- any `reconciliation_required` mutation event once live writes are enabled;
- any non-zero `unresolvedApprovalOperations` count from the protected daily
  monitor;
- repeated credential, authorization, storage, or provider-unavailable events.

Vercel runtime logs are sufficient for the first private staging deployment.
Add a paid log drain or incident vendor only after the event contract is proven;
do not send raw request or database data to a monitoring vendor.

Production and Preview deployments each run with `NODE_ENV=production`, so
each database URL must have its matching Sensitive
`MAINTAINFLOW_DATABASE_CA_CERT` trust root. Keep Preview on an isolated
non-production database credential even when the provider root CA happens to be
the same. Certificate rotation requires updating the scoped secret, deploying a
new immutable revision, and proving a real authenticated pooler query before
promotion; never fall back to encryption-only TLS or disable hostname checks.

## Exact-revision deployment smoke

Create a protected GitHub environment named `staging`. Require an appropriate
reviewer for that environment, set its non-secret
`MAINTAINFLOW_STAGING_ORIGIN` variable to the one approved credential-free
HTTPS origin, and create the environment secrets
`MAINTAINFLOW_STAGING_READINESS_PROBE_SECRET` and
`MAINTAINFLOW_STAGING_CRON_SECRET`. Then run the **Hosted deployment smoke**
workflow from `main` with the exact deployed Git SHA and expected stage. The
workflow deliberately accepts no destination input, so a dispatch cannot send
either bearer secret to an arbitrary host.

Before it sends either secret, the workflow fetches repository history and
proves that the full supplied object ID resolves to a commit and is an ancestor
of `origin/main`. A fabricated hexadecimal label, abbreviated SHA, detached
commit, or non-main revision therefore cannot count as deployment evidence.

The same probe can be run locally without writing secrets to the repository:

```bash
MAINTAINFLOW_PROBE_ORIGIN='https://staging.example.com' \
MAINTAINFLOW_EXPECTED_BUILD_SHA='<exact deployed git sha>' \
MAINTAINFLOW_EXPECTED_RELEASE_STAGE='demo' \
MAINTAINFLOW_READINESS_PROBE_SECRET='<dedicated readiness secret>' \
CRON_SECRET='<dedicated cron secret>' \
npm run probe:deployment
```

The probe must prove all five gate groups in one run:

1. `/api/health` returns the exact compiled revision;
2. unauthenticated `/api/ready` returns 401;
3. authenticated `/api/ready` returns the expected stage/revision with every
   dependency check passed;
4. the protected monitoring route completes successfully, including bounded
   cleanup; and
5. the public landing page, privacy notice, private-beta terms, registration
   access gate, and Readiness workspace all return bounded HTML containing
   their expected product markers.

Those five public surface requests are deliberately unauthenticated, reject
redirects, and fail if a different application is mounted at the configured
origin. The script never prints bearer secrets or response bodies. A 503 is
deployment failure evidence, even if some maintenance or monitoring work
completed.

Container CI runs this same complete probe against the built image through an
explicit loopback-only HTTP exception. The exception is accepted only when
`CI=true`, never for a remote HTTP host, and does not relax the hosted probe's
credential-free HTTPS-origin requirement.

CI also builds a second standalone image with a syntactically valid non-secret
test Clerk publishable key. It starts that image in `private_read` against the
migrated TLS PostgreSQL service and requires all thirteen readiness checks, then
proves that changing the runtime public Clerk key makes startup fail. This
covers the account-backed image/configuration boundary without contacting
Clerk or OpenAI and is not evidence of either hosted service working.

## Alert and retry policy

- Probe liveness every five minutes and authenticated readiness every five to
  fifteen minutes from a service that can store the readiness secret safely.
- The readiness route gives every dependency check a ten-second wall-clock
  deadline and caps the route at fifteen seconds. A stalled pool checkout or
  query therefore returns a logged `503` instead of reaching the platform's
  function timeout.
- Alert after two consecutive liveness/readiness failures; page immediately on
  revision mismatch or an invalid release stage.
- Require one successful monitoring completion after every deployment and one
  per UTC day. Respect its `Retry-After` header, retry once, then escalate.
- The deployment probe requires both zero recovered operations for that run and
  zero persistent unresolved operations. That count includes stale active rows
  skipped by recovery while a provider-send transaction still holds their lock.
  The provider-write fence also blocks every new apply or rollback on the
  affected advertiser until reconciliation.
- The runtime PostgreSQL client disables query pipelining for Supavisor
  transaction mode, caps statements at twenty seconds, and caps lock waits at
  eighteen seconds. Those database deadlines remain above the 15-second Ads
  HTTP send window; the provider-send database lock otherwise ends only on
  commit, rollback, or session cleanup. Keep pipelining disabled until the
  hosted pooler is proven to contain Supavisor's v2.10 pipelined-reply fix.
- Never automatically retry an Ads apply or rollback whose transport ended
  without a response, or returned HTTP 408 or 5xx. Those outcomes remain locked
  for manual Ads Manager reconciliation.
- Treat any failure after the provider-send callback begins, including a
  transaction commit failure, as an uncertain provider outcome. Disable live
  writes, verify Ads Manager, and reconcile the durable record; never infer that
  a database error means the provider request was not sent.
- A definitive 4xx provider rejection may be corrected and submitted only as a
  new deliberate approval or rollback attempt.

## Scheduled monitoring run contract

- The protected route always performs bounded stale-operation recovery,
  unresolved-ledger checks, readiness-quota cleanup, and expired live-snapshot
  cleanup before it starts provider work.
- In `demo`, provider monitoring is paused: the route does not verify Ads
  credentials or call OpenAI. It returns only capped aggregate due-account and
  due-window counts after maintenance; those counts are not live Ads evidence.
- In `private_read` and `live_write`, one invocation has a 60-second route cap
  and a shared 45-second provider budget. It selects at most two advertiser
  accounts and one due monitoring window per account. Both Insights requests
  for a window share the same abort signal, including rate-limit waits.
- If that budget expires, unstarted or interrupted account leases are released
  without increasing their provider-failure backoff. The response still sets
  `deadlineExhausted=true` and returns `503`, so the scheduler retries rather
  than treating partial work as a healthy run.
- Monitoring logs and responses expose capped aggregate counts and ages only;
  they do not include advertiser account IDs. The deployment probe allows 65
  seconds for this route and requires `deadlineExhausted=false`.

## Incident containment

For any suspected bad write, credential exposure, cross-account access, or
unconfirmed provider outcome:

1. set `OPENAI_ADS_LIVE_WRITES_ENABLED=false`;
2. set `MAINTAINFLOW_RELEASE_STAGE=private_read` (or `demo` if provider reads
   must also stop), then redeploy and run the exact-revision probe;
3. preserve the immutable deployment SHA and sanitized run/event IDs;
4. verify the advertiser state directly in Ads Manager without resending the
   request;
5. reconcile the durable approval only after the actual state is known;
6. rotate affected Ads, Conversions, Clerk, database, and operational secrets
   at their source when exposure is plausible; and
7. record customer impact, containment time, evidence, decisions, and required
   notification under the pilot agreement.

Do not paste credentials, authorization headers, raw provider/database errors,
conversion payloads, or customer URLs into tickets or chat.

## Deployment and database recovery

- Roll back application code only to an immutable previously verified SHA.
- Database migrations are forward-only. Prefer a corrective migration; never
  edit an applied migration or restore an older schema under newer code.
- Before `private_read`, complete the read-only
  [hosted backup and restore verification](database-backup-restore-verification.md)
  against a pre-backup source manifest and a distinct isolated restore target,
  including migration of the clone to the full current ledger before the final
  read-only verification. `npm run test:db` covers only a disposable database
  and is not restore proof.
- Keep application writers and operational jobs stopped between the source
  capture and the provider backup recovery point. The restore verifier requires
  exact migration/schema fingerprints and critical aggregate counts, plus zero
  isolation/orphan violations, inside one bounded read-only transaction.
- Preserve both mode-`0600` evidence manifests with the release record. Do not
  set `MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED=true` from a provider
  snapshot notification or disposable database test alone. Hosted production
  `db:migrate` additionally requires the passing manifest, sealed pre-backup
  capture, and backup recovery point all to remain no more than 24 hours old,
  and checks them against the exact target identity, full build SHA, and local
  migration set before it connects.
- A production restore decision must account for approvals and reconciliation
  records created after the backup. Do not erase unresolved external-write
  evidence merely to recover availability.

## Promotion sequence

1. Distinct staging project in `demo`; exact-revision smoke and log-secret scan.
2. Hosted database/Clerk in `private_read`; role and account-isolation proof.
3. First OpenAI Ads key; complete `first-account-acceptance.md` read-only gates.
4. One reversible staging write in `live_write`; independently verify apply,
   monitoring record, rollback, and all structured events.
5. Restore `private_read` until customer, legal, backup, alert, and incident
   evidence is reviewed for production promotion.
