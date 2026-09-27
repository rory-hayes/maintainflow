# Deployment health and operator readiness

The health routes distinguish a running API from working dependencies. They do not establish production acceptance, provider delivery, automatic worker execution, backup recovery or a legally complete service. Keep the current preview, registration and billing controls unchanged until their separate activation is approved.

## HTTP checks

| Route | Access | Meaning |
| --- | --- | --- |
| `GET /api/health` | Public | Existing API status, environment, release revision and file limits. Its global request-protection hook uses the database; it is not an independent database-free liveness check. It does not process a queue. |
| `GET /api/ready` | Public | HTTP 200 means bounded database capability, private-storage metadata/access and restore-state probes passed. HTTP 503 means one or more probes are unavailable. Only check names and fixed statuses are returned. |
| `GET /api/internal/diagnostics` | Existing `FOLIO_WORKER_SECRET` bearer | Dependency results and durable queue counts/ages, plus missing public-operator fields. No account IDs, document text, object keys, recipient addresses or underlying database errors are returned. |

All responses are private/no-store. Readiness and diagnostics bypass the global database-backed rate limiter so dependency failures cannot delay their own bounded probes or run before the diagnostics bearer check. Dependency probes coalesce concurrent requests and cache a result for 15 seconds within a warm instance. Each probe has a three-second deadline. Database timeouts destroy only the probe connection, including a connection acquired after the deadline. These controls bound a monitor's cost; they are not a database availability guarantee.

The database check uses both runtime pools and zero-row reads of current required relations/columns, including migration 038's billing mode and Checkout idempotency columns. Restricted runtime roles deliberately cannot read `schema_migrations`; readiness does not widen those grants or claim an exact migration-ledger audit. Deployment still verifies the migration journal using the migration identity.

Filesystem readiness requires an existing accessible directory, refuses a directory symlink, and creates no files. Supabase readiness reads only metadata for the fixed `folio-originals` bucket and requires private visibility and an allowed size limit. It does not write, retrieve or delete a customer object. A successful metadata check does not prove an upload/download round trip or deletion.

The diagnostics endpoint returns HTTP 401 for an incorrect bearer and HTTP 503 if its secret or dependencies are unavailable. The same secret permits a worker wake; keep it in a server-side monitor secret store. Do not put it in a URL, browser code, command-line argument, screenshot or copied support log. Use an owner-only curl configuration file or the monitor's protected header facility. Rotate the runtime and Vault copies together if compromised.

For each production release, bind the existing host-specific protection exception to the verified current immutable deployment hostname and retire its predecessor. A 27 September review found this rule still referenced the retired PR45 host, demonstrating why deployment success alone is insufficient. Keep only the two approved canonical hostnames plus the verified production hostname; inspect both draft and live rule configuration after the change. Preserve authentication and all other protections, with no wildcard preview exception. Any QA hostname requires its own separately scoped, bounded exception and retirement.

## Worker observations and alerts

`worker.queues` covers extraction, field suggestions, split suggestions, integration deliveries, provider events, account email, invitation email and private-object deletion. Each lane reports waiting, due, processing, expired-lease and failed counts, plus the age in seconds of the oldest due item. Failed counts are retained terminal rows, not a count of new incidents. Future retries do not contribute to due age.

These are queue observations, not exact claim eligibility. A paused integration, parser setup, workspace concurrency or another policy can prevent a due row from being claimed. Account request admission and maintenance/retention are additional watchdog responsibilities; this endpoint does not claim to inventory every scheduled task. An empty queue does not establish that a worker will wake. The response explicitly leaves heartbeat and queue-eligibility verification false.

Before public activation, configure an independent monitor and test its notification delivery:

1. Poll liveness/readiness every minute. Start with an alert after three consecutive non-200 readiness responses, and notify on recovery. Record the actual chosen cadence and recipients.
2. Read authenticated diagnostics. Investigate due age over five minutes or expired leases persisting across three polls; tune thresholds using observed load. A clock tick or HTTP 202 worker acknowledgement is insufficient recovery evidence.
3. Alert on increases in failed counts, then identify the responsible lane through authorized operator inspection. Do not automatically clear or replay terminal rows merely to silence an alert.
4. Review platform function failures/timeouts and the named `folio-worker-watchdog` cron results. Correlate pg_net acknowledgements with the durable job/result state. Cron success alone is not completion.
5. During a controlled drill, prevent the immediate wake for one owned synthetic job and let the independent watchdog recover it. Verify one extraction result and one usage reservation, then remove only the owned fixture. Record deployment SHA, UTC timestamps and scheduler/HTTP/result correlation.

This code does not create an external monitor, send an alert, or register its recipient. `alerts.deliveryVerified` remains false until separate operational evidence exists. Use the [hosted worker contract](HOSTED-WORKER.md) and the current reviewed watchdog SQL; do not copy an older queue predicate into production.

## Bounded watchdog history maintenance

`cron.job_run_details` has no automatic retention, according to the [pg_cron monitoring documentation](https://github.com/citusdata/pg_cron#monitoring-jobs). A dashboard observation on 26 September 2026 showed 80.78 MB for that table; it did not establish the age, status or job ownership of those rows. This maintenance procedure targets only the active, minutely `folio-worker-watchdog`, not every job in the table. It is separate from customer document retention, backups and recovery acceptance.

The offline preparer imports no runtime configuration and never connects to a database. It creates a new private directory of SQL and hashes; **running it does not execute the SQL**. Its conservative minimum retention is 30 days for successes and 90 days for failures. Choose explicit UTC cutoffs at or before those limits; no moving cutoff is used during apply. Reviews expire after 24 hours. Each batch contains at most 1,000 exact, completed run IDs. Running, incomplete, unknown-status, other-job, other-owner and other-database rows are retained. Snapshot owner/database labels are limited to 63 characters without controls or dollar signs; unsupported labels are rejected, never rewritten into another identity.

1. Confirm the intended Supabase project and use the existing scheduler owner identity in SQL Editor. Do not change runtime permissions or use a tenant connection. Generate the read-only inventory with reviewed cutoffs and a new output path, for example:

   ```sh
   node --import tsx scripts/prepare-cron-history-maintenance.ts inventory --success-before 2026-08-28T00:00:00Z --failure-before 2026-06-29T00:00:00Z --limit 1000 --out .local/cron-history-inventory-unique
   ```

2. Run only `inventory.sql` first. It uses a read-only transaction with bounded statement/lock timeouts. Save its single JSON value privately as `snapshot.json`. It contains job configuration and row digests, IDs, statuses and UTC times; it never returns job commands, return messages or Vault values. Check the project, owner, database, exact watchdog, cutoffs and selected IDs. Preserve any incident/acceptance evidence that depends on these logs before deletion. If no candidates are eligible, stop; do not shorten retention simply to obtain a nonempty batch.
3. After reviewing the exact snapshot and authorizing that bounded deletion, prepare the apply files in another new directory:

   ```sh
   node --import tsx scripts/prepare-cron-history-maintenance.ts prepare-apply --snapshot .local/cron-history-inventory-unique/snapshot.json --out .local/cron-history-apply-unique
   ```

4. Review `apply.sql`, its copied snapshot and `preparation.json` hashes, then execute the whole transaction using the same project and owner. It holds the unchanged watchdog row against concurrent configuration edits, locks only reviewed history IDs, rechecks complete row digests and eligibility, and rolls back on any mismatch. Concurrent maintenance fails rather than broadening the batch. It installs no function/job/schema and changes no watchdog settings, logging configuration or grants. Require a successful `COMMIT`: the returned count describes deletion **inside the transaction**, not an independent durable-commit receipt.
5. Run `verify.sql` read-only. Require matching database/owner, unchanged watchdog digest and zero remaining reviewed IDs. Preserve execution and verification receipts. On timeout, disconnection or an uncertain result, inspect using this verification query before deciding anything further; never automatically replay apply. Replaying an already deleted batch fails closed. Any further batch requires a fresh inventory and review.

This tool does not install an ongoing schedule or establish a maintenance owner. Review history growth as part of routine operations; record the chosen operator/cadence separately before claiming ongoing maintenance. The table-size measure includes unrelated and retained rows. Row deletion does not promise immediate disk-file shrinkage; no `VACUUM FULL` or storage-capacity change is included. Local tests use disposable PostgreSQL surrogate tables with the documented pg_cron columns; they verify SQL boundaries and rollback, not hosted extension permissions or actual deletion. No hosted history has been removed by adding this tool.

## Operator and customer disclosures

`GET /api/config` exposes only the validated `publicService` fields used by `/privacy` and `/terms`. Configure the following with approved information:

| Environment variable | Public content |
| --- | --- |
| `FOLIO_OPERATOR_NAME` | Actual service operator identity |
| `FOLIO_SUPPORT_EMAIL` | Monitored support contact |
| `FOLIO_PRIVACY_EMAIL` | Monitored privacy-request contact |
| `FOLIO_PRIVACY_URL` | HTTPS link to the operator's full privacy notice |
| `FOLIO_TERMS_URL` | HTTPS link to completed service/payment/cancellation terms |
| `FOLIO_SUBPROCESSORS_URL` | HTTPS link to the current subprocessor disclosure |
| `FOLIO_RETENTION_NOTICE` | Approved plain-text statement for backups, audit records and provider copies |
| `FOLIO_DATA_LOCATION_NOTICE` | Approved plain-text statement about hosting, processing locations and transfers |

The three existing `MAINTAINFLOW_LEGAL_ENTITY_NAME`, `MAINTAINFLOW_SUPPORT_CONTACT_EMAIL` and `MAINTAINFLOW_PRIVACY_CONTACT_EMAIL` settings are fallback aliases. An explicit nonempty Folio setting takes precedence. Invalid controls, emails, non-HTTPS policy links or URLs containing credentials are omitted. Missing fields stay missing; no name, address, retention period or legal promise is inferred.

The protected diagnostic lists missing configuration names. Even a complete configuration does not certify legal review, monitored mailboxes, provider contracts or activation. The application pages state the limits of their technical notes and link to the operator's policies. Do not point those links back to the same unfinished page and treat that as a completed notice.

Workspace document retention and retryable object deletion are implemented. Downloaded exports and copies delivered to other services have separate lifecycles. Retained original PDF/TIFF/ZIP bundles can contain omitted pages, excluded files or deleted-child bytes while another child remains. Public disclosure must account for those originals, backups, operational records and provider copies rather than promising one universal deletion deadline.

## Backup and restore operations

The [encrypted backup CLI](BACKUP-RESTORE.md) has isolated PostgreSQL 17 and filesystem restore evidence. It does not capture hosted Supabase Storage objects, install a schedule, upload off-host artifacts or enforce backup retention. Do not run it against hosted storage while claiming a complete cloud backup.

Before public activation, record the actual database/object backup method, stable integration-key custody, encrypted off-host destination, schedule, retention, access owner and recovery targets. Confirm that database backups alone do not omit original objects. Keep backup private keys separately from backup artifacts and runtime secrets.

For every recovery drill:

1. Select a completed backup and isolated empty destination; prevent all outgoing provider traffic.
2. Restore the database, originals and matching integration encryption key. Preserve pending-restore protection until verification succeeds.
3. Verify account/tenant isolation, exact original and approved export bytes, historical results, retained bundle sources, tombstones, queued jobs and deletion/outbox state.
4. Activate only the isolated restored instance with the documented explicit command. Process controlled queued work once and verify no duplicate charges or deliveries.
5. Record elapsed recovery time, source/artifact identity, missing objects, cleanup and any failure. A successful local drill is not proof of hosted disaster recovery.

Backup age monitoring and failed-drill notification must be wired to the chosen backup service. The health endpoint intentionally reports no fabricated backup-success timestamp. Keep `hostedRecoveryVerified` and `scheduledBackupVerified` as unverified until independent records establish them.
