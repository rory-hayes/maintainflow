# TIFF page splitting

Folio can split a newly uploaded TIFF or an existing TIFF document into separate TIFF documents using a fixed page count or ordered custom ranges. Stored sources can be ordinary documents, ZIP-import leaves, or existing split children. TIFF has no native searchable text, so marker mode returns the fixed `tiff_marker_unsupported` error; the UI offers page counts and ranges.

Each operation retains an exact copy of its immediate original. Existing source documents, history, approvals and prior exports remain intact. Children contain the selected pages and use the normal extraction, review and export workflow. A new operation charges its selected pages once; recovering the same accepted request does not charge again. Mock billing and the free-plan settings remain unchanged.

## Archival fidelity and compatibility

`server/core/tiff-split-engine.ts` creates fresh TIFF directories and copies the selected pages' encoded strip/tile blocks without decoding and re-encoding the archival pixels. It preserves TIFF byte order, classic/BigTIFF layout, sample depth, compression, dimensions and orientation. The JPEG preview and AI PDF remain separate resized derivatives; neither becomes a child's original TIFF.

Only the selected main IFDs and their supported reachable metadata are copied. Omitted pages' exclusive strips/tiles, directory contents and unreachable auxiliary metadata do not enter the child. Exact shared blocks are copied once within a child. Directory/value/data offsets are relocated; SHORT strip offsets can become LONG where necessary. BigTIFF output directories and external values are aligned to eight bytes, even though intake accepts the word-aligned BigTIFF files produced by the installed native library. [LibTIFF BigTIFF Design](https://libtiff.gitlab.io/libtiff/specification/bigtiff.html)

The finite tag catalogues in the codec are the compatibility boundary. Supported SubIFD, Exif, GPS and interoperability references are relocated, including shared metadata nodes. Standard GPSVersionID tag zero is accepted without weakening duplicate or ordering checks. [CIPA Exif 2.31, Table 15](https://cipa.jp/std/documents/e/DC-X010-2017.pdf)

Known scalar/string/rational fields and supported opaque values are copied unchanged. These include ICC, XMP/IPTC and Photoshop image-resource values; the codec does not interpret or redact the selected page's application metadata. ICC tag offsets are relative to the profile header; Photoshop image resources are length-delimited data blocks. This explains copying the enclosing values, and is not blanket certification of every application's private metadata. [ICC profile specification, §6.2](https://www.color.org/icc34.pdf), [Adobe Photoshop file format, image resources and TIFF tags](https://www.adobe.com/devnet-apps/photoshop/fileformatashtml/)

Modern JPEG-in-TIFF preserves both the encoded image segments and its JPEGTables value. Older JPEG table-offset tags require different relocation and are unsupported. [LibTIFF TIFF Technical Note 2](https://libtiff.gitlab.io/libtiff/specification/technote2.html)

The fixed `tiff_repack_unsupported` response rejects unknown/private TIFF tags, MakerNote, free-block maps, old JPEG table-offset tags, unsupported pointer types, auxiliary references to other main pages, and ambiguous overlaps between image blocks or directory values. Metadata is never silently discarded to make splitting succeed. This means some TIFFs accepted for ordinary extraction cannot be split losslessly by this version.

Before acceptance, the whole original, including omitted pages, and every child's main pages undergo complete sequential native decoding and the existing bounded AI-PDF validation. Corruption in an excluded original page therefore rejects the operation too. Unclassified native faults remain retryable operational errors; they are not converted into permanent content rejections.

## Bounds

| Bound | Limit |
| --- | --- |
| Original TIFF and each child | 10 MiB |
| Original pages / output groups | 30 pages / 20 children |
| Combined child TIFF bytes | 20 MiB |
| Image pixels | 40 MP per page; 300 MP across the input IFD graph |
| Declared native page bytes | 160 MiB |
| Derived JPEG preview / image conversion | 2 MiB per page; longest edge 2,048 pixels; quality 90 |
| Derived AI PDF | 10 MiB for the whole original and separately for each child |
| IFD graph / entries / encoded blocks | 256 IFDs; 1,024 entries per IFD; 100,000 blocks |
| Isolated decoder timeout / intake deadline | 30 seconds / 120 seconds |
| Compiled child V8 heap / source TSX child V8 heap | 192 MiB / 256 MiB |

These are application and V8 limits, not an operating-system sandbox or a native RSS ceiling. Source and child pages are decoded sequentially. The 20 MiB aggregate limit is checked before allocating the children or starting native decoding; the per-child layout is also bounded before allocation. Passing the archival byte and pixel limits alone does not guarantee acceptance: the preview and AI-PDF derivatives must also fit their limits. Existing workspace byte/object/active-operation quotas and physical-deletion accounting still apply.

## Requests, recovery and removal

Existing `pdf-splits` API, table and lineage identifiers are retained for compatibility. TIFF receipts explicitly carry `sourceMimeType: "image/tiff"`; child documents are `image/tiff`. A `pdf-split` root kind identifies the historical batch type and does not imply the root bytes are PDF.

New multipart uploads use `POST /api/parsers/:id/pdf-splits`. Stored documents use `POST /api/documents/:id/pdf-splits` with `{requestId, sourceSha256, options}`. Signed uploads reserve the same request identity, preview it, confirm one immutable plan, then finalize. Preview creates no documents, jobs or usage charges. Parser format policy and current workspace authorization apply to each path.

Request IDs bind source bytes, parser, operation origin and canonical options. Stored admission also binds the source document. Conflicting reuse fails; uncertain responses recover through `GET /api/parsers/:id/pdf-splits/requests/:requestId`. Accepted stored receipts and source-bound durable rejection outcomes remain recoverable after source removal. A transient response alone does not authorize replacing an unknown operation with a new request.

Stored-source reads, writes and final acceptance recheck source and authorization. Child creation and page charges commit together. Failed writes or acceptance leave cleanup work for uncommitted objects. An explicit undo removes only the chosen stored split batch; it preserves the source, siblings and independently retained nested batches. Lineage keeps immediate-source page ranges separate from composed root-page ranges. A ZIP leaf is the page-bearing root document, not the ZIP container.

Undo also deletes whole saved exports containing any removed child, including mixed exports with surviving original or sibling documents; original-only exports remain intact. Used page credits are not refunded. The complete retained source copy, including omitted pages, remains while any batch child exists. Removing the last child or undoing the batch queues that copy for physical deletion; an existing source document and independently retained copies keep their own lifecycle.

Migration `035_tiff_splitting.sql` adds source MIME identity and the finite TIFF rejection reasons while preserving legacy PDF defaults. Local migration/testing does not prove hosted migration or deployment. No real provider, email or payment calls are part of this codec work.

## Local codec evidence

- The initial combined codec set passed **34/34** in **13.080 seconds**: 12 new split groups and 22 existing TIFF regressions. After the final BigTIFF output-alignment correction and added IPC checks, all **13/13 split groups** passed in **0.940 seconds**. The latter includes 13 forged IPC responses covering MIME, header/data, counts, ranges, geometry, orientation and text. Full release checks are recorded separately by the release task.
- Actual native fidelity covers classic/BigTIFF in both byte orders, mixed dimensions and 8/16-bit RGB/RGBA samples, all eight orientations, LZW/PackBits/Deflate/JPEG/CCITT strip/tile encodings, exact block bytes, shared Exif, GPS tag zero, selected thumbnail SubIFDs, physical exclusion, source immutability and size limits. These are generated fixtures, not an exhaustive scanner corpus.
- An actual isolated **source TSX** decoder accepted a **30-page / 300 MP** synthetic TIFF, producing **15 two-page TIFFs** in **3.591 seconds**: **255,578 source bytes**, **3,775,695 combined child bytes**. All 30 original and 30 child pages were fully decoded and the encoded blocks matched. The source deliberately shares one real text-page strip among 30 IFDs. The run used a **256 MiB V8** limit and did **not** measure RSS. It preceded the BigTIFF-only alignment correction and used classic TIFF. Compiled 192 MiB verification is a separate required result.
- The same maximum fixture then passed through the **current compiled** `.vercel/output/functions/api.func` child with a **192 MiB V8** limit and no TSX child. It produced the same 15 children and **3,775,695 bytes** in **4.024 seconds**, with exact encoded blocks and independently parsed two-page children. Compiled hashes were unchanged before/after. Other local QA ran concurrently, so timing reflects that load. RSS was not measured.

Private local evidence: `.local/tiff-splitting-2026-09-20/codec-focused-final.log`, `codec-alignment-final.log`, `benchmark-300mp.json`, and `benchmark-300mp-compiled.json`. No hosted migration, live-domain verification, provider acceptance or production billing is implied by these results.

## Complete local workflow acceptance — 20 September 2026

Lossless TIFF page splitting passes **703/703 serial tests** on **Node 24.13.0** in **295.348 seconds**, with no failures, skips or cancellations. **10/10 desktop/tablet/mobile browser groups** pass in **38.157 seconds** at 1440×1000, 820×1000 and 390×844. New uploads and stored TIFFs, including ZIP leaves and earlier split children, support fixed groups and custom ranges, with actual page previews, source-bound recovery and explicit batch undo. Archival child pixels remain encoded TIFF data; approvals and earlier original-only exports remain intact. Export rows now follow requested document order, including valid mixed-case UUIDs. Build, hosted packaging, compiled runtime checks and backup/restore (**11 groups, 17 restored-runtime assertions; 55 tables and 174 rows**) pass on the same **305 unchanged source files**, fingerprint **`cdf4d49ddd7fca1dcdabc98e7a2acf0d13d6550cc628d5d1cefa472f899ae5d3`**. Browser extraction and transports are controlled; no real provider calls occur. Hosted **021–035** and matching runtime activation remain pending. Free plans and mock billing are unchanged; all **47 original capability criteria** are preserved.

The browser used compiled UI assets with the actual local Fastify routes at `http://127.0.0.1:4337`, through the installed Playwright Chromium fallback because the Browser plugin was unavailable. All 15 captured frames were individually inspected. Page identity, meaningful content, absence of framework overlays, explained console output, screenshots and real interaction state checks passed. Three controlled extraction responses were used; signed PUT was intercepted in memory while reservation, preview, confirmation and finalization used real application routes. All three owned accounts/workspaces and ten remaining documents were cleaned. Safari, Firefox, live object storage and actual provider quality were not tested.

The interaction loop covered upload and stored source selection → actual TIFF page preview → fixed/custom page choice and credit confirmation → explicit Create → correction/approval and exact CSV/XLSX/JSON download → nested source/root page references → batch undo and original-only export preservation. Separate groups exercised lost acceptance responses, malformed/late previews, workspace/viewer boundaries, parser format policy and interrupted signed staging/reload. Existing PDF marker splitting also passed. The export lifecycle regression verifies mixed-case UUID de-duplication, explicit approval matching, snapshot order and all three downloaded formats with reversed requested order.

Reproduce with Node 24, the documented isolated test database and provider-disabled environment: `npm test`, `npm run build:vercel`, `node scripts/verify-vercel-bundle.mjs` and `npm run verify:backup`. Browser receipts and screenshot artifacts remain private local QA evidence.

Earlier attempts remain recorded: the first full suite had two obsolete quota-status expectations (700/702); matching request-ID conflicts now intentionally return 409 while distinct requests still receive quota 429. The corrected 702-test source passed before the final export UUID regression was added. Workflow testing found and fixed export row order, and independent review found the mixed-case UUID edge case. One browser harness attachment-MIME expectation was corrected without changing the ordinary TIFF download contract. These earlier results are separate from the final unchanged-source acceptance above.
