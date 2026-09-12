# Hosted preview status — 12 September 2026

Folio is live at [maintainflow.io](https://maintainflow.io) as an invite-only hosted preview, with billing mocked. The Git deployment verified during acceptance and its GitHub checks passed; its application code is unchanged from the revision that passed all 11 canonical-domain browser checks. The authenticated watchdog is installed, and hosted recovery of synthetic queued and expired-lease jobs passed with duplicate-prevention observation and fixture cleanup. Resend receiving and Google Sheets authorization/delivery remain unverified.

## Verified Git deployment at scheduler acceptance

- Deployment during scheduler acceptance: `dpl_DPPcG9J4xsjNhK6UFe4Yj9bAffV2`, source `git`, revision `685d83f4bff6e6a9160eba4b908046cb24604b07`. This documentation/evidence commit leaves application code unchanged from `c2aa2f418da1e0ce0273abb0e9eaa1dc73e82f1b`.
- Actual domain aliases and `/api/health` confirmed this revision; hosted, invite-only preview mode remains enabled. The [earlier canonical HTTP smoke](evidence/free-preview-2026-09-11/canonical-git-deployment-2026-09-12.json) retains its original `c2aa2f4` revision and records the health/config checks, sign-in app shell and HTTP 308 redirect from www to the apex.
- [CI run 34695747549](https://github.com/rory-hayes/maintainflow/actions/runs/34695747549) passed for `685d83f`: **230 tests**, zero failures/skips/cancellations, typecheck, hosted packaging and isolated function/runtime decoder verification.
- [CodeQL run 34695747013](https://github.com/rory-hayes/maintainflow/actions/runs/34695747013) passed both JavaScript/TypeScript and Actions analyses for the same revision.
- Authenticated canonical-domain browser acceptance on `c2aa2f4` **passed all 11 checks**: real form login, unique signed PDF upload, deterministic extraction, both private PDF pages, saved correction, pinned approval, actual JSON browser download, reload persistence, 390px mobile fields/document/navigation, and logout. No unexpected browser errors or horizontal overflow were observed. [Canonical browser evidence](evidence/free-preview-2026-09-11/canonical-browser-2026-09-12-adfe959c.json). Earlier runner failures were caused by parser-readiness bypass, an exact label matcher, full-page screenshot resizing and expected query cancellation; no application change was required. Original receipts remain outside the repository.
- The following candidate receipts retain their original revision and scope.

## Accepted candidate evidence — revision 11165f4

- Deployment: `dpl_ConmCwJCBhZxKyonNAYqEkweoLNL` at `https://maintainflow-1yqnlg26n-rorys-projects-accf0d71.vercel.app`.
- Runtime revision: `11165f404a169ccf3a61fb51781231aa554f1127`, Node 24, region `fra1`; private Node function 66.7 MiB. Cloud typecheck/build passed with zero dependency audit findings.
- The full HTTP acceptance passed seven groups over 63 requests: invite-gated registration; signed upload and CORS; deterministic extraction and source evidence; correction and pinned approval; CSV/XLSX/JSON exports; a valid 6 MiB original upload/download; session revocation/relogin; mocked upgrade/cancel; tenant and unauthenticated denials. SHA checks matched downloaded originals. Replay retained one document/job/usage entry.
- See [complete HTTP evidence](evidence/free-preview-2026-09-11/hosted-e2e-2026-09-12T12-28-25-328Z-1a3a73aa-b91a-455d-b3b2-7666e6357dee.json). This runner uses deterministic rules. A separate hosted AI acceptance also passed: seven core invoice fields, native matched-text grounding, job/schema/source provenance, provider token usage and exactly one two-page ledger event. Mock Explore was restored after the test. See [AI evidence](evidence/free-preview-2026-09-11/hosted-ai-2026-09-12T12-34-05-142Z-0de082ec-f99a-4036-8481-6751ff173c30.json).
- An isolated Playwright browser verified meaningful desktop/mobile review UI, private PDF rendering, page navigation, no relevant console errors and no horizontal overflow at 390px. This used an owned synthetic session on candidate revision `11165f4`; it is separate from the completed canonical-domain workflow above. Screenshots and browser receipts are outside the repository under `/private/tmp/folio-hosted-browser-20260912/`.

## Configuration and fixes

The user executed the private database bootstrap. Both restricted pooler logins passed verified TLS, correct search path/timeouts, and isolation checks. Neither can access legacy tables/definers, create schema objects, edit migrations or rewrite the document journal. [Database evidence](evidence/free-preview-2026-09-11/hosted-database-2026-09-12.json).

The inherited Vercel Storage key was rejected with `AccessDenied`. The user supplied a current server Secret key in the ignored mode-0600 local file. It passed a real HTTP-200 bucket lookup: private `folio-originals`, 10 MiB cap, octet-stream MIME policy. Only the production `SUPABASE_SERVICE_ROLE_KEY` was replaced as a sensitive server variable. The accepted candidate and canonical Git deployment use that production configuration. [Key validation](evidence/free-preview-2026-09-11/hosted-storage-key-validation-2026-09-12.json).

Hosted testing also found and fixed shared middleware overriding the original route's `no-referrer` policy. Ten focused direct-upload tests passed, including a reproduction of that exact failure. A test-only bigint assertion was corrected to accept PostgreSQL's lossless decimal-string byte size; hashes and page counts were already correct. Hosted exports enforce a 4 MiB rendered-byte limit before snapshot storage/download; eight lifecycle tests passed. Thirteen storage diagnostic tests passed without exposing credentials or provider response text.

The user approved the restricted logins, server credentials, private Storage and authenticated worker setup. No additional setup approval is required. Vercel remains Hobby; Supabase was last directly verified Free/Nano on 11 September. No paid plan change was made. Billing is visibly simulated and the hosted mock upgrade/cancel checks made no Stripe call.

## Hosted scheduler acceptance

The first private installer returned PostgreSQL `42501`: its metadata `SELECT FOR UPDATE` required UPDATE privilege that the Vault/cron access role did not have. The corrected installer removed those row locks while retaining the transaction advisory lock, exact conflict guards and supported function APIs. **Six local restricted-ACL checks passed** against synthetic SELECT-only metadata tables and function APIs; these local checks are separate from the hosted proof below. The user ran the corrected installer, and the supplied SQL Editor screenshot showed job ID 1 active.

The [hosted scheduler acceptance summary](evidence/free-preview-2026-09-11/scheduler-acceptance-2026-09-12.json) records the following observations on deployed `685d83f`, with no application requests, manual worker calls or deployments made by the acceptance operators during the recovery observation window. All times are UTC on 12 September:

- Two isolated synthetic jobs were seeded at 13:32:26 and became due at 13:33:56.552924. Vercel recorded an authenticated `POST /api/internal/worker` returning HTTP 202 at 13:34:00.
- The queued job completed at 13:34:02.685 on attempt 1; the job with an expired lease completed at 13:34:02.766 on attempt 2. The 13:34:27.355 observation reported `durableRecoveryPassed=true`.
- A second observation at 13:35:47.510, **80.155 seconds later**, found the same run IDs, attempts and update times. Usage remained exactly two ledger entries and two pages.
- Cleanup at 13:36:16.762 reported `fixtureRemoved=true` for the marked QA workspace.

This demonstrates hosted recovery and no duplicate runs or usage during the observed window. The expired lease was synthetic; the test did not physically kill a running process. Timing and Vercel logs correlate the watchdog invocation with recovery, but do not establish exact pg_net request/response-ID correlation.

## Domain, Git and remaining work

Vercel is connected to `rory-hayes/maintainflow`, production branch `main`, with automatic deployments and custom-domain assignment enabled. Both `maintainflow.io` and `www.maintainflow.io` are verified; www redirects to the apex. The migration hold is removed, and the Git deployment at scheduler acceptance served revision `685d83f4bff6e6a9160eba4b908046cb24604b07` on the canonical domain. The prior source remains preserved on `backup/pre-folio-2026-09-11` at `2ad3baf4aa27a3ac3d3c6a07c80b23b55e706147`. Future release checks should read the actual domain alias and runtime revision, because `project.targets.production` can reference a canceled deployment.

1. Complete Resend receiving setup and verify an actual inbound delivery through extraction.
2. Complete Google Sheets authorization and verify delivery of approved values to a sheet.

Neither delivery path nor customer use is verified. Real Stripe is intentionally deferred; hosted billing remains visibly mocked.

Private configuration and credentials stay under ignored `.local/hosted-preview/` and are excluded by `.vercelignore`. Do not print or commit keys, passwords, cookies, invitation codes, signed URLs or private SQL Vault values. Earlier failed QA accounts and receipts are retained separately for diagnosis.
