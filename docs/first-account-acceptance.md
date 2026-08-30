# First OpenAI Ads account acceptance

Use this runbook only after OpenAI issues an account-scoped Ads API key. The
first phase is read-only: do not enable live writes until the provider contract,
hosted security boundary, and account ownership have all been verified.

## 1. Verify the account outside MaintainFlow

- Confirm the advertiser account ID and key ownership in OpenAI Ads Manager.
- Use a staging deployment and a non-production database first.
- Apply database migrations `001` through `012` in filename order and confirm
  an `/api/ready` request authenticated with
  `MAINTAINFLOW_READINESS_PROBE_SECRET` reports the exact migration ledger as
  current.
- Configure Clerk, `DATABASE_URL`, the credential keyring, and the readiness
  rate-limit secret. Keep `OPENAI_ADS_LIVE_WRITES_ENABLED=false`.

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
3. Confirm account switching and read-only roles with separate test users.
4. Compare campaigns, statuses, budgets, creatives, and a fixed insight window
   with Ads Manager. Record discrepancies as provider-contract findings; do not
   normalize them away in the UI.
5. Verify logs and error monitoring do not contain the key, authorization
   header, raw conversion payload, or encrypted credential material.

## 4. Validate measurement separately

An Ads API key is not a Conversions API key. Connect the account's Pixel ID and
Conversions API credential through the separate form, keep the global
validate-only flag enabled, and confirm the dry-run result in the same Ads
Manager account.

## 5. Unlock one controlled write

Only after the read comparison passes:

1. enable live writes in staging;
2. promote `MAINTAINFLOW_RELEASE_STAGE` from `private_read` to `live_write`;
3. select one reversible, low-risk recommendation;
4. inspect the exact request, evidence, safeguard, and rollback payload;
5. approve once and confirm the result independently in Ads Manager;
6. verify the durable approval and monitoring records; and
7. exercise the stored rollback with an authorized operator.

Production remains blocked until the same gates pass on the hosted environment.
Real ad review, delivery, attribution, permissions, rate limits, and provider
latency cannot be proven by the local simulator.
