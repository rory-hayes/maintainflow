# Folio concept-to-render fidelity review

Reviewed 6 September 2026 using `view_image` on the saved browser evidence and original Image Gen concepts. This is a visual comparison of saved images. The parent agent owns live browser interaction, responsive measurements and functional QA; this review did not operate CUA or independently rerun those checks.

The implementation preserves the white canvas, oversized dark headings, periwinkle action family, original paper illustration and open marketing sections. The hero is the closest composition match. The schema editor is now materially more compact, though it still shows fewer fields per viewport than the concept. Remaining visible departures include the persistent app sidebar in onboarding/review, smaller secondary typography and greater mobile page height. No numerical fidelity score is assigned.

## Evidence and comparison limits

- Desktop concepts and evidence are 1536 × 1024. Desktop screenshots are viewport captures at different scroll positions, so section-relative composition is compared rather than treating every absolute vertical offset as a mismatch.
- Mobile concept12 is 887 × 1774; current mobile evidence is 390 × 844. Shrinking the concept to 390px would also shrink its body text and controls below the implementation's intended 16px body / 44px control sizing. Matching its entire page density at that viewport would compromise those deliberate dimensions.
- `landing-use-cases-desktop.png` shows Receipts, while concept03 shows Invoices. The receipt illustration and copy therefore represent a different selected state, not an incorrect rendering of the invoice.
- `landing-faq-desktop.png` and `landing-footer-desktop.png` show the second answer open; concept06 has the first answer open. The footer capture also includes an intentional visible keyboard focus outline.
- `schema-desktop.png` records the earlier expanded controls. Replacement `schema-compact-desktop.png` now shows five complete core rows. `schema-options-desktop.png` and the final overwritten `schema-options-mobile.png` establish the expanded Department row with two allowed choices and a populated default. The final mobile image was inspected after the readability adjustment: enlarged controls fit the390px width without visible horizontal clipping. The parent separately confirmed14px control text,44px input/select height and12px labels through DOM measurements. `schema-nested-desktop.png` supplies a visible nested-object child inside Line items.
- `document-queued-desktop.png` is a queued document-review state, despite its filename. The later `documents-desktop.png` capture supplies actual list evidence for concept07.
- `review-desktop.png` initially captured an incorrect “Unsaved changes” label before the parent's baseline-order fix. The parent reported the fix and pinning of the first displayed run; this report does not treat a code-change report as replacement screenshot evidence.
- Additional review, export, documents, integration, billing and usage captures appeared during the review and were inspected. Replacement hero, pricing, integration, phone/tablet review and mobile-continuation images were inspected afterward. Mobile review is390 ×844 and tablet review is768 ×1024. Image inspection, rather than file modification timestamps alone, establishes the replacement state.
- The first inspected `landing-desktop.png` had a clipped navigation pill. The replacement capture was inspected and shows the complete pill; this finding is visually closed.

## 01 — Landing hero

References: `concepts/01-landing-hero.png`; `../evidence/landing-desktop.png` (initial capture and replacement inspected; replacement hero saved21:53:03 IST).

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Composition | Large three-line heading on the left; blue paper tray and one bordered results panel on the right; workflow heading below the horizontal rule. | Main composition preserved. |
| Copy and wrapping | “Your documents.”, “Beautifully”, and “structured.” retain the concept line breaks. The replacement body also breaks after “need.”, matching the concept sentence split. | Headline and body line breaks now match. |
| Scale and alignment | Heading begins near the concept's left edge and has similar dominant height. The results panel sits slightly farther right; the illustration is more compact and higher relative to that panel. | Close hero hierarchy with different illustration-to-panel spacing. |
| Color and underline | Periwinkle replaces the generator's vivid blue. The rendered underline is much thinner and nearly straight, while the concept has a heavier hand-drawn curve. | Action color is an intentional contrast correction; underline remains a visible style departure. |
| Illustration | Original isolated art keeps the tray/papers metaphor and white surround. It removes raster “INVOICE”, envelope decoration and currency glyph from the concept. | Accepted asset simplification; code-rendered fields remain readable. |
| Controls | Two pill CTAs keep their order and filled/outline hierarchy. The header contains the same navigation labels and a single sign-in action. | Hierarchy preserved. |
| Header defect | Initial capture showed a rectangular white notch in the top-right primary pill. The replacement shows its complete uninterrupted outline. | Visually closed after the stacking correction. |
| Section transition | Thin rule and next workflow heading are visible near the lower viewport edge in both images. Implementation also reveals the workflow subtitle. | Section rhythm is close at this desktop viewport. |

## 02 — Workflow and product demonstration

References: `concepts/02-workflow.png`; `../evidence/landing-workflow-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Step structure | Four equal Capture / Extract / Review / Export columns retain numbered circles and connecting horizontal lines. | Structure preserved. |
| Typography | Step labels and descriptions are visibly smaller than the concept; the subtitle is also quieter. | The implemented section feels less editorial and more compact. |
| Vertical rhythm | The implementation leaves more space between the section heading and step rail; its demo begins lower within the capture. | Spacing departure; screenshot scroll offset also contributes to absolute position. |
| Product canvas | One pale bordered canvas contains a document/results toolbar, left original, right field list and lower-right Open sample CTA. | Main component anatomy preserved. |
| Synthetic document | The implementation removes invented contact details and uses two rows whose amounts sum to €248.40. The generated five-row invoice did not reconcile. | Necessary content correction, with a less dense document appearance. |
| Result controls | Five field/value rows remain aligned. Native fields and toolbar controls are smaller than concept02's generous boxes and text. | Preserved hierarchy with reduced control/text scale. |
| Panel proportions | Document remains slightly wider than the field panel; the native paper has more empty space around its short sample. | Coherent split, visibly quieter content density. |
| Raster/UI boundary | The saved image shows a native document/table presentation without placing the concept screenshot into the page. | Meets the intended asset-versus-control separation; functionality belongs to browser QA. |

## 03 — Use cases and features

References: `concepts/03-use-cases.png`; `../evidence/landing-use-cases-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Main grid | Two-line heading and right-side introductory copy sit above tabs; document example remains left and feature list right. | Asymmetric structure preserved. |
| Selected state | Evidence selects Receipts and shows Corner Café, €8.00, with receipt-specific copy. Concept shows Invoices. | Different valid state; invoice detail fidelity cannot be judged from this capture. |
| Duplicate identity | The downstream Folio wordmark generated above concept03 is absent in the assembled page. | Accepted correction; one site header is appropriate. |
| Type hierarchy | Section heading is bold and large; feature heading, icons, body copy and tab labels are materially smaller than in the concept. | Clear hierarchy, lower downstream scale. |
| Tabs | Five text tabs use a thin line and active underline. Actual tabs occupy a shorter span rather than filling the wider concept rail. | Interaction anatomy preserved; tab density differs. |
| Document treatment | Receipt uses a narrow white paper inside a larger pale frame. Concept invoice fills most of its frame. | Appropriate document-specific aspect ratio; the difference is not a failed invoice layout. |
| Feature list | Three features use small blue outline icons, bold titles and horizontal separators, without independent cards. | Open list style preserved. |
| Viewport coverage | Capture includes the preceding Results demo at the top and clips the format note at the bottom. | Requires a section-aligned or second capture to assess the bottom note visually. |

## 04 — Integrations

References: `concepts/04-integrations.png`; `../evidence/landing-integrations-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Split layout | Left heading/body/CTA/handwriting balances a right four-row integration list. | Main composition preserved. |
| Heading wrap | Replacement uses “Clean data.” followed by “Ready for what's next.” on one line, restoring the concept's two-line grouping. | Wrapping resolved through smaller type; the heading remains smaller than the concept. |
| Row anatomy | Each integration has a bordered icon, title, description and right-aligned category; rows remain separated by rules. | Structure preserved without unnecessary large cards. |
| Scale | Icon boxes, headings and descriptions are smaller. Category labels are especially fine compared with the concept. | More whitespace within rows and lower visual emphasis. |
| Content | Download formats, API/webhooks, automation recipes and Google Sheets keep the same order. “Setup required” remains visible for Sheets. | Copy hierarchy preserved with truthful setup qualification. |
| Handwriting | The support line remains under the CTA, but it is smaller and lacks the concept's prominent underline flourish. | Recognizable accent, less expressive treatment. |
| Footer note | The lower rule and “Clear connection status. No guesswork.” note are present; their text is smaller. | Anatomy preserved, scale reduced. |
| Duplicate identity | The concept's standalone Folio wordmark is removed. | Accepted assembled-page correction. |

## 05 — Pricing and illustrative calculator

References: `concepts/05-pricing-roi.png`; `../evidence/landing-pricing-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Pricing structure | Three equal open columns with thin vertical dividers keep Explore / Standard / Team. | Main structure matches. |
| Plans and allowance | €0 / €29 / €79 and 50 / 1,000 / 5,000 pages are visible in the expected order. | Content matches the shared illustrative plan configuration. |
| Price emphasis | Replacement prices are dark ink, matching the concept's emphasis color. They remain visibly smaller than the concept. | Color resolved; scale difference remains. |
| Benefits and CTAs | Three checked benefit lines and a primary pill align beneath each plan. Actual check icons, copy and buttons are smaller. | Consistent column rhythm with less visual weight. |
| Qualification | The illustrative-pricing note stays directly beneath the columns. | Required honesty preserved; text is finer than concept. |
| Calculator anatomy | One pale band contains title, two native numeric inputs/sliders and a separate result region divided vertically. | Component structure matches. |
| Default result | 500 documents and 3 minutes produce visible “25 hours”. | Default visual state and arithmetic match. This screenshot alone does not prove all calculator input behavior. |
| Result scale | The result and supporting text occupy less width/height than the concept; slider tracks/thumbs use browser-native proportions. | Substantial scale difference, with usable native controls retained. |

## 06 — FAQ, final CTA and footer

References: `concepts/06-faq-footer.png`; `../evidence/landing-faq-desktop.png`; `../evidence/landing-footer-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| FAQ grid | Introductory heading/copy sit left, flat ruled disclosures right. | Open layout preserved. |
| Heading wrap | Actual “A few useful answers.” wraps to two lines; concept keeps a single line extending into the central area. | Visible measure/scale departure, though the split remains clear. |
| Disclosure scale | Questions and answers are substantially smaller than the concept's large editorial questions. | More compact and less prominent FAQ. |
| Selected state | Second answer is open in evidence; first is open in concept. | Different captured state rather than missing disclosure content. |
| Added question | Fifth AI setup question is present beyond the four concept questions. | Necessary content addition because real scan/image extraction is unavailable. |
| Toggle and focus | Expanded disclosure shows a cross-shaped rotated plus; concept shows a minus. The footer capture has a visible focus outline around the active question. | Icon departure; focus treatment is an intentional accessibility state. |
| Final CTA band | Ruled horizontal band retains the left sentence and right Try a sample pill. Text and button are smaller than concept. | Structure preserved, emphasis reduced. |
| Footer | Four columns preserve Folio, Product, Resources and Legal; copyright remains below a final rule. | Content and alignment match, with smaller footer typography and more quiet space. |

## 07 — Documents list follow-up

References: `concepts/07-app-documents.png`; `../evidence/documents-desktop.png` (21:41:47 IST).

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Page anatomy | Sidebar, breadcrumb, Documents heading, dashed upload area, filter row, checkbox table and pagination follow the concept. | Main structure preserved. |
| Header action | Actual top-right action is Create parser rather than Upload documents; upload remains available through Choose files in the dropzone. | CTA role differs, while avoiding duplicate file-picker actions. |
| Search placement | Actual list has one search input in the filter row. The concept also repeats search in the global header. | Accepted simplification; document search stays near its filters. |
| Upload limits | Actual copy states20 files,10MB and30 pages rather than the generated20MB claim. | Necessary correction to match the backend limits. |
| Table data | Actual capture shows one persisted synthetic TXT document; concept shows six different files and lifecycle states. | Honest data-dependent density; no artificial records were added for a screenshot match. |
| Type and rows | Table/toolbar typography is smaller than concept07, but the main columns and generous horizontal spacing are preserved. | Consistent app scale with quieter visual emphasis. |
| Status | Visible Needs review uses a pale amber pill and readable wording. | Status language matches; the other lifecycle colors remain outside this specific capture. |
| Sidebar | Actual narrower sidebar uses small outline icons and a pale active row; account/workspace values are runtime data. | Same design family, different raw concept dimensions. |
| Pagination | Actual shows1 document, Page1 and disabled Previous/Next. | Correct visible single-page state; multi-page behavior belongs to functional QA. |

## 09 — Parser onboarding

References: `concepts/09-app-onboarding.png`; `../evidence/onboarding-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Page shell | Concept removes the sidebar and uses a simple Folio/back-to-workspace header. Actual onboarding stays inside the full workspace sidebar and breadcrumb shell. | Major compositional change; consistent app navigation takes space from the onboarding canvas. |
| Form alignment | Both use a centered open form with parser name, schema choice rows and a lower-right creation CTA. Actual form is centered within the remaining content area. | Form anatomy preserved. |
| Progress rail | Three numbered stages remain. Actual labels sit beside smaller circles and have no long connector lines; concept puts labels beneath larger circles. | Clear visual departure in the progress component. |
| Heading size | Actual title is visibly smaller and occupies less horizontal span. | Less of the concept's focused onboarding emphasis. |
| Schema choices | Five full-width radio rows have icons, bold titles and short descriptions, with a pale selected row. | Selection anatomy preserved. |
| Order and copy | Purchase orders precede Receipts in the actual preset order; concept has Receipts second. “Custom parser” replaces “Custom schema”, and descriptions follow implemented preset copy. | Modest content/order departure. |
| Focus and CTA | Parser-name focus ring is visible; the primary pill remains below the choices on the right. | Usable native form state; smaller CTA/type than concept. |
| Additional status | Actual footer includes text-anchor/AI setup information absent in concept. | Honest product limitation adds height; the captured wording predates the stronger adapter-unavailable copy update. |

## 10 — Schema editor

References: `concepts/10-app-schema.png`; `../evidence/schema-compact-desktop.png`, `../evidence/schema-options-desktop.png`, `../evidence/schema-options-mobile.png`, `../evidence/schema-nested-desktop.png`. The original `schema-desktop.png` remains historical evidence of the expanded layout before refinement.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Overall density | Concept displays six top-level fields plus four nested columns in one compact grid. The replacement shows five complete top-level core rows, up from two and part of a third. | Substantial improvement, with a material remaining density departure. The concept's whole schema still does not fit in the actual viewport. |
| Core controls | Key, label, type, required state, reorder and delete remain visible together in each core row. Concept combines its naming into one column and keeps instructions visible. | Everyday editing is easier to scan; the separate key and human label consume more width than the concept. |
| Progressive disclosure | Each closed row has an Extraction options summary, including its anchor and any configured default or choice count. Department is shown expanded with the full settings. | The earlier always-expanded height is resolved. Instructions require an extra disclosure action, a deliberate tradeoff for compactness. |
| Reordering | Explicit up/down buttons now sit with delete beside each row's type/required controls. Concept has drag grips. | Keyboard-operable ordering remains visible; three icon buttons are still heavier than a grip and delete icon. |
| Defaults and choices | The expanded Department row visibly contains Operations and Finance choices, a checked default toggle, and Operations as the default value. | Populated-default and enum presentation are now visually covered. These settings add height only when that row is opened. |
| Row grouping | Core fields remain separately bordered cards with repeated labels, gaps and their own summary line. Concept uses densely aligned horizontal table rows. | This repeated chrome is the main remaining density difference; the implementation remains a form rather than a literal table reproduction. |
| Toolbar | Actual Save schema is at schema-version level. The top header shows “Edit fields” even while Fields is selected; concept has Try a document and Save schema in the page header. | Toolbar hierarchy differs; Edit fields is redundant in this captured tab. |
| App shell and type | Actual sidebar is narrower and page title/input labels are smaller. Underlined parser tabs remain. | Shared app identity preserved; raw concept dimensions are not matched. |
| Field order/version | Actual compact capture is schema version3 with invoice_number before supplier, and includes currency/subtotal fields. Concept starts supplier and has a shorter schema. | Runtime schema content differs legitimately; even accounting for more configured fields, the actual rows remain taller. |
| Nested state | The new nested capture shows quantity, unit_price, amount and an item_meta object containing cost_centre, with distinct blue nesting rails and Add child field controls at both levels. | Nested array/object layout is now visibly covered. The hierarchy is clear but much taller than the concept's compact four-column child table. Add/reload/remove behavior belongs to the parent's browser QA record. |
| Mobile arrangement | The final390px capture shows two core columns, separate reorder/delete actions and a full-width expanded options stack. Enlarged input text, the choices textarea and default remain within the frame without visible horizontal clipping. | Readability finding closed by replacement image inspection and the parent's DOM measurements:14px controls,44px input/select height and12px labels at widths up to600px. The taller form is an accepted mobile tradeoff. |

## 11 — Workspace settings

References: `concepts/11-app-settings.png`; `../evidence/settings-workspace-desktop.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Structure | Sidebar, title, description, underlined tabs, open label/value rows, save CTA and lower billing callout are present. | Core layout matches. |
| Content width | Actual settings form ends well before the right viewport edge; concept rows span almost the full content region. | Narrower measure increases unused right-side space. |
| Type and sidebar | Actual title, labels, sidebar text and controls are smaller; the sidebar is about244px versus roughly280px in the concept. | Consistent implemented app shell, lower concept scale. |
| Supported configuration | Concept locale/timezone selects become a link to parser settings. Actual rows add upload limits and local-auth status. | Correct adaptation to actual API ownership; invented workspace settings are avoided. |
| Processing preferences | Concept shows review/email switches. Actual General omits them; approval is intrinsic to export and Notifications has a separate honest unavailable-delivery state. | Necessary capability correction. The screenshot does not prove the Notifications tab presentation. |
| Tabs | Password and Activity extend the six concept tabs to eight for the captured owner. | Functional scope addition; all fit at this desktop width. |
| Billing callout | Actual callout uses a light filled surface and View plans button; concept uses an outlined box plus setup badge. | Modest component-style change; runtime billing status is inside the destination panel. |
| Identity | Actual local account/workspace names replace the generated concept identity. | Required runtime data adaptation, not a fidelity defect. |

## 12 — Mobile hero and workflow

References: `concepts/12-mobile-landing.png`; `../evidence/landing-mobile.png`; `../evidence/landing-mobile-continuation.png`; `../evidence/landing-workflow-mobile.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Responsive order | Wordmark/menu, three-line headline, handwriting, body, paired CTAs and illustration remain in that order. | Reading order matches. |
| Gutters | Actual content has roughly22px side gutters in a390px viewport; no element visibly crosses the viewport edge in these captures. | Appropriate narrow-width composition. This visual check is not a scrollWidth measurement. |
| Headline | “Your documents.” remains on one line, followed by “Beautifully” and “structured.”; accent and underline remain. | Copy and headline wrapping match the concept intent. |
| Body and controls | Actual body remains readable at the declared mobile size, and the two pills have roughly44px-plus height. Scaling concept12 proportionally would yield noticeably smaller type/controls. | Deliberate accessibility/readability tradeoff; extra page height is expected. |
| Handwriting | Replacement handwriting wraps to two lines with an informal Caveat stroke. It is smaller and less dominant than the concept's handwritten block. | Typeface character now aligns; scale remains quieter. |
| Hero density | At390×844, the capture reaches only the bottom of the tray. Concept12 at its own height includes the results panel and next heading. | The mobile hero is materially taller in relative viewport terms. Do not claim identical density. |
| Illustration | Actual isolated tray uses one clean document/paper scene and omits the concept's embedded result chips and motion lines. | Accepted correction to avoid duplicated raster UI. |
| Result panel coverage | The continuation capture shows one native bordered Extracted fields panel with Supplier, Invoice no., Total and Synthetic sample, followed by the workflow heading. | Coverage gap closed; no duplicate raster result chips are visible. |
| Workflow adaptation | Actual four stages become a two-by-two grid and the product canvas stacks vertically, with native tabs and readable invoice columns. | Sensible responsive transformation; concept12 does not show enough workflow content for a direct component comparison. |
| Mobile demo crop | The workflow screenshot ends after the first invoice row. | Lower invoice/result content and its overflow behavior remain outside this image. |

## Additional review-state comparison

References: `concepts/08-app-review.png`; `../evidence/document-queued-desktop.png`; `../evidence/review-desktop.png`; `../evidence/review-line-items-desktop.png`.

1. The concept devotes the full viewport to document/fields. The implementation retains the244px sidebar and workspace top bar, reducing the working area; within that area it still uses an approximately even split.
2. Original text appears as a faithful plain-text source because the sample is a TXT file. It cannot visually match the concept's formatted PDF invoice, and should not be dressed up as that PDF.
3. The review sample is Juniper Studio / INV-00127 / €553.50, while the marketing concept uses Northstar Office / INV-1042 / €248.40. Both are marked synthetic, but this is a continuity difference across the public demo and actual sample workflow.
4. Source-evidence links and original values appear below the native controls. They are much smaller than the concept, with dense metadata after each field.
5. No invented due-date warning appears for this captured schema. The concept's orange warning is only appropriate when a real required field is missing; visual identity should not introduce false validation errors.
6. Approve & export moves from the top toolbar to the lower-right sticky action area, beside Save correction. The top has a distinct disabled Export until approval.
7. The line-item capture shows two native editable rows and explicit Add row/delete controls. This extends the concept's tab anatomy to a concrete editing state, but nested arrays/objects are not captured.
8. Queued state keeps the readable source alongside a quiet processing message and disabled actions. This is additional state coverage beyond the ready-to-review concept.
9. The initial “Unsaved changes” label is stale evidence of a fixed bug. New PDF and phone captures say “Extracted values” with Save correction disabled for untouched data, visually supporting that correction.
10. Subsequent mobile and tablet review captures were inspected; their distinct layout observations follow below.

## 13 — Mobile and tablet review follow-up

References: `concepts/13-mobile-review.png`; `../evidence/review-mobile.png`; `../evidence/review-source-mobile.png`; `../evidence/review-tablet.png`.

| Point | Observed comparison | Assessment |
| --- | --- | --- |
| Field columns | Replacement390px capture uses one full-width field at a time, with larger original/evidence text beneath each. | Initial two-column issue is visually closed; the layout now follows concept13. |
| Navigation | Actual phone capture adds a workspace header, full reprocess/run/export toolbar and a second Fields/Line items/History tab row beneath the Fields/Document pane switch. | More navigation chrome than concept13, reducing above-the-fold field space. |
| Pane switch | Both Fields and Document states are represented in saved images. Document view uses the full mobile width with a pale original-document canvas. | Visible responsive state coverage is established; live switching behavior remains the parent's test. |
| Source format | Actual source is marked ORIGINAL TEXT and faithfully presents the uploaded synthetic TXT sample. | Appropriate source-format adaptation rather than a fabricated PDF rendering. |
| Action area | Bottom save/approve actions remain visible in a sticky white footer. Save correction is disabled for unchanged values; primary approval remains clear. | Action hierarchy broadly matches concept13. |
| Runtime notice | The final phone capture has no lingering reprocess success banner. It shows the real Needs review state without inventing the concept's missing-field warning. | Runtime notices are state-dependent; the clean field layout has more room. |
| Evidence density | Original/evidence text is larger and has the full field width in the replacement. Concept source labels remain larger relative to their frame. | Significant readability improvement; some fine-text scale difference remains. |
| Tablet sidebar | At768px the replacement has a menu trigger and no persistent sidebar, giving the split editor the full viewport width. | Initial tablet-width issue is visually closed. The implemented drawer breakpoint is1000px. |
| Tablet source wrapping | Replacement page and zoom controls fit one row. Original table lines still wrap where long, but the wider source pane is materially easier to read. | Main space constraint resolved; a long text line need not be forced into an unwrapped image-like layout. |
| Lower-content coverage | Replacement phone Fields capture reaches three full-width scalar controls; tablet capture ends during additional fields. | These images establish layout but not access to every lower field or nested table. |

## Additional export-modal evidence

Reference: `../evidence/export-desktop.png`. No separate Image Gen export-dialog concept was supplied; this is a component-family review.

1. A centered white dialog uses the shared rounded border, dark title, muted description and clear close control.
2. Native Format and Column mapping fields align in two columns, followed by a full-width optional table key, consistent with the app's open forms.
3. The explicit approved-revision description and selected-document count make the export scope visible.
4. A green success notice and Download export button are visible in the captured state. The screenshot alone does not inspect downloaded file contents.
5. Background blur and dimming focus attention on the modal. Focus trapping, Escape and return focus are separate interaction checks owned by the parent.

## Actual PDF review follow-up

References: `../evidence/review-pdf-desktop.png`; `../evidence/review-pdf-page2.png`.

1. The captured PDF appears as a rendered white page inside the source canvas, with Page1 of2 and Page2 of2 states represented.
2. The supplied PDF is a plainly formatted held-out synthetic invoice, so it remains visually different from the decorated invoice in concept08. Its actual original content is preserved.
3. Page2 shows additional desk-pad and pen lines, while the native Line items panel shows four rows spanning both pages. This is useful visible multi-page/table coverage; processing correctness remains covered by the parent's evaluation evidence.
4. An amber no-template-matched message uses the shared warning treatment and explains fallback anchors. It represents a real extraction check, rather than the concept's invented missing due date.
5. The field panel shows source evidence and original values alongside date, amount and department values. Native date presentation follows the browser's locale while the document retains its printed date.
6. The footer says Extracted values, with Save correction disabled for untouched data. This newer capture supports visual closure of the earlier false unsaved-state label.

## Additional settings-family states

New saved images inspected while final recaptures were pending: `../evidence/integrations-desktop.png`, `../evidence/billing-desktop.png`, `../evidence/usage-desktop.png`. These states extend the shared app family; they have no separate matching Image Gen frame.

- Integrations keeps the open ruled rows and small outline icon containers; API/webhook actions and provider state remain distinct. The empty connection area accurately says there are no saved connections. Google Sheets has a visible Setup required label and disabled connection action. Four tabs retain the shared underline system. Native marketplace support is explicitly distinguished from webhook recipes in the visible copy.
- Billing uses three bordered plan columns rather than the public pricing section's open dividers. Plan values remain consistent. The visible setup message says Stripe test billing is unconfigured. Test checkout/portal actions are visibly disabled. The pale disabled controls are subordinate to the status explanation; the image provides no evidence of a successful provider transaction.
- Usage has an open allowance rail, restrained progress bar and four current counts, followed by a pale counting-rule explanation and native ledger table. The workspace is labelled Local development. The captured4/1,000 pages and $0.0000 recorded model cost are runtime values, not marketing claims. Reprocessing and uploads have separate ledger rows. The lower ledger continues beyond the viewport and is not fully covered by this image.

## Prioritized mismatch ledger

| Priority | Item | Next action / disposition |
| --- | --- | --- |
| Closed | Initial narrow phone/tablet review layout. | Replacement phone is single-column; replacement tablet uses a drawer and wider editor. Visually confirmed. |
| Improved; remaining departure | Schema density diverged sharply from concept10. | Replacement now shows five complete core rows with working disclosure, compared with the concept's six plus four nested columns. Repeated labels and card spacing keep the rows taller than the concept. |
| Closed | Schema mobile control readability. | Final replacement image shows enlarged controls fitting390px without visible horizontal clipping. Parent DOM checks confirm14px control text,44px input/select height and12px labels. |
| Medium | Persistent sidebar changes onboarding and review composition. | Decide whether maintaining app navigation outweighs the concept's dedicated focused layouts; do not claim those frames are exact matches. |
| Medium | Secondary marketing typography and pricing/result numerals remain smaller than concepts. | Price color is now visually corrected to dark ink. Assess remaining downstream scale separately. |
| Closed | Integration heading wrapping. | Replacement restores two lines at1536px through a smaller heading size. Overall type-scale difference remains recorded. |
| Closed | Header pill clipping in initial hero evidence. | Replacement hero visibly shows a complete navigation pill after the stacking fix. |
| Closed | Nested schema and populated-option image coverage. | Saved images now show Department's populated default/choices and an item_meta object containing cost_centre inside Line items. Nested forms retain greater height than the concept. |
| Low | CTA sizes, underline flourish, icon sizes and FAQ expanded icon differ. | Refinement opportunities after functional and responsive correctness; preserve contrast/focus sizing. |
| Accepted | Darker accessible action color, corrected invoice arithmetic, original standalone art and omitted invented account/contact details. | Preserve these departures from generative artifacts. |
| Accepted | Truthful AI/provider gating and accessible mobile sizing add copy and height. | Preserve; improve composition without concealing unsupported capabilities or reducing control readability. |

This review establishes the observed visual comparisons only. Passing TypeScript, local workflow tests, live browser interactions, provider setup, deployment and external customer use are separate evidence categories.
