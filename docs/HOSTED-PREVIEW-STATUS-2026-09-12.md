# Hosted preview status — 12 September 2026

The user approved the restricted Folio database logins, server-side Vercel credentials and authenticated worker setup. Keep hosting on the existing free plans and billing mocked. Approval is no longer a blocker.

## Completed

- Vercel team remains Hobby; no paid upgrade was selected.
- All 22 prepared Folio production settings were saved. Database URLs, invitation, worker secret, encryption key and approved AI key use sensitive server-side variables. Existing provider credentials remain in place.
- Explicit deployment exclusions and a dry-run source scan found no private files or credential values in the uploaded source.
- Protected candidate `dpl_G1jwiGD6rRFPibT6Fw9uBFzRmds3` is READY at `https://maintainflow-myjps3yc4-rorys-projects-accf0d71.vercel.app`, using source commit `61dda4d163fbe160dddfb56bdd22f319a128cbfb` and runtime region `fra1`.
- The Linux build completed: Node function bundle 66.7 MiB, dependencies audited with zero reported vulnerabilities, typecheck and frontend build passed.
- Five HTTP startup checks passed: preview configuration, unauthorized worker rejection, missing-invite registration rejection, SPA sign-up routing, and exact API revision.
- Both custom domains are verified on the intended project. `www.maintainflow.io` redirects to `maintainflow.io`. The live custom-domain alias still points to `dpl_77dQ7bkAWJwhma6aUHaU5SnpkH5F`, revision `2ad3baf4aa27a3ac3d3c6a07c80b23b55e706147`.

The candidate was created with `--prod --skip-domain`; its protected Vercel project hostname was assigned, while the custom domain stayed on the previous application. No source was pushed or domain promoted.

## Remaining connection blocker

Computer bootstrap timed out repeatedly before exposing any browser state. Documented diagnostics confirmed Chrome running, its extension installed/enabled and native-host manifest correct. A documented fresh-window reconnect succeeded in opening Chrome, but Computer still timed out. The user was asked to reconnect/reinstall the Computer/Browser plugin and reply ready. Do not request the setup approval again.

The Supabase database bootstrap, Vault secrets and watchdog have **not** been applied. The private bucket was verified on 11 September as non-public, `10485760` bytes, MIME `application/octet-stream`. Database-backed account creation, direct uploads, private originals, extraction, provider integrations and actual scheduled recovery remain unverified on the candidate. No AI, email or payment call was made by these startup checks.

## Resume after the connection is restored

1. Recheck the existing Supabase project's state, then apply the prepared private `.local/hosted-preview/bootstrap.sql` through its SQL Editor. Preserve legacy data and configuration. Verify the two actual pooler connections and tenant isolation.
2. Run the candidate's prepared HTTP acceptance, including the valid 6 MiB upload and mock billing. Keep deployment protection enabled.
3. Prepare the approved Vault values and conditional watchdog for the stable custom domain. The protected candidate requires explicit authenticated access if testing the database scheduler before promotion; a successful cron query alone is insufficient proof.
4. Promote the accepted application to the custom domain, install the watchdog and use [the scheduler acceptance procedure](HOSTED-SCHEDULER-ACCEPTANCE.md) for actual cron/HTTP/job proof. Restore the canonical watchdog and clean only its marked QA workspace. Complete browser and provider checks within their approved scope, then push the accepted source and verify the automatic Git deployment's revision.

Private configuration and credential files are in ignored `.local/hosted-preview/`; do not print or commit their contents. [Startup receipts](evidence/free-preview-2026-09-11/hosted-startup-2026-09-12.json) contain only safe metadata and check results.
