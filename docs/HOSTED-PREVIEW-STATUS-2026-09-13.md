# Hosted preview status — 13 September 2026

Folio is live at [maintainflow.io](https://maintainflow.io) as an invite-only preview on the existing free hosting plans, with billing visibly mocked. The canonical revision verified by the provider checks is `e446f6bd74c910c8fafa8b3973239c3e216f1735`. Google Sheets authorization, approved-value delivery, replay without a duplicate row, and refresh after natural token expiry have now passed. Resend setup has progressed, but actual Folio email intake remains unverified.

The [12 September checkpoint](HOSTED-PREVIEW-STATUS-2026-09-12.md) retains the earlier deployment, browser, storage, tenant-isolation and scheduler-recovery evidence. Those dated results have not been rewritten as tests of newer work.

## Current evidence

| Area | Verified scope | Remaining boundary |
| --- | --- | --- |
| Google Sheets | Real consent; synthetic two-page invoice upload and rules extraction; correction and pinned approval; HTTP 200 delivery with native Sheet readback. Explicit replay preserved one data row with no duplicate. | Provider disconnect/revocation and refresh after a runtime restart have not been tested. |
| Google token refresh | The stored access token expired naturally. A new correction and approval triggered delivery, changed the access token, persisted a future expiry, and retained the refresh token. Native readback found the original row plus exactly one new row for revision 2. | The canonical deployment remained unchanged; no restart or expiry-metadata manipulation occurred. |
| Resend | A Full access key, dedicated canonical webhook and synthetic probe to the account's own managed inbox were verified. The private application environment bundle is prepared. | The bundle has not been applied to Vercel; actual signed Folio body/attachment intake, extraction and metering have not passed. |
| API-key expiry | Implemented locally on `codex/api-key-expiry`, based on `e446f6b`; local serial suite **238 passed**, typecheck/build passed and **14 local desktop/mobile browser checks passed**. | Post-fix expiry tests and hosted packaging/runtime checks also passed. Migration 020 is applied and verified; deployment is still required and the canonical runtime does not yet include this feature. |
| Billing and hosting | Existing free hosting plans remain in use. Billing remains mocked. | No real payment or customer-use acceptance is claimed. |

The public-safe [Sheets delivery/replay receipt](evidence/provider-acceptance-2026-09-13/google-sheets-acceptance-public-safe-2026-09-13.json) records the approved values, numeric total and revision comparison, followed by a second complete 26,000-cell readback with no duplicate rows or formula cells. The [natural-refresh receipt](evidence/provider-acceptance-2026-09-13/google-natural-refresh-public-safe-2026-09-13.json) records the later token and row observations. Account identities, Sheet identifiers, application resource identifiers and credentials are omitted. These are synthetic acceptance checks, not evidence of general customer workflows.

## Next release steps

1. Migration 020 is applied and its journal/nullable column verified. Deploy and verify the expiry runtime next. See [API-key expiry](API-KEY-EXPIRY.md), including its rollback constraint.
2. Resolve the two pending exact Resend approvals: transferring the prepared eight settings, including server credentials, to Vercel production; and deleting the unused superseded key. Automatic approval review rejected those actions pending explicit authorization. Neither action has been performed.
3. After the authorized environment update and deployment, run the prepared synthetic body-plus-PDF receiving check through the actual provider webhook, private originals, extraction jobs and usage ledger. Repeat the observation to check for duplicate processing.

Full reference parity and customer use remain unverified. The historical callback mismatch is resolved for the tested Google flow; it is retained in the earlier checkpoint as a record of the original blocker.
