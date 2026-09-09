# MaintainCode Ads Stripe test setup

## Current evidence

On 9 September 2026, the owner signed in to the intended Maintain Flow Stripe account and its test mode was verified. Two dedicated MaintainCode Ads test products and their four prices were created and read back; the legacy catalog was preserved. The approved test credential was verified against the intended account. These setup checks do not establish completed checkout, webhook delivery or subscription lifecycle acceptance.

Select the intended account and its test/sandbox environment before every setup action. Existing environment variable names alone do not establish test mode or credential ownership. Preserve unrelated products, portals and webhook endpoints.

## Exact resources

Create two clearly named products in the selected **test** environment, with the following four active, licensed recurring prices. Use EUR with quantity one, interval count one, and no automatic usage overages. These are the proposed amounts displayed and validated by the app, not evidence of paid demand.

| Product                   | Interval |                     Amount | Server setting               |
| ------------------------- | -------- | -------------------------: | ---------------------------- |
| MaintainCode Ads Business | Monthly  |      €49.00 (`4900` cents) | `STRIPE_PRICE_STARTER_MONTH` |
| MaintainCode Ads Business | Yearly   |    €490.00 (`49000` cents) | `STRIPE_PRICE_STARTER_YEAR`  |
| MaintainCode Ads Agency   | Monthly  |    €149.00 (`14900` cents) | `STRIPE_PRICE_AGENCY_MONTH`  |
| MaintainCode Ads Agency   | Yearly   | €1,490.00 (`149000` cents) | `STRIPE_PRICE_AGENCY_YEAR`   |

Prefer metadata identifying `maintaincode_ads`, the plan and `test_acceptance` so these new resources can be distinguished from existing products. Before creating anything, inspect exact names/metadata to avoid duplicate resources from a prior attempt.

Add a **new test webhook endpoint**, leaving previous endpoints intact:

- URL: `https://maintainflow.io/api/attribution/billing/webhook`
- Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- Signing secret: save the `whsec_…` issued specifically for this new endpoint as `STRIPE_WEBHOOK_SECRET`.
- API credential: use the selected account's `sk_test_…` or appropriately scoped `rk_test_…` as `STRIPE_SECRET_KEY`. Never copy a live key into the test setup.

The webhook verifies the raw body signature, claims a persisted workspace refresh generation, and retrieves canonical subscription state before changing billing. A superseded overlapping request fails for a fresh Stripe retry rather than overwriting a newer result. A generic synthetic subscription event with an invented subscription ID cannot prove this flow; Stripe must be able to retrieve the real test subscription. See [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).

Set `MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID` to a dedicated **test** customer portal configuration when the default portal is shared. The app passes this exact configuration to Stripe; omitting it retains Stripe's default selection. Enable cancellation and payment-method updates. If plan changes are enabled, allow only the two current products with all four matching prices. A dedicated configuration preserves the legacy portal's behavior. Actual portal access remains unverified until a test workspace has a Stripe customer. See [Stripe customer portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal).

## Secure configuration and diagnostic

Store the six required values and, when used, the dedicated portal ID in a private local JSON file at `/tmp/maintaincode-stripe-config.json` (file permissions `0600`), using environment variable names as top-level keys. This file should contain the test key, the new endpoint's signing secret and the four new price IDs. Do not save unrelated Vercel secrets or print this file. Configure those exact keys in the maintainflow Vercel project's production environment for the authorized test acceptance deployment and redeploy. Keep a newly prepared webhook disabled until its matching server configuration is deployed. Do not use placeholder IDs to make configuration checks appear green.

```bash
# Local shape check: no Stripe requests.
node scripts/check-maintaincode-billing.mjs --config /tmp/maintaincode-stripe-config.json

# Read-only Stripe verification, after account access is authorized.
node scripts/check-maintaincode-billing.mjs --config /tmp/maintaincode-stripe-config.json --remote
```

The diagnostic refuses live keys, reads four distinct exact prices, checks two named test products and the exact new webhook, and validates the selected portal's active test mode, required features and product/price mapping. An explicit portal ID is retrieved directly without falling back to the shared default. It makes no write, creates no checkout, and prints no keys or webhook secret. Remote checks require account, product, price, webhook-endpoint and portal-configuration read permissions; permission errors are a configuration gap, not permission to escalate access silently.

A readable webhook endpoint does not prove that the configured signing secret belongs to it. Only a correctly signed accepted delivery supplies that evidence. Do not treat `ok:true` from the read-only diagnostic as payment completion or customer validation.

## Acceptance still to run

Use only disposable test-mode workspaces and Stripe's documented test payment methods, with authorization for creating test subscriptions. Never enter real card details or create a live charge during this acceptance run.

Checkout attempts persist an immutable request identity across retries and reuse an open session across clock boundaries. An explicit plan or interval change expires the previous owned session and confirms its current status before replacing it. If payment completed in the meantime, the app reconciles the subscription and directs the customer to the portal. A create request with an unknown outcome retains its original parameters and key; after 23 hours it requires review before another payment can start. These private attempt and refresh fields are excluded from workspace responses and exports.

After successful test payments, cancel all test subscriptions and close unused sessions. Cancellation retains the workspace's Stripe identifiers and does not restore its original no-customer trial; use a separate billing acceptance workspace when that original workspace must remain unchanged.

1. Verify each of the four plan buttons creates hosted Checkout with the exact EUR amount/interval and returns to the correct workspace/domain. Cancel the checkout and verify no paid entitlement is granted.
2. Complete an authorized test subscription. Verify the actual signed subscription event receives a 2xx response, the exact workspace becomes active, the plan matches, and another workspace is unchanged.
3. Replay the same signed delivery and verify no duplicate subscription or entitlement. Check stale events cannot cancel a newer subscription.
4. Test declined and authentication-required test payment scenarios. The app must not show active access until canonical subscription status supports it.
5. Open the test customer portal, verify the correct customer and subscription, then test authorized cancellation. Confirm eventual `canceled` state and the expected capture/retention behavior.
6. Inspect delivered event history and the app's persisted billing state. Record exact event/subscription IDs privately, statuses, timestamp and deployed revision. Signing-secret configuration, checkout redirect, webhook delivery, entitlement, portal and live billing are separate proofs.

These scenarios follow [Stripe's billing test guidance](https://docs.stripe.com/billing/testing). No live billing should be described as working from test-mode results.
