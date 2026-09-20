# Split a stored PDF

Document Review can split a PDF already stored in its parser into new documents. The source may be an ordinary PDF, a PDF selected from a ZIP, or a child of an earlier PDF split. Fixed page groups, custom ranges and searchable text markers use the same preview and bounded decoder as uploaded PDF splitting.

The user reviews the proposed ranges and additional selected-page credits before submitting. Each new batch is a separate processing operation. Its children have their own jobs, corrections, approvals and exports. The source bytes, original processing history, corrections and approvals remain unchanged. Earlier exports containing only the original remain byte-identical.

## Source identity and recovery

`POST /api/documents/:id/pdf-splits` accepts a request UUID, source SHA-256 and split options. The server resolves the source inside the authenticated workspace; a caller cannot provide a storage key or download URL. It verifies the retained bytes against their stored length and hash before decoding. The existing PDF limits apply: 10 MiB source, 30 pages, 20 children, 20 MiB combined derivatives and the workspace's selected-page quota.

Migration 034 adds durable stored-source admission and lineage. A request binds the workspace, parser, source document ID, SHA-256 and canonical options. Two documents with identical bytes remain distinct sources. Ordinary uploaded splits and signed-upload reservations cannot take an admitted stored request UUID. Failed or interrupted reads retain this identity for safe retry; accepted requests replay the same manifest without another charge, including after source deletion or undo.

Short transactions check current membership, credential validity and source existence around admission and final acceptance. File reads, decoding and storage writes occur outside those locks. Nonblocking authorization locks report a retryable conflict while account access changes. Expiry is checked again before commit. Concurrent source removal or access revocation must leave no accepted children or partial page charge.

The browser keeps only scoped recovery metadata: user, workspace, parser, source, request, hash, options and the time saved. It retains an unresolved request across reload and logout so the same operation can be checked or retried again, including an old request. Source bytes, filenames and signed URLs are not stored in this record. A known receipt and explicit new-batch action are required before a second operation; a lost response is not treated as permission to start another charged batch.

A permanently rejected stored request has an explicit recovery result containing its source and option bindings. The client verifies every binding before showing “Split not created” and offering a deliberate new operation after the reason is addressed. An ordinary HTTP error, missing result or failed connection does not establish a permanent rejection. This avoids both accidental duplicate batches and an endless retry of a request that the server has already rejected.

## Page references

Children retain the page range in the immediate source PDF. Stored splits also record the root PDF's identity, hash, page count and composed range. For example, splitting root pages 3–4 into single pages produces children with source pages 1 and 2 and root pages 3 and 4. A ZIP is never used as a PDF page-number origin; its PDF leaf is the root asset.

Each batch retains its own copy of its immediate PDF source. Deleting or undoing an ancestor batch does not delete an independently created descendant batch or its retained copy. Root IDs are immutable lineage references, not authority to retrieve an original that has been deleted.

## Undo one batch

An explicit confirmation removes the selected batch's remaining direct children and their results. The original, sibling batches and descendant batches remain. Previously charged pages remain charged. A repeated undo is safe and retains the request tombstone so replay cannot recreate deleted children.

An immutable saved export containing any removed child is deleted as a whole. An export containing only the original or unaffected documents remains unchanged. Undo does not rewrite a mixed export to hide its deleted child. Private object deletion follows the existing durable cleanup queue, and its pending or failed status remains visible.

## Verification and release boundary

The focused backend and complete workflow run passes **13/13 tests** in **48.177 seconds**. It covers real six-page PDF content, corrections, approvals, typed CSV/XLSX/JSON exports, repeated-request charges, native marker verification, ZIP PDF leaves, nested page lineage, mixed-export removal, descendant-source preservation, exact history pagination, quota and rollback. Earlier compatibility checks pass **30/30 PDF database tests** and **11/11 decoder tests**. Independent adversarial verification passes **9/9 groups** in **22.218 seconds**, and the final recovery helper checks pass **6/6 cases**. The full serial regression suite passes **669/669 tests**, with zero failures, skips or cancellations in **278.560 seconds**, including the sign-in error regressions. Build (**1.782 seconds**), hosted packaging (**5.136 seconds**) and compiled runtime/decoder verification (**9.757 seconds**) pass on the same unchanged source. The final browser run passes **9/9 groups** in **35.582 seconds** at **1440×1000, 820×1000 and 390×844**, on the same unchanged source. It covers original approval/export, stored marker/range preview and additional cost, lost split response and reload, child review/export, nested lineage and lost undo response, ZIP and uploaded-split source entry, authoritative rejection recovery, held-source cancellation, workspace replacement and viewer restrictions. All three owned accounts/workspaces and eight remaining fixture documents were cleaned, with zero real provider calls and no unexplained page or console errors. The browser used guarded localhost transport and installed Playwright because the Browser plugin was unavailable. The two prior harness-only failures were a marker textbox selector collision and a history GET replacing a captured POST payload; both were corrected without changing product source.

The current-migration [backup regression](evidence/stored-pdf-splitting-2026-09-20/backup-regression.json) passes **11 restore groups and 15 restored-runtime assertions** in **16.267 seconds**, on **297 unchanged source files**. It restores all **55 tables and 137 rows**, including two stored admissions, an active batch and an undone batch. Seven live originals, the retained nested source, root page numbers, three saved exports, replay and unchanged page usage are verified. The separate temporary cluster, storage, keys and fixture credentials are removed; the normal development database is untouched by this drill.

Migration 034 is applied to the guarded local database only. Hosted migrations 021–034 and a matching runtime remain pending. Free plans and mocked billing remain unchanged. This increment does not implement AI split boundaries, TIFF splitting or additional archive formats, and does not establish production readiness or customer use.

[Combined verification](evidence/stored-pdf-splitting-2026-09-20/verification.json) · [Browser checks and screenshot index](evidence/stored-pdf-splitting-2026-09-20/README.md). All 16 final frames were individually inspected, with 11 selected for publication.

![Choose stored PDF ranges and review additional page credits](evidence/stored-pdf-splitting-2026-09-20/desktop-stored-split-ranges-cost.png)

![Mobile stored PDF split confirmation](evidence/stored-pdf-splitting-2026-09-20/stored-confirmation-cost-390.png)
