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
  if (
    BILLING_EXPECTATIONS.every((item) =>
      /^price_[A-Za-z0-9]+$/.test(env[item.key] ?? ""),
    ) &&
    new Set(BILLING_EXPECTATIONS.map((item) => env[item.key])).size !== 4
  )
    issues.push("The four MaintainCode plan price IDs must be distinct.");
  if (
    env.MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID &&
    !/^bpc_[A-Za-z0-9]+$/.test(env.MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID)
  )
    issues.push(
      "MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID must be a valid bpc_ configuration ID when provided.",
    );
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
        price.id !== env[expected.key] ||
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
  const planProducts = ["starter", "agency"].map((plan) => {
    const keys = BILLING_EXPECTATIONS.filter((item) => item.plan === plan).map(
      (item) => item.key,
    );
    return new Set(
      prices
        .filter((price) => keys.includes(price.key))
        .map((price) => price.product),
    );
  });
  if (
    planProducts.some((group) => group.size !== 1) ||
    [...planProducts[0]][0] === [...planProducts[1]][0]
  )
    issues.push(
      "Each plan's monthly and annual prices must belong to its own distinct MaintainCode product.",
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
  const configuredPortalId = env.MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID;
  let portal;
  if (configuredPortalId) {
    try {
      portal =
        await stripe.billingPortal.configurations.retrieve(configuredPortalId);
    } catch {
      issues.push(
        "The configured customer portal could not be retrieved; verify its test-account ID and read permissions. No default fallback was used.",
      );
    }
    if (!portal)
      issues.push(
        "The configured customer portal was not returned; no default fallback is permitted.",
      );
    else if (portal.id !== configuredPortalId)
      issues.push(
        "The returned customer portal does not match the configured portal ID.",
      );
  } else {
    const portals = await stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
    });
    if (portals.has_more !== false)
      issues.push(
        "Customer portal listing was incomplete; inspect all configurations before declaring the default portal ready.",
      );
    const defaults = portals.data.filter((item) => item.is_default === true);
    if (defaults.length !== 1)
      issues.push(
        "Exactly one active default test customer portal is required when no dedicated configuration ID is provided.",
      );
    else portal = defaults[0];
  }
  if (portal) {
    if (portal.active !== true || portal.livemode !== false)
      issues.push(
        "The selected customer portal must be active and in test mode.",
      );
    if (
      portal.features?.subscription_cancel?.enabled !== true ||
      portal.features?.payment_method_update?.enabled !== true ||
      typeof portal.features?.subscription_update?.enabled !== "boolean"
    )
      issues.push(
        "The selected test customer portal needs cancellation and payment-method updates enabled, with subscription-update configuration available for inspection.",
      );
    if (portal.features?.subscription_update?.enabled === true) {
      const expectedProducts = new Map();
      for (const price of prices)
        expectedProducts.set(price.product, [
          ...(expectedProducts.get(price.product) ?? []),
          price.id,
        ]);
      const mapping = portal.features.subscription_update.products;
      const valid =
        Array.isArray(mapping) &&
        mapping.length === 2 &&
        new Set(mapping.map((item) => item?.product)).size === 2 &&
        mapping.every((item) => {
          const expected = expectedProducts.get(item?.product);
          return (
            expected &&
            Array.isArray(item.prices) &&
            item.prices.every((id) => typeof id === "string") &&
            JSON.stringify([...item.prices].sort()) ===
              JSON.stringify([...expected].sort())
          );
        });
      if (!valid)
        issues.push(
          "The selected customer portal subscription-update product-price mapping must include only the two configured MaintainCode products and all four prices under their matching products, without missing, duplicate or legacy entries.",
        );
    }
  }
  return {
    ok: issues.length === 0,
    mode: "test",
    remoteChecked: true,
    accountId: account.id,
    prices,
    webhookEndpointId: matching[0]?.id,
    portalConfigurationId: portal?.id,
    portalSelection: configuredPortalId ? "configured" : "default",
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
