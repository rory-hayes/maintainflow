# Live scheduler acceptance procedure

Prepared 2026-09-12. This is a plan and a nonsecret SQL generator, not evidence that the live test ran. No application code or remote state was changed to prepare it.

The acceptance target is a complete chain: the named `folio-worker-watchdog` cron job schedules an HTTP request through pg_net; that exact request receives Folio's 202 acknowledgement; the hosted worker completes one queued job and one recovered expired lease exactly once. Both use deterministic text rules. This test does not invoke AI, billing, external integrations or document Storage, and does not establish upload/decoder/provider acceptance.

## Prepare the kit

Run from the release checkout:

```sh
node scripts/prepare-scheduler-acceptance.mjs
```

The generator reads the current canonical watchdog SQL and writes seven nonsecret files under `.local/scheduler-acceptance/<random-marker>/`. It does not read credentials, open a database connection or send HTTP requests. Its `manifest.json` contains all exact IDs and expected results. Keep this manifest with the final evidence.

A kit is already prepared at:

```
.local/scheduler-acceptance/1036d637-d127-4f28-a3b4-be726f05f60e/
```

Its only fixture workspace is `e4b45233-9b14-4ea5-8d43-37f14c2c7262`. Generated SQL creates no users or memberships, so nobody can log into this backend-only fixture. It creates two plainly marked document rows containing synthetic `Proof` and `Total` text, but no original objects. Their hashes describe that exact text. Each has one marked usage entry; the worker must not add another.

## Execute in a quiet window

Use the authorized Supabase SQL Editor identity. All fixture data belongs to the isolated `folio` schema. Do not run an API upload/reprocess/approval, manually call the worker endpoint, run a separate worker, or deploy a new revision during this short measurement window. Read-only SQL observations are safe. If other app mutations occur, rerun the acceptance later rather than claiming cron caused the completion.

1. Deploy the hosted package and configure its runtime secrets, then apply canonical `deploy/supabase-worker.sql`. Record the deployment revision separately. The worker URL in Vault must refer to this revision's reachable host. No secret value should appear in evidence.
2. Run `01-preflight.sql`. Require one active named watchdog with schedule `* * * * *`, both Vault configuration checks true, `runnable=false`, and zero active leases. Runtime roles must not be superusers or bypass RLS. Diagnose any missing extension, role or function before creating fixtures.
3. Run `02-instrument.sql`. It temporarily wraps the same named cron command, preserving its actual wake predicate, URL, bearer lookup, HTTP body and timeout. It captures the returned request ID in the marked workspace's `audit_events`. This makes the HTTP evidence exact rather than guessing from timestamps or unrelated HTTP requests. Capture is limited to ten minutes after fixture creation. The underlying canonical dispatch still runs if the fixture is absent or capture has expired.
4. Run `03-fixture.sql` once. Its transaction refuses a busy worker window, creates the marked workspace and both jobs, and records baseline cron/HTTP IDs. The queued job becomes available after 90 seconds; the simulated crashed job's fake lease expires at the same time. This prevents any preceding mutation wake from claiming immediately. Save the returned baseline and `runnableAfter` time. Do not manually advance either timestamp.
5. Wait until at least 30 seconds after `runnableAfter`, then run `04-observe.sql`. Repeat this read-only query at most once per minute, with an eight-minute total deadline from fixture creation. It returns one JSON result containing the complete evidence. Do not treat 202 or a successful cron SQL run alone as success.
6. Once both jobs complete, wait one further watchdog interval (70 seconds) and run `04-observe.sql` again. Save both observations. In this quiet window there should be no additional completed extraction runs or additional QA dispatch once the queues are idle.
7. On success or failure, run `05-restore.sql` to restore the canonical watchdog command. Run `01-preflight.sql` to confirm it remains active. Preserve observations before cleanup.
8. Run `06-cleanup.sql`. It removes only the exact UUID workspace carrying the exact marker. It refuses a still-active processing lease or unexpected memberships, integrations, subscriptions or upload reservations. No Storage deletion is needed because this fixture created no objects. If its guard refuses cleanup, retain the fixture for diagnosis rather than broadening the deletion.

## Pass criteria

| Evidence | Required result |
| --- | --- |
| Captured cron run | `cronStatus=succeeded`, real `cronRunId`, recorded dispatch belongs to that run's time window |
| Exact pg_net response | Captured `requestId` joins a response with `httpStatus=202`, `timedOut=false`, `httpError=null`, `expectedAcknowledgement=true` |
| Queued job | `state=completed`, `attempts=1`, cleared lease |
| Abandoned-lease job | `state=completed`, `attempts=2`, cleared lease |
| Each extraction | One run, `engine=text-anchors`, `model=deterministic-v2`, `expectedValues=true`, `costUsd=0`, empty token usage |
| Each document | `documentState=needs_review`, `latestRunMatches=true` |
| Replay observation | Same two run IDs and one run per job after the next cron interval |
| Usage | Two entries and two pages total, unchanged between observations |
| Side effects | Memberships, integrations, subscriptions, intake reservations and direct uploads all zero |
| Cleanup | `fixture_removed=true`; canonical named watchdog remains active |

HTTP 401/403 points to bearer configuration or deployment protection; 404 points to a wrong revision/route; 5xx, timeout or missing pg_net response requires logs. A 202 with stuck jobs requires inspecting that deployment's worker logs, database roles/search path, leases and `waitUntil` lifecycle. Preserve the fixture errors and restore the canonical scheduler after the eight-minute deadline; do not create repeated fixtures while diagnosing.

The pg_net request ID and response table are documented by [Supabase pg_net](https://supabase.com/docs/guides/database/extensions/pg_net): dispatch occurs after commit and responses are retained for six hours by default, so export evidence promptly. Cron execution status is recorded independently in `cron.job_run_details`, as described in [Supabase Cron](https://supabase.com/docs/guides/cron). Neither alone establishes successful application processing.
