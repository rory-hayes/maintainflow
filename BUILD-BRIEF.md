# Parseur — product and implementation brief

## Mission and scope
The user has decided to build a copycat application of Parseur (https://parseur.com/). This is an instruction to start implementing a real full-stack SaaS, not to repeat market research, propose ideas, or stop at a landing page. Keep this Codex task titled exactly "Parseur".

Reproduce the useful public product capabilities and workflows through our own implementation. The goal is a general-purpose email/PDF/document extraction platform; purchase orders are an initial sample workflow, not a restriction on the application. Support invoices, receipts, lead emails and custom document schemas as well. Use Parseur as the internal working title; write original product copy and create original assets. Do not present our application as the existing company or reuse its customer testimonials, logos, certifications, usage figures or accuracy claims.

Work only in /Users/rory/Documents/Ideation/parseur. Inspect applicable AGENTS.md guidance and the directory before editing. Preserve this BUILD-BRIEF.md and any existing work; do not change sibling projects. Create a new repository inside this directory if none exists and it is appropriate. No remote repository, paid subscription or public production launch is required merely to start implementation.

## Required tools, skills and execution mode
The task must run at ultra reasoning. The task creator requested this through the actual task setting, not only this prompt. Keep the configured model; no particular model was requested.

Explicitly use the installed [Build Web Apps](plugin://build-web-apps@openai-curated-remote) plugin. Start by reading build-web-apps:frontend-app-builder. At handoff its path is /Users/rory/.codex/plugins/cache/openai-curated-remote/build-web-apps/0.1.2/skills/frontend-app-builder/SKILL.md; discover the current path if it changes. Announce use of the skill. Follow its complete concept, design-system, implementation and browser-fidelity workflow. Use its frontend-testing-debugging, React, shadcn, Supabase and Stripe skills where relevant.

The user explicitly requests goal-driven work. At the beginning, call get_goal, then create_goal if no unfinished goal exists. Objective: "Build and verify the Parseur document-extraction SaaS specified in BUILD-BRIEF.md, with IntunePckgr-inspired design across the landing page and every application screen, real persisted document processing, review and exports, and an honest integration and release status." No token budget was requested: omit token_budget. Use the native goal tools; no separately installed Goal SKILL.md was found during handoff. If a Goal skill is available in this task, read it too. Do not mark the goal complete while required work remains. Respect the goal tool's rules for genuinely blocked status.

Read imagegen when producing visual concepts. For real OpenAI extraction use the installed openai-developers:openai-platform-api-key skill and its credential flow. Use browser tools for live reference inspection and rendered QA. Use deployment/provider skills when those capabilities become necessary. Do not assume plugins or credentials are active merely because this brief mentions them; verify tool availability. Keep useful work moving when one external integration is blocked. Do not introduce a design-approval pause unless the user requests it or an applicable instruction actually requires it.

## Visual direction: both references, one coherent product
Primary design reference: https://intunepckgr.com/
Secondary product and design reference: https://parseur.com/

Inspect both in a real browser at desktop and mobile sizes, including lower sections. Search extraction alone is insufficient: IntunePckgr's page did not expose useful text through ordinary web extraction. Inspect public Parseur documentation, screenshots and videos for application workflows; if an authenticated session is available and authorized, inspect it read-only. Document screens inferred from public materials. Do not claim to have inspected an authenticated app that you could not access.

The parent inspected both hero screens on 6 September 2026:
- IntunePckgr: true white background; strong black sans-serif headings; oversized emphasis; indigo/periwinkle primary buttons and outline secondary buttons with pill shapes; restrained blue accents; ample whitespace; left copy/right illustration composition; a handwritten supporting line and underline accent; friendly blue illustration; slim navigation and subtle borders.
- Parseur: white canvas, large black headline with blue emphasis; concrete document-to-fields visual on the right; clearly demonstrated intake -> extraction -> structured output workflow; product examples and operational information rather than abstract AI messaging.
Treat these as observations to verify, not exact sampled design tokens.

Use IntunePckgr as the stronger visual influence for the landing page, then cascade that visual language through onboarding, app shell, tables, forms, document viewer, schema editor, integrations, billing and settings. Use Parseur for product information architecture and document-workflow clarity. Carry one shared palette, type scale, spacing system, radius scale, button system, borders, icons and interaction language throughout. Dense work screens should remain efficient and readable; playful marketing illustration should not crowd the document editor.

Create coordinated Image Gen concepts before implementation, following the Build Web Apps skill. Cover the full landing-page sequence and the main app states, not only a hero. Create original document-processing illustration assets inspired by the reference's tone rather than copying its mascot. Keep real app controls and text code-native. Extract reusable tokens and component variants. Use the user-supplied design direction without substituting a generic SaaS template, arbitrary dark theme or unrelated card grid.

Landing page: navigation, clear offer and working primary CTA, document-to-data product demonstration, intake/extraction/review/export workflow, supported use cases and formats, feature sections, integrations with truthful availability, configurable pricing, an explicitly illustrative ROI calculator, FAQ and footer. Only include security/product claims we can substantiate. The hero should show our actual app workflow or an accurate sample of it.

## Feature parity inventory
Create docs/PARITY-MATRIX.md before substantial coding. Inspect current official Parseur feature pages, help centre and developer docs. For each capability record source URL, observed behaviour, our route/component/backend, acceptance test, priority and status: verified working, implemented but unverified, blocked by an external dependency, or deferred with an explicit reason. Do not invent undocumented internals or promise unlimited parity.

Use these references as starting points:
- https://parseur.com/
- https://parseur.com/features
- https://parseur.com/pricing
- https://help.parseur.com/
- https://developer.parseur.com/
Follow observed navigation links to capture, extraction, normalization, exports and format documentation.

Implement in this order, retaining the broader parity target:

1. Workspace and onboarding
Real authentication, account/session handling, workspace membership and roles; create a parser/mailbox; select a sample use case or custom schema; upload a first document; define fields; review a result; download/export it. Provide synthetic sample documents so the workflow is discoverable without requiring private customer files.

2. Parser/mailbox management
List/create/rename/archive parsers, choose extraction mode and instructions, configure locale/timezone, field schema and output mapping, document history, usage and settings. Workspaces and parsers must persist. Support separate parser configurations within one workspace.

3. Capture and document lifecycle
Drag-and-drop and batch upload; PDF, PNG/JPEG and email text/EML first; inspect Parseur's current format list and extend feasible formats such as CSV/XLSX/DOCX in later implementation passes. Accept API submissions. Build dedicated inbound-email routing with a verified provider adapter, including attachment handling and provider signature checks. Never display an unprovisioned email address as live.
Track received, queued, processing, needs review, processed, exporting, exported and failed states. Include pagination, search, filters, bulk actions, duplicate detection, retry/reprocess and deletion. Limits must be explicit and enforced server-side.

4. Extraction and field/schema editor
Implement real schema-constrained AI extraction. Read native PDF text where appropriate and use vision/OCR for scans and images. Support strings, numbers, dates, booleans, currencies, multiline text, arrays/tables and nested line items; required fields, field instructions, defaults and schema versions.
A missing value should remain missing, not fabricated. Preserve provenance: page number and available text/source evidence; highlight coordinates only when actually available. Keep raw extracted values separate from normalized values and user corrections.
Audit and implement template/rule extraction where feasible: text anchors and/or selectable document regions, saved templates and explicit matching behaviour. A mode toggle without a working engine is not parity. Record unsupported behaviours precisely.

5. Review, normalization and validation
Split document preview and editable field/table pane; page navigation/zoom; keyboard navigation; correction, approval and reprocessing with clear version history. Normalize dates, currency and numbers, trim/transform text, preserve leading zeros in identifiers, check required fields and reconcile line-item totals where applicable. Show validation issues with explanations. Do not label uncalibrated model guesses as statistical confidence.
Extraction runs must pin document/schema/prompt/model versions so reprocessing does not silently overwrite approved outputs. Use customer corrections in that parser's workflow; do not train across tenants by default.

6. Exports and integrations
Real CSV, XLSX and JSON downloads, including configurable column mapping and line-item handling. Prevent spreadsheet formula injection. Implement authenticated, signed outbound webhooks with delivery status, retries, idempotency and replay controls.
Provide a real API for uploads, job status and results, with scoped revocable API keys and documentation.
Implement Google Sheets when credentials are available. Make Zapier/Make/n8n/Power Automate usable through honest API/webhook recipes and validated examples; do not call a generic webhook a published native marketplace connector. Keep direct integrations and bridges distinct. Inspect additional Parseur connectors and track their implementation in the parity matrix.

7. Usage, billing and operations
Page/document usage ledger, quotas, concurrency limits, model cost tracking and configurable plan limits. Stripe test-mode checkout, subscription webhooks and billing portal through the relevant skill when available; do not activate live charges. Pricing is our configurable assumption, not Parseur's financial evidence.
Workspace settings, member permissions, API keys, retention, notifications, document deletion, audit events and clear failure diagnostics. Provide troubleshooting/help pages that match actual behaviour.

## Architecture and build approach
Default stack: TypeScript, React + Vite, React Router, shared CSS/Tailwind tokens and appropriate shadcn primitives for the frontend, following Build Web Apps defaults. Keep components modular by feature rather than one giant app file.
Use a typed server/API and durable background worker. Prefer Postgres with migrations, managed authentication and private object storage through Supabase if accessible; use a queue design appropriate to the chosen deployment, initially a durable Postgres jobs table if sufficient. Record final choices in docs/ARCHITECTURE.md. Avoid microservice sprawl.
Keep provider access behind server-side adapters. Reuse an existing authorized server-side gateway only after verifying its contract and adding isolated routes; do not modify unrelated products.
Suggested entities: users, workspaces, memberships, parsers, schema versions, templates, documents, document files, jobs, extraction runs, extracted fields/line items, corrections, approvals, export mappings, integrations, webhook deliveries, API keys, usage ledger, subscriptions and audit events.
Use private storage and tenant-scoped authorization for every document, run, export, job and API route. Protect secrets, redact logs, validate uploads, limit file/page sizes, expire signed URLs and restrict outbound webhook destinations against internal-network access. Treat document contents as untrusted data, never instructions to execute tools.
Processing must survive refreshes and worker restarts. Use bounded retries, timeouts, idempotency, transactional job claiming and explicit recoverable failure states. Meter once per billable event, including retries and reprocessing rules.
Provide migrations, environment documentation, local startup commands and fixture generation. Any local demo mode must be labelled, isolated and reproducible. It cannot stand in for the real extraction path or production authentication.

## Execution milestones and verification
A. Inspect references, save the feature matrix and architecture, create concepts and design tokens.
B. Implement the landing page plus complete app shell/onboarding in the shared system.
C. Complete one real vertical slice: authenticated upload -> durable processing -> structured extraction -> correction/approval -> persisted CSV/XLSX/JSON export.
D. Continue through template extraction, batches, email/API intake, integrations, quotas, billing and team/settings features. Milestones sequence the work; they are not permission to stop after a mockup.
E. Run browser QA, functional tests, extraction evaluation and a code-based defensive review. Fix material failures and compare rendered screenshots directly with concepts using view_image as required by the skill.

Use a held-out synthetic document set covering multiple layouts, scans, multi-page line items, missing fields, duplicates, malformed files and decimal/date formats. Report field-level correctness and failure handling; measure rather than invent accuracy percentages.
Test workspace isolation with two accounts, role restrictions, invalid uploads, duplicate inbound events, worker retry/restart, export escaping, webhook retries, usage idempotency and subscription-event replay. Use local owned fixtures and controlled endpoints.
Verify the real app in the browser at desktop, tablet and mobile widths. Exercise every shipped button and route, empty/loading/error states, forms, filters, document review and downloads. Include accessibility, keyboard/focus behaviour, no horizontal overflow and browser-console checks.
Retain meaningful evidence in docs/VERIFICATION.md and docs/RELEASE-GATES.md. Separate local tests, real AI-provider verification, deployed revision, live email delivery, third-party integration verification, billing test mode and actual customer use.
If credentials, DNS, authentication or an external account action blocks a capability, finish all independent work and state the exact unblock needed. Never substitute a pretend success state or mark that integration verified.

## Working style and handoff
Proceed autonomously with sensible reversible decisions. The user wants implementation now; do not redirect this task into another validation debate, request permission to begin, or require a sales pilot before coding.
The product should be self-service and manageable asynchronously. Prefer reusable configuration and clear error handling over bespoke customer setup.
Keep short progress updates, maintain the parity matrix and goal, and continue until required work is completed or genuinely blocked. Do not buy domains/services, contact customers, accept new paid plans or make public production changes without applicable authorization.
At handoff provide the runnable app location, startup instructions, screenshots, the exact implemented feature list, test results, real integration status and concrete remaining gates. A polished frontend alone is not completion.
Start now by confirming ultra reasoning is in the task configuration if visible, reading the required skill, creating the goal, inspecting the references, and then designing and building.

