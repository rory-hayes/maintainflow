# Independent operational monitoring

`scripts/operations-monitor.ts` probes the canonical app from a separate runner. `.github/workflows/operations-monitor.yml` prepares an opt-in GitHub Actions schedule on `main`; importing either monitor script makes no requests. Code and local tests do not establish that the schedule, alerts or inbox delivery are active.

The runner calls only `GET /api/health`, `GET /api/ready` and `GET /api/internal/diagnostics`, with bounded responses, deadlines and redirects disabled. A dedicated `FOLIO_MONITOR_SECRET` permits diagnostics only; it cannot authorize `/api/internal/worker`. No customer data is uploaded, jobs are retried or workers are woken by the monitor.

## Behaviour

- The workflow requests a run every five minutes, best effort. Three consecutive unhealthy observations open one incident; a healthy observation closes it with a recovery notice. GitHub delay makes elapsed detection time longer than the nominal cadence.
- Due work older than five minutes or an increase from the last observed terminal failure count opens an incident immediately. A decrease establishes the next count baseline, so later failures are not hidden below a historical maximum. Three consecutive observations of expired leases also open an incident. Existing failures on initialization establish a baseline rather than generating historical alerts.
- A gap exceeding 20 minutes between observations is a separate monitoring-gap incident. It is detected only when execution resumes; the workflow cannot report its own permanent stoppage.
- Email content contains only fixed check names, the app origin and timestamps. No diagnostic payload, account identifier, document content, credential or raw provider error appears in logs or notices.

## Authoritative encrypted checkpoints

State is encrypted and authenticated with AES-256-GCM and bound to the exact configured app origin. Artifacts contain one encrypted `state.enc`, not plaintext monitor state. Treat artifacts in a public repository as publicly obtainable ciphertext; keep the state key in GitHub secrets and never publish it.

`scripts/monitor-artifact-state.ts` reads only fixed GitHub API metadata for `rory-hayes/maintainflow`, `operations-monitor.yml` and `main`. It scans at most 30 runs and bounded artifact metadata. Exact workflow run names distinguish `Folio monitor: run` and `Folio monitor: initialize` from probe/drill runs. Runs whose only job is disabled use `Folio monitor: disabled`, derived from the same activation predicate as the job gate. Probe, drill and disabled runs do not participate in state history.

The latest prior stateful run is authoritative. Within that run, the highest saved attempt wins, then `delivered` before `prepared` before `resumed`. A rerun inspects earlier attempts of its current run; it cannot roll back a newer stateful run. A successful attempt must retain its delivered checkpoint. Missing, expired, ambiguous or incomplete authoritative history fails closed instead of silently choosing an older run. First-ever initialization requires an explicit `initialize` dispatch and completely enumerated history with no earlier stateful run. A 30-run window that might conceal earlier state cannot authorize initialization.

For every stateful run, steps execute in this order:

1. Select an artifact by exact ID and run ID, download into `.monitor`, then require exactly one regular, non-symlink `state.enc` of at most 128 KiB and authenticate it. Extra files, malformed state, wrong keys and wrong origins fail before mail.
2. Upload the authenticated prior state as `folio-monitor-state-v1-{attempt}-resumed` **before** retrying its pending notices. This is the carried-forward outbox, not a claim that its notices have been delivered. First-ever initialization skips this step.
3. Deliver previous pending notices, then take a new observation and prepare the next encrypted state. Draining pending notices first prevents a full backlog from blocking delivery recovery.
4. Successfully upload `folio-monitor-state-v1-{attempt}-prepared` before sending newly prepared notices.
5. Deliver those notices, then successfully upload `folio-monitor-state-v1-{attempt}-delivered`. A stateful run cannot succeed without this final checkpoint.

Uploads use immutable names, include the hidden path explicitly, fail on missing files, use no compression and request 90-day retention. No unconditional failure handler uploads a potentially older local file. One workflow concurrency group serializes runs with `cancel-in-progress: false`. The runner has a ten-minute deadline for bounded notice retries; cancellation leaves the last successfully uploaded checkpoint available for reconciliation.

If a provider accepts an email but its response or final checkpoint is lost, the earlier checkpoint retains the same notice ID, timestamp and body. Resend receives the same idempotency key on retry. Pending notices aged 23 hours or more stop for reconciliation; the monitor does not recreate an expired provider idempotency key. Preserve sender, recipient and origin configuration during uncertain-delivery recovery because changing them changes the request body. Provider acceptance and actual inbox delivery remain different evidence.

## Configuration and activation

1. Install an independently generated `FOLIO_MONITOR_SECRET` as a sensitive server setting and as a GitHub Actions secret. Keep the worker credential out of the monitor workflow.
2. Install `FOLIO_MONITOR_STATE_KEY` (32 random bytes encoded as base64), `FOLIO_MONITOR_EMAIL_API_KEY` (verified-domain sending credential), and the approved `FOLIO_MONITOR_EMAIL_TO` as GitHub Actions secrets. The sender is `no-reply@maintainflow.io` in this workflow. The GitHub token has `contents: read` and `actions: read` and is passed only to metadata selection and exact-artifact download.
3. Keep `FOLIO_MONITOR_ENABLED` unset or false. Explicit `main` dispatches of `probe`, `initialize` and `delivery-drill` are allowed while automatic monitoring is disabled; ordinary `run` dispatches and schedules remain skipped. Dispatch `probe` and inspect health/readiness/diagnostics.
4. With recipient consent, dispatch `delivery-drill` with a fresh UUID and a fixed current UTC ISO timestamp, for example `2026-09-20T12:00:00.000Z` with the actual execution time substituted. It creates two `[TEST]` notices from synthetic failures and recovery, changes no application state and reads/writes no incident artifacts. Record provider acceptance and inbox observation separately. An uncertain retry must reuse **both** UUID and timestamp within the allowed window; do not invent another identity to bypass reconciliation.
5. Dispatch `initialize` before enabling the schedule. Initialize promptly, before more than 30 disabled/probe/drill runs can hide earlier history; exceeding that scan bound requires explicit reconciliation, not a reset. Initialization restores an existing authoritative artifact instead of discarding it. After successful initialization, set repository variable `FOLIO_MONITOR_ENABLED=true` and observe a genuine scheduled run, exact artifact selection, checkpoint uploads and quiet healthy operation. Manual dispatch alone does not establish scheduling.
6. Preserve source revision, workflow run links, delivery receipts, chosen cadence and recipient in the private operational record. Do not place credentials or decrypted state in public artifacts.

Use `node scripts/operations-monitor.ts --plan` for offline inspection. `--probe` reads dependency endpoints; `--validate-state` checks and authenticates the downloaded directory without network calls. The workflow uses separate `--prepare` and `--deliver` phases; local `--run` alone does not provide the remote checkpoint guarantees above. `--delivery-drill` sends test email and requires recipient authorization. Configuration is environment-only; the CLI does not read application `.env` files.

## Limits and recovery

This repository's public visibility was checked on 20 September 2026. Standard hosted runners can use the public-repository allowance, but artifact storage, retention and any changed visibility or runner selection require their own account checks. This workflow does not establish unlimited free capacity. See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

GitHub can delay or drop scheduled runs and disables public-repository schedules after 60 days without repository activity. This is best-effort monitoring, not a five-minute SLA or an independently watched monitor. An external stale-run/dead-man check remains a production gate. Do not create artificial commits to conceal the inactivity restriction. See [schedule limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

Missing/expired artifacts, a failure before the first checkpoint of a stateful run, an older pending notice, secret rotation or inconsistent history require operator reconciliation. Preserve the latest authenticated artifact, workflow evidence and provider receipts. Do not delete failed runs/artifacts, reset initialization, change notice identities or fall back to an earlier run merely to make the monitor green. The 90-day artifact setting is requested retention, not a permanent recovery guarantee. A failed GitHub run is not itself proof that an operator received a failure notification.

The app's `alerts.deliveryVerified` remains false because the app cannot certify independent inbox observations.

Monitoring does not prove automatic worker recovery, backups, actual provider integrations, legal review or public activation. Those retain separate acceptance evidence.
