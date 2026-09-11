# Public Parseur workflow evidence

Inspected 6 September 2026 to inform the original **Folio** application in this project. Evidence consists of official public documentation, the screenshots embedded in those articles, and sampled frames from an official tutorial video. **No authenticated Parseur account or application session was inspected.** Public screenshots can depict older versions; dates and caveats below matter.

`PARITY-MATRIX.md` owns feature scope and implementation status. These notes explain the visible workflow. The parent implementation task separately owns desktop/mobile inspection of the Parseur and IntunePckgr marketing sites and the resulting original design concepts.

## Evidence register

| Source | What was actually inspected | Use and limit |
|---|---|---|
| [AI parsing guide](https://help.parseur.com/en/articles/8294111-extract-data-using-the-ai-parsing-engine) | Public article text and its rendered field-list / field-editor screenshots in the browser | Current documented onboarding and schema workflow; screenshot filenames span different dates. |
| [Manual data editing](https://help.parseur.com/en/articles/15231606-how-to-manually-edit-parsed-data-in-parseur) | Article dated 22 May 2026; rendered document-review screenshot in the browser | Confirms document preview plus Data/Fields pane; editing and reprocessing semantics. |
| [Invoice to Excel processing in 2026 with Parseur](https://www.youtube.com/watch?v=ih7E4dgJ_GQ) | Official Parseur video linked by the AI guide; sampled live browser playback through 00:37 | Observed queued document list and invoice field/table configuration. Not watched end to end; no transcript was available. The page says published about one year ago, so the current title does not prove a 2026 recording. |
| [OCR template tutorial](https://help.parseur.com/en/articles/5796344-create-your-first-ocr-template-to-extract-text-from-pdf) | Public article text, dated 10 July 2026; links to screenshots and video | Article explicitly describes a previous app version still available. Do not treat it as current AI UI. |
| [Email template tutorial](https://help.parseur.com/en/articles/3548731-create-your-first-template-to-extract-text-from-emails) | Public article text and its official tutorial link | Article describes the deprecated template system. Useful capability evidence, not a current-app visual specification. |
| [Downloads guide](https://help.parseur.com/en/articles/8675887-manually-download-extracted-data) | Public instructions and export-layout explanations | Individual and mailbox downloads, custom columns, table row semantics. |
| [Google Sheets guide](https://help.parseur.com/en/articles/3560183-export-data-to-google-sheets) | Public setup and limitation details | The documented direct method uses an IMPORTDATA formula; it is periodic refresh, not immediate API append. |
| [Developer API documentation](https://developer.parseur.com/) | Public guides, navigation and relevant endpoint/schema references | Functional contract observations only. No Try It requests or authenticated calls were made. |

## Onboarding and field configuration

The documented AI path is: choose AI-assisted mailbox creation, upload representative documents, review suggested fields, refine their definitions, reprocess, then export. A manually created mailbox may also enable AI. Field editing includes name, output format, required/missing behavior and instructions; repeating values use a named table with columns. A matching template takes precedence over AI, rather than both engines combining their outputs. The AI guide documents a 25-page extraction ceiling and recommends brief field instructions. [AI guide](https://help.parseur.com/en/articles/8294111-extract-data-using-the-ai-parsing-engine)

The browser-rendered field-list screenshot shows a light sidebar, mailbox breadcrumb, count beside the Fields heading, compact rows, checkboxes and individual edit/delete icons. Its edit screenshot uses labelled inputs, a format selector, and switches. These are observations of public screenshots, not sampled design tokens. [Field editor screenshot section](https://help.parseur.com/en/articles/8294111-extract-data-using-the-ai-parsing-engine#h_564d17934c)

**Folio design inference:** use a short guided flow with explicit parser name, use case, schema and first upload. Supply synthetic examples. Keep the schema editor accessible from the parser and document review. Explain the selected real engine and its limits before processing. The preset library, progress presentation and exact `/app` routes are our choices.

## Document queue and review

The sampled official video shows a queue with document names, received/activity columns, selection checkboxes, status pills and page-size controls. Its sidebar includes Dashboard, Import, Documents, Fields, Post Process, Export and Settings. At 00:37 it shows an invoice on the left and a Fields pane on the right, including an invoice-line-items table with separate description, quantity, total and unit-price columns. [Official video at 00:37](https://www.youtube.com/watch?v=ih7E4dgJ_GQ&t=37s)

The May 2026 public review screenshot shows document metadata and actions at the top, source content left, and Data/Fields tabs right. The manual-edit guide opens editing from the download/options menu, permits changes to values, objects and arrays, and offers a choice to resend updated data to integrations. Search helps find values within larger results. It explicitly states that edits affect only that document, do not train AI, and are discarded by reprocessing. [Review screenshot and editing guide](https://help.parseur.com/en/articles/15231606-how-to-manually-edit-parsed-data-in-parseur#h_bd86126511)

**Folio design inference and intentional difference:** use a legible form/table review pane with an optional JSON view, source evidence and explained validation issues. Preserve raw extraction, normalized values, correction history and previous approved runs. Reprocessing must create a new run. Approval/version preservation is required by our brief and must not be presented as behavior verified in the reference product. Coordinate highlights appear only when the extraction source actually supplies coordinates.

## Template workflows

The older OCR tutorial starts a template from one or multiple selected documents. Its editor provides a name, samples, document image, fields, metadata, static values and settings. Drawing and resizing a rectangle creates a field; absolute page position is the default. Labels support shifting positions and help match layouts. Results show the document alongside table/JSON output. [OCR template guide](https://help.parseur.com/en/articles/5796344-create-your-first-ocr-template-to-extract-text-from-pdf)

The email template guide selects text within a rendered email, then creates a named field or table. Settings include regional parsing and the action for a matching document. Saving can reprocess all, unprocessed, or no documents. Its documented document actions also include skip, copy, logs and template debugging. [Email template guide](https://help.parseur.com/en/articles/3548731-create-your-first-template-to-extract-text-from-emails)

For selection, the separate template guide requires a complete match, favors a matching template with more fields, then considers other documented fallbacks. A nonmatching document can use AI when enabled; otherwise parsing fails. [Template selection](https://help.parseur.com/en/articles/4251574-understand-how-parseur-picks-a-template)

**Folio design inference:** an initial text-anchor template engine must expose its exact matching rules, examples and nonmatch behavior. It must not claim zonal/dynamic OCR until that engine and region editor exist. Template priorities should be deterministic and visible, rather than imitating an undocumented tie-break implementation.

Official video references identified but not watched: [OCR tutorial](https://www.youtube.com/watch?v=UIV-qkLCP3M), [email-template tutorial](https://www.youtube.com/watch?v=uMkGQUaZ9AI), [bank-statement AI tutorial](https://www.youtube.com/watch?v=rIJwPfJ4oj0).

## Formats, metadata and preprocessing

The support format list includes documents, images, spreadsheets and email/container formats, with distinct size/page limits. It says encrypted PDFs are unsupported and file controls use detected MIME type. Our advertised list and limits must follow our tested adapters, rather than copying the reference's complete format list. [Format guide](https://help.parseur.com/en/articles/5275611-document-formats-supported-by-parseur)

Metadata is separate from extracted body fields, applies at mailbox level, and requires reprocessing to add it to already processed documents. This supports treating document ID, source filename, sender, received time and original-file lineage as explicit data. [Metadata guide](https://help.parseur.com/en/articles/3559848-extract-metadata-from-emails-and-documents-with-metadata-fields)

Splitting settings live under import/upload and support page count, explicit ranges, keyword boundaries and AI. The guide distinguishes splitting independent documents from table rows within a document; it also describes original/split lineage and reverse/re-split actions. [Splitting guide](https://help.parseur.com/en/articles/8116012-split-bundled-multi-page-documents-into-several-documents)

**Folio design inference:** display detected format and page count where available, precise rejection messages, independent batch status and original lineage. Keep archive expansion, linked-document fetch and additional converters as explicit gaps until their safety and fidelity tests pass.

## Normalization and output shape

Field formats include single/multiline text and their raw/plain/HTML variants, dates/times, numbers, person names, addresses and linked documents. The general field-format guide states tables inside table fields are unsupported; Folio's brief separately asks for nested structures. [Format overview](https://help.parseur.com/en/articles/3559928-use-field-formats-to-normalize-data)

Text variants differ in how they preserve line breaks, collapse spaces or strip markup. [Text formatting](https://help.parseur.com/en/articles/4258849-format-parsed-data-as-text) Date handling exposes ambiguity and warns against conflicting date formats and AI instructions. [Date/time formatting](https://help.parseur.com/en/articles/4258865-format-parsed-data-as-date-and-time) Number formatting has regional input behavior. [Number formatting](https://help.parseur.com/en/articles/4258885-format-parsed-data-as-a-number)

**Folio design inference:** retain the observed source value beside normalized output; preserve identifiers as strings; show a parser-level locale and deterministic ambiguity policy. Date, decimal, boolean, required-field and total-reconciliation failures need visible explanations. Do not infer certainty from an uncalibrated model score.

## Downloads and integration setup

A document offers Excel/CSV/JSON and JSON copy. A mailbox offers filtered downloads and custom field ordering. The table-row layout repeats parent fields per line item, while the document layout expands repeating cells across columns. Download date filters use UTC in the reference guide. [Download workflow](https://help.parseur.com/en/articles/8675887-manually-download-extracted-data)

The direct Google Sheets workflow copies a prepared IMPORTDATA formula into a sheet. The guide describes roughly hourly refresh and limitations around large data or preserving extra columns. It recommends automation platforms when immediate appends or more control are required. [Sheets workflow](https://help.parseur.com/en/articles/3560183-export-data-to-google-sheets)

**Folio design inference:** a saved mapping should show selected columns and a row preview before export. Exports must contain actual approved/current run data, escape spreadsheet formulas and produce independently parseable files. A future OAuth/service-account Sheets adapter is a separate implementation path; a bridge, formula or recipe must be labelled accurately.

## API, keys and webhook operations

Binary uploads and email/text JSON are separate documented input methods; intake is asynchronous and returns identifiers for later correlation. [Upload API guide](https://developer.parseur.com/upload-emails-and-documents-guide) Lists support page/page-size, case-insensitive substring search and explicit sort fields. [Pagination guide](https://developer.parseur.com/pagination-searching-sorting)

The key workflow names keys, optionally expires them and reveals new secrets once. Keys can be renamed, disabled and revoked; restrictions and creation permissions depend on account role/plan. The docs distinguish modern hashed keys from older legacy keys. Folio should implement only the safer show-once/hash pattern, with its own scoped permissions. [API-key guide](https://developer.parseur.com/api-keys)

Webhook setup chooses an event, target and optional authentication. Reference events include processed, flattened processed data, table items, extraction failure and export failure. Public docs describe 30-second acknowledgements, bounded retries for selected transient failures and document-linked delivery logs. Reprocessing can resend exports. The public reference also documents shared webhook configuration across mailboxes; Folio's initial parser-bound connections are an intentional simpler choice. [Webhook guide](https://developer.parseur.com/webhooks)

**Folio design inference:** server-controlled HMAC signatures, stable event IDs, explicit retries/replay and protected destination validation are acceptance requirements. We do not infer that Parseur implements our exact signing, idempotency or network validation scheme. Recipes should show our verified API/payload contract, never imply published native marketplace apps.

## Screen provenance map

| Folio screen | Basis | Unverified / original design choice |
|---|---|---|
| Landing page | Public marketing workflow; separate parent visual inspection | Original illustration/copy and shared IntunePckgr-inspired tokens. |
| Sign in / sign up | Public account entry links and brief | Exact auth UI/session internals not inspected. |
| Workspace / parser list | Public mailbox model and video sidebar/queue | Workspace cards, navigation and role design are original. |
| New parser / onboarding | AI guide steps and embedded screenshots | Preset/sample progression and wizard styling are original. |
| Parser document queue | Sampled official video | Our state labels, bulk actions and empty/error treatments are original. |
| Review | May 2026 screenshot and editing guide | Approval history, provenance display and form-first layout are brief-driven. |
| Schema editor | Public field list, edit panel and table columns | Versioning and nested-schema controls are brief-driven. |
| Template editor | Older public template tutorials | Text-anchor engine and its matching contract are our implementation. |
| Exports / integrations | Download, Sheets and webhook guides | Mappings and connection-state design follow actual shipped adapters. |
| Usage / billing | Public pricing/credit model | Folio prices, limits, Stripe flow and cost ledger are original. |
| Settings / team / retention | Public role/retention/API-key references | No authenticated settings screens inspected; all detailed UI is inferred. |

## Evidence handling

Browser inspection used temporary public help/video tabs. Embedded screenshots are linked by their stable article sections because their CDN URLs contain expiring query parameters. No reference logos, screenshots, video frames, testimonials, customer data or claims are copied into Folio's product assets. These notes document visible behavior for original implementation, not a promise of unlimited feature parity.
