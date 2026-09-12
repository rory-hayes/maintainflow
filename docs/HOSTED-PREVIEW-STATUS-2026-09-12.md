# Hosted preview status — 12 September 2026

Folio's protected hosted candidate now passes the complete synthetic HTTP workflow on the existing free hosting setup, with billing mocked. The custom domain has not yet been switched in this status snapshot. The authenticated watchdog and external provider setup remain separate gates.

## Verified candidate

- Deployment: `dpl_ConmCwJCBhZxKyonNAYqEkweoLNL` at `https://maintainflow-1yqnlg26n-rorys-projects-accf0d71.vercel.app`.
- Runtime revision: `11165f404a169ccf3a61fb51781231aa554f1127`, Node 24, region `fra1`; private Node function 66.7 MiB. Cloud typecheck/build passed with zero dependency audit findings.
- The full HTTP acceptance passed seven groups over 63 requests: invite-gated registration; signed upload and CORS; deterministic extraction and source evidence; correction and pinned approval; CSV/XLSX/JSON exports; a valid 6 MiB original upload/download; session revocation/relogin; mocked upgrade/cancel; tenant and unauthenticated denials. SHA checks matched downloaded originals. Replay retained one document/job/usage entry.
- See [complete HTTP evidence](evidence/free-preview-2026-09-11/hosted-e2e-2026-09-12T12-28-25-328Z-1a3a73aa-b91a-455d-b3b2-7666e6357dee.json). This runner uses deterministic rules. A separate hosted AI acceptance also passed: seven core invoice fields, native matched-text grounding, job/schema/source provenance, provider token usage and exactly one two-page ledger event. Mock Explore was restored after the test. See [AI evidence](evidence/free-preview-2026-09-11/hosted-ai-2026-09-12T12-34-05-142Z-0de082ec-f99a-4036-8481-6751ff173c30.json).
- An isolated Playwright browser verified meaningful desktop/mobile review UI, private PDF rendering, page navigation, no relevant console errors and no horizontal overflow at 390px. This used an owned synthetic session on the candidate. Real canonical-domain login/upload UI remains pending until promotion. Screenshots and browser receipts are outside the repository under `/private/tmp/folio-hosted-browser-20260912/`.

## Configuration and fixes

The user executed the private database bootstrap. Both restricted pooler logins passed verified TLS, correct search path/timeouts, and isolation checks. Neither can access legacy tables/definers, create schema objects, edit migrations or rewrite the document journal. [Database evidence](evidence/free-preview-2026-09-11/hosted-database-2026-09-12.json).

The inherited Vercel Storage key was rejected with `AccessDenied`. The user supplied a current server Secret key in the ignored mode-0600 local file. It passed a real HTTP-200 bucket lookup: private `folio-originals`, 10 MiB cap, octet-stream MIME policy. Only the production `SUPABASE_SERVICE_ROLE_KEY` was replaced as a sensitive server variable. The accepted candidate uses it. [Key validation](evidence/free-preview-2026-09-11/hosted-storage-key-validation-2026-09-12.json).

Hosted testing also found and fixed shared middleware overriding the original route's `no-referrer` policy. Ten focused direct-upload tests passed, including a reproduction of that exact failure. A test-only bigint assertion was corrected to accept PostgreSQL's lossless decimal-string byte size; hashes and page counts were already correct. Hosted exports enforce a 4 MiB rendered-byte limit before snapshot storage/download; eight lifecycle tests passed. Thirteen storage diagnostic tests passed without exposing credentials or provider response text.

The user approved the restricted logins, server credentials, private Storage and authenticated worker setup. No additional setup approval is required. Vercel remains Hobby; Supabase was last directly verified Free/Nano on 11 September. No paid plan change was made. Billing is visibly simulated and the hosted mock upgrade/cancel checks made no Stripe call.

## Domain, Git and remaining work

Vercel is connected to `rory-hayes/maintainflow`, production branch `main`, with automatic deployments and custom-domain assignment enabled. Both `maintainflow.io` and `www.maintainflow.io` are verified; www redirects to the apex. The last alias readback still points to the previous app deployment `dpl_77dQ7bkAWJwhma6aUHaU5SnpkH5F` at revision `2ad3baf4aa27a3ac3d3c6a07c80b23b55e706147`. Local source removes remote main's migration hold. Source has not yet been pushed; read the actual domain alias after promotion or push, not `project.targets.production`, which can point at a canceled deployment.

1. Push the accepted source to `main` and verify the actual Git deployment and domain alias, then check real canonical-domain login and upload in the isolated browser. The protected candidate has already passed HTTP, UI and AI acceptance.
2. The user runs the already-approved private `.local/hosted-preview/worker-setup-after-promotion.sql` once in Supabase SQL Editor. Computer still fails to initialize despite the user's reinstall; do not repeat reconnect advice without new evidence.
3. After earlier worker invocations finish, use `.local/hosted-preview/scheduler-practical-acceptance.mjs` to seed future-due synthetic queued/expired-lease fixtures, observe durable recovery during a quiet window, correlate Vercel worker 202 logs, observe unchanged run IDs/usage after another minute, and clean only its marked QA workspace. Require `observation.durableRecoveryPassed=true`; an observation command exiting zero alone is not acceptance. This cannot prove exact pg_net request/response correlation or a real killed process.
4. Verify CI and the automatic deployment's live revision. Resend receiving and Google Sheets still report setup incomplete; neither delivery path is verified. Real Stripe is intentionally deferred.

Private configuration and credentials stay under ignored `.local/hosted-preview/` and are excluded by `.vercelignore`. Do not print or commit keys, passwords, cookies, invitation codes, signed URLs or private SQL Vault values. Earlier failed QA accounts and receipts are retained separately for diagnosis.
