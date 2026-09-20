# Native PDF region templates

Folio can save scalar-field regions from a searchable PDF and match them against another PDF whose labels and values have moved together. Choose a retained PDF, select an exact anchor, draw a value region or enter its coordinates, then explicitly preview the unsaved draft. The preview shows exact captured text, normalized values and validation issues. Saving a template affects future extraction jobs; applying it to an existing document requires explicit reprocessing.

This implements the native-text subset of X07. Image-only pages, OCR, repeating tables, deskew, changing page sizes and automatic layout scaling remain outside this increment. All 47 original capability criteria remain in scope.

## Coordinate and matching contract

Server-side PDF.js geometry supplies normalized top-left coordinates for the displayed crop box, including page rotation and UserUnit. Supported page rotations are 0, 90, 180 and 270 degrees. Each rule records the fixed page number, reference width/height/rotation and the value region's offset from a unique anchor. Reference page dimensions must match within 0.01 points. The same anchor/value translation is supported; scaling or independent layout changes are not inferred.

Anchors match literal, case-sensitive text with normalized whitespace. An anchor may occur within one native text block or across blocks, but its rectangle always contains the complete participating blocks. Repeated or overlapping occurrences are ambiguous. These are PDF text/font-metric rectangles, not invented character or ink bounds. Values capture complete native blocks in PDF.js reading order; a box that cuts a block is rejected. The interface shows the full anchor block and exact captured text so the user can check this behavior before saving.

Unsupported independently rotated, skewed, mirrored, vertical or right-to-left text marks that page unsupported. Missing/ambiguous anchors, changed page geometry, partially enclosed blocks, out-of-page regions and missing values produce explicit match reasons. Ordinary nonmatches can use the parser's existing fallback; decoder, source-integrity and processing failures do not silently invoke AI.

## Saved definitions and extraction history

Templates distinguish `text-v1` and `native-pdf-region-v1`, with stable identities and increasing revisions. Enabled native rules target distinct scalar leaf fields; arrays are unsupported. Disabled definitions can be retained while fields are changed. Current definitions can be inspected without the original authoring sample.

New ordinary uploads, PDF splits, ZIP leaves, reprocessing and initially held setup jobs pin the same `complete-regions-v1` policy and full saved definitions. Complete templates compete by configured field count, then creation time and ID. A native template has no automatic priority over a complete text template. Required raw values must be present; a default cannot manufacture a complete match, while zero and false remain valid values.

Existing queued `complete-v1` and unstamped jobs retain their previous selectors. Existing legal text templates retain their previous input bounds. A successful new selection stores its kind, revision, digest and immutable definition on the extraction run. Native evidence also stores source SHA-256, page, complete anchor blocks and captured value region. Later edits, template deletion, job deletion and parser copies do not rewrite recorded runs. Copied templates get new IDs and revision 1; sample files, mutation receipts and extraction history are not copied.

Review can navigate to a recorded native region only after verifying the exact original PDF bytes and rendering the recorded page. Raw text and evidence remain unchanged when a reviewer corrects, approves and exports effective values.

## Preview, save and recovery

Preview reads the existing private original; it creates no sample copy, extraction job, document or page-credit charge. It binds the document hash and current parser schema, checks membership and credentials before and after source work, and rejects changed source descriptors, parser settings or permissions. Partial draft values are explicitly labelled and cannot become a completed worker result.

Native create/update/delete requests use a stable request UUID. Updates and deletion additionally bind the expected revision; create/update bind the schema. Replaying an accepted request returns its immutable accepted result and reports the current revision or deletion separately. A conflicting edit preserves the unsaved draft for explicit reconciliation.

The browser persists only scoped recovery metadata, identifiers and digests, never source bytes or a template body. A lost response can recover the same request. After reload, an unknown request may be explicitly closed. Closing and saving use the same workspace lock: closure recovers an already accepted result or permanently prevents an unknown delayed save from committing. A different account, workspace or parser cannot adopt the recovery record.

## Limits

| Limit | Value |
| --- | --- |
| Original PDF | 10 MiB, 30 pages |
| Native blocks | 5,000 per page, 20,000 total |
| Native text | 1 MiB total, 4,096 characters per block |
| Geometry response | 8 MiB |
| Maximum page dimension | 14,400 points |
| Templates / rules per template | 100 / 100 |
| Canonical native definition / stored snapshot | 64 KiB / 72 KiB |
| Legacy text definition / snapshot ceiling | 512 KiB / 520 KiB, preserving previous per-field bounds |
| Geometry child deadline / preview budget | 30 seconds / 45 seconds |
| Shared decoder concurrency | Two |
| Child V8 heap | 256 MiB in TypeScript source mode; 192 MiB in the compiled package |

These are bounded native-text operations. V8 heap settings do not establish a maximum native-process RSS.

## Local verification — 20 September 2026

The final serial suite passes **821/821 tests** on Node 24.13.0 in **459.609 seconds**, with zero failures, skips, cancellations or todo cases. The final 335-file source fingerprint is `6c30b667c3ba30ff03e11ad242aa84cfc0007beca855734ca2ae43c453399580`.

**10/10 browser groups** pass in **34.801 seconds**, with all **18 screenshots** individually reviewed at desktop, tablet and mobile widths. They cover numeric/drawn regions, exact zero/false values, translated labels, unsupported pages, partial preview, lost-save recovery, conflicting editors, delayed responses, read-only inspection, pinned reprocessing and historical source overlays with exact CSV/XLSX/JSON exports. Two controlled extraction calls and zero real provider calls occurred; the three owned accounts, workspaces and documents were cleaned up. The successful run retains its original `early` designation and was selected as final browser evidence after verifying source continuity.

Build and hosted packaging pass, as do **15 compiled runtime checks**. The compiled geometry child accepts **30 pages / 20,000 native blocks** and rejects **20,001 blocks** at the documented limit. The isolated backup/restore drill passes **11 groups and 25 restored-runtime assertions**, preserving **57 tables, 263 rows and 33 objects**; its isolated resources were removed without touching the normal application database.

These application checks used fingerprint `621b497001f9f05efe3b8156fe7e349771d3389a43d70edd9b96fe8b834b8e74`. The first full suite passed 820/821 tests and found one stale new-job policy expectation. Only that test literal was corrected before the final run; comparison of every manifest entry confirms all other 334 files, including application code, are identical. Both fingerprints and the initial failure remain recorded. Browser testing also exposed and fixed editor-only metadata reaching strict region validation; disabled-template previews now explicitly state that a match requires enabling and saving.

[Combined acceptance receipt](evidence/native-pdf-regions-2026-09-20/verification.json) · [Final suite manifest](evidence/native-pdf-regions-2026-09-20/source-manifest.json) · [Browser and packaging manifest](evidence/native-pdf-regions-2026-09-20/prior-checks-source-manifest.json). Exact-head CI, hosted activation and customer use are separate evidence.

## Release boundary

Migration 037 is local only. Hosted migrations **021–037** and matching runtime activation remain pending. The current work uses owned synthetic PDFs, local database/storage and controlled transport. It does not establish hosted behavior, broad document accuracy or customer use. Free plans and visibly mocked billing remain unchanged.
