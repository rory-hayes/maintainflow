# AI-assisted first-document setup acceptance — 13 September 2026

The local implementation adds an explicit “Set up with a sample” choice. The first accepted sample discovers and saves initial fields, then runs extraction using the original upload reservation. Preset creation remains the default. Extracted results still require review and explicit approval/export. This closes the manual detour in the earlier [field-suggestion checkpoint](SCHEMA-SUGGESTIONS-ACCEPTANCE.md), which remains separately recorded.

The final local source passed **355/355 serial tests**, with zero failures, skips or cancellations, in **82.639557625 seconds**. Thirteen focused setup regressions passed in **5.301475042 seconds**. Typecheck, `build:vercel`, six isolated packaged decoders, API startup and the preview invitation guard passed. Migration 025 applied to the guarded local PostgreSQL database (16 migrations in public). The earlier 342-test/14-browser-replay checkpoint remains historical manual-suggestion evidence.

The first aggregate run failed to import the new CSS from the server-rendered onboarding fixture. Moving that stylesheet to the browser entry point fixed the import; all four existing availability cases and the final aggregate then passed. No component test was removed or disabled.

## Separate provider and browser evidence

| Run, UTC | Verified result | Boundary |
| --- | --- | --- |
| Live provider run, 14:59:55–15:00:26 | Explicit sample creation and awaiting/processing states survived reload. One original write/reservation created one two-page upload charge. One real suggestion automatically saved schema v2 and released the original job. One real extraction matched every expected synthetic manifest value, including four line items, with no issues and no automatic approval/export. | The script then explicitly approved the result but stopped on an overly strict export-format test selector. Export completion is not claimed for this run. |
| Recorded-result browser follow-up, 15:01:21–15:01:35 | **10 grouped checks passed**: creation, reload, held jobs, automatic initial schema, extraction comparison, rendered original PDF, explicit approval and matching JSON download/reload, failed-sample retry, manual override and unavailable-provider fallback. Desktop 1440×1000 and mobile 390×844 fit. | Replayed this feature run's two recorded provider outputs, with **zero new live calls**. Three additional canned suggestion calls exercised recovery; no canned extraction ran. No page errors occurred; console observations were the normal signed-out 401 and a test canvas-readback performance notice. |

The follow-up compared the untouched normalized extraction to the synthetic manifest using explicitly recorded field-key/label aliases, then compared downloaded JSON bytes with the approved run. It retained one original job, one upload usage event and two pages, with no reprocess charge. Approval and export counts remained zero until the explicit user actions. All owned local accounts/documents/storage were cleaned up after each run.

| Actual successful provider response | Model / prompt | Tokens | Estimated USD cost |
| --- | --- | --- | --- |
| Field discovery | `gpt-5.4-mini-2026-03-17` / `folio-openai-schema-suggestion-v1` | 788 input; 0 cached; 307 output | $0.0019725 |
| Initial extraction | `gpt-5.4-mini-2026-03-17` / `folio-openai-extraction-v2` | 1,116 input; 0 cached; 872 output | $0.004761 |

These are successful-response estimates, not reconciled provider billing. The source is a small synthetic invoice already used in previous evaluation; this is workflow acceptance, not new held-out accuracy evidence. The prior manual-suggestion live calls are separate historical operations. Private receipts retain exact source/schema fingerprints, outputs, timestamps and local operation identifiers without adding credentials to tracked files.

## Persisted behavior

- Setup states and source identity survive reload. Initial jobs stay unclaimed until fields are ready.
- First upload, initial job, one page reservation and suggestion request commit atomically. Rejected/duplicate/replayed uploads create no extra discovery or page charge.
- Successful discovery saves the immutable schema, records suggestion provenance, releases original jobs and writes audits in one transaction.
- Terminal failures remain visible. Retry can choose another accepted sample and retains original page credits. Suggestion request limits still apply.
- Manual field saves take precedence over late discovery. Deleting the current source clears its pointer and allows replacement; late workers cannot restore deleted work.
- Workspace, tenant, role, API-scope, origin, lease and schema checks guard state changes. Worker claims leave busy workspace operations untouched.

The [architecture contract](ARCHITECTURE.md#ai-assisted-first-document-setup) describes the endpoints, limits and transactional boundaries.

## Release boundary

Migration 025 is local only. Its ignored hosted SQL wrapper is prepared for review, not executed. Hosted migrations 021–025 and matching runtime releases remain pending. The canonical invite-only preview remains sign-in revision `676a61a`; free hosting plans and mocked billing are unchanged. Existing Google acceptance belongs to earlier `e446f6b`. Actual Folio Resend intake, real Stripe, full reference parity and customer use are not established by this feature.
