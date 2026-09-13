# PDF splitting acceptance — 13 September 2026

**Node 24.13.0** local acceptance passed: **434/434 serial tests** in **131.790 seconds**, with zero failures, skips or cancellations; **15/15 controlled desktop/mobile browser groups** and build/package/runtime checks passed on **217 unchanged source files**, fingerprint **`f8f0bc647d95a9de6147053558fb346578150f4dd40f6406ab991791c3b234a6`**. The first failed Node 24 CI run and earlier Node 26 checkpoint remain recorded below. Git/CI and hosted release are separate.

Migration [027](../migrations/027_pdf_splitting.sql) is applied locally only. Hosted migrations **021–027** and the corresponding runtime release remain pending. Existing free plans and visibly mocked billing remain unchanged. This record establishes no new live-provider, hosted or customer-use acceptance.

## Implemented workflow and limits

An authorized editor can split a newly uploaded PDF for an active, ready parser that accepts PDF input. The user chooses either a fixed number of pages per document or explicit page ranges. The server checks the actual PDF and constructs the accepted children; the local PDF.js preview does not authorize a page count, type or quota decision.

Ranges are one-based, inclusive, ordered and nonoverlapping. They may omit pages, and a single resulting document is valid. Fixed-size groups cover the source in order, with a shorter final group when necessary. Each accepted child becomes an independent document with its own immutable PDF, job and review lifecycle. Extraction uses the ordinary configured worker path. Approval and export remain explicit, independent actions for each child.

| Bound | Implemented limit |
| --- | --- |
| Uploaded source | PDF, at most 10 MiB and 30 pages; current workspace file/page limits also apply. |
| Output count | At most 20 documents per accepted split. |
| Derived files | At most 10 MiB per child and 20 MiB combined. No silent truncation or dropped child. |
| Decoder text | Existing 2 MiB text bound. |
| Decoder execution | Shared ordinary/split concurrency of two per runtime and a 30-second deadline. Compiled JavaScript retains a 192 MiB heap; TypeScript/TSX source execution uses 256 MiB for loader/compiler overhead. The subprocess is a resource boundary, not an OS sandbox. |
| Decoder output transport | Explicit 42 MiB split-response cap; ordinary decoding retains its 4 MiB cap. |
| Intake work | Two active split attempts per workspace; at most two concurrent object writes per attempt; 120-second attempt budget, including elapsed direct-upload claim/read time. |
| Temporary storage | Existing 250 MiB reservation budget includes split write reservations. Failed or uncertain split writes retain their reserved bytes until removal succeeds. |

The [shared planner](../shared/pdf-split.ts), [isolated split engine](../server/core/pdf-split-engine.ts), [intake transaction](../server/core/pdf-split-intake.ts) and [receipt/lineage readers](../server/core/pdf-split-records.ts) define the current contract. This implements fixed-size and custom-range splitting only. Keyword/AI boundaries, TIFF splitting, archive expansion, and resplitting or reversing an existing document remain outside this slice. The original C10 criterion and all 47 capability IDs remain intact.

## Acceptance, metering and request recovery

The server stores the shared original and all derived PDFs through tracked write intents, then accepts the batch in one transaction. Workspace and parser locks serialize the decision with current quota, parser settings, schema and template changes. Every child receives the same commit-time schema/configuration snapshot, including the current template-selection policy. The transaction creates all child identities, jobs, upload usage and bounded audit events together. A failed quota, schema, insertion or audit check cannot leave a partly accepted batch.

Only selected pages consume upload credits. For example, selecting pages 1 and 3–4 from a four-page source charges three pages across the two resulting documents. Omitted pages and the retained source container add no separate processing charge. There is no automatic schema-discovery request, reprocessing charge, approval or export caused by splitting.

The request UUID identifies one operation within the workspace and binds the source-byte SHA, parser and canonical submitted specification. Canonicalization removes irrelevant JSON property ordering while preserving the selected mode and values. Reusing the same binding returns the stored accepted or rejected outcome before decoding, writing or charging again. A changed binding returns 409. A new request UUID is an explicit new charged split; cross-request content deduplication is not claimed.

Derived documents retain their actual PDF-byte SHA. Equal-byte children can still have different range/document identities, and neither aliases an ordinary uploaded document. Ordinary uploads retain their existing byte-deduplication behavior within the ordinary-document subset. Split receipts use their own tables and do not change ordinary accepted/rejected/deleted `intake_events` receipts.

Accepted receipt metadata survives document deletion. Replay reports each child's availability without recreating deleted documents or charging again. Receipt lookup remains available for an archived parser. The public response includes batch/document identities, names when retained, page ranges and availability; it does not disclose storage keys, hashes, lease owners or extracted values.

| API | Contract |
| --- | --- |
| `POST /api/parsers/:id/pdf-splits` | Exactly one multipart file, request UUID and split-options JSON; returns 202 with the ordered receipt. |
| `POST /api/parsers/:id/uploads` | Optional `pdfSplit: {requestId, options}` is persisted with the signed-upload reservation. |
| `POST /api/uploads/:id/finalize` | Existing empty body. Verifies staged bytes and dispatches using the saved spec. Split acceptance and completed-reservation identity commit together under the finalize-owner/lease check. |
| `GET /api/parsers/:id/pdf-splits/requests/:requestId` | Read the owned receipt, including archived-parser recovery and deleted-child availability. |
| `DELETE /api/pdf-splits/:id` | Atomically purge live group metadata and queue object cleanup; report `pending`, `failed` or `complete` without storage/network calls in this route. |

Create/delete require an owner, admin or editor with `documents:write` for API keys. Receipt and original reads require `documents:read`. Session origin checks, tenant isolation and the ordinary authorization path remain in force.

An interrupted signed PUT can use a fresh staging reservation with the **same** split request UUID, source and specification. Matching reservations do not consume an extra provisional page allowance, so recovery works at the final remaining credit. Changed bindings retain the normal provisional quota treatment. Every physical staging reservation still counts toward active-upload and temporary-byte limits; final acceptance rechecks selected-page usage. The accepted shared original is a separate server-written immutable object, never the object addressed by the upload capability.

The implemented UI preserves the pending request identity across uncertain responses and reloads without storing PDF bytes or signed URLs. A deliberate new operation requires an explicit start-new action. The final browser checks below verify those controls with owned synthetic fixtures.

## Original retention, deletion and errors

The full uploaded original includes omitted pages. It also continues to contain the pages of a deleted child while any sibling remains. The split and deletion UI disclose that shared-source retention; deleting one child must not be described as erasing its pages from the retained bundle. Child-local evidence uses rebased page numbers with original-page lineage available separately. Existing child-original routes return the derived PDF; bundle-original routes require a currently live owned child with document-read authorization.

Deleting the last child, deleting the group or expiring the retained children queues shared-original removal and clears retained filename/storage-pointer metadata. Minimal request and child-identity receipts remain for replay. A queued removal is not confirmed physical deletion. Whole-group delete retries inspect cleanup state for every durable child key plus the original source key: any failed removal takes precedence, pending work remains pending, and an empty queue reports complete.

Both filesystem and remote reconciliation recognize retained shared originals. A failed/uncertain write releases its active-attempt slot but keeps its byte reservation until successful physical removal; repeated failures therefore cannot free the same budget repeatedly. Potentially late writes retain delayed cleanup. Unattempted and already adopted writes release their temporary intents. After an uncertain COMMIT acknowledgement, cleanup checks committed document/source references before deciding an object is unreferenced.

Finite, application-owned source-validation, PDF-split and PDF-policy errors produce safe durable rejection decisions once complete input reaches the intake boundary. Malformed request shapes fail before acceptance. Decoder busy/start/crash/timeout/invalid-IPC outcomes, arbitrary lookalike status codes and storage failures remain retryable. Rejected or rolled-back acceptance creates no document jobs or page usage. An uncertain response can follow a committed batch, so recovery must reuse the request UUID. Audit/rejection metadata uses bounded identities, counts and fixed reasons rather than source text, filenames, provider diagnostics or extracted values.

## Node 24 compatibility verification

The final local follow-up used the official **Node 24.13.0** macOS arm64 runtime throughout. All phases below identify the same 217-file source fingerprint **`f8f0bc647d95a9de6147053558fb346578150f4dd40f6406ab991791c3b234a6`**, unchanged during each phase. The suite's test-run duration is distinct from its 131.961133916-second orchestration wrapper.

| Layer | Result | UTC interval / boundary |
| --- | --- | --- |
| Full serial suite | **434/434 passed**, **131.789766083 seconds**; zero failures/skips/cancellations | **20:40:56.017537–20:43:07.980091** |
| Production build | **Passed**, **2.030687459 seconds** | **20:41:18.494586–20:41:20.525300** |
| Packaging | **Passed**, **5.398825167 seconds** | **20:41:44.713851–20:41:50.112736** |
| Packaged runtime | **Passed**, **4.633947 seconds** | **20:42:07.723765–20:42:12.357767**; six ordinary decoders, actual split/derived-PDF decoding, API startup and preview invitation guard. Both ordinary/split compiled launch arguments assert 192 MiB and no TSX loader. |
| Controlled browser | **15/15 grouped checks passed** | **20:43:24.759–20:43:46.699**; desktop/mobile, zero provider calls or page errors and all owned fixtures cleaned. |

The focused Node 24 renderer check passed **4/4** in **1.522296083 seconds**, executing the transformed installed modern main with the upstream legacy worker compatibility shims in Node's fake-worker realm. The actual browser check separately uses the application's modern main/worker pair. These local results do not replace the Linux CI rerun, hosted migration approval or deployment acceptance.

## Initial Node 26 local verification

The earlier **Node 26.5.0** checkpoint used 217 files with fingerprint **`707706f938f479fc34caf5fb4eb8f1f46f62965d74b44a9e6b660bbea5fbdc3e`**. Its counts, timings and 15-group browser pass remain historical evidence for that source.

| Layer | Result | Evidence boundary |
| --- | --- | --- |
| [Decoder/planner tests](../tests/pdf-split-decoder.test.ts) | **10/10 passed**, **12.356235542 seconds** | Controlled PDF planning, derived-output and isolated decoder/resource checks. |
| [Intake/API tests](../tests/pdf-split-intake.test.ts) | **15/15 passed**, **18.889343625 seconds** | Owned local database and controlled storage; no provider requests. |
| [Lineage/cleanup tests](../tests/pdf-split-lineage.test.ts) | **11/11 passed**, **1.223866417 seconds** | Owned receipts, read/delete isolation, retained-original reconciliation and cleanup accounting. |
| [Renderer regressions](../tests/pdfjs-render-errors.test.ts) | **4/4 passed**, approximately **0.894 seconds** | Transformed installed browser module and real worker; concurrent rejection, same-page retry, valid rectangle/image pixels and version/branch guard. |
| Full serial suite | **434/434 passed**, **129.740819709 seconds** | Zero failures, skips or cancellations on the final recorded 217-file source. |
| Production build | **Passed**, **1.643461625 seconds** | Local compilation/frontend build. |
| Packaging | **Passed**, **5.395301875 seconds** | Local deployment artifact creation. |
| Packaged runtime | **Passed**, **5.092490291 seconds** | Six ordinary document decoders, actual PDF splitting and derived-PDF decoding, API startup and preview invitation guard. |

The intake cases cover selected-page charging, coherent job snapshots, equal-byte child identities, canonical replay/tombstones, safe typed rejection, simultaneous duplicate/quota contenders, parser changes during writes, atomic audit rollback, lost COMMIT acknowledgement, late writes, direct-upload fencing, multipart/role/scope/origin/tenant boundaries, asynchronous group-delete status, active-attempt limits, failed-write byte-budget exhaustion/recovery and interrupted-PUT recovery at the last page credit.

The unchanged frontend retains its earlier Vite development-transform proof at 20:10:23 UTC: the configured pre-transform applied the compatibility fix, dependency optimization did not bypass it, and no HTTP/WebSocket server listened. Environment-file loading was disabled.

These are controlled fixture and packaged-execution results. They do not establish broad PDF rendering fidelity, general extraction accuracy, new live-provider behavior or hosted operation.

## Browser acceptance

The final Node 24 run from **2026-09-13T20:43:24.759Z** to **2026-09-13T20:43:46.699Z** passed **15/15 grouped checks** on desktop 1440×1000 and mobile 390×844. Canvas readiness was checked after actual rendering and pixel readback; reviewed screenshots and measured document/body widths showed no horizontal overflow. No page errors or external requests occurred, and all owned accounts, workspaces and stored fixtures were cleaned up.

The workflow covers fixed-size groups and remainder pages, rejected reversed ranges, custom selections and omitted-page/credit disclosure, keyboard tabs, guarded pending submission, actual child PDFs and unchanged full original, ordinary template extraction, original-page lineage, explicit approval and exact mapped CSV bytes, deleted-child receipt replay, whole-batch cleanup, signed-upload failure/reselection/reload, a deliberately lost accepted finalize response, starting a new split during a held PDF load, unchanged ordinary upload behavior, role/format/setup restrictions and desktop/mobile help. Six accepted upload ledger entries total **13 pages**, with **zero extraction or suggestion provider calls**. The split source container is not charged separately.

An oversized embedded-image fixture exposed an installed PDF.js operator-stream error-propagation bug: the worker rejected the image, but the display layer resolved a blank render. The guarded browser-build transform now propagates that failure. The final browser check verifies a visible safe error, no ready/partial canvas, disabled creation and recovery after selecting a valid PDF. This is bounded failure handling, not a guarantee that every malformed PDF or image is detected.

The earlier Node 26 complete browser run at **20:07:05.303–20:07:28.211 UTC** also passed **15/15 groups**, and remains separate from the Node 24 run above. Earlier stopped attempts remain separate: fixture initialization before any account setup; the real preview error; a browser-context harness error after eight groups; and expected fake-transfer cancellation accounting after thirteen groups. A separate 14-group workflow pass explicitly left the preview guard pending. Only the two explicitly dated 15-group runs count as complete browser acceptance at their respective source/runtime checkpoints. Expected console/network observations are the signed-out 401, missing-receipt 404s, controlled failed-transfer/finalize responses, deliberately lost response, navigation/completed-intercept cancellation events and test-only canvas-readback notice. Signed storage was intercepted into owned local files, and a controlled non-throttling limiter was used; neither live object-storage nor rate-limit acceptance follows.

The [public-safe receipt](evidence/pdf-splitting-2026-09-13/verification.json) records source identity, times, counts and limits. Raw account identities, cookies, signed URLs and private fixtures are excluded.

## CI and release

The first GitHub CI run, **34780126331** on Linux **Node 24.13.0**, passed **411/434 tests** and failed **23**. This exposed two separate compatibility issues: TypeScript/TSX split-decoder execution exhausted the former 192 MiB source heap, and the Node renderer harness used the modern worker without the upstream `Uint8Array.toHex` compatibility shim. The source child now receives 256 MiB while compiled JavaScript retains 192 MiB. The Node-only harness uses the installed legacy worker with the transformed actual modern browser main; the application still uses its modern browser main/worker pair. CI and the deployed runtime requirement remain Node 24. The subsequent local Node 24 suite/build/package/runtime and browser checks passed as recorded above. Linux CI and final integration checks must still be verified on the corrected head; the earlier Node 26 pass does not establish them.

The review request records the exact Git candidate and its separate CI results. The [public-safe local receipt](evidence/pdf-splitting-2026-09-13/verification.json) identifies the tested application files; that fingerprint is not a deployment identity. This feature is stacked on parser-copy PR29. CodeQL must be verified on the final integration head before the stack is merged; local tests and a Vercel preview check do not establish that result.

Migration 027 is local only; hosted **021–027** and their matching release remain pending. The prior canonical sign-in release, existing free hosting plans, mock billing and previously recorded provider boundaries are unchanged by these local checks. No deployment, plan upgrade, real payment test, customer use or complete C10/reference-product parity is claimed.
