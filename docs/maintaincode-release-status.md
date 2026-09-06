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
- GitHub CI is green for release head `4f448ba4ebc52bcc434bf22981dd8e22833354d2`: 1,176 application tests, lint, TypeScript, production build, dedicated contract/configuration suites, browser sample journey, container build and TLS database readiness/revision checks passed. The separate PostgreSQL job passed all 25 migrations and 82 integration tests. Both CodeQL analyses passed. The tested GitHub merge artifact has the same tree as the release head. Runs: https://github.com/rory-hayes/maintainflow/actions/runs/34060687392 and https://github.com/rory-hayes/maintainflow/actions/runs/34060685551. Dedicated suites repeat tests included in the main suite; their totals are not a unique-test sum.
- The live public OpenAI specification check passed (version 2.3.0, 73 operations); the attribution insights request now uses the documented `daily` granularity. This establishes published-contract compatibility, not authenticated provider acceptance.
- Fourteen public production settings were saved and independently read back from the existing MaintainFlow Vercel project, including public Supabase authentication configuration, app origins, certificate, pool limit, legal contacts and feature flags. Local test mode is explicitly `0` and advertiser-write flags are `false`. Credential key ID and all private credential settings remain pending. These settings require a new deployment to affect the app; the existing domain has not switched.
- Earlier local build artifact inspection found no `.env` files or matches for the new private database password values across 3,174 build files.

## Pending production gates

1. Store the new runtime connection, encryption key/key ID and independent job secrets in Vercel production. Automatic approval review rejected this credential upload until the owner explicitly approves the sensitive values going to project `prj_9995IQ0H1GERFJseqQ9bqnOI7b02`. No private credential updates succeeded. The installed Vercel CLI mishandles array input; a single top-level environment object per request was proved with the successful public-settings updates.
2. Complete SMTP sender/username/credential settings in the new Supabase project. Automatic approval review requires explicit approval to transfer the existing Resend sending key to this project. Templates alone do not prove delivery.
3. Sign in to the intended Stripe test account, create the new prices/webhook, and run checkout, entitlement and portal acceptance. No Stripe resources or payments were created. Google sign-in was blocked by automatic approval review pending the exact account/sign-in authorization; a login tab is preserved for the owner.
4. Deploy the exact reviewed revision, verify maintainflow.io and authenticated readiness, create and reload a real customer workspace, exercise confirmation/recovery/sign-out, install tracker on an authorised test page, and verify capture and CRM-field delivery. Vercel preview still fails its missing-configuration gate; green GitHub CI is not a deployed acceptance result.
5. Connect authorised HubSpot and OpenAI Ads accounts to establish real provider evidence. Local mocks and synthetic database records do not establish this.

## Credential handling

New credentials are held in private local setup files and must not be committed. Only the dedicated app-role connection belongs in the application. The administration connection stopped authenticating after initial bootstrap; a password-reset attempt was rejected by automatic approval review, so no further reset was attempted. The authenticated Supabase SQL editor remains available for authorised schema work. The runtime role continued to pass hosted checks.

Do not describe the domain as serving this release, payments as working, or the product as accepted until the pending gates have current evidence.
