# Folio design system and accepted concept inventory

Created 6 September 2026 before frontend implementation. Folio is the original public identity; Parseur remains the internal task/project title. The agent selected this coherent direction under the user's instruction to proceed without a design approval pause. These are Image Gen concepts, not authenticated Parseur screenshots or verified implementation evidence.

## Reference and creative direction

The parent inspected public IntunePckgr and Parseur at desktop/mobile dimensions. IntunePckgr supplies the stronger visual influence: true white canvas, oversized black sans-serif type, periwinkle pill buttons, handwritten support, thin rules, friendly blue illustration and generous whitespace. Parseur supplies document-workflow clarity. Public workflow research is recorded separately in REFERENCE-WORKFLOWS.md and PARITY-MATRIX.md.

The unifying idea is a document becoming useful structured information. Marketing has one original paper-tray illustration and an honest native document/results demonstration. The application uses efficient tables and open forms; it does not repeat the playful illustration in the document editor.

## Color and typography lock

These declared tokens resolve minor generative color/size variation across screenshots. The reference-led periwinkle takes precedence over the brighter blue occasionally generated in the concept pixels. This is a recorded interpretation decision before coding, not a later restyle.

| Token | Value | Use |
| --- | --- | --- |
| Canvas and panels | #FFFFFF | True white throughout |
| Ink | #13151B | Headings, primary text |
| Muted | #687086 | Body, secondary labels |
| Accent | #6573D5 | Large heading emphasis, handwritten line and illustration |
| Accessible action | #5C69C4 | Small button fills, links and selected UI text |
| Accent hover | #5664C4 | Hover/focus contrast |
| Subtle surface | #F5F6FC | Document canvas, selected surfaces, calculator |
| Line | #E6E8EF | Borders and dividing rules |
| Active surface | #EFF1FB | Selected navigation/radio rows |
| Review | #A65E05 on #FFF8E9 | Amber validation and review status |
| Success | #26814B on #EDF8F1 | Processed/saved status |
| Error | #BA3B3B on #FFF1F1 | Failed state and validation |

Use Inter with system sans fallback for both marketing and app chrome. Use Caveat with a handwritten fallback only for the supporting accent. Use tabular numbers in tables and calculator outputs. The native wordmark is plain bold text, not a fabricated icon mark.

| Text | Desktop | Small screen |
| --- | --- | --- |
| Hero | 76px / 1.04, weight 800, -0.055em | 44px / 1.05, up to 52px where width permits |
| Section heading | 48–54px / 1.08, weight 750–800, -0.04em | 32–38px / 1.12 |
| App page title | 36px / 1.15, weight 750 | 28px / 1.2 |
| Feature title | 26–32px / 1.2, weight 700 | 24–28px |
| Marketing body | 18–19px / 1.65 | 16–18px / 1.6 |
| App body and controls | 14–16px / 1.45 | 16px input text |
| Label/caption | 13–14px / 1.45 | 13–14px |
| Handwriting | 26–30px / 1.2 | 25–28px / 1.25 |

## Geometry, components and motion

- Maximum landing container 1280px with 32px desktop/24px mobile minimum gutters. At 1536px, use 128px outer gutters; preserve concept composition proportionally rather than stretch every control.
- Landing navigation height 86px; hero roughly 690–770px including its vertical margins. Downstream sections receive 96–120px vertical padding, contracting to 64–80px on small screens.
- App sidebar 236px, top bar 72–76px, main padding 32–40px. Editor deliberately drops the sidebar to preserve its split workspace.
- Spacing scale: 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96, 120.
- Buttons: primary filled accent and white text; secondary white, accent text, 1px accent border; quiet text variant where appropriate. Marketing height52px, app44px, radii999px. Dense toolbar buttons may use 10px radius as shown in editor concept08. No gradients on code controls.
- Inputs/selects: 44px minimum height, 10px radius, 1px line border, white background, body font. Place labels above or left per screen. Do not rely on placeholders as labels.
- Panels: 12–16px radius, 1px border. Use only around a coherent product canvas, upload dropzone, result table or transactional grouping. Marketing feature/integration lists remain open with dividing rules.
- Focus: visible 3px periwinkle outline plus 3px offset. Hover transitions 140ms, disclosure 180ms. Disable motion under prefers-reduced-motion. No continuous bobbing of documents.
- Tables: 56–64px standard rows, text14px, 12–16px cell padding, horizontal rules. Do not turn desktop tables into unrelated dashboard cards.
- Tab system: text labels with periwinkle underline for content navigation; bordered compact segmented variants only for the demonstrated document/results switch.
- Semantic status pills represent real lifecycle state, not decoration. State words always remain readable without depending on color.

## Icon inventory

Use Lucide icons with 1.8px rounded strokes, 18–20px app controls and 24px sidebar/dropzone icons. Explicit exceptions: feature row art can use 30–36px line icons; very small chevrons 16px. All are SVG/code-native. No generic emoji.

| Meaning | Icon/metaphor | Placement and state |
| --- | --- | --- |
| Documents | FileText | Sidebar, sample toolbar, file rows |
| Images | FileImage or Image | Uploaded image rows |
| Email | Mail | EML rows and schema selection |
| Parsers | Layers or PanelsTopLeft | Sidebar; one consistent choice throughout |
| Integrations | Plug or Puzzle | Sidebar; one consistent choice throughout |
| Usage | ChartNoAxesColumnIncreasing | Sidebar |
| Settings | Settings | Sidebar |
| Upload/download | Upload / Download | Dropzone and export controls |
| Search | Search | Native filter input |
| Navigation | ChevronLeft, ChevronRight, ChevronDown | Breadcrumb, pager, select |
| Edit/schema | FilePenLine | Feature row |
| Source check | FileSearch | Feature row |
| Repeated data | Table2 | Feature row, sheets integration |
| Developer/API | Code2 | Integration row |
| Automation | Workflow | Integration row |
| Help | CircleHelp | Sidebar/help link |
| Warning/success | CircleAlert / CircleCheck | Inline state with text |
| Add/remove | Plus, Minus, Trash2 | Schema edit and FAQ |
| Drag row | GripVertical | Schema row reorder, only if operable |
| Mobile menu | Menu, X | Toggle with aria-expanded |
| Reprocess | RotateCw | Editor toolbar |

## Complete concept inventory

All filenames below are in docs/design/concepts. Every concept was inspected using view_image after copying into this project. Desktop concepts01–11 have native dimensions1536×1024. Mobile concepts12–13 are887×1774 (the generator selected this size despite the requested mobile dimensions).

| Concept | Purpose and composition | Core text/control inventory |
| --- | --- | --- |
| 01-landing-hero.png | Quiet nav, large left copy, right tray illustration and native result table; next workflow heading visible | Folio; Product; How it works; Pricing; Resources; Sign in; Start extracting; Try a sample |
| 02-workflow.png | Four open numbered workflow columns, then one split product demonstration | From a document to your next step.; Capture; Extract; Review; Export; Invoice sample; Document; Results; Open sample |
| 03-use-cases.png | Asymmetric heading, use-case tab row, paper example beside three separated features | Different documents. One clear workflow.; Invoices; Receipts; Purchase orders; Lead emails; Custom documents; Fields that fit your work. |
| 04-integrations.png | Left heading/copy/CTA; right four-row open integration list | Clean data. Ready for what's next.; Explore integrations; CSV, XLSX and JSON; API and webhooks; Automation recipes; Google Sheets |
| 05-pricing-roi.png | Three open columns with vertical dividers; lower pale calculator band | Start small. Make room for more.; Explore; Standard; Team; Get started; What could you save? |
| 06-faq-footer.png | Left introduction, right flat accordion; final ruled CTA band; four-column footer | A few useful answers.; Let your documents do less waiting.; Try a sample; Documents into useful data. |
| 07-app-documents.png | Sidebar, title, upload dropzone, filter toolbar, checkbox table and pager | Documents; Every file, from intake to export.; Upload documents; Drop documents here; Choose files; Search documents; All parsers; All statuses; Export |
| 08-app-review.png | Full-width editor; 52/48 document/fields split, version controls, evidence and missing-date state | Invoice review; Reprocess; Run2; Approve & export; Fields; Line items; History; Save correction |
| 09-app-onboarding.png | Three-stage progress rail and centered open schema-choice form | Create a parser; Add a document; Review & export; What would you like to extract?; Parser name; Start with a schema; Create parser |
| 10-app-schema.png | App sidebar, parser tabs, schema input table, nested line-item columns | Supplier invoices; Documents; Fields; Templates; Settings; Try a document; Save schema; Add field; Add column |
| 11-app-settings.png | Shared app shell, settings tabs, open label/control rows, preferences and honest connection state | Workspace settings; General; Members; API keys; Retention; Notifications; Billing; Save changes; View plans |
| 12-mobile-landing.png | Single-column hero continuation; same nav identity/copy/CTA, then illustration and one native result table | Same hero copy lock; Menu control |
| 13-mobile-review.png | Single-column fields with Fields/Document pane switch; accessible sticky actions | Same review copy; Line items(2); Run history; Save correction; Approve & export |

## Allowed above-the-fold copy

Exact visible text allowed on desktop hero:

1. Folio.
2. Product; How it works; Pricing; Resources; Sign in; Start extracting.
3. Your documents. / Beautifully / structured.
4. Less copying. More getting things done.
5. Turn PDFs, emails and images into the fields you need. Review the details, then send clean data to your next step.
6. Start extracting; Try a sample.
7. Extracted fields; Supplier; Northstar Office; Invoice no.; INV-1042; Total; €248.40; Synthetic sample.
8. From a document to your next step. (next-section preview where viewport allows).

Do not add an eyebrow, proof badge, accuracy claim, client logo or extra description. Menu replaces desktop navigation on small screens. An authenticated navigation variant may point to the real workspace, while retaining the same geometry.

## Native sample data and content lock

Use synthetic document examples only. The canonical sample invoice is Northstar Office, INV-1042, date2026-09-01, currencyEUR; two line items: Desk supplies, quantity2, unit price85.00, amount170.00; Notebook sets, quantity4, unit price19.60, amount78.40; total248.40. The invoice is explicitly illustrative, not a customer document.

Use-case copy:

- Heading: Different documents. One clear workflow.
- Description: Set up a parser for each kind of document. Choose the fields you need and keep the output consistent.
- Feature1: Your schema, your rules — Name fields, add instructions and choose data types.
- Feature2: Source evidence alongside values — Check extracted text against the original document.
- Feature3: Tables stay structured — Review and export repeated line items.
- Format note: Start with PDF, PNG, JPEG, EML or text.

Integration copy:

- Download a file, call the API or send approved results to a webhook.
- CSV, XLSX and JSON — Download structured results and line items. Category: Downloads.
- API and webhooks — Connect your systems with scoped keys and signed deliveries. Category: Developer tools.
- Automation recipes — Guides for Zapier, Make, n8n and Power Automate. Category: Webhook bridges.
- Google Sheets — Requires a connected Google account and configuration. Category: Setup required.
- Keep your workflow moving.
- Clear connection status. No guesswork.
- Each integration shows its setup, delivery history and errors in your workspace.

Pricing is a configurable launch assumption in shared/plans.ts: Explore€0/50pages/1parser; Standard€29/1000pages/10parsers; Team€79/5000pages/50parsers. Do not claim live billing or guaranteed quota enforcement before backend verification. Display: Illustrative launch pricing. Checkout availability is shown in your workspace.

Calculator formula: documents per month × minutes per document /60. Defaults500 and3 yield25hours. Exact qualification: An illustrative calculator, using your assumptions. Before review time. This is an estimate, not a promised result.

FAQ questions: What can I extract?; Can I check the results before exporting?; How are pages counted?; Can I connect my existing tools? Add a practical AI/provider setup question if the real app requires it. Answers must reflect actual implementation gates rather than concept claims.

## Assets and image treatment

| Asset | Use | Native size and treatment |
| --- | --- | --- |
| public/assets/hero-document-tray.png | Primary hero; isolated from concept01 using Image Gen edit | 1254×1254, pure white surround, object-fit contain, no tint/overlay/mask |
| public/assets/document-flow-illustration.png | Optional help/onboarding empty-state art where useful | 1254×1254, white surround, original tray-to-data-strip scene; no text, no UI |

Do not embed any complete concept screenshot in the application. Product demos, documents, values, labels, tabs and controls remain HTML/React. The wordmark is code-native text. Never color-wash the art to make it match CSS.

## Responsive and continuity plan

- Use the same gutters and type rhythm across all six landing sections. Connect with whitespace, rules and the single lower calculator band; do not wrap every section in a giant rounded container.
- At narrow widths, use-case heading/description, product split and integration split become stacked in reading order. Tabs can wrap without page overflow. Pricing columns stack with horizontal dividers.
- Hero remains left-aligned with full readable copy. Two CTAs may sit together above420px and stack below if needed. Illustration then the native result table follow. The large mobile reference is a conceptual density guide; verify actual390px and768px widths.
- App sidebar becomes a dismissible accessible navigation drawer below900px. Filters wrap. Preserve table semantics with a labeled local horizontal scroll if required; the overall page must not overflow.
- Review switches between Document and Fields on mobile, preserving edits while changing panes. Its footer leaves content padding equal to action-bar height plus safe area.
- Schema table may become field sections on narrow screens because editable inputs must remain usable; preserve field order, required states, and instructions.

## Intentional corrections to generated concepts

These were selected before implementation to honor the brief and avoid copying generative mistakes:

1. Use shared #6573D5 accent and exact white canvas; do not reproduce incidental vivid-blue variation, image grain or button gradients. Measured white on this accent is only4.228:1, so interactive button fills, small links and selected UI text use the closely related #5C69C4 accessible action token (contrast4.915:1). The large hero/handwriting and illustration retain the reference accent.
2. Use one native result panel. Concept12's illustration accidentally duplicates field text inside the tray; use the clean standalone hero asset instead.
3. Correct sample invoice arithmetic in concept02 to the canonical two-row invoice above. Ignore invented street addresses, tax IDs and extra vendor contacts.
4. Remove the incidental Folio wordmark that concepts03 and04 placed above a downstream section; the assembled page has one main navigation header.
5. Use the actual signed-in display name; concept11 invented an account identity. Names and lifecycle timestamps are examples only.
6. Missing due date is a warning only if the selected schema actually requires it; do not invent validation issues for optional missing values.
7. Set truthful runtime connection/usage state from the backend. Concept notification switches and billing state are anatomy examples, not proof of configured external delivery.
8. Native sidebars, toolbar sizes and pills follow declared shared tokens where Image Gen varied their pixel widths/radii.
9. Do not show inert reorder grips or unavailable integration actions. Preserve useful functional clarity while recording unsupported engine/provider gates.

## Fidelity handoff and verification boundary

Concept design and view_image inspection are complete. Browser/rendered fidelity is the implementation owner's next gate; no claim of implementation fidelity or functional verification is made in this document.

Compare each implemented section to its corresponding image using view_image, preferably at1536×1024. Also test tablet768px and mobile390px; record the difference from mobile concept's generator-selected resolution. Inspect at least: exact hero copy and line breaks; header/CTA hierarchy; white/periwinkle palette; illustration framing; native demo anatomy; section rhythm/container model; app toolbar/input typography; sidebar/table density; editor evidence/validation anatomy; responsive focus and overflow. Keep the final mismatch ledger in docs/VERIFICATION.md.

Source prompts: PROMPTS.md and PROMPTS-APPENDIX.md. Builtin image generation only; no paid API/CLI fallback was used.
