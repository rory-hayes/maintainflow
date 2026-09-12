# Hosted preview status — 12 September 2026

The user approved the restricted Folio database logins, server-side Vercel credentials and authenticated worker setup. Keep hosting on the existing free plans and billing mocked. Approval is no longer a blocker.

## Completed

- Vercel team remains Hobby; no paid upgrade was selected.
- All 22 prepared Folio production settings were saved. Database URLs, invitation, worker secret, encryption key and approved AI key use sensitive server-side variables. Existing provider credentials remain in place.
- Explicit deployment exclusions and a dry-run source scan found no private files or credential values in the uploaded source.
- Protected diagnostic candidate `dpl_GkHCHE7j1fxqB3WoLMMXvgWTPtak` is READY at `https://maintainflow-md72zaral-rorys-projects-accf0d71.vercel.app`, using source commit `cdd6372c0187055d830853a110f851d0da69b2c1` and runtime region `fra1`.
- The Linux build completed: Node function bundle 66.7 MiB, dependencies audited with zero reported vulnerabilities, typecheck and frontend build passed.
- Five HTTP startup checks passed: preview configuration, unauthorized worker rejection, missing-invite registration rejection, SPA sign-up routing, and exact API revision.
- After the user ran the prepared database bootstrap, both real pooler connections passed TLS, role, search-path and isolation checks. Neither role can access legacy tables or definers, create schema objects, edit the migration ledger or rewrite the document journal. See [database evidence](evidence/free-preview-2026-09-11/hosted-database-2026-09-12.json).
- Hosted synthetic owner registration and parser creation succeeded. The first upload reservation failed with HTTP 503; the diagnostic candidate narrowed this to Supabase's bucket-read request returning HTTP 400. The provider code is `AccessDenied`; the current service-role and Storage admin database privileges remain intact. A current project server key must be validated privately before replacing the configured credential. See [storage rejection evidence](evidence/free-preview-2026-09-11/hosted-storage-rejection-2026-09-12.json). See [partial HTTP acceptance](evidence/free-preview-2026-09-11/hosted-e2e-2026-09-12T11-26-36-793Z-681618df-be3b-48e7-a891-3eb34e4d9bf7.json).
- Mock Team upgrade, persistence and cancellation passed on the owned synthetic workspace; its parser was retained. Real Stripe was not called. Resend and Google Sheets currently report setup incomplete. See [mock billing evidence](evidence/free-preview-2026-09-11/hosted-mock-billing-2026-09-12.json).
- Hosted exports now enforce a 4 MiB rendered-byte limit before storing snapshots or downloading existing ones. Eight export lifecycle tests passed. The deployed storage diagnostic had twelve passing tests; a subsequent local precision patch has thirteen passing tests and typecheck, and will ship with the next candidate after credential validation. The current candidate cloud build passed.
- Both custom domains are verified on the intended project. `www.maintainflow.io` redirects to `maintainflow.io`. The live custom-domain alias still points to `dpl_77dQ7bkAWJwhma6aUHaU5SnpkH5F`, revision `2ad3baf4aa27a3ac3d3c6a07c80b23b55e706147`.

The candidate was created with `--prod --skip-domain`; its protected Vercel project hostname was assigned, while the custom domain stayed on the previous application. No source was pushed or domain promoted.

## Remaining connection blocker

Computer bootstrap timed out repeatedly before exposing any browser state. Documented diagnostics confirmed Chrome running, its extension installed/enabled and native-host manifest correct. A documented fresh-window reconnect succeeded in opening Chrome, but Computer still timed out. The user was asked to reconnect/reinstall the Computer/Browser plugin and reply ready. Do not request the setup approval again.

After the user confirmed uninstalling/reinstalling Computer, both a fresh `cua.getState()` and a direct documented Chrome/Supabase tab request still timed out before exposing browser state. Plugin dependency inspection could not resolve the bundled Computer reference in its public directory; that does not establish installation state. Do not repeat the reinstall advice without new evidence.

The user has now executed the private `.local/hosted-preview/bootstrap.sql`, which was checked against all ten current migrations and the configured passwords. Live read-only connection checks confirm that the database setup succeeded. The worker/Vault setup remains a separate later step. Private installers are prepared for manual execution because Computer still cannot expose a browser session.

The Vault secrets and watchdog have **not** been applied. The private bucket was verified on 11 September as non-public, `10485760` bytes, MIME `application/octet-stream`. Direct uploads, private originals, extraction, provider integrations and actual scheduled recovery remain unverified on the candidate. No AI, email or payment call was made by the hosted checks.

## Remaining work

1. The user supplied a current server Secret key through the private, ignored mode-0600 key file. A live bucket lookup returned HTTP 200 and confirmed private access, 10 MiB limit and octet-stream MIME policy. Only the production `SUPABASE_SERVICE_ROLE_KEY` was replaced through Vercel as a sensitive server variable. See [key validation](evidence/free-preview-2026-09-11/hosted-storage-key-validation-2026-09-12.json). Deploy a new protected candidate before testing; existing deployments retain their original environment snapshots.
2. Run the candidate's prepared HTTP acceptance, including the valid 6 MiB upload and mock billing. Keep deployment protection enabled. Verify signed Storage CORS separately because the HTTP runner is not a browser test.
3. Prepare the approved Vault values and conditional watchdog for the stable custom domain. The protected candidate requires explicit authenticated access if testing the database scheduler before promotion; a successful cron query alone is insufficient proof.
4. Promote the accepted application to the custom domain, install the watchdog and use [the scheduler acceptance procedure](HOSTED-SCHEDULER-ACCEPTANCE.md) for actual cron/HTTP/job proof. Restore the canonical watchdog and clean only its marked QA workspace. Complete browser and provider checks within their approved scope, then push the accepted source and verify the automatic Git deployment's revision.

Private configuration and credential files are in ignored `.local/hosted-preview/`; do not print or commit their contents. [Startup receipts](evidence/free-preview-2026-09-11/hosted-startup-2026-09-12.json) contain only safe metadata and check results.

The private `.local/hosted-preview/scheduler-practical-acceptance.mjs` provides a shorter restricted-role QA path after domain promotion and watchdog installation. It combines durable queued/expired-lease observations with separate Vercel worker request logs; it cannot establish an exact pg_net request/response join. It has not been executed remotely.
