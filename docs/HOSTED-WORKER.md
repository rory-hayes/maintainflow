# Bounded hosted worker

The release checkout supports an invite-only Folio preview using Vercel Node functions, an isolated `folio` Postgres schema and private Supabase Storage. Billing remains mocked. This document records implementation and local acceptance on 2026-09-11; it does not certify a live deployment, a working cloud scheduler, Resend delivery or Google Sheets authorization.

## Execution and continuation

`server/hosted-worker.ts` exposes `registerHostedWorker(app, {waitUntil})` and `wakeHostedWorker()`. The root Vercel handler attaches `wakeHostedWorker()` to `waitUntil` after successful API mutations. The authenticated `POST /api/internal/worker` endpoint returns 202 and attaches the same drain to the platform lifetime hook. Its random `FOLIO_WORKER_SECRET` must have at least 32 characters; comparisons use fixed-length SHA-256 digests with `timingSafeEqual`.

A drain has a 210-second cooperative work budget. Independent serial consumers handle extraction, webhook/Sheets delivery, provider events and deletion. Each stops claiming when insufficient time remains for its bounded IO. Retention and object reconciliation process one unit per invocation. No process loop, idle sleep, ephemeral cursor or successful HTTP acknowledgement is treated as durable completion. Vercel must be configured with Fluid Compute and a 300-second function duration to leave room for IO settlement and retry updates. `waitUntil` remains subject to that platform timeout; it is not a persistent worker service.

Every core claim now has a fresh lease owner, including overlapping invocations inside the same warm process. A late result from an expired claim cannot commit against a new owner's lease. Core extraction has its existing 90-second deadline and 120-second lease. Deliveries and provider events already use per-claim tokens. A hard process termination leaves a lease that the next invocation can recover. Transaction and connection timeouts must also be configured on hosted database pools; a cooperative deadline cannot cancel an arbitrary database wait.

Inbound email uses existing `intake_events` receipts as durable per-body/per-attachment checkpoints. A budget yield schedules continuation without spending a failure attempt. Subsequent invocations skip completed items before download or decode; a deleted document's receipt also prevents recreation. The aggregate email limit is checked across all declared attachments on every continuation. Webhook HTTP requests and Sheets range writes accept the drain's abort signal. Existing idempotency identities and exact Sheets ranges remain stable across retries.

`deploy/supabase-worker.sql` installs a named, idempotent pg_cron watchdog. Once per minute it checks only for runnable work or expired leases. It calls the worker through pg_net only when necessary. The URL and bearer token reside in Supabase Vault (`folio_worker_url`, `folio_worker_secret`). The URL must be a stable deployment hostname ending `/api/internal/worker`; deployment protection must permit the authenticated request. Secrets are never committed to the SQL template.

The watchdog includes jobs, pending approval deliveries, due delivery retries, provider events, deletion retries, retention and mature interrupted-upload reservations. Stripe is excluded because this is a mocked billing preview. Disabled deliveries with retryable expired leases do not create perpetual wakes. A running, unexpired provider lease creates no wake by itself. The query and HTTP acknowledgement are separate from completed processing; inspect cron execution, pg_net HTTP response status and durable job state.

Vercel Queues was considered. The current Postgres queue already provides transactional admission, tenant quotas, per-workspace concurrency, attempts, leases and pinned extraction versions. Adding a second queue would still need an outbox or reconciliation for the gap between a database commit and queue publication. Conditional Supabase cron is the smaller integration for this preview.

## Local acceptance

The following ran against a newly created, isolated local `folio_worker_qa` database on the existing private Unix socket. It was initialized with the checkout's 10 migrations and did not use any hosted database or real provider transport.

- TypeScript check passed.
- 39 focused tests passed: `hosted-worker`, `ai-worker`, `providers`, and `integrations` suites.
- A fresh authenticated hosted scheduler recovered a job from an expired database lease, created one immutable extraction run and retained one page usage reservation. A repeated wake created no second run.
- Two overlapping claims for the same job in one process demonstrated fencing: the expired owner's response saved nothing; the new owner saved the only run.
- Deadline cancellation reached an active controlled consumer, and remaining budget prevented further claims. An error in maintenance did not starve another queue lane.
- Inbound processing committed the email body, yielded, then resumed from its persisted receipt to process only the remaining attachment. Replay caused no additional intake or downloads.
- The SQL watchdog function and actual scheduled SELECT were executed in a rolled-back transaction using a controlled SQL HTTP stub. Idle queue: zero calls; runnable email: one; unexpired lease: zero; expired lease: one; mocked Stripe: zero. The entire temporary SQL environment was rolled back. No network request occurred.

Reproduction for the focused suite, with the local QA database already initialized:

```sh
env PGHOST=/Users/rory/Documents/Ideation/parseur/.local/socket PGPORT=55432 \
  PGDATABASE=folio_worker_qa DATABASE_SCHEMA=public \
  STORAGE_DIR=/Users/rory/Documents/Ideation/maintainflow-folio-release/.local/worker-qa-files \
  FOLIO_PREVIEW_MODE=false node --import tsx --test --test-concurrency=1 \
  tests/hosted-worker.test.ts tests/ai-worker.test.ts tests/providers.test.ts tests/integrations.test.ts
```

Still requiring hosted evidence: package deployment, native decoder execution in Vercel, real Supabase pooler connections and RLS, signed upload/finalize/download, pg_cron plus pg_net execution across a stopped function, Resend email delivery, Sheets authorization/range delivery, free-plan capacity and domain revision. Parent deployment work may append that evidence separately.

## Runtime packaging and free-plan constraints

The decoder spawns a separate Node process. The Vercel package must include the compiled `decoder-child.js`, decoder engine/limits and transitive parser dependencies, including platform-correct Sharp native libraries and PDF.js assets. `source.ts` chooses the compiled child when present; development falls back to the TypeScript child. The child retains a 30-second timeout, bounded output and memory limit, with a sanitized environment. File tracing alone must not be assumed to include a dynamically spawned child: the build explicitly traces it and hosted acceptance must exercise real file types.

A Vercel function's request and response body limit is 4.5 MB, while the application accepts originals up to 10 MiB. Original uploads and downloads must use private Storage signed URLs, with the API accepting small reservation/finalization requests. Supabase signed upload capabilities last two hours, so cleanup cannot discard their ledger at the API reservation's shorter expiry. Direct-upload staging and mature cleanup are owned by the storage adapter.

Current official constraints researched on 2026-09-11:

- Vercel Hobby is restricted to personal, non-commercial use. Mock billing does not by itself make a commercial service eligible. See [Hobby](https://vercel.com/docs/plans/hobby) and [fair use](https://vercel.com/docs/limits/fair-use-guidelines).
- Fluid Node Hobby functions have a 300-second maximum and 2 GB memory; request/response bodies are limited to 4.5 MB and function bundles to 250 MB. See [function limits](https://vercel.com/docs/functions/limitations). The current limits page takes precedence over older skill examples.
- Hobby Vercel cron runs at most once a day, so it cannot provide this minute-level queue watchdog. See [cron usage](https://vercel.com/docs/cron-jobs/usage-and-pricing).
- Supabase Free includes a 500 MB database and 1 GB Storage, may pause low-activity projects, and has no paid availability guarantee. See [pricing](https://supabase.com/pricing) and [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).
- Supabase officially supports [pg_cron plus pg_net scheduled HTTP calls](https://supabase.com/docs/guides/functions/schedule-functions). pg_net's default HTTP timeout is 2 seconds; the template uses 15 seconds only for acknowledgement, with processing attached to Vercel `waitUntil`. See [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net).
- Supabase Free Edge Functions have a 150-second wall-clock limit, 256 MB memory and a 2-second CPU allowance; Sharp is unsupported there. The existing decoder belongs in the Node package. See [Edge Function limits](https://supabase.com/docs/guides/functions/limits).
- Signed upload tokens remain valid for [two hours](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl). Database backups do not include Storage objects; Free needs a separate database and object backup procedure. See [backups](https://supabase.com/docs/guides/platform/backups).
