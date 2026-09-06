# MaintainCode Ads Stripe test setup

## Current evidence

On 6 September 2026, the available Chrome session reached Stripe's signed-out login page. Starting Google sign-in was rejected by automatic approval review because the specific account/sign-in method had not been authorized. No Stripe CLI configuration or process-level Stripe key was available. No Stripe products, prices, webhook endpoint, customer, payment or subscription were created by this setup attempt. Existing production environment variable names do not establish whether a usable test account is connected.

The browser is left at the Stripe sign-in page for the owner. After signing in, explicitly select the intended Stripe account and its test/sandbox environment. Existing live products, prices and webhook endpoints must remain unchanged.

## Exact resources

Create two clearly named products in the selected **test** environment, with the following four active, licensed recurring prices. Use EUR with quantity one, interval count one, and no automatic usage overages. These are the proposed amounts displayed and validated by the app, not evidence of paid demand.

| Product                  | Interval |                     Amount | Server setting               |
| ------------------------ | -------- | -------------------------: | ---------------------------- |
| MaintainCode Ads Starter | Monthly  |      €49.00 (`4900` cents) | `STRIPE_PRICE_STARTER_MONTH` |
| MaintainCode Ads Starter | Yearly   |    €490.00 (`49000` cents) | `STRIPE_PRICE_STARTER_YEAR`  |
| MaintainCode Ads Agency  | Monthly  |    €149.00 (`14900` cents) | `STRIPE_PRICE_AGENCY_MONTH`  |
| MaintainCode Ads Agency  | Yearly   | €1,490.00 (`149000` cents) | `STRIPE_PRICE_AGENCY_YEAR`   |

Prefer metadata identifying `maintaincode_ads`, the plan and `test_acceptance` so these new resources can be distinguished from existing products. Before creating anything, inspect exact names/metadata to avoid duplicate resources from a prior attempt.

Add a **new test webhook endpoint**, leaving previous endpoints intact:

- URL: `https://maintainflow.io/api/attribution/billing/webhook`
- Events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`
- Signing secret: save the `whsec_…` issued specifically for this new endpoint as `STRIPE_WEBHOOK_SECRET`.
- API credential: use the selected account's `sk_test_…` or appropriately scoped `rk_test_…` as `STRIPE_SECRET_KEY`. Never copy a live key into the test setup.

The webhook verifies the raw body signature and retrieves canonical subscription state before changing a workspace. A generic synthetic subscription event with an invented subscription ID cannot prove this flow; Stripe must be able to retrieve the real test subscription. See [Stripe subscription webhooks](https://docs.stripe.com/billing/subscriptions/webhooks).

The current app opens Stripe's default customer portal configuration. Inspect the **test** portal before changing it: cancellation and payment-method updates must be enabled for acceptance. If this configuration is shared with other products, preserve its behavior and plan a dedicated MaintainCode portal configuration before introducing broader changes. Actual portal access remains unverified until a test workspace has a Stripe customer. See [Stripe customer portal integration](https://docs.stripe.com/customer-management/integrate-customer-portal).

## Secure configuration and diagnostic

Store only the six required values in a private local JSON file at `/tmp/maintaincode-stripe-config.json` (file permissions `0600`), using environment variable names as top-level keys. This file should contain the new test key, the new endpoint's signing secret and the four new price IDs. Do not save unrelated Vercel secrets or print this file. Configure those exact keys in the maintainflow Vercel project's production environment for the test acceptance deployment and redeploy.

The setup attempt did **not** create this secret file because no Stripe resources or credentials were obtained. Do not use placeholder IDs to make configuration checks appear green.

```bash
# Local shape check: no Stripe requests.
node scripts/check-maintaincode-billing.mjs --config /tmp/maintaincode-stripe-config.json

# Read-only Stripe verification, after account access is authorized.
node scripts/check-maintaincode-billing.mjs --config /tmp/maintaincode-stripe-config.json --remote
```

The diagnostic refuses live keys, reads the four exact prices, checks named test products and the exact new webhook, and reports missing portal configuration. It makes no write, creates no checkout, and prints no keys or webhook secret. Remote checks require account, product, price, webhook-endpoint and portal-configuration read permissions; permission errors are a configuration gap, not permission to escalate access silently.

A readable webhook endpoint does not prove that the configured signing secret belongs to it. Only a correctly signed accepted delivery supplies that evidence. Do not treat `ok:true` from the read-only diagnostic as payment completion or customer validation.

## Acceptance still to run

Use only disposable test-mode workspaces and Stripe's documented test payment methods, with authorization for creating test subscriptions. Never enter real card details or create a live charge during this acceptance run.

1. Verify each of the four plan buttons creates hosted Checkout with the exact EUR amount/interval and returns to the correct workspace/domain. Cancel the checkout and verify no paid entitlement is granted.
2. Complete an authorized test subscription. Verify the actual signed subscription event receives a 2xx response, the exact workspace becomes active, the plan matches, and another workspace is unchanged.
3. Replay the same signed delivery and verify no duplicate subscription or entitlement. Check stale events cannot cancel a newer subscription.
4. Test declined and authentication-required test payment scenarios. The app must not show active access until canonical subscription status supports it.
5. Open the test customer portal, verify the correct customer and subscription, then test authorized cancellation. Confirm eventual `canceled` state and the expected capture/retention behavior.
6. Inspect delivered event history and the app's persisted billing state. Record exact event/subscription IDs privately, statuses, timestamp and deployed revision. Signing-secret configuration, checkout redirect, webhook delivery, entitlement, portal and live billing are separate proofs.

These scenarios follow [Stripe's billing test guidance](https://docs.stripe.com/billing/testing). No live billing should be described as working from test-mode results.
