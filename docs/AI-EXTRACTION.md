# AI extraction contract and evidence

Recorded 7 September 2026. Secure credential setup is complete and the configured OpenAI project has answered real extraction requests on owned synthetic fixtures. The local browser also completed the **AI receipt QA** create/upload/worker/review/approval/JSON/reload workflow after explicit user approval: [exact browser acceptance](AI-BROWSER-ACCEPTANCE.md). The final source passes **160/160 tests** and the build on a stable **185-file** snapshot after the source-disclosure mobile overflow fix. The earlier v1 aggregate passed **145/145 tests**, with a **74/74** iterated synthetic regression result. A subsequently authored independent held-out set measured **49/51** in its untouched first v1 pass; the two French-date failures prompted a narrow date-field instruction change and prompt version **v2**. Its unchanged-input replay measured **51/51**. This replay does not replace the held-out first-pass result, and one successful browser receipt does not establish general accuracy, a production deployment or customer acceptance. All prior evidence remains preserved below.

## Runtime and provider request

The [provider adapter](../server/core/openai-provider.ts) uses the fixed snapshot **`gpt-5.4-mini-2026-03-17`** and current prompt version **`folio-openai-extraction-v2`**, with low reasoning effort. Earlier records retain their actual v1 prompt provenance; the v2 change selects the literal calendar-date component without relaxing normalization. It sends one request to `https://api.openai.com/v1/responses`, requires that exact model in the completed response, sets `store: false`, supplies no tools and rejects redirects. OpenAI documents the snapshot and its API capabilities on the [model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini).

The API and worker entrypoints explicitly create the provider after configuration loads. Importing `buildApp()` or worker helpers does not enable a provider or start queue processing. Tests retain `setExtractionProvider` dependency injection and can exercise unconfigured behavior even when the application has an approved local credential. `GET /api/presets` reports `providers.ai.configured`; this reports configuration, not successful authentication, remaining quota or document quality. Rules mode never calls the AI provider.

All supported inputs include decoded text with one-based page markers. Every PDF additionally sends its original bytes as a Base64 file, including PDFs with native text, because otherwise image-only values within those PDFs could be missed. PNG/JPEG inputs send original bytes as a Base64 image with `detail: high`. Other supported formats—text, HTML, EML, CSV, XLSX and DOCX—send their decoded text. No external document URL or Files API upload is used. OpenAI's [file-input guide](https://developers.openai.com/api/docs/guides/file-inputs) and [image-input guide](https://developers.openai.com/api/docs/guides/images-vision) describe these input mechanisms.

The prompt treats document content as untrusted data and confines parser instructions to extraction. No tool execution or URL retrieval is available. `store: false` is a request setting, not a claim of zero provider retention; the project's provider data controls have not been certified here. OpenAI distinguishes application state from abuse-monitoring retention in its [data-controls documentation](https://developers.openai.com/api/docs/guides/your-data). Local original deletion does not revoke data already sent to a provider or downloaded elsewhere.

## Schema, values and evidence

The adapter builds a strict JSON Schema with every requested key present and `additionalProperties: false` at every object level. Raw scalars are literal strings or null; nested objects and arrays may also be null, and absent tables may be empty. A local recursive validator rejects unknown/missing keys, invalid types and oversized structures after the API responds. This follows the [Structured Outputs contract](https://developers.openai.com/api/docs/guides/structured-outputs), while retaining independent local validation.

Raw values remain separate from normalized values. The server applies existing defaults, trimming/case transforms, numeric/currency/boolean conversion, allowed-choice checks, required-field checks and invoice reconciliation. It does not rewrite raw values to satisfy the benchmark. Calendar dates normalize to ISO dates; unambiguous written month names use the parser locale when its calendar is Gregorian. Unsupported or invalid dates remain available for validation rather than rolling over. Timestamp or timezone conversion is not implemented; saving a timezone does not enable that behavior. See [normalization](../server/core/extraction.ts), [written-date handling](../server/core/written-date.ts) and [schema validation](../server/core/schema.ts).

For `text/csv` only, [decodeCsvRawValues](../server/core/csv-values.ts) prepares normalization input without changing raw output or evidence. A scalar is decoded only if it exactly equals a whole quoted source-cell token; embedded commas/newlines and doubled quote escapes are preserved as cell data. If that same token is also an actual decoded cell value, it is retained to avoid ambiguous double decoding. Whitespace around malformed quoted tokens is not silently repaired. Limits are 30 pages, 512×1024 UTF-16 source characters, 20,000 parsed cells, 10,000 visited values/array entries and recursive record depth eight (root depth zero). Malformed source or any exceeded bound returns all raw normalization input unchanged, with no partial conversion. Nine [pure helper tests](../tests/csv-values.test.ts) passed; the provider now invokes this helper only for CSV before ordinary normalization.

Evidence carries a page, quote and explicit source classification:

| Source | Check and meaning |
| --- | --- |
| `matched-text` | The quote matches the specified decoded page after whitespace collapse. The raw scalar must also occur on that same page. These checks establish page-text presence, not semantic interpretation, field association or an exact bounding box. |
| `model-visual` | A PDF/image quote was supplied by the model and could not be independently matched to native text. The run retains a visual-evidence issue and the UI asks the reviewer to compare the original. This is not independent OCR verification. |
| Missing/invalid evidence | Unknown paths/pages or unsupported quotes are discarded. Present values without retained evidence receive a review issue. A raw value absent from a cited native page receives a source-mismatch issue. |

Every successful extraction enters `needs_review`. Corrections and approvals preserve the original run and its provenance. Approval revalidates current schema values; source-evidence warnings remain review guidance, not an automatic semantic verifier or an enforced image-comparison step. Missing required dates and other schema failures must be resolved before approval.

## Enforced application limits

These are local application limits, not the model's full advertised limits.

| Boundary | Current limit |
| --- | --- |
| Original input | 10 MiB; 30 pages; valid sequential page metadata |
| Decoded page text | 512 KiB, including page markers |
| Generated response schema | 500 fields across nested levels; 100,000 serialized bytes |
| Parser shape | 60 root fields; 30 child fields per object/table; four nesting levels |
| Instructions | Parser route: 8,000 characters; adapter also rejects input over 10,000 |
| Raw output | 65,536 UTF-16 units per scalar in local validation; 1,000 rows per array; 5,000 rows across arrays |
| Evidence | 2,000 submitted items; 2,000 characters per quote; up to 20 retained quotes per field |
| Response | 16,000 output tokens requested; 1 MiB streamed JSON response cap |
| Time | 80-second provider abort deadline; 90-second worker deadline; 120-second job lease |

Authentication/model-access errors, exhausted project quota, refusals, invalid structure, wrong model and hard input/output-limit failures are permanent for that job attempt. Rate limiting, server/network failures and cancellation are retryable up to the durable job maximum. The worker releases its lease, records a safe error and schedules bounded backoff. Shutdown aborts active extraction; late responses after the worker deadline cannot create a run. Job fixtures verify these paths without live provider calls. The decoder subprocess still requires the separate production isolation controls described in [DECODER-RECOVERY.md](DECODER-RECOVERY.md).

## Stored provenance and cost

The job retains its queued schema version, instructions and locale. A successful immutable run records the actual engine/model, prompt version, document digest, raw/normalized values, evidence, issues, response ID and token usage. Usage includes input, cached-input, output, reasoning and total tokens. Reprocessing creates a new run and preserves earlier approvals and byte-identical private originals. Rules retain their existing `folio-extraction-v1` prompt provenance.

Cost is an **estimate for successful recorded responses**. The current calculation uses standard USD rates checked on 7 September 2026: $0.75 per million uncached input tokens, $0.075 cached input tokens and $4.50 output tokens. Reasoning tokens are recorded within output usage, not charged a second time. The rates and snapshot are listed on the [OpenAI model page](https://developers.openai.com/api/docs/models/gpt-5.4-mini). Failed, timed-out or discarded responses may still incur provider charges that are not reconciled into local run costs. Local page quotas and displayed model cost are not a provider billing reconciliation.

## Observed results and verification

The earlier v1 runs in the following table use owned synthetic originals that were iterated to fix written dates and CSV handling. They are synthetic regression evaluations, not independent held-out accuracy tests. The separate first-pass held-out set is recorded afterward. Counts compare expected leaf values, including expected nulls; they are not an accuracy certification or representative customer benchmark.

| Run | Result and retained evidence |
| --- | --- |
| Initial freeform probe, 07:30:29–07:30:33 UTC | One call, 2/4 values. Exposed unsupported written-date normalization and a benchmark case mismatch. [Original report](evidence/openai-evaluation-2026-09-07T07-30-29-792Z.json) remains unchanged. |
| First full run, 07:40:37–07:41:04 UTC | Nine calls, 62/62 values; estimated successful-call cost $0.01351875. Covers native PDF, German dates/decimals, missing fields, EML, CSV, XLSX, DOCX, freeform text and PNG. Malformed PDF was rejected before a provider call. Evidence warnings remain in the [report](evidence/openai-evaluation-2026-09-07T07-40-37-066Z.json), including missing XLSX quotes. |
| Expanded run, 07:46:30–07:46:57 UTC | Twelve calls, **73/74** values; estimated successful-call cost $0.0171525. Added JPEG, image-only PDF and one bounded document-instruction case. JPEG/PDF missing dates stayed null with required-field issues. Visual results retained model-visual warnings. [Expanded report](evidence/openai-evaluation-2026-09-07T07-46-30-870Z.json). |
| Earlier v1 regression after CSV integration, 08:05:38–08:07:05 UTC | Twelve calls, **74/74** values; estimated successful-call cost **$0.017121**. Malformed PDF rejected before a call. Required-field, visual and missing-evidence issues remain; the freeform case took **57.011 seconds**. [Final report](evidence/openai-evaluation-2026-09-07T08-05-38-093Z.json). |

The freeform original says `OAK MARKET`; the historical fixture expected `Oak Market` despite having no title-case transform. The tracked [AI expectation sidecar](../fixtures/ai/expectations.json) corrects this expected value and explains why, while preserving the historical fixture/report. Written-month normalization was a separate source fix. The initial failed report is not erased or reclassified as passing.

The expanded run's CSV merchant value was `"Maple, Supplies"` instead of `Maple, Supplies`: raw CSV container quotes survived into normalized text. That 3/4 case and the aggregate 73/74 remain the recorded result. The bounded source-token normalization fix is integrated, and the original 73/74 report remains unchanged. The v1 aggregate/build passed and its later live CSV case measured 4/4. In that new call the model returned an already unquoted merchant; decoding the earlier quoted-token form is established by controlled helper/provider tests, not inferred from that particular live response. The earlier result is not relabelled as passing. The single document-instruction fixture proves only that this particular input produced its expected receipt values; it does not establish general resistance to prompt injection.

The preceding [135-test output](evidence/openai-tests-results.txt), [test timing](evidence/openai-tests-run.json), [build output](evidence/openai-build-results.txt) and [build timing](evidence/openai-build-run.json) passed before the CSV follow-up. They are not proof for later source. Nine controlled worker tests cover configuration isolation, pinned inputs, provenance, retry/permanent/timeout/shutdown behavior, image bytes and immutable approvals. The v1 aggregate/build/source identity after CSV integration and its twelve-call live evaluation are recorded below. They do not establish test/build coverage for the later v2 prompt change. At this historical checkpoint positive browser AI review/approval/export was pending approval; the later completed workflow is recorded separately in [AI-BROWSER-ACCEPTANCE.md](AI-BROWSER-ACCEPTANCE.md). No browser success is inferred from API evaluation. No Resend inbox, Google account delivery, Stripe provider flow, production deployment or customer-use claim follows from these OpenAI results.


### Earlier v1 verification after CSV integration

- **145/145 tests passed**, 0 failures and 0 skipped, from `2026-09-07T08:05:33.986510Z` to `08:05:56.362225Z`: [timing](evidence/openai-final-tests-run.json), [exact output](evidence/openai-final-tests-results.txt). The controlled aggregate includes the CSV helper/provider regression and worker tests; it makes no real OpenAI calls.
- **Build passed**, exit 0, from `2026-09-07T08:05:56.362826Z` to `08:05:58.008198Z`: [timing](evidence/openai-final-build-run.json), [exact output](evidence/openai-final-build-results.txt).
- **Live evaluation: 12 calls, 74/74 expected leaf values**, from `2026-09-07T08:05:38.093Z` to `08:07:05.124Z`: [report](evidence/openai-evaluation-2026-09-07T08-05-38-093Z.json). This separate real-API command overlapped the controlled test/build run. It retained expected missing fields and review warnings; it was not an automatic approval workflow.

The [source manifest](evidence/openai-final-source-before.json), recorded at `2026-09-07T08:05:12.315635Z`, and [final integrity check](evidence/openai-final-integrity.json) at `08:11:42.443485Z` identify **180** unchanged source/config/test/fixture/public files with SHA-256 fingerprint `8d8b81756ef5e2bd79182997d956feb104cc21936c66f84d339390ec95c6f207`. Documentation and runtime secrets are outside that source identity. Earlier source reports remain historical.

The [credential-boundary check](evidence/openai-key-boundary-check.json) records a configured server credential, environment-file mode `600`, and **172 client files scanned with no credential match**. The approved environment file is Git-ignored. This is a bounded file/output check, not a general secret-scanning certification; no credential value is included in the evidence or this document.

Historical approval checkpoint: the [prepared AI parser form](evidence/ai-parser-pending-approval.png) shows configuration controls only; it was not submitted. At that checkpoint positive browser AI review, approval and actual export evidence were pending. Automatic approval review rejected the preparatory parser-creation action; explicit approval for that browser workflow had not yet been provided. No browser success, deployment, real external integration delivery or customer acceptance is inferred from these completed checks.


## Independent held-out first pass and v2 date guidance

To address the fresh held-out requirement in `BUILD-BRIEF.md`, a separate author created the [new fixture manifest](evidence/heldout-ai-2026-09-07/manifest.json) using only presets, shared types and the package manifest. Its recorded authoring boundary excludes prior extraction code, tests, fixtures, reports, model calls, APIs and database access. The [generator](evidence/heldout-ai-2026-09-07/generate.mjs) and [authoring verification](evidence/heldout-ai-2026-09-07/authoring-verification.json) preserve reproducibility, arithmetic, readable source previews, expected email content and byte-identical duplicate checks. The finalized manifest predates the first model evaluation; expectation values and original bytes were frozen.

The [untouched v1 first pass](evidence/openai-heldout-evaluation-2026-09-07T08-30-01-014Z.json) ran from `2026-09-07T08:30:01.014Z` to `08:30:26.269Z` with the unchanged `8d8b81756ef5e2bd79182997d956feb104cc21936c66f84d339390ec95c6f207` source fingerprint. It made **6 calls** and matched **49/51 expected leaf values**, or **46/47 excluding the duplicate**. The inputs were **five unique valid documents plus one exact duplicate**, with a seventh malformed PDF rejected before a provider call. The duplicate was intentionally submitted as a separate model input and contributes four expected values to the total; this checks repeated extraction behavior, not intake deduplication. Estimated successful-call cost was **$0.01509975**, not reconciled billing.

All 31 values in the new two-page invoice passed. The undated image-only PDF retained a null date and required-field issue; the narrative email preserved its expected paragraph breaks; the English freeform receipt passed. Both mismatches were the same French receipt date in the original and duplicate inputs:

| Input | v1 returned date | Expected normalized date | Preserved outcome |
| --- | --- | --- | --- |
| French image receipt | `2 septembre 2026 à 10:43` | `2026-09-02` | Date validation issue; review required |
| Exact duplicate image | `Achat du 2 septembre 2026 à 10:43` | `2026-09-02` | Date validation and evidence issues; review required |

The model included time/prose in a calendar-date field. Existing normalization did not silently discard it, and schema validation retained an invalid-date issue. The first-pass failures remain unchanged in their original report. This is a small independent synthetic acceptance set with one duplicated case, not customer-document accuracy certification or a broad estimate of model reliability.

The sole application-source change is in [openai-provider.ts](../server/core/openai-provider.ts): prompt version becomes **`folio-openai-extraction-v2`**, and date-field schema guidance asks for the literal calendar-date component, excluding its label, surrounding prose and time of day. It preserves the original date spelling/order and forbids inferring a transaction date from file metadata. Date normalization, validation, source matching, model snapshot and all other extraction bounds remain unchanged.

The [v2 source manifest](evidence/openai-date-source-before.json), recorded at `2026-09-07T08:33:46.050877Z`, identifies **180 files** with fingerprint `a06ef665f30164235af58eae98f8c43286a3f7d19098e0534eb87009842d418c`. The [final v2 integrity check](evidence/openai-date-final-integrity.json) at `08:35:32.901292Z` confirms that source remained unchanged through verification. The held-out originals and expectation manifest have their own hashes in both evaluation reports; documentation/evidence artifacts are outside the 180-file application-source fingerprint.

| v2 check | Exact result |
| --- | --- |
| Controlled aggregate | **145/145 passed**, 0 failures and 0 skipped; `2026-09-07T08:34:07.822735Z`–`08:34:30.062310Z`. [Timing](evidence/openai-date-tests-run.json), [output](evidence/openai-date-tests-results.txt). |
| Build | Exit **0**; `2026-09-07T08:34:30.062749Z`–`08:34:31.623552Z`. [Timing](evidence/openai-date-build-run.json), [output](evidence/openai-date-build-results.txt). |
| Live regression replay | **6 calls, 51/51 expected values**, no unexpected fields; `2026-09-07T08:34:10.311Z`–`08:34:32.484Z`. Malformed PDF rejected before a call; estimated successful-call cost **$0.01604925**. [Replay report](evidence/openai-date-regression-evaluation-2026-09-07T08-34-10-311Z.json). |

Both French dates now normalize to `2026-09-02`, with their model-visual warnings retained. The genuinely absent date remains null with its required-field issue, and all successful results remain `needs_review`. Original bytes and expected values were unchanged for the replay. The original held-out **49/51** report, including both failures, remains immutable.

Because the v2 guidance responds to observed failures, replaying this set is **regression evidence**, not a second independent held-out result. No earlier passing suite or v1 source identity is treated as current v2 verification. The v1 74/74 iterated regression result and all earlier measurements remain historical, not relabelled as v2 results. At this checkpoint positive browser AI review/approval/export was unverified; the later [completed AI workflow](AI-BROWSER-ACCEPTANCE.md) is separate evidence. Other provider/production gates remain unverified.


Historical v2 handoff checkpoint: [v2 runtime](evidence/openai-date-local-runtime.json) confirms HTTP 200 web/API/presets and observed worker startup after tests; [redacted credential check](evidence/openai-date-key-boundary-check.json) confirms mode 600, Git ignored/untracked and no key match across 172 client files. At that checkpoint the AI browser workflow awaited explicit approval; the later completed workflow is recorded in [AI-BROWSER-ACCEPTANCE.md](AI-BROWSER-ACCEPTANCE.md).


## Current review-provenance verification — 7 September 2026

The frontend audit found hidden nested/table source quotes. `ExtractionSources` now renders an immutable original-source disclosure using `rawValues`, the pinned schema and evidence, with original row numbers. Corrected, removed, added or reordered rows do not relabel those original quotes. Review retains its existing page-navigation callback and model-visual/AI-read labels. `RunModelUsage` moved unchanged into a separate component. [REVIEW-PROVENANCE.md](REVIEW-PROVENANCE.md) records the display contract.

The 15 added controlled SSR tests cover extraction sources (**8**), AI onboarding availability (**4**) and run-cost display (**3**). They make no provider, database or browser calls. The source-disclosure checkpoint aggregate passed **160/160**, 0 failures and 0 skipped, from `2026-09-07T09:09:18.914692Z` to `09:09:44.685551Z`: [timing](evidence/review-provenance-tests-run.json), [output](evidence/review-provenance-tests-results.txt). The build passed from `09:09:44.686219Z` to `09:09:46.410534Z`: [timing](evidence/review-provenance-build-run.json), [output](evidence/review-provenance-build-results.txt).

The [source-before record](evidence/review-provenance-source-before.json) and [final integrity record](evidence/review-provenance-final-integrity.json) identify **185 files**, fingerprint `f2bd05a30bd9e4c0f891c6b908e197bd8fd54cbc46f9919563be869c10b002f8`, unchanged at `2026-09-07T09:11:09.186169Z`. The integrity comparison confirms **110 extraction/backend/schema/fixture/config files unchanged** from the earlier v2 AI proof. No new model calls were made during that frontend checkpoint; the prior 145-test, 51/51 regression replay and original 49/51 held-out results retain their original timestamps and scope.

At the source-disclosure checkpoint, browser acceptance was blocked by the locked Mac and AI creation awaited explicit approval. [Passive browser evidence](evidence/ai-passive-browser-check.json) shows the prepared mobile form and desktop Usage before the disclosure change; it does not establish a submitted workflow. The user subsequently unlocked the Mac and explicitly approved creation. [AI-BROWSER-ACCEPTANCE.md](AI-BROWSER-ACCEPTANCE.md) now records completed source comparison, approval, actual JSON download and persisted lifecycle; [REVIEW-PROVENANCE.md](REVIEW-PROVENANCE.md) records the completed disclosure/mobile/keyboard pass. Provider-account and production gates remain separate.

## Final browser and source verification

The final source passed **160/160 tests**, zero failures/skips, from `2026-09-07T17:15:22.744417Z` to `17:16:03.468224Z`; TypeScript/Vite build passed from `17:16:03.469913Z` to `17:16:05.141937Z`. [Test output](evidence/ai-browser-tests-results.txt), [test timing](evidence/ai-browser-tests-run.json), [build output](evidence/ai-browser-build-results.txt) and [build timing](evidence/ai-browser-build-run.json) are preserved. The [final integrity record](evidence/ai-browser-final-integrity.json) identifies **185 files**, fingerprint `d58b8bbac1a945458f955b204da5499273de6ef12531636d809ca11f27f736c4`, unchanged during verification. Only `src/features/documents/review.css` changed from the preceding source-disclosure checkpoint: its table wrapper now contains the absolutely positioned screen-reader label, eliminating the observed mobile page overflow. The [browser acceptance record](evidence/ai-browser-acceptance.json) preserves the one actual synthetic receipt workflow, its recorded successful-run cost estimate and visual-evidence limitations. No model-quality percentage is added from this browser smoke.
