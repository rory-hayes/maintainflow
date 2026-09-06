# MaintainCode Ads release status — 6 September 2026

This is an evidence ledger, not a launch claim.

## Verified

- Target repository: `rory-hayes/maintainflow`; original main revision `b20f9f7fed2232381cbdeca2efbc65d8a6d477aa` remains in Git history.
- Replacement is published on `maintaincode-attribution-release`, with draft PR https://github.com/rory-hayes/maintainflow/pull/11. Main has not been switched.
- The current public domain health endpoint returns HTTP 200 with service `maintainflow-ads`, identifying the existing application rather than this replacement.
- New Supabase project: `mvzspyhwoqzcygekridy`, MaintainCode Ads, Tuesday organisation, free/nano, Ireland (`eu-west-1`). It was created empty for this release, with automatic Data API grants disabled.
- Migrations 001–024 were applied from a clean pinned bootstrap; migration 025 was subsequently applied through the authenticated SQL editor. The hosted ledger reports 25 migrations. A dedicated `maintaincode_app` login passed TLS certificate verification, workspace/credential row security, and two-tenant persistence tests. Queue registration, lease completion, restricted grants and cleanup passed, with all synthetic records rolled back.
- Sign-up and password-recovery email templates are saved and verified after reopening. Site URL is `https://maintainflow.io`, auth redirects are scoped to `https://maintainflow.io/auth/**`, and email confirmation is enabled.
- Resend reports `maintainflow.io` as a verified sending domain. This is not proof that authentication email is delivered.
- Full verification passed: 1,166 tests in 138 files, lint, TypeScript, production build, plus dedicated contract/configuration checks. Build output contained no `.env` files or matches for newly created private database password values. Subsequent migration025 RLS change passed 14 relevant tests.
- The subsequent database CI fix passed all 25 migrations, 82 PostgreSQL integration tests and 28 readiness unit tests. The contract update passed the live public OpenAI specification check (version 2.3.0, 73 operations), 21 focused tests and 28 Ads contract tests; the attribution insights request now uses the documented `daily` granularity. These checks establish local/database and published-contract compatibility, not authenticated provider acceptance.

## Pending production gates

1. Store the new runtime connection, encryption key and independent job secrets in Vercel production. Automatic approval review rejected this credential upload until the owner explicitly approves the sensitive values going to project `prj_9995IQ0H1GERFJseqQ9bqnOI7b02`. The attempted API updates did not succeed.
2. Complete SMTP sender/username/credential settings in the new Supabase project. Automatic approval review requires explicit approval to transfer the existing Resend sending key to this project. Templates alone do not prove delivery.
3. Sign in to the intended Stripe test account, create the new prices/webhook, and run checkout, entitlement and portal acceptance. No Stripe resources or payments were created. Google sign-in was blocked by automatic approval review pending the exact account/sign-in authorization; a login tab is preserved for the owner.
4. Confirm GitHub CI on the pushed revision containing the corrected legacy runtime-role policy checks and reviewed public Ads contract. Vercel preview currently fails its missing-configuration gate; production credentials have not been uploaded.
5. Deploy the exact reviewed revision, verify maintainflow.io and authenticated readiness, create and reload a real customer workspace, exercise confirmation/recovery/sign-out, install tracker on an authorised test page, and verify capture and CRM-field delivery.
6. Connect authorised HubSpot and OpenAI Ads accounts to establish real provider evidence. Local mocks and synthetic database records do not establish this.

## Credential handling

New credentials are held in private local setup files and must not be committed. Only the dedicated app-role connection belongs in the application. The administration connection stopped authenticating after initial bootstrap; a password-reset attempt was rejected by automatic approval review, so no further reset was attempted. The authenticated Supabase SQL editor remains available for authorised schema work. The runtime role continued to pass hosted checks.

Do not describe the domain as serving this release, payments as working, or the product as accepted until the pending gates have current evidence.
