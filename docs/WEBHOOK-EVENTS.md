# Selectable webhook events

MaintainFlow uses the existing workspace integrations, immutable document history and durable signed-delivery queue. This extension adds terminal failure subscriptions without a separate service, credential store or billing system.

## Setup and boundaries

Open **Integrations → Add webhook**, enter a public HTTPS receiver that you control, optionally select a parser, and choose one or more events. Save the one-time signing secret securely on the receiver. Approval is selected by default. Existing connections without an explicit event list remain approval-only; Google Sheets always receives approvals only.

Event choices are fixed when a connection is created. Pause, enable, replay and remove retain their existing behavior. To change event choices, create the replacement connection and deliberately retire the old one; events during a gap are not backfilled. Connections are eligible only for events recorded at or after their creation. While paused, eligible history is retained subject to document retention and can be queued after enabling. Already queued deliveries retain their original payload.

| Event | Meaning | Data |
| --- | --- | --- |
| `document.approved` | A user explicitly approved a revision. | Existing approval/run/correction identity and approved values; envelope unchanged. |
| `document.extraction_failed` | Document processing entered a final failed state, including permanent/exhausted failures and setup failure before extraction. | Immutable failure-event ID, document/parser identity, failed job ID, time and fixed explanation. No extracted values or raw provider exception. |
| `document.export_failed` | Generation or persistence of an export failed after an eligible selection was accepted. | One failure per selected document, shared export-operation ID, exact selected approval/run IDs, format, time and safe explanation. |

Transient extraction retries are not terminal failure events. Invalid requests, authentication/permission errors, unsuccessful download requests and failed webhook deliveries do not produce export-generation failures. A failed export does not invalidate an earlier successful export snapshot. A failure can be delivered after a later processing attempt succeeds: it describes the immutable historical event, not current document status.

A repeated failure has a new event ID, even when a setup retry reuses the same job. Export failure events for different documents in one batch have distinct event IDs and the same `exportId`. Missing-operation or malformed legacy history is excluded rather than assigned an invented identity. Deleting or expiring a document removes its pending delivery payloads under the existing retention policy. An HTTP request already sent to a receiver cannot be recalled.

## API and receiver contract

`POST /api/integrations/webhooks` accepts optional `events`, a nonempty unique list of at most three supported event names. Omission selects `document.approved`. Existing owner/admin permissions and `integrations:write` scope apply. Event choices cannot be changed by the existing enabled-only PATCH endpoint. Delivery history adds `event`, `documentId` and `documentName` to its existing fields; it continues to return the latest 100 deliveries in the current workspace.

Failure examples are clearly synthetic:

- [Extraction failure](../fixtures/automations/document-extraction-failed.json)
- [Export failure](../fixtures/automations/document-export-failed.json)
- [Failure JSON Schema](../fixtures/automations/document-failed.schema.json)

Common failure fields are `event`, `id`, `document: {id, name, parserId}`, `failedAt`, and `error: {code, message}`. Extraction includes `jobId`. Export includes `exportId`, `runId`, `approvalId` and `format` (`csv`, `xlsx` or `json`). Error codes are `extraction_failed`, `export_generation_failed` and `export_size_limit`. They do not expose the provider's raw error or document values.

Use [verifyWebhookDelivery](../examples/automations/verify.ts) for a receiver subscribed to these events. It verifies the existing raw-byte HMAC, timestamp and delivery identity before parsing and validating the appropriate envelope. The existing `verifyApprovalDelivery` remains approval-only. Existing invoice recipes should continue to subscribe/filter for `document.approved`; failure events must not be mapped into invoice rows.

The signing headers, five-attempt limit and manual-replay identity are unchanged. Persist the connection/delivery ID atomically before acknowledging. Retries and replay use the stored JSON payload with the same delivery ID; the timestamp/signature can change on each attempt. Delivery is at least once, so a receiver must deduplicate. A delivered HTTP response proves receiver acceptance, not completion of its downstream automation.

## Release and evidence boundaries

The application reuses the existing JSON configuration, document journal and delivery tables; no application migration or new runtime grant is required for these event choices. The hosted watchdog needs the matching owner-only function-body update from `deploy/supabase-worker.sql` so unqueued failures wake the worker and approval events do not wake connections subscribed only to failures. Its existing owner, invoker security, fixed search path and execute restrictions must be preserved. Do not reconfigure Vault, cron, extensions or credentials to apply this body update.

The backup verifier binds the exact watchdog function hash. Use the matching operator checkout when restoring an older archive, and verify the updated function through the existing managed restore drill. Bank migrations 039/040 remain a separate pending approval.

Controlled tests and local browser acceptance are recorded in the release report. They do not establish a real destination account, live inbox delivery or hosted scheduling acceptance. No receiver is activated automatically and no notification email is sent by this work.

## Local verification — 26 September 2026

**80/80 focused tests** passed on an unchanged isolated source copy, including nine new webhook cases, 13 watchdog groups and the receiver examples. These cover subscriptions, legacy approvals/Sheets, tenant/role/scope isolation, terminal and repeated failures, expired leases after review, exact historical export approvals, safe renderer/size/persistence failures, signed retries/replay, bounded reconciliation, locked-document catch-up and deletion/retention.

**10/10 browser groups** passed at 1440×1000 and 390×844 using existing Playwright Chromium (Browser plugin unavailable). Flow: real sign-in → select events and create a connection → actual blank-PDF rules failure → controlled signed delivery → history/source link/replay → mobile form scrolling and creation → viewer restrictions. The final run had no page errors, overlays, unexpected console errors or external calls; the initial signed-out session check returned its expected HTTP401. Two earlier test-selector failures were corrected before this final run. All five final screenshots were inspected.

TypeScript, frontend/hosted builds and isolated runtime/decoder checks passed. **12/12 managed restore checks** passed with the updated watchdog hash, preserving owner-only execution and tenant isolation. Temporary copied checkouts and socket-only databases were removed. The normal database and real credentials were untouched. Final full-suite CI and deployment status belong to the release PR.

[Sanitized verification receipt](evidence/webhook-events-2026-09-26/verification.json) · [Desktop selection](evidence/webhook-events-2026-09-26/desktop-event-selection.png) · [Desktop history](evidence/webhook-events-2026-09-26/desktop-failure-delivery.png) · [Mobile submission](evidence/webhook-events-2026-09-26/mobile-event-selection-submit.png) · [Mobile history](evidence/webhook-events-2026-09-26/mobile-failure-delivery.png).
