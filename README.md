# MaintainFlow document workspace (Folio)

An original document-extraction workspace built under the internal project/task name **Parseur**. React/Vite supplies the interface; Fastify, PostgreSQL, and a separate durable worker persist accounts, files, parser schemas, extraction runs, corrections, approvals, and exports. The visual direction is informed by the public IntunePckgr and Parseur references; Folio is not either company.

**12 September hosted preview:** Folio is deployed at [maintainflow.io](https://maintainflow.io) as an invite-only preview with mocked billing. At scheduler acceptance, Git revision `685d83f` on `rory-hayes/maintainflow` served the canonical Vercel deployment; application code is unchanged from `c2aa2f4`. CI passed **230 tests**, typecheck, hosted packaging and runtime checks, and both CodeQL analyses passed. Canonical-domain browser acceptance on `c2aa2f4` passed login, upload, extraction, correction, approval, JSON download, reload, mobile navigation and logout. Hosted recovery of a synthetic queued job and expired lease passed on `685d83f`, with unchanged run IDs and usage after a second observation and successful fixture cleanup. Resend receiving and Google Sheets authorization/delivery remain unverified. See [current hosted status and evidence](docs/HOSTED-PREVIEW-STATUS-2026-09-12.md) and [scheduler acceptance](docs/evidence/free-preview-2026-09-11/scheduler-acceptance-2026-09-12.json). Hosting plans are unchanged and real Stripe testing remains deferred. The previous code remains preserved on `backup/pre-folio-2026-09-11`; the [11 September rollout plan](docs/PRODUCTION-READINESS-2026-09-11.md) records the earlier migration gates.

**Historical local scope (8 September):** real local authentication, deterministic text-anchor extraction and schema-constrained OpenAI extraction for native text, PDFs and images. Secure OpenAI setup is complete. The browser has now created **AI receipt QA**, uploaded a synthetic image, reviewed the actual worker result, approved it and downloaded matching JSON; reload preserves the approval and all seven lifecycle entries. [AI browser acceptance](docs/AI-BROWSER-ACCEPTANCE.md) records the exact result. That source passed **184/184 tests** and the build; the September 11 report records the replacement source verification. [Provider setup](docs/PROVIDER-SETUP.md) records nine new billing-mock tests and eight managed-inbox tests, with real provider acceptance kept separate. Parser restoration now shares creation’s active-capacity lock/check, and membership/invitation changes record atomic audit events; [workspace integrity](docs/WORKSPACE-INTEGRITY.md) records seven added regressions. Prior source-disclosure desktop/mobile navigation and keyboard checks remain preserved. An independently authored held-out set measured **49/51 expected values**, exposing date text that included adjacent wording/time. Prompt v2 narrows date selection; the unchanged set then measured **51/51 in a regression replay**. The original failure and earlier 74/74 regression remain preserved in [AI extraction evidence](docs/AI-EXTRACTION.md). These small synthetic results do not establish general accuracy. At the user’s request, billing now uses an explicitly labelled local mock; its browser selection/change/cancel/reload workflow passed and real Stripe verification is deferred. Resend account access is confirmed, but receiving setup and Google Sheets OAuth/delivery remain incomplete. That September 8 checkpoint did not establish production deployment, managed authentication, cloud storage or customer use. See the historical [verification](docs/VERIFICATION.md) and [remaining gates](docs/RELEASE-GATES.md); current hosted evidence is recorded in the September 12 status above.

## Run locally

The current bootstrap targets this macOS machine: Node.js/npm and PostgreSQL 17 command-line tools at `/opt/homebrew/bin` are installed. Other operating systems need a compatible PostgreSQL instance and the connection variables below; the bundled `local-db.mjs` is not a portable installer. The observed Node runtime during testing was 26.5.0.

```sh
cd /Users/rory/Documents/Ideation/parseur
npm ci
npm run setup
npm run dev
```

Open **http://127.0.0.1:5178**. Vite proxies `/api` to **http://127.0.0.1:4318**. `npm run dev` starts the Vite frontend, Fastify API, and durable worker together. Keep all three running for the upload-to-result workflow. Use `127.0.0.1` consistently because the default allowed application origin is exact.

`npm run setup` starts a private local PostgreSQL database and applies numbered migrations. The database uses `.local/socket/.s.PGSQL.55432`; TCP is disabled. Its local trust authentication is restricted by a private Unix-socket directory and is a local-development choice. Records live in `.local/pg`; uploaded originals live in `.local/files`; the development encryption key lives in `.local/secrets`. These paths and `.env*` are ignored by Git. Preserve them if you want to keep the workspace; do not delete `.local/` as a routine restart.

Stop the development processes with Ctrl-C. The database remains available until `npm run db:stop`. On restart, run `npm run setup` and `npm run dev` again. A normal app refresh or worker restart does not clear jobs, documents, or approved revisions.

## First complete workflow

1. Register a local account and name the workspace. There is no shared seeded account or password.
2. Create a parser using Invoice, Purchase order, Receipt, Lead email, or Custom. Choose **Text-anchor rules** for saved labelled layouts, or **AI extraction** when the runtime reports it configured. AI sends document content to the configured OpenAI project.
3. Use the parser's synthetic sample, or upload a document supported by the selected mode. The sample enters the real intake, private storage, usage ledger, and worker; it does not insert a fabricated result.
4. Review the source beside the extracted fields and tables. Compare AI-read image quotes with the original; they are not independently verified native text. Missing/invalid values remain reviewable. Correct values and resolve validation issues, then approve.
5. Download the approved revision as CSV, XLSX, or JSON. Reprocessing creates another run and preserves earlier approvals in history.

Review now exposes nested and table quotes in an immutable original-source disclosure, retaining original row numbers even when corrected rows are added, removed or reordered. AI-read evidence keeps its label. See [review provenance](docs/REVIEW-PROVENANCE.md).

History records received, queued, processing, review, approval and export activity across runs, with selected-run provenance shown separately. Export attempts retain bounded success/failure details and identify the approved revision used. Earlier documents do not receive fabricated history. See [document lifecycle semantics](docs/DOCUMENT-LIFECYCLE.md) for transaction and recovery limits.

The header bell shows real completed/failed processing jobs, with personal read status. Workspace administrators can enable or hide the inbox in Settings; no notification emails are sent. Configured retention removes aged originals and local derived copies, deferring active jobs. [Notification and retention semantics](docs/NOTIFICATIONS-RETENTION.md) document the exact deletion boundary and passing local/browser checks.

`npm run fixtures` generates ten original synthetic files and a manifest under `fixtures/generated`. They include a two-page invoice with continuing line items, German number/date formatting, missing values, lead email, CSV/XLSX/DOCX receipts, an unconfigured freeform layout, a scan, and a malformed PDF. Match the parser preset and locale in `fixtures/generated/manifest.json`; these inputs exercise different schema workflows. The freeform and scan examples demonstrate rules-mode limits; separate real AI measurements retain their raw values, evidence warnings and expected missing fields. Small synthetic results do not establish general accuracy.

## Formats and metering

PDF native text, TXT, EML body text, CSV, XLSX worksheet content, DOCX text, and HTML-to-text intake are implemented. AI mode sends original PDFs and PNG/JPEG images to the configured OpenAI provider and other formats as decoded text. Rules mode still reports an actionable failure for documents without readable text; an unconfigured AI job also fails explicitly. EML upload processes the email body; inbound-provider attachments use the separate Resend path.

HTML conversion preserves long values, heading case and flat table boundaries while omitting script/style content and appended link URLs. HTML-only EML uses the same converter; an actual plain-text alternative takes precedence. These are tested text-conversion behaviors, not a promise to reproduce arbitrary HTML layouts. Incomplete Office containers are rejected. AI CSV normalization decodes only exact quoted source-cell tokens, preserving raw output and evidence; malformed, ambiguous or over-limit inputs remain unchanged. See [AI extraction limits](docs/AI-EXTRACTION.md).

Limits are 10 MiB per file, 20 files per batch, 30 PDF pages, 40 megapixels per image, and 30 XLSX sheets with at most 10,000 rows/200 columns per sheet. Office container expansion is limited to 40 MiB/2,000 entries. Encrypted/malformed PDFs and unsupported formats are rejected. DOCX/text/email count as one extraction page; each spreadsheet sheet counts as one page, not one row.

Decoding runs in a bounded subprocess with a scrubbed environment, 30-second deadline and per-process concurrency of two. Durable reservations and cursor-based maintenance recover interrupted original writes. The subprocess is not an OS sandbox; exact controls and deployment limits are in [DECODER-RECOVERY.md](docs/DECODER-RECOVERY.md).

Each accepted unique upload reserves its pages once. Automatic retries and duplicate content in the same parser do not reserve local pages again. OpenAI retries may incur provider charges; recorded model cost estimates successful responses only and is not billing reconciliation. Explicit reprocessing reserves those pages again. New accounts and additional workspaces use **Explore**: 50 pages/month, one active parser, and one concurrent job. Existing workspace entitlements are preserved. The public Explore/Standard/Team prices and limits in `shared/plans.ts` are configurable launch assumptions; viewing a pricing CTA does not activate a plan or billing.

## Configuration

The server reads `.env.local` and `.env` from the project directory. Keep server secrets out of client code, Vite-prefixed variables, source control, logs, and browser storage.

| Variable | Default / purpose |
| --- | --- |
| `APP_ORIGIN` | `http://127.0.0.1:5178`; exact browser origin and trusted provider return URLs |
| `PORT`, `HOST` | API `4318`, loopback `127.0.0.1` |
| `STORAGE_DIR` | `.local/files`; private original-object adapter |
| `DATABASE_ADMIN_URL` | Optional server migration/worker administrator connection URL |
| `DATABASE_URL` | Optional restricted application connection URL; must not bypass RLS |
| `PGHOST`, `PGPORT`, `PGDATABASE` | Local fallback `.local/socket`, `55432`, `folio` |
| `PGADMINUSER`, `PGUSER` | Local fallback `folio_admin`, `folio_app` |
| `INTEGRATION_ENCRYPTION_KEY` | Production-required base64 32-byte AES-GCM key; local private file fallback in development |
| `OPENAI_API_KEY` | Server-only OpenAI credential; current local setup was completed through the approved secure flow |
| `FOLIO_BILLING_MOCK` | Literal `true` opts into local billing simulation; disabled when `NODE_ENV=production` |
| `LOG_LEVEL` | `warn` |

Resend custom-domain and managed-inbox settings, Google OAuth configuration, and the separate deferred Stripe test adapter are documented in [PROVIDERS.md](docs/PROVIDERS.md). The user-requested billing mock changes real local plan limits without Stripe calls or payment; the UI identifies its simulated state. Missing receiving/OAuth prerequisites keep those connections blocked, with no fabricated usable inbox or spreadsheet-sync success. OpenAI uses the fixed `gpt-5.4-mini-2026-03-17` snapshot through explicit API/worker entrypoint initialization. Importing the application for tests does not enable it. [AI-EXTRACTION.md](docs/AI-EXTRACTION.md) records its provenance, cost and evidence contracts.

The public API currently uses `/api`, not `/api/v1`. `/help/api` documents scoped bearer keys, asynchronous upload, job status, results, approved exports, signed webhooks, and automation bridges. `/api/health` reports the API process; it is not an end-to-end queue, storage, provider, or production-readiness check.

## Verification and build commands

```sh
npm run typecheck
npm test
node --import tsx scripts/evaluate.ts
npm run build
```

The automated test suite uses controlled provider fixtures; it does not run the real OpenAI evaluator. Use a running migrated local database for tests. Keep test files serial because they share the local jobs table, and stop the development worker while the controlled tests own fixture jobs. For an individual suite without the `tsx` CLI's IPC listener: `node --import tsx --test --test-concurrency=1 tests/providers.test.ts`. A restricted execution environment may need permission to connect to the local Unix socket.

`npm run build` checks TypeScript and emits the frontend to `dist`. `npm start` runs the production-configured API/static server only; it does **not** start a worker, provision a database, configure TLS, or establish a production deployment. A production runtime also needs a separately supervised worker, explicit origin/storage/database/secrets, auth recovery and verification decisions, migrations, backups, and the release checks below. No public deployment is implied by these commands.

## Project guide

| Path | Purpose |
| --- | --- |
| `BUILD-BRIEF.md` | Preserved user scope and acceptance requirements |
| `src/features`, `src/components`, `src/styles` | Feature screens, shared controls, and design tokens |
| `server/core`, `server/integrations` | Auth/intake/rules/AI/review/operations and provider/export adapters |
| `shared`, `migrations` | Types, presets, configurable plans, and database migrations |
| `tests`, `scripts`, `fixtures` | Local fixtures, functional checks, bootstrap and measured evaluation |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Runtime, persistence, isolation, and provider boundaries |
| [PARITY-MATRIX.md](docs/PARITY-MATRIX.md) | 47 referenced capabilities with current implementation/evidence status |
| [REFERENCE-WORKFLOWS.md](docs/REFERENCE-WORKFLOWS.md) | Public source screenshots/video observations and inferred screens |
| [AI-EXTRACTION.md](docs/AI-EXTRACTION.md) | Implemented OpenAI contract, synthetic live results and remaining AI verification |
| [VERIFICATION.md](docs/VERIFICATION.md) | Current test/evaluation evidence and browser QA ledger |
| [AI-BROWSER-ACCEPTANCE.md](docs/AI-BROWSER-ACCEPTANCE.md) | Real AI image intake, review, approved JSON, persisted lifecycle and usage |
| [WORKSPACE-INTEGRITY.md](docs/WORKSPACE-INTEGRITY.md) | Transactional parser capacity and membership audit guarantees |
| [RELEASE-GATES.md](docs/RELEASE-GATES.md) | Concrete remaining work and external unblocks |

Historical [verification from 8 September](docs/evidence/provider-setup-2026-09-08/verification.json) records **184 passing tests**, a successful TypeScript/Vite build and **191 source files**, fingerprint `a1b67de414f66a5724ead433ff286f28620a77014a8f41f0f331cebef9de99e0`, unchanged during that verification. [Provider setup](docs/PROVIDER-SETUP.md) records the exact times, local billing mock, managed-inbox contract and account approvals outstanding at that checkpoint. The [167-test workspace checkpoint](docs/WORKSPACE-INTEGRITY.md), earlier 160-test records, [AI browser acceptance](docs/AI-BROWSER-ACCEPTANCE.md), [source-disclosure browser proof](docs/REVIEW-PROVENANCE.md) and model evaluations retain their original dates and scope. The [12 September status](docs/HOSTED-PREVIEW-STATUS-2026-09-12.md) records the current deployed preview, [230-test CI run](https://github.com/rory-hayes/maintainflow/actions/runs/34695747549) and [CodeQL run](https://github.com/rory-hayes/maintainflow/actions/runs/34695747013) for `685d83f`. Resend/Sheets delivery and customer use remain unverified; real Stripe testing is deferred by the user.
