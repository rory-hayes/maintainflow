# Document lifecycle journal

Migration 008 adds a workspace-scoped journal of actual document and export phases. The document list shows the latest document state; the History tab retains the phases that led to it. Existing extraction runs, schemas, corrections and approvals keep their own immutable provenance. Earlier events are not reconstructed from assumptions.

## Intake and processing

Accepted intake inserts the original document as received, creates its durable job, then changes it to queued in one transaction. The journal records both transitions with actual clock timestamps and an internal sequence. The API continues to return the committed queued document; no incomplete intake is published between those steps. Duplicate/rejected intake creates no new document lifecycle.

A database trigger records real processing-state changes: received, queued, processing, needs_review, processed and failed. Reprocess and retry transitions use the same mechanism. An unchanged status does not add a duplicate phase. When available, the operation ID identifies the corresponding job.

## Approved exports

Each valid selected export receives an operation UUID. Events refer to the approval/run and format used by that export. Exporting and exported phases are recorded around rendering and snapshot persistence. This preserves the distinction between exporting a prior approval and reviewing a newer extraction. A historical export does not change a newer needs_review/queued/processing/failed document state.

Export remains a synchronous request. Its start and completion events commit with the immutable snapshot. A savepoint reverts partial export writes on a handled render/persistence failure; the start and failed events commit with a fixed safe explanation, then the API returns the failure. Invalid, unauthorized or unapproved selections rejected before rendering create no export phases. An abrupt process/database loss can roll back the entire uncommitted request; the journal does not claim an asynchronous export queue or crash-recovered attempt.

## Isolation, visibility and deletion

The composite document/workspace foreign key and forced RLS bind every event to its document's workspace. The application role can select/insert events and use the identity sequence, but cannot directly update/delete events. Deleting a document cascades its journal. The migration runner preserves these restricted grants after its broader existing table grants.

GET /api/documents/:id returns a lifecycle array of the newest 200 events, ordered by internal sequence. The sequence is not exposed; public fields are id, phase, state, operationId, createdAt and details. Details are limited to safe reason, format, approvalId and runId fields. The browser labels this recent activity across all runs and retains selected-run provenance below it. Legacy documents may have no lifecycle events until their next operation.

Verification results and browser evidence are maintained in VERIFICATION.md and BROWSER-QA.md after the final source checks.

## Verified local behavior — 6 September 2026

The frozen-source aggregate passed **107/107 tests**, 0 failed and 0 skipped, from `2026-09-06T22:44:24.273055Z` to `22:44:45.209463Z`. This includes **7 document-lifecycle tests** and **6 export-lifecycle tests**. They cover the ordered received → queued → processing → needs_review → processed path; duplicate/no-op handling; distinct reprocess operations; actual no-text failure; atomic rollback; newest-first, bounded public history with the internal sequence hidden; tenant isolation; restricted event mutation; and document cascade deletion. Export cases cover actual rendering, shared operation identity, older approvals with newer review work, rejected selections, handled render/format/persistence failures and removal of snapshots/events on deletion. See [exact aggregate output](evidence/lifecycle-test-results.txt).

The build passed from `2026-09-06T22:44:56.418472Z` to `22:44:58.325104Z`. Migrations 001–008 were applied. The [verification manifest](evidence/verification-lifecycle-run.json) records **169** stable source/config/test/example/fixture/public files and fingerprint `2ab5de77522d89c03f5dd82ce03c0ff634ac6add018978f9a0a1a6c104acb3c4`, unchanged between test start and post-build verification. Its evaluation is separately timestamped: the [frozen deterministic-v2 report](evidence/lifecycle-extraction-evaluation.json), generated at `2026-09-06T22:43:36.744Z`, measured 54/54 supported leaf values and 54/58 across readable synthetic layouts; no AI provider was invoked. Earlier 81/63/50-test evidence remains historical in [VERIFICATION.md](VERIFICATION.md).

After those checks, the real local browser uploaded a synthetic German receipt, reviewed exact values (`Linden Küche`, `2026-09-17`, `EUR`, `1234.56`), approved it without correction and downloaded [the resulting JSON](evidence/approved-locale-receipt.json). [DOM evidence](evidence/lifecycle-browser.json) and the [approved-export screenshot](evidence/lifecycle-approved-export.png) show all seven actual phases, including export start/completion, with selected-run provenance retained. At 390×844, [initial](evidence/lifecycle-mobile.png) and [scrolled](evidence/lifecycle-mobile-scrolled.png) viewport captures show the history and lower details; [DOM measurements](evidence/lifecycle-mobile.json) and [scroll measurements](evidence/lifecycle-mobile-scrolled.json) record a 390-pixel document width. The [console capture after desktop restoration](evidence/browser-console-lifecycle.json) contains no error/warning entries.

These results establish controlled local behavior with synthetic originals. They do not establish an asynchronous export queue, recovery of an abruptly interrupted export transaction, production concurrency/load, live provider delivery, AI/OCR quality or a production deployment. Browser actions are separately recorded in [BROWSER-QA.md](BROWSER-QA.md).

The [final integrity check](evidence/lifecycle-final-integrity.json) at `2026-09-06T22:58:24.484759Z` confirmed the same 169-file source fingerprint and matching test/build/evaluation outputs, frozen evaluation report and downloaded locale JSON hashes.
