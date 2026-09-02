# First OpenAI Ads account acceptance

Use this runbook only after OpenAI issues an account-scoped Ads API key. The
first phase is read-only: do not enable live writes until the provider contract,
hosted security boundary, and account ownership have all been verified.

## 1. Verify the account outside MaintainFlow

- Confirm the advertiser account ID and key ownership in OpenAI Ads Manager.
- Use a staging deployment and a non-production database first.
- Apply every migration in the checked-in
  [`databaseMigrationManifest`](../src/lib/database/migration-manifest.ts) in
  filename order and confirm an `/api/ready` request authenticated with
  `MAINTAINFLOW_READINESS_PROBE_SECRET` reports the exact migration ledger as
  current.
- Configure the complete hosted `private_read` environment below. The three
  operational secrets must each contain at least 32 characters and must be
  pairwise distinct. `DATABASE_URL` must contain exactly one
  `sslmode=verify-full` parameter, and the private-beta operator list must
  contain the exact Clerk user ID that will connect the account.

```text
MAINTAINFLOW_RELEASE_STAGE=private_read
OPENAI_ADS_DATA_MODE=live
OPENAI_ADS_LIVE_WRITES_ENABLED=false
OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED=false

MAINTAINFLOW_APP_ORIGIN=https://staging.example.com
MAINTAINFLOW_TRUST_PROXY_HEADERS=false
MAINTAINFLOW_LEGAL_ENTITY_NAME=<legal entity>
MAINTAINFLOW_PRIVACY_CONTACT_EMAIL=<monitored privacy email>
MAINTAINFLOW_SUPPORT_CONTACT_EMAIL=<monitored support email>

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=<staging Clerk publishable key>
CLERK_SECRET_KEY=<staging Clerk secret key>
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/auth/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/auth/sign-up
MAINTAINFLOW_ADMISSION_MODE=private_beta
MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS=<signed-in Clerk user ID>
MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED=false

DATABASE_URL=postgres://<user>:<password>@<host>/<database>?sslmode=verify-full
MAINTAINFLOW_DATABASE_POOL_MAX=4
MAINTAINFLOW_CREDENTIAL_KEYRING={"v1":"<base64-encoded 32-byte key>"}
MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID=v1

MAINTAINFLOW_READINESS_PROBE_SECRET=<32+ random characters>
CRON_SECRET=<different 32+ random characters>
READINESS_RATE_LIMIT_SECRET=<different 32+ random characters>
READINESS_TRUST_X_FORWARDED_FOR=false
```

Do not set a deployment-wide `OPENAI_ADS_API_KEY` for the hosted connection;
the operator enters the account-scoped key through the protected form and the
server stores it in the encrypted vault. Supply valid build-revision provenance
through the deployment platform or the documented build argument, then run
`npm run check:production-config` before deployment and the authenticated
`/api/ready` probe afterward.

## 2. Run the read-only provider acceptance suite

Set the following values in the shell that runs the test. Do not write a real
key into a committed `.env` file, terminal transcript, issue, or CI log.

```bash
OPENAI_ADS_LIVE_TEST_ENABLED=true \
OPENAI_ADS_API_KEY='<account-scoped key>' \
OPENAI_ADS_EXPECTED_ACCOUNT_ID='<ad account id>' \
MAINTAINFLOW_RELEASE_STAGE=private_read \
OPENAI_ADS_DATA_MODE=live \
OPENAI_ADS_LIVE_WRITES_ENABLED=false \
npm run test:ads-live
```

The suite calls only the read paths used by the product: account, campaigns,
ad groups, ads, conversion event settings, delivery insights, and conversion
insights. It verifies account binding and parses every response through the
checked-in schemas. It contains no create, update, activate, pause, delete, or
bulk operation.

## 3. Exercise the hosted read path

1. Sign in through the configured Clerk tenant.
2. Connect the account key through the workspace onboarding form so it is
   verified with `GET /ad_account`, encrypted, and stored for that account.
3. For an agency pilot, enter a second client's key from the Workspace screen,
   verify that the preview resolves to the expected advertiser ID and name, then
   explicitly confirm that advertiser for the agency. Prove no account or
   ciphertext is stored before confirmation, confirm the attached account
   appears in the selector, and retry the same key once to verify the existing
   encrypted credential is retained rather than silently rotated.
4. Confirm account switching and read-only roles with separate test users.
5. Compare campaigns, statuses, budgets, creatives, and a fixed insight window
   with Ads Manager. Record discrepancies as provider-contract findings; do not
   normalize them away in the UI.
6. Verify logs and error monitoring do not contain the key, authorization
   header, raw conversion payload, or encrypted credential material.

## 4. Validate measurement separately

Before this phase, set `OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED=true`,
redeploy the same reviewed revision, and rerun the exact-revision readiness and
deployment probes.

An Ads API key is not a Conversions API key. Connect the account's Pixel ID and
Conversions API credential through the separate form, keep the global
validate-only flag enabled, and confirm the dry-run result in the same Ads
Manager account.

## 5. Unlock one controlled write

Only after the read comparison passes:

1. enable live writes in staging;
2. promote `MAINTAINFLOW_RELEASE_STAGE` from `private_read` to `live_write`;
3. confirm the account has an eligible live recommendation, then select one
   reversible, low-risk recommendation;
4. inspect the exact request, evidence, safeguard, and rollback payload;
5. approve once and confirm the result independently in Ads Manager;
6. verify the durable approval and monitoring records; and
7. exercise the stored rollback with an authorized operator.

The current live-write rule is intentionally narrow. It requires an active
conversion campaign whose returned event settings are unarchived, use the
current 30-day attribution contract, and each resolve to exactly one conversion
source; an active click-billed ad group with a writable configured CPA bid; at
least three click-attributed conversions in the trailing seven-full-day window;
and measured CPA at least 20% above that bid. Automated bidding is not writable
through this rule. If the connected account produces no eligible
recommendation, record the read-only acceptance as passed but leave
`OPENAI_ADS_LIVE_WRITES_ENABLED=false` and the release stage at `private_read`.
Do not manufacture a recommendation or use a simulator ID against the provider;
repeat the controlled-write gate later with a genuinely eligible live account.

Production remains blocked until the same gates pass on the hosted environment.
Real ad review, delivery, attribution, permissions, rate limits, and provider
latency cannot be proven by the local simulator.
