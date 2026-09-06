# MaintainCode Ads release status — 6 September 2026

This is an evidence ledger, not a launch claim.

## Verified

- Target repository: `rory-hayes/maintainflow`; original main revision `b20f9f7fed2232381cbdeca2efbc65d8a6d477aa` remains in Git history.
- Replacement is published on `maintaincode-attribution-release`, with draft PR https://github.com/rory-hayes/maintainflow/pull/11. Main has not been switched.
- New Supabase project: `mvzspyhwoqzcygekridy`, MaintainCode Ads, Tuesday organisation, free/nano, Ireland (`eu-west-1`). It was created empty for this release, with automatic Data API grants disabled.
- Migrations001–024 were applied from a clean pinned bootstrap, then a dedicated `maintaincode_app` login was configured. TLS certificate verification and effective workspace/credential row security passed through the transaction pooler. Hosted two-tenant verification passed and rolled back all synthetic records.
- Sign-up and password-recovery email templates are saved and verified after reopening. Site URL is `https://maintainflow.io`, auth redirects are scoped to `https://maintainflow.io/auth/**`, and email confirmation is enabled.
- Resend reports `maintainflow.io` as a verified sending domain. This is not proof that authentication email is delivered.
- Full verification passed: 1,166 tests in138 files, lint, TypeScript, production build, plus dedicated contract/configuration checks. Build output contained no `.env` files or matches for newly created private database password values. Subsequent migration025 RLS change passed14 relevant tests.

## Pending production gates

1. Store the new runtime connection, encryption key and independent job secrets in Vercel production. Automatic approval review rejected this credential upload until the owner explicitly approves the sensitive values going to project `prj_9995IQ0H1GERFJseqQ9bqnOI7b02`. The attempted API updates did not succeed.
2. Complete SMTP sender/username/credential settings in the new Supabase project. Automatic approval review requires explicit approval to transfer the existing Resend sending key to this project. Templates alone do not prove delivery.
3. Sign in to the intended Stripe test account, create the new prices/webhook, and run checkout, entitlement and portal acceptance. No Stripe resources or payments were created. Google sign-in was blocked by automatic approval review pending the exact account/sign-in authorization; a login tab is preserved for the owner.
4. Independently verify hosted migration025 and maintenance queue after applying the pending schema transaction.
5. Deploy the exact reviewed revision, verify maintainflow.io and authenticated readiness, create and reload a real customer workspace, exercise confirmation/recovery/sign-out, install tracker on an authorised test page, and verify capture and CRM-field delivery.
6. Connect authorised HubSpot and OpenAI Ads accounts to establish real provider evidence. Local mocks and synthetic database records do not establish this.

## Credential handling

New credentials are held in private local setup files and must not be committed. Only the dedicated app-role connection belongs in the application. The administration connection stopped authenticating after initial bootstrap; a password-reset attempt was rejected by automatic approval review, so no further reset was attempted. The authenticated Supabase SQL editor remains available for authorised schema work. The runtime role continued to pass hosted checks.

Do not describe the domain as serving this release, payments as working, or the product as accepted until the pending gates have current evidence.
