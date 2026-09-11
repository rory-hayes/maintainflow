# MaintainFlow document application: readiness on 11 September 2026

## Decision

**Not ready for unrestricted self-service outreach or paid production onboarding.** The document workflow is implemented and has prior local acceptance evidence, but the replacement has not yet demonstrated a deployed backend, production account recovery/verification, private storage recovery, or actual provider delivery. Repository replacement, Stripe catalog setup, local tests, domain deployment and customer use are separate states.

This report combines the code/configuration audit with current local test, actual container and fresh-account evidence. No hosted success is inferred from those checks.

## Implemented application

- Password signup/sign-in/sign-out/change, hashed sessions, workspace membership/roles and scoped API keys.
- Parser/schema management, deterministic and OpenAI extraction, durable intake/jobs, native document and image support, source review, corrections and immutable approvals.
- CSV/XLSX/JSON exports, approval webhook delivery records, usage/quota enforcement, document deletion/retention and interrupted-intake cleanup.
- Controlled Resend, Google Sheets and Stripe test adapters. A separately labelled local billing mock exists and is disabled in production.

The prior 8 September evidence contains 184 passing tests and a successful TypeScript/Vite build for its recorded source identity. Earlier browser evidence includes actual AI receipt upload, worker processing, source comparison, approval, JSON export and reload. That historical record is not a substitute for testing the replacement revision or its hosted environment.

## Production blockers and next evidence

| Priority | Gap | Implementation evidence | Completion evidence |
| --- | --- | --- | --- |
| P0 | Hosted API, worker and private originals | `server/app.ts`, `server/core/worker.ts`, `server/core/intake.ts` use a long-running server/worker and filesystem originals. New `Dockerfile`/`compose.yaml` package an isolated candidate; a static frontend cannot fulfill this workflow. | Identified hosted revision, HTTPS routing, actual document processing, private-original retrieval/deletion, restart recovery and a file between 4.5 and 10 MB through final routing. |
| P0 | Safe database provisioning | `migrations/001_core.sql` creates generic public-schema tables; `scripts/migrate.ts` grants the app role access to all public tables. | Dedicated database or reviewed schema isolation; never apply these directly to the legacy product database. Prove migrations, restricted roles and two-workspace isolation. |
| P0 | Production account lifecycle | `server/core/auth-routes.ts` provides passwords and sessions; there is no email verification or forgotten-password recovery. Invitations are manual. | Real verification, recovery and invitation delivery; wrong/expired/replayed token rejection, current membership and session revocation. |
| P0 | Production billing | `server/integrations/providers.ts` accepts test keys/prices/events only. Mock billing is unavailable in production. Plans are Explore €0/50 pages/1 parser, Standard €29/1,000 pages/10 parsers and Team €79/5,000 pages/50 parsers. | Match created catalog IDs to the intended account/mode, configure server credentials and callbacks, and prove hosted test Checkout, webhook reconciliation, portal changes/cancellation and enforced entitlement changes. Live charging remains a separate activation step. |
| P0 | Backup and restore | PostgreSQL and original files are separate durable stores; integration tokens require the same stable encryption key. | Encrypted off-host backups, documented retention and a successful isolated restore of database + originals + encryption configuration. |
| P0 | Public service terms and privacy | `src/features/marketing/Help.tsx` expressly describes local preview terms and unfinished privacy details. | Final operator/support details, processing/provider and retention disclosures consistent with the chosen hosting and service. |
| P1 | Resend and Sheets delivery | Provider adapters exist but configuration alone is not end-to-end evidence. | A received email creates the correct parser document through the signed public callback; an approved result reaches the actual connected spreadsheet and retries do not duplicate it. |
| P1 | Abuse controls and operational monitoring | Auth attempt counters are process-local; proxy/client-IP configuration and public AI signup abuse need review. `/api/health` reports only API liveness, and the worker has no heartbeat probe. | Distributed authentication limits, bounded signup/AI spend exposure, dependency readiness, worker/queue-age alerts, safe log retention and alert delivery. |
| P1 | Decoder/host isolation and capacity | Subprocess decoding has byte/page/output/deadline/concurrency limits, but shares the service OS identity. Basic native text/image decoding, private-file access and production API startup passed inside the restricted local container. | Full format/size and adversarial resource tests, host/egress controls and recovery under load; the basic container check does not establish capacity or a separate decoder security sandbox. |

Signup previously assigned every new workspace the development allowance of 1,000 pages and 25 parsers, contradicting the advertised Explore plan. This is corrected in the replacement. Three new integration tests cover saved defaults, quota enforcement and preservation of existing plans. The fresh browser account showed 1 of 50 pages used and one active parser allowed.

## Deployment candidate and promotion hold

`compose.yaml` runs PostgreSQL, one-shot migrations, API and a separate worker. API and worker share private originals and stable encryption configuration. Database has no published host port; raw application HTTP binds the host loopback interface. Production encryption configuration is checked at module startup, so missing/invalid keys prevent boot. Local environment files and data do not enter the image.

The Vercel configuration deliberately holds this replacement: automatic Git builds are canceled, and manual frontend-only builds fail with a clear explanation. Keep the current production deployment available until the replacement backend and domain routing pass acceptance. The old Next.js build command/cron is not compatible with this application.

See [DEPLOYMENT.md](DEPLOYMENT.md) for the isolated setup, promotion criteria and rollback requirements. Packaging verification passed TypeScript checking, shell syntax, YAML parsing/invariants and missing/invalid/valid production-key checks. Starting the existing Colima VM subsequently enabled a real image build and bounded container verification; Compose remains unavailable as a CLI plugin.

The first Linux build caught a TypeScript variable-shadowing error in the new E2E runner. After its correction, actual container execution found the production homepage returned 403 while the API was healthy. The explicit `/` SPA route fixes that bug; a new isolated production regression verifies root/deep SPA/static asset responses and preserves API JSON 404s without a database or previous frontend build. The original failures are retained in `evidence/production-packaging-2026-09-11/docker-build-first.txt` and `container-checks-first.json`.

The corrected image **`maintainflow-documents:qa-20260911`**, ID **`sha256:8ae3f985e7fb6873e5f4b61a5669e3dbc26f5465086263433e0d61fc7549523a`**, built successfully and passed local checks at **08:16:21–08:16:25 UTC**: non-root UID 1000, read-only root, stable-key startup rejection/round-trip, private volume write/read/delete with 0600 file permissions, native text and image decoder execution, excluded local secrets, API production liveness and homepage HTML. Temporary test containers/volume were cleaned. [Actual checks](evidence/production-packaging-2026-09-11/container-checks.json), [final image build](evidence/production-packaging-2026-09-11/docker-build-final.txt). This is local image acceptance, **not** database/Compose orchestration, provider delivery, hosted deployment, backup/restore or customer-use evidence. The image label explicitly identifies local packaging QA rather than claiming a Git release revision.

## Ordered production plan

1. Preserve and verify the current repository/deployment rollback point; push the replacement code with production promotion held. Record the exact new revision and its complete test/build results.
2. Complete a fresh-user local end-to-end run on that revision, including enforced Explore limits, real processing/review/approval/downloads and retained state after reload. Record any failures and fixes.
3. Select and provision the isolated backend host/database/private storage; configure stable secrets, TLS and same-origin routing. Build and boot the actual image and exercise migration/restart recovery.
4. Complete verification/recovery/invitation mail, public account abuse controls and final service/privacy/support details before opening self-service registration.
5. Verify provider delivery and Stripe test subscription lifecycle on the hosted revision. Preserve existing live provider/catalog/customer data while the replacement is tested.
6. Complete two-workspace isolation, private original deletion/retention, backup/restore and worker/queue monitoring acceptance. Record the final HTTPS domain revision and rollback exercise.
7. Only then decide which verified features can be offered in outreach and activate payments separately. Do not promise automatic email/Sheets delivery or paid subscription behavior until those corresponding checks pass.

## Current verification results

| Area | Result | Evidence and boundary |
| --- | --- | --- |
| Automated application suite | **188/188 passed**, zero failed/skipped | Final run after the production root-route fix, 11 September 08:16–08:17 UTC. Covers extraction/intake, authorization, tenant isolation, durable lifecycle, exports, quotas and controlled provider adapters. Provider mocks in tests are not live provider acceptance. |
| GitHub CI | **New workflow prepared** | The replacement now has its own isolated PostgreSQL test/build workflow; the post-push result must be checked separately. Prior MaintainCode Ads CI results do not apply. |
| Production build | **Passed** | TypeScript and Vite build. Tested source manifest contains 200 files; fingerprint `2ba1993b1a5e3c6582dd224a1ee1d7d0a14a09f24c51a224328f1315486de2f5`. See `evidence/migration-2026-09-11/verification.json`; final transfer integrity records any later packaging-exclusion-only change. |
| Actual Linux container | **Passed bounded acceptance** | Image `sha256:8ae3f985e7fb6873e5f4b61a5669e3dbc26f5465086263433e0d61fc7549523a`; non-root execution, read-only root, private originals write/read/delete, decoder execution, valid-key round trip, missing/invalid-key rejection, API and homepage. Full Compose/database orchestration and hosting remain unverified. |
| Fresh-user HTTP E2E | **7/7 checks passed** | Real API and separate worker, 08:11:46–08:11:51 UTC. Fresh Explore account, two-page PDF/four line items, original-byte verification, duplicate prevention, correction, immutable approval, CSV/XLSX/JSON contents, sign-out/sign-in persistence, mock Team upgrade/cancellation, and second-account isolation. `evidence/migration-2026-09-11/release-e2e.json`. |
| Fresh-user Chrome E2E | **Core workflow passed** | Another new account created in the UI; AI receipt parser, built-in synthetic receipt, real OpenAI worker, source comparison, saved correction, approval, JSON download and reload/history. Browser showed the real Explore limits. `evidence/migration-2026-09-11/browser-acceptance.json`. |
| AI provider | **Actual local request passed** | Engine `openai`, model `gpt-5.4-mini-2026-03-17`, 486 input/123 output tokens; estimated successful-call cost $0.000918. Four expected receipt fields matched. Deliberate merchant correction remained separate from original extraction. One reused synthetic sample is not a general accuracy benchmark. |
| Browser/layout | **Passed inspected states** | Chrome at 1512×745 and 390×844; mobile document view had scroll width 390, no page overflow. Initial completed workflow had zero console warnings/errors. Desktop/mobile screenshots retained locally with the evidence. |
| Stripe | **Test catalog configured; payments still mocked** | Existing Maintain Flow test account, two new document products at €29/€79 monthly. Existing live products/subscriptions were untouched. Hosted Checkout, webhooks and portal were not exercised. |
| Resend / Sheets | **Not accepted** | No actual received-email-to-document or approved-result-to-Sheet delivery in this run. These remain explicit setup and hosted acceptance gates. |
| Live domain | **Cutover held** | `maintainflow.io` was verified serving old `maintaincode-ads` revision `2ad3baf…` at the start. The replacement's Vercel hold prevents publishing a frontend without its stateful backend. Repository main replacement does not establish a live new application. |

The browser receipt is document `e4549183-90f7-43d0-8721-99c090333b94`, run `1c7dee7c-3090-41c5-b602-e1c127f8b157`, approved revision 1. The actual downloaded 505-byte JSON has SHA-256 `c296f0b5c8b71efda41be7fdc542e7924d36a3eca33a82f66b938a0fb20b782f`. It contains the reviewed merchant `Willow Coffee QA`; the saved original remains `Willow Coffee`.

The HTTP run uses a reused synthetic two-page invoice with four line items and total EUR 959.40. It is regression and integration evidence, not a newly held-out extraction benchmark. QA credentials/cookies are retained only in ignored `.local` files with mode 0600.

## Issues found and resolved

1. **Wrong signup entitlements:** new accounts received a development-only 1,000 pages/25 parsers. They now receive the shared Explore 50 pages/one parser/one concurrent job; existing workspace plans are preserved.
2. **Production homepage returned 403:** local Vite hid a Fastify static-directory behavior. The production server now explicitly serves `index.html` at `/`; a production-mode regression verifies root, deep SPA paths, JavaScript assets, health caching and API 404s. Actual container acceptance passed after the fix.
3. **Local services were stopped:** the private database and app/API/worker were restarted. The installed Colima VM was also stopped; it was started to make container verification possible.
4. **Temporary E2E runner compile error:** a shadowed identifier was fixed before the runner executed; final typecheck/build and the real HTTP workflow passed. The first failing container build log is preserved.

Two automation limitations remain separate from application behavior: Chrome denied `fileChooser.setFiles` because the extension lacks file-URL access, so browser intake used the app's synthetic sample; actual PDF multipart upload passed through HTTP. The browser download-event observer timed out, but the app reported success and the matching JSON was located in Downloads and verified byte-for-byte.

## Stripe catalog receipt

Account: `acct_1SLliwF3c6inFQxp`, **test mode**, verified through the saved product detail pages on 11 September.

| Application plan | Monthly price | Product | Price ID |
| --- | --- | --- | --- |
| Explore | Free | No Stripe subscription required | — |
| Standard | EUR 29 | `prod_VEtCMN5UzvP4kS` | `price_1UEPPlF3c6inFQxpqeSckzaf` |
| Team | EUR 79 | `prod_VEtDSaklZSdevv` | `price_1UEPQmF3c6inFQxpHyB4df3d` |

Both products showed zero active subscriptions. The local environment stores the matching test price IDs and keeps `FOLIO_BILLING_MOCK=true`. The Stripe dashboard also showed **payouts paused / required task overdue**; the owner must resolve that account task before relying on payouts. Production activation additionally needs live-mode support, final tax configuration and actual hosted billing lifecycle acceptance.

## Repository handoff

Target: `https://github.com/rory-hayes/maintainflow`, main branch. Rollback branch `backup/pre-folio-2026-09-11` was published and verified at `2ad3baf4aa27a3ac3d3c6a07c80b23b55e706147` before replacement. The migration uses an ordinary commit and preserves history. It does not alter the legacy database or customer subscriptions.

The final task response and the local `evidence/migration-2026-09-11/repository-after.json` receipt record the pushed replacement SHA and post-push domain state. That post-push receipt is retained locally rather than embedding a self-referential commit ID in its own commit. The code is developed under the Folio name; MaintainFlow is the repository/domain and test billing identity for the replacement. Public branding and final launch copy can be aligned during the production release.

## Outreach recommendation

The demonstrated document workflow supports a supervised product demonstration using synthetic or explicitly approved documents. Do not advertise this as an available self-service production service yet. Complete steps 3–6 in the production plan, then offer only the features that have passed hosted acceptance. Paid onboarding follows verified billing activation.

