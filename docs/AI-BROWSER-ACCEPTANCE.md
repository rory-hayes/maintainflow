# AI receipt browser acceptance

Recorded 7 September 2026 against the local Folio application at `http://127.0.0.1:5178`. After the user confirmed the Mac was unlocked and explicitly approved creation, the browser completed the prepared **AI receipt QA** workflow: create receipt parser with AI selected → upload the owned synthetic `fixtures/generated/receipt-scan.png` original → wait for the durable worker's real OpenAI extraction → compare all four values with the displayed receipt → approve revision zero without a correction → download JSON → reload the document and inspect history.

[Machine-readable acceptance](evidence/ai-browser-acceptance.json) preserves the browser assertions and artifact identity. The earlier automatic approval rejection and locked-Mac checkpoints are preserved in [BROWSER-QA.md](BROWSER-QA.md). They are resolved for this workflow. This is one local synthetic image acceptance result; it does not expand the independent held-out accuracy evidence or verify a customer document, other provider account, production deployment or billing reconciliation.

## Persisted identities and approved bytes

| Record | Value |
| --- | --- |
| Parser | `93b86395-d048-46a9-9f0a-bdf1cf85b610` — AI receipt QA |
| Document | `336b6eb6-8711-4433-afea-9e177bc8aea3` — receipt-scan.png |
| Extraction run | `2a371ebe-dc87-4105-bf2f-f92122ccd640` |
| Approval | `fff66561-22d0-4329-a5f9-457e1c217ea2` |
| Revision / correction | `0` / `null` |
| Actual downloaded JSON | [approved-ai-receipt.json](evidence/approved-ai-receipt.json), **455 bytes** |
| Download SHA-256 | `31922323562ed82feaa9c679c20ea7081c95c5f841bd1389cbc3ffc8682f949f` |

The downloaded approved values are Merchant **Birch Bakery**, Date **2026-08-25**, Currency **EUR** and numeric Total **18.6**. The review preserved raw Total **18.60** separately. The original receipt was visible during comparison; the UI retained its global image-comparison warning and per-field **AI-read source · Page 1** labels. These quotations are model-read evidence, not independently verified native text. [Review DOM](evidence/ai-browser-review.txt).

## Worker provenance, lifecycle and usage

The selected run displays engine `openai`, model `gpt-5.4-mini-2026-03-17`, prompt `folio-openai-extraction-v2`, **1,021 input tokens**, **180 output tokens** and displayed estimated model cost **$0.001576**. The pre-approval history records the real intake and worker phases: [DOM](evidence/ai-browser-history-before.txt), [screenshot](evidence/ai-browser-history-before.png). The processing state is also retained in [the intake screenshot](evidence/ai-browser-processing.png).

Reload shows **Run 1 · Approved** and **Exported**, with seven actual lifecycle entries: Received, Queued, Processing, Ready for review, Approved, Export started and Export completed. Export entries identify JSON and the approved revision context; selected-run metadata remains visible below the lifecycle. [Reloaded history DOM](evidence/ai-browser-reloaded-history.txt), [screenshot](evidence/ai-browser-reloaded-history.png).

The Usage screen shows **39 / 1,000 pages**, **8 documents stored**, **3 needing review**, **1 failed document** and **$0.0016 estimated model cost**. Its latest ledger entry is this document's one-page upload. The page explicitly limits estimates to recorded successful runs and notes that failed/canceled attempt charges may be absent. [Usage DOM](evidence/ai-browser-usage.txt), [screenshot](evidence/ai-browser-usage.png). These observations are not a reconciliation of the OpenAI bill.

## Separate verification boundaries

The final source passed **160/160 tests**, zero failures/skips, from `2026-09-07T17:15:22.744417Z` to `17:16:03.468224Z`; TypeScript/Vite build passed from `17:16:03.469913Z` to `17:16:05.141937Z`. [Test output](evidence/ai-browser-tests-results.txt), [test timing](evidence/ai-browser-tests-run.json), [build output](evidence/ai-browser-build-results.txt) and [build timing](evidence/ai-browser-build-run.json) are preserved. The [final integrity record](evidence/ai-browser-final-integrity.json) identifies **185 files**, fingerprint `d58b8bbac1a945458f955b204da5499273de6ef12531636d809ca11f27f736c4`, unchanged during verification. Only `src/features/documents/review.css` changed from the preceding source-disclosure checkpoint: its table wrapper now contains the absolutely positioned screen-reader label, eliminating the observed mobile page overflow. The earlier 09:11 source-disclosure checkpoint remains historical. [REVIEW-PROVENANCE.md](REVIEW-PROVENANCE.md) records the completed table-source desktop/mobile/keyboard acceptance and the deeper structures covered only by controlled tests.

Resend receiving, Google Sheets and Stripe test Checkout/portal still require the exact account configuration and acceptance described in [RELEASE-GATES.md](RELEASE-GATES.md). No new model-quality percentage follows from this successful browser receipt.


After the final test/build run, the API, worker and Vite services were restarted. Browser reload again showed **Run 1 · Approved**, **Exported** and the same four values. The final 1280×720 viewport had a 1280px document width and no captured browser warning/error entries. [After-restart DOM](evidence/ai-browser-after-restart.txt), [screenshot](evidence/ai-browser-after-restart.png), [acceptance record](evidence/ai-browser-acceptance.json).

The current [redacted runtime/configuration check](evidence/ai-browser-runtime.json), recorded `2026-09-07T17:19:42.405Z`, confirms web/API health/presets HTTP 200, observed worker startup and OpenAI configuration. Required Stripe test, Resend and Google OAuth settings remain absent, with Resend inbound disabled. No credential values were printed.
