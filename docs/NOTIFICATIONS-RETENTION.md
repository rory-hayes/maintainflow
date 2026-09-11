# Processing notifications and retention

Verified locally on 6 September 2026. This records actual in-app behavior and the age-expiry function used by the durable worker. It does not establish email delivery, an unattended multi-day soak, production backup erasure, or deletion of copies already delivered outside Folio.

## Notification semantics

The workspace-header bell lists the latest 50 completed or failed extraction jobs. Each outcome links to its document and includes its job ID, document name, completion/failure time and personal read status. `completed` means extraction is ready for review; it does not mean the user approved the result or that an export was delivered. A terminal `failed` outcome is actionable through the document's persisted failure details and retry controls. Queued jobs and transient attempts waiting for another retry do not appear as terminal failures. Provider delivery failures remain in the integration diagnostics; they are not extraction notifications.

The inbox derives outcomes from durable jobs instead of copying extracted values or raw provider errors into another event store. A reprocess creates a new job and therefore a new outcome. The read receipt records the terminal state; a different later terminal state for the same job becomes unread. The unread count covers all retained terminal jobs, while the list shows 50. Mark all read covers all retained outcomes, including older ones outside that list.

Read status is per user and workspace, persisted in `notification_reads` under forced workspace RLS. Reading a notification or opening its document never changes document status, runs, corrections, approval or export eligibility. Removing a document removes its jobs and cascades their read receipts, so deleted document links are not retained in the inbox.

The owner/admin setting **Show in-app processing notifications** applies to the workspace. Off hides the inbox and unread count; it does not delete jobs or personal read receipts. Re-enabling restores the retained outcomes. All current workspace members may read/mark their own notifications; only owners/admins may change the preference. These endpoints require browser sessions; API keys cannot impersonate a member's inbox. The client refreshes outcomes every 15 seconds while mounted and after read mutations. There are no notification emails, browser push notifications or background delivery guarantees.

| Route | Contract |
| --- | --- |
| `GET /api/workspace/notifications` | Returns `{enabled, unreadCount, notifications}`; each item has `id`, `documentId`, `documentName`, `kind`, `occurredAt`, `read` |
| `POST /api/workspace/notifications/read` | `{jobIds: [UUID, ...]}` marks up to 100 specified terminal jobs; `{}` marks all terminal jobs in the selected workspace. Foreign, nonexistent and active job IDs are inert. |
| `PATCH /api/workspace/settings` | Owner/admin session may save `{notifications: boolean}` and `{retentionDays: integer}`. |

## Retention contract

Document age is measured from receipt (`documents.created_at`) against the workspace's configured 1–3,650 days. The worker calls `enforceRetention()` every 120 completed loop cycles; this is an operational cadence, not a guaranteed wall-clock deletion deadline. Each sweep considers the oldest 100 eligible documents. Queued or processing jobs defer expiry. Eligibility is checked again after acquiring the document lock, so a concurrent reprocess cannot silently lose its original.

The deletion transaction removes the document's runs, corrections, approvals, job-derived notifications/read receipts, local export snapshots containing it, queued delivery payloads, and Sheets write reservations. It durably records the original file in `file_deletions`. Immediate unlink is attempted; a filesystem failure remains tracked for bounded worker retries and an admin retry action. Minimal usage events and intake idempotency tombstones survive with null document links; audit action/resource identities remain. These records do not retain the deleted extraction values or original bytes.

Downloads already on users' devices, email-provider copies, delivered webhook payloads at a destination, external spreadsheet rows and deployment backups require their own retention policies. Local deletion cannot revoke them.

## Exact local evidence

`node --import tsx --test --test-concurrency=1 tests/retention-notifications.test.ts` passed **4/4**, with 0 failures and 0 skipped. The first run found a fixture-only PostgreSQL UUID/text parameter-cast error; that setup was corrected before the passing run. Migrations 005 and 006 applied successfully, and `npm run typecheck` passed after these changes.

The suite owns two synthetic workspaces and two users. It pauses no process itself, never claims a processing job, never invokes a provider, and cleans only its own rows/files. With the separately running development worker paused, it calls the exact exported maintenance function with an optional workspace restriction. Fixture timestamps are deliberately three days old against a one-day retention setting; there is no time manipulation of other data.

The assertions establish:

- Only terminal outcomes appear; extracted private values and failure diagnostics do not leak into the inbox. Other workspaces and API keys are denied.
- Marking read is persistent, per member and idempotent, and leaves exact document, job and extraction-run rows unchanged. Foreign and active IDs create no receipts.
- Owner/admin preference changes hide and restore outcomes/read status; a viewer cannot change the preference.
- Both aged completed and failed originals disappear from PostgreSQL and the private filesystem, along with runs/corrections/approvals/snapshots/deliveries/Sheets reservations/read receipts. Fresh, queued, processing and other-workspace documents stay available. A second sweep removes nothing; deferred active documents become eligible after they finish. Minimal usage, audit and intake-tombstone records remain as documented.

The browser pass in [BROWSER-QA.md](BROWSER-QA.md#processing-notifications) used the user's existing local workspace with five actual terminal jobs. Off/deep-link/enable, read-one then reload, mark-all then reload and document navigation passed. At 390×844 the dialog stayed within the viewport; Escape closed it and returned focus to the bell. [Mobile evidence](evidence/notifications-mobile.png) and [desktop evidence](evidence/notifications-desktop.png) record the result.

An unattended multi-day retention run, large-workspace notification pagination/load behavior, and production monitoring/backup erasure remain separate operational evidence. The configured age-expiry logic itself is verified above; it is no longer an unimplemented or untested setting.
