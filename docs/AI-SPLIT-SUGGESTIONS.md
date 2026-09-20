# Reviewed AI split suggestions

Folio can propose document boundaries for a newly uploaded or stored PDF or TIFF. Stored sources include ordinary documents, ZIP leaves and earlier split children. The user requests a suggestion, reviews every page, explicitly applies the proposed ranges, edits them if needed, and explicitly creates the documents. A proposal alone creates no documents, extraction jobs or page-credit charges. Manual fixed groups, custom ranges and PDF text markers remain available.

The original PDF, including scanned pages, is supplied to the configured AI provider. TIFF uses the verified PDF rendering of all original TIFF pages; it does not send a thumbnail or replace the archival TIFF. The UI discloses this before requesting a suggestion. The production adapter uses OpenAI Responses with `store:false`, the pinned `gpt-5.4-mini-2026-03-17` model, a strict output schema and no tools. These settings do not establish zero data retention or model accuracy. [OpenAI file inputs](https://developers.openai.com/api/docs/guides/file-inputs) · [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## Boundaries and review

The model returns only an ordered list of starting page numbers. The first start must be page 1; every start must be distinct, within the verified source page count and greater than the previous start. The server derives each end from the next start, with the final group ending at the last source page. A proposal therefore covers every page exactly once. Invalid output, refusals, incomplete responses and unsupported response shapes do not become usable ranges. Uncertain continuity can remain one document; the application does not invent confidence scores.

Applying a proposal fills the custom-range editor. It does not submit a split. A later suggestion never silently overwrites manual edits. Confirmed custom ranges may deliberately omit pages under the existing split rules, with the selected-page charge and omissions displayed before Create. The receipt preserves both the original proposed starts and the final confirmed ranges.

The existing isolated PDF/TIFF split engine revalidates the source and creates the children. TIFF children retain encoded TIFF image data under the existing lossless codec's compatibility limits. Originals, immediate-source and cumulative root-page references, earlier approvals and original-only exports retain their existing semantics. Stored-batch undo removes that batch and exports containing its removed children; used page credits are not refunded. See [TIFF splitting](TIFF-SPLITTING.md) and [stored PDF splitting](STORED-PDF-SPLITTING.md).

## Durable jobs and exact recovery

Migration `036_split_suggestions.sql` adds private requester-owned draft jobs, separate from document extraction, and durable AI provenance on split receipts. A job binds the workspace, parser, requester, source SHA-256, MIME type, expected bytes and original document identity when applicable. Credential hashes remain server-side; plaintext credentials, private object keys and signed URLs are omitted from the public DTO.

Fresh uploads use either multipart intake or a signed staging reservation. Signed staging and the immutable verified source copy have different keys. The reservation precedes any private copy write, and finalization verifies byte length, hash and actual format. Retrying the original request recovers the same job. A signed URL's cleanup reservation survives cancellation and lost responses until its validity plus cleanup buffer ends.

Worker execution checks current membership, session/API-key validity, required scopes, parser state and format policy before provider work and before committing a proposal. Stored source changes or removal suppress late results. The shared worker capacity and FIFO order include extraction, field suggestions and split suggestions. Automatic account email has its own lane.

Create binds a separate stable UUID to one canonical selection before source I/O. Source checks, quota checks, documents, extraction jobs, usage and the accepted suggestion/receipt linkage are fenced and committed atomically. Concurrent retries can recover only that batch. A different source, selection or creation flow cannot adopt the bound UUID. Quota and temporary failures retain the exact request for retry. Durable decoder rejection closes the draft; a new manual split uses a new UUID.

The client saves only scoped recovery identifiers, hashes and confirmed options. It verifies the current actor and source when recovering. Status reads do not enqueue work. An unknown Create remains frozen until a matching receipt or an authoritative closed-job response resolves it. That response uses the same workspace lock as final acceptance, so a late request cannot commit after the server has reported that creation is closed. Accepted receipts and AI provenance survive draft-source expiry, source removal and batch undo.

## Limits and retention

| Limit | Value |
| --- | --- |
| Source | One PDF or TIFF, at most 10 MiB and 30 pages |
| Proposed groups | At most 20 |
| AI requests | 10 per workspace in the last 24 hours, shared with field suggestions |
| Pending AI drafts | Three per workspace, shared with field suggestions; uploading drafts count |
| Automatic attempts | Three; retryable transport failures use bounded backoff |
| Claimed-attempt processing budget / provider request | 90 seconds / 80 seconds; queue wait, lease recovery and failure bookkeeping are outside the processing budget |
| Provider response / native text | 1 MiB / 512 KiB |
| Maximum output tokens | 4,096 |
| Private suggestion source access | Expires 24 hours after request reservation; physical cleanup follows asynchronously after active leases end. Cancellation makes the source eligible for earlier cleanup |
| Temporary upload storage | Shared 250 MiB reservation budget, including source copies, signed staging and split/archive write intents |

Sources and signed staging continue to consume reserved bytes until physical removal succeeds. Interrupted operations retain a finite lease, and cleanup skips active leases. This is not a guarantee against arbitrarily late operations in an unbounded storage adapter. Draft metadata remains for result recovery. The backup object inventory includes immutable suggestion sources and any present staging objects; recovery metadata and receipt provenance are included in the database backup.

Model token usage and estimated standard USD token cost are retained as provenance. They are not page-credit charges or a provider billing reconciliation. Free-plan settings and mock billing remain unchanged.

## Verification boundary

The same 317-file source passed **763/763 serial tests**, **11 desktop/tablet/mobile browser groups**, production build and packaged native runtime checks, and an isolated encrypted backup/restore drill with **11 groups and 21 restored-runtime assertions**. All 20 browser frames were individually reviewed. Browser and restore fixtures made zero real provider calls and cleaned their owned data. [Local evidence](evidence/ai-split-suggestions-2026-09-20/verification.json) · [Source manifest](evidence/ai-split-suggestions-2026-09-20/source-manifest.json).

This increment uses synthetic local files, controlled AI responses and local database/storage verification. Actual model boundary quality, live provider billing, live signed object storage, hosted migrations and the canonical domain require separate evidence. Hosted migrations **021–036** and matching runtime activation remain pending. The full 47-criterion capability matrix remains in scope; broader archive formats remain a C10 gap.
