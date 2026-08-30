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
- any `reconciliation_required` mutation event once live writes are enabled;
- repeated credential, authorization, storage, or provider-unavailable events.

Vercel runtime logs are sufficient for the first private staging deployment.
Add a paid log drain or incident vendor only after the event contract is proven;
do not send raw request or database data to a monitoring vendor.

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

The same probe can be run locally without writing secrets to the repository:

```bash
MAINTAINFLOW_PROBE_ORIGIN='https://staging.example.com' \
MAINTAINFLOW_EXPECTED_BUILD_SHA='<exact deployed git sha>' \
MAINTAINFLOW_EXPECTED_RELEASE_STAGE='demo' \
MAINTAINFLOW_READINESS_PROBE_SECRET='<dedicated readiness secret>' \
CRON_SECRET='<dedicated cron secret>' \
npm run probe:deployment
```

The probe must prove all four gates in one run:

1. `/api/health` returns the exact compiled revision;
2. unauthenticated `/api/ready` returns 401;
3. authenticated `/api/ready` returns the expected stage/revision with every
   dependency check passed; and
4. the protected monitoring route completes successfully, including bounded
   cleanup.

The script never prints bearer secrets or response bodies. A 503 is deployment
failure evidence, even if some maintenance or monitoring work completed.

## Alert and retry policy

- Probe liveness every five minutes and authenticated readiness every five to
  fifteen minutes from a service that can store the readiness secret safely.
- Alert after two consecutive liveness/readiness failures; page immediately on
  revision mismatch or an invalid release stage.
- Require one successful monitoring completion after every deployment and one
  per UTC day. Respect its `Retry-After` header, retry once, then escalate.
- Never automatically retry an Ads apply or rollback whose transport ended
  without a response, or returned HTTP 408 or 5xx. Those outcomes remain locked
  for manual Ads Manager reconciliation.
- A definitive 4xx provider rejection may be corrected and submitted only as a
  new deliberate approval or rollback attempt.

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
- Before `private_read`, restore the hosted backup into an isolated database,
  apply the current migration ledger, run `npm run test:db` against the fixture,
  and record recovery point/time evidence.
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
