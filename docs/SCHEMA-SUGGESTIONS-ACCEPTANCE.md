# W03 field-suggestion acceptance — 13 September 2026

The local W03 source passed **342/342 serial tests**, zero failures, skips or cancellations, in **77.220664166 seconds**, plus packaging/runtime checks and the bounded synthetic provider/browser runs below. It is **not deployed**. Migration 024 is applied and its completed-result constraint verified locally; hosted migrations **021–024 remain unapplied**, and the hosted migration wrapper is prepared but unexecuted. The canonical invite-only preview remains `676a61a`, with free plans and mocked billing unchanged. No customer-use or general extraction-accuracy claim follows.

## Separate provider and browser runs

All live calls used `gpt-5.4-mini-2026-03-17` and a synthetic multi-page invoice. There was **one real suggestion call and one real extraction call** across the evidence below. Replays reused those outputs; counters in replay receipts retain the original calls and must not be read as additional provider requests.

| Local run, UTC | Result | Limits |
| --- | --- | --- |
| 14:02:54–14:03:06 | A UI upload and initial rules run succeeded. The queued suggestion survived reload, then the real provider draft became ready without changing saved fields or existing runs. | The browser run stopped on an assertion after readiness; its failed-run result remains recorded. It did not complete review/save/extraction. |
| 14:04:31–14:04:49 | **12 grouped browser checks passed** using the recorded real suggestion, followed by one real OpenAI extraction. The flow exercised explicit draft review/use/edit/save, schema provenance, new-schema reprocessing, old-run preservation, separate cost display, stale-save 409 and honest provider unavailability/history. | No second suggestion-provider call occurred. This was a controlled suggestion replay followed by real extraction, not a single uninterrupted live-provider flow. |
| 14:06:53–14:07:05 | **14 grouped checks passed on the final UI**, replaying both recorded provider outputs with no new live calls. Invalid, uncommitted allowed-choice input also required replacement confirmation. Cancel/discard, stale-draft preservation and confirmed reload passed. Desktop 1440×1000 and mobile 390×844 layouts fit, with no page errors. | Console observations were the expected signed-out session 401 probe and intentional stale-save 409. Replay proves the UI/data path using recorded outputs, not another live model result. |

The actual extraction result exactly matched the synthetic `invoice-multipage` manifest expectation, including all four line-item rows, and had an empty issue list. This is one synthetic result, not a held-out accuracy evaluation or evidence for arbitrary invoices. Suggestions never auto-save fields, reprocess a source or approve results; the tested reprocessing was explicit and preserved the original run.

| Actual provider result | Prompt | Tokens | Estimated USD cost |
| --- | --- | --- | --- |
| Field suggestion | `folio-openai-schema-suggestion-v1` | 788 input; 0 cached input; 281 output | $0.0018555 |
| Extraction using the saved fields | `folio-openai-extraction-v2` | 1,073 input; 0 cached input; 829 output | $0.00453525 |

These are successful-response token estimates, not provider-bill reconciliation. Suggestion usage is separate from extraction cost and adds no document-page credits; explicit reprocessing follows the existing page-credit rule. Failed, canceled or discarded live calls can incur unrecorded provider charges. Private receipts retain original outputs and exact timestamps; account, resource, provider-response and credential identifiers are omitted from this document.

## Controlled checks and remaining release work

Fourteen adapter tests passed with injected transport, covering request shape, recursive metadata bounds, original PDF/images/native text, safe failures, output/usage validation and cancellation. Eight hosted-worker tests passed after coordinating extraction/suggestion rounds: progress in either queue causes the other to be reconsidered within the same invocation, while shared workspace capacity and FIFO constraints remain enforced. The focused **14 schema-suggestion + 12 AI-worker tests passed 26/26 in 8.757 seconds**, including delayed storage and retention exclusion. `build:vercel` passed after the final runtime/UI fixes; the isolated packaged runtime verifier passed **all six decoder cases, API startup and the preview invitation guard**. A bounded 639-file secret scan found no matches; this is not an exhaustive secret audit.

The local implementation defers scheduled retention while a document has queued/processing extraction or suggestion work and rechecks eligibility under the document lock. Explicit deletion still cascades suggestions; late completion cannot restore them. The dirty marker includes invalid widget input that has not committed to schema fields, so draft replacement cannot silently discard that input. The [architecture contract](ARCHITECTURE.md#field-suggestion-contract) records request replay, quotas, tenant checks, deadlines, leases, schema-version checks and cost boundaries.

The final 342-test suite includes the additional cancellation/retention regressions. Before release, retain current source/package evidence, apply and verify the hosted migrations through the authorized workflow, deploy matching source and verify the canonical runtime. The earlier 310-test/24-browser C04 checkpoint predates W03 and is not its acceptance.
