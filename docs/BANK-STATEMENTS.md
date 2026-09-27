# Bank-statement conversion within MaintainFlow

## Intended workflow

Public bank-statement conversion page → existing account/workspace → guided upload → processing → transaction/source review → explicit approval → exact approved CSV or Excel download.

This extension uses the existing authentication, membership roles, private originals, parser-backed jobs, page ledger, extraction provider, corrections, approvals and immutable export snapshots. It does not introduce a second application, billing system, accounting ledger or PDF generator. The broader extraction product and ongoing release work remain in place.

## Implementation baseline — 26 September 2026

Before this extension, the active checkout already supported tenant-scoped authentication and storage; signed/multipart batch upload; native PDF text and provider-assisted PDF/image extraction; versioned schemas/runs; corrections and approvals; duplicate-file protection; page quotas; and CSV/XLSX/JSON snapshots with spreadsheet-injection protection. It had no bank-statement preset, reconciliation engine, durable transaction identities, cross-file statement warnings or bank-specific onboarding/review/export experience.

Implementation is on `codex/bank-statement-workflow`, incorporating the existing timezone work (migration 039) and the merged operations release. Bank statements add migration 040. Neither a passing synthetic fixture nor existing provider configuration proves general bank compatibility or real-world extraction accuracy.

## Data and review contract

- Extract account/currency groups independently. Preserve literal source values and the original file. Missing or uncertain values stay unresolved.
- Monetary values are canonical decimal **strings**; reconciliation uses scaled integer arithmetic rather than floating-point sums. Invalid/ambiguous values retain their raw text and produce review issues.
- Each upload pins its selected regional format, including signed reservations completed after workspace defaults change. Re-extraction keeps the current statement's setting unless the user explicitly chooses another. A run's bank context pins its locale and source identity map. Account and transaction identifiers survive corrections, exclusion and reordering. Original rows are excluded with a reason rather than silently deleted. User-added rows are distinctly labelled and cannot claim extracted provenance.
- Bank and credit-card balance conventions are explicit. A convention is not selected merely because it makes the balance match. Account/currency groups never share a reconciliation total.
- Check opening/net/closing balances, provided running balances and explicitly stated debit/credit totals. Explain missing information and discrepancies. A matching balance is only one check.
- Warn about overlapping periods and possible repeated transactions across different files in the same workspace. Masked/unknown account identifiers cannot establish account identity. Never remove a repeated transaction automatically.
- Corrections and approvals continue to use the existing optimistic revision checks. Approval also binds the current bank review checks, so another file or correction cannot silently change the warnings being accepted. Warnings require explicit acknowledgement; unresolved blocking errors require correction or exclusion.
- Retain literal source quotes, including useful partial quotes. Warn when quotes do not cover an originally extracted transaction description, and preserve available missing/mismatched-source and visual-reading warnings. These checks follow original identities through edits and reordering; excluded and user-added rows do not inherit active extraction-evidence warnings. Older runs can gain current description-coverage warnings without rewriting their saved evidence, approvals or downloads. Quote coverage does not verify debit/credit direction or establish extraction accuracy.
- Exports pin an approval for every selected statement. Fixed CSV/XLSX columns identify source statement, account/currency group and transaction origin. Only included rows from that exact approved snapshot are exported. Spreadsheet-injection protections remain active.

## Input boundaries

Use the existing supported formats and enforce existing file/page/workspace limits: up to 20 files in a batch, 10 MiB per file and 30 pages per document. Native/scanned PDFs and supported images use the configured extraction provider; availability and limitations remain visible. The guided choices cover day-first/dot-decimal, US month-first/dot-decimal and day-first/comma-decimal formats. The provider caps each extracted array at 1,000 rows and all nested arrays at 5,000 rows, and also has a bounded response/token budget; dense statements can exceed that budget before those row limits. Invalid or incomplete provider responses fail rather than becoming approved data. No universal bank, accounting-import, QuickBooks, Xero, OFX or QBO compatibility claim is made.

An active bank workflow uses one existing parser entitlement. Setup never archives another workflow or bypasses plan limits. Excel writes ordinary amounts as numeric cells within its 15-significant-digit precision; larger exact amounts remain text. CSV writes canonical decimal literals. Dates use `YYYY-MM-DD`, absent amounts remain blank and debit/credit columns retain their reviewed direction and signs. Every row identifies its approved source, account/currency group and stable transaction identity.

## Walkthrough

1. Open `/bank-statement-converter`, then use the existing sign-in or registration flow. Invited-preview and workspace permissions still apply.
2. In **Bank statements**, choose the date/number convention and upload your files. Each file shows its own receipt, processing or failure state. Exact duplicate files link to the existing statement.
3. Open a completed statement. Select each account/currency group, compare the transaction table with the original, and follow available source-page evidence. On a small screen, switch between **Transactions** and **Original**.
4. Correct statement metadata or transaction fields; add missing rows; exclude incorrect rows with a reason; reorder rows if needed. User-added rows are visibly identified. Save corrections to refresh checks.
5. Resolve blocking errors and explicitly acknowledge the current warnings. **Approve statement** saves an immutable revision. A matching balance does not establish complete extraction.
6. Download CSV or Excel from **Approvals & history**, or select approved statements in the hub for a batch download. Selecting a historical approval exports that exact snapshot despite later corrections or extraction runs.

## Current local evidence

A full isolated regression snapshot passed **982/982 tests**, TypeScript, the frontend build, hosted bundle build and isolated hosted runtime checks. After the final per-upload locale/reprocessing fix, **321/321 targeted tests** and TypeScript passed against an unchanged backend snapshot, including signed/multipart intake, duplicate replay and usage, archive/PDF/TIFF intake regressions, timestamps, approvals and exact exports. Final pull-request CI separately verifies the final committed source.

All local runs used copied checkouts, disposable PostgreSQL 17 clusters and synthetic accounts. The normal database, real credentials and real extraction providers were not used. The source checks pass real native/scanned PDF and PNG bytes through the decoder and provider adapter with a **controlled provider transport**; they do not measure OCR accuracy.

The final recovery rehearsal passed **11/11 filesystem groups and 28/28 restored-runtime checks**, plus **12/12 managed permission/recovery groups**. It restores actual bank contexts, account dates, transaction indexes, corrections, approvals, export bytes and reserved upload formats. The exact deployment SQL passed **7/7 isolated checks**, including prerequisite refusal, restricted roles, idempotent replay, existing permission preservation, tenant policies and private Data API boundaries. See [release preparation](BANK-STATEMENT-RELEASE.md).

Current production was independently verified at operations revision `c418f497d8eb24e561a2fe5761951590bfd36e0e`. At preparation time, bank/timestamp migrations 039–040 and this workflow are **not deployed**. Hosted real-provider acceptance remains separate from local evidence.

## Verification coverage

| Requirement | Required evidence |
| --- | --- |
| Intake and extraction | Labelled synthetic native/scanned, multipage and wrapped-description fixtures; real decoder/provider-adapter tests; exact-file replay and usage preservation. Real provider evaluation is recorded separately from controlled responses. |
| Financial normalization/checks | Exact decimal/date/sign/currency cases, missing values, statement and running-balance mismatches, multiple account/currency groups, convention ambiguity. |
| Cross-file warnings | Overlaps, duplicated transactions, masked accounts and legitimate repeated payments; tenant separation. |
| Review/audit | Stable extracted/user-added identities across edits/reordering/exclusion; source-page links; optimistic conflicts; warning acknowledgement; approval history. |
| Exports | Exact rows and approval IDs for individual/selected batches in CSV and XLSX; group/source columns; injection protection; preserved historical downloads after later edits. |
| Permissions | Owned and outsider workspace fixtures, viewer/edit roles, scoped API access, no unauthorised mutation or export. |
| Browser | Desktop and mobile landing → sign-in → upload → processing → correction → approval → download walkthrough; mixed-success batch and retry states; readable layout and console health. |
| Regression/release | Existing document workflows, full relevant tests/build/runtime/restore checks; source and deployment identity verified independently. |

## Browser walkthrough and evidence

Desktop (1440 px) and mobile (390 px) browser checks passed the dedicated landing and sign-in return, a mixed native PDF/scanned PDF/PNG batch with an independently rejected corrupt PDF, transaction editing/addition/exclusion/reordering, source evidence, warning acknowledgement, approvals, single and batch CSV/XLSX downloads, exact duplicate usage, extraction retry, historic snapshots and the existing invoice workflow. Additional checks verified unsaved drafts across background extraction, explicit discard before switching runs, per-batch date formats despite concurrent defaults, and format selection while viewing an older run.

The automated browser burst reached the existing request limit once; the affected generic signup check passed after the natural window reset. Rate limits stayed unchanged. Authentication and deliberately invalid-file responses were expected; the successful review/export and later regression phases recorded no browser errors.

[Local verification receipt](evidence/bank-statements-2026-09-26/local-verification.json) · [Desktop landing](evidence/bank-statements-2026-09-26/bank-landing-desktop.png) · [Mobile landing](evidence/bank-statements-2026-09-26/bank-landing-mobile.png) · [Desktop review](evidence/bank-statements-2026-09-26/bank-review-actions-desktop.png) · [Mobile review](evidence/bank-statements-2026-09-26/bank-review-actions-mobile.png).

Local, controlled-provider, real-provider and deployed results remain distinct. The release pull request and final delivery report record CI, hosted migration and live-domain acceptance separately.
