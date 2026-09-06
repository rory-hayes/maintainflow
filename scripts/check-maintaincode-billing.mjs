import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Stripe from "stripe";

export const BILLING_EXPECTATIONS = Object.freeze([
  {
    key: "STRIPE_PRICE_STARTER_MONTH",
    plan: "starter",
    interval: "month",
    amount: 4900,
  },
  {
    key: "STRIPE_PRICE_STARTER_YEAR",
    plan: "starter",
    interval: "year",
    amount: 49000,
  },
  {
    key: "STRIPE_PRICE_AGENCY_MONTH",
    plan: "agency",
    interval: "month",
    amount: 14900,
  },
  {
    key: "STRIPE_PRICE_AGENCY_YEAR",
    plan: "agency",
    interval: "year",
    amount: 149000,
  },
]);
const WEBHOOK_URL = "https://maintainflow.io/api/attribution/billing/webhook";
const EVENTS = [
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
];
export function inspectBillingConfiguration(env) {
  const issues = [];
  const key = env.STRIPE_SECRET_KEY;
  const mode = /^(sk|rk)_test_/.test(key ?? "")
    ? "test"
    : /^(sk|rk)_live_/.test(key ?? "")
      ? "live"
      : "missing_or_invalid";
  if (mode !== "test")
    issues.push(
      "A Stripe test-mode secret or restricted key is required for billing acceptance.",
    );
  if (!env.STRIPE_WEBHOOK_SECRET?.startsWith("whsec_"))
    issues.push(
      "The new test webhook endpoint signing secret is missing or invalid.",
    );
  for (const item of BILLING_EXPECTATIONS)
    if (!/^price_[A-Za-z0-9]+$/.test(env[item.key] ?? ""))
      issues.push(`${item.key} is missing or invalid.`);
  return { ok: issues.length === 0, mode, issues };
}
export async function inspectRemoteBilling(env, stripe) {
  const configuration = inspectBillingConfiguration(env);
  if (!configuration.ok) return { ...configuration, remoteChecked: false };
  const issues = [];
  const account = await stripe.accounts.retrieve();
  const prices = await Promise.all(
    BILLING_EXPECTATIONS.map(async (expected) => {
      const price = await stripe.prices.retrieve(env[expected.key]);
      if (
        price.livemode ||
        !price.active ||
        price.type !== "recurring" ||
        price.currency !== "eur" ||
        price.unit_amount !== expected.amount ||
        price.recurring?.interval !== expected.interval ||
        price.recurring?.interval_count !== 1
      )
        issues.push(
          `${expected.key} does not match the active EUR test-mode plan.`,
        );
      return {
        key: expected.key,
        id: price.id,
        product:
          typeof price.product === "string" ? price.product : price.product.id,
        amount: price.unit_amount,
        currency: price.currency,
        interval: price.recurring?.interval,
        livemode: price.livemode,
      };
    }),
  );
  const products = await Promise.all(
    [...new Set(prices.map((price) => price.product))].map((id) =>
      stripe.products.retrieve(id),
    ),
  );
  if (
    products.length !== 2 ||
    products.some(
      (product) =>
        product.deleted ||
        product.livemode ||
        !product.active ||
        !product.name.startsWith("MaintainCode Ads"),
    )
  )
    issues.push(
      "Expected two clearly named active MaintainCode Ads test products; unrelated products must be preserved.",
    );
  const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const matching = endpoints.data.filter(
    (endpoint) => endpoint.url === WEBHOOK_URL && !endpoint.livemode,
  );
  if (
    matching.length !== 1 ||
    matching[0].status !== "enabled" ||
    EVENTS.some(
      (type) =>
        !matching[0].enabled_events.includes(type) &&
        !matching[0].enabled_events.includes("*"),
    )
  )
    issues.push(
      "Exactly one enabled test webhook for the MaintainCode URL and all three subscription events is required.",
    );
  if (endpoints.has_more)
    issues.push(
      "Webhook listing was incomplete; inspect the remaining endpoints before declaring configuration complete.",
    );
  const portals = await stripe.billingPortal.configurations.list({
    active: true,
    limit: 100,
  });
  const defaultPortal = portals.data.find((portal) => portal.is_default);
  if (
    !defaultPortal ||
    !defaultPortal.features.subscription_cancel.enabled ||
    !defaultPortal.features.payment_method_update.enabled
  )
    issues.push(
      "The app's default test customer portal needs cancellation and payment-method updates enabled; review before changing any shared configuration.",
    );
  return {
    ok: issues.length === 0,
    mode: "test",
    remoteChecked: true,
    accountId: account.id,
    prices,
    webhookEndpointId: matching[0]?.id,
    issues,
    unverified: [
      "signing-secret ownership until a correctly signed delivery is accepted",
      "hosted Checkout completion",
      "workspace subscription state after webhook",
      "portal access and cancellation",
      "declines and authentication-required payments",
      "live billing",
    ],
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf("--config");
    const env =
      index >= 0
        ? JSON.parse(readFileSync(process.argv[index + 1], "utf8"))
        : process.env;
    let result = inspectBillingConfiguration(env);
    if (process.argv.includes("--remote") && result.ok)
      result = await inspectRemoteBilling(
        env,
        new Stripe(env.STRIPE_SECRET_KEY, {
          maxNetworkRetries: 1,
          timeout: 15000,
        }),
      );
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch {
    console.error(
      "Billing verification failed. Check test-account authorization and required read permissions; no payment or configuration mutation was attempted.",
    );
    process.exitCode = 1;
  }
}
