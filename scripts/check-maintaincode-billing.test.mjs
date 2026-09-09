import { describe, expect, it, vi } from "vitest";
import {
  BILLING_EXPECTATIONS,
  inspectBillingConfiguration,
  inspectRemoteBilling,
} from "./check-maintaincode-billing.mjs";
function config() {
  return {
    STRIPE_SECRET_KEY: "sk_test_privatefixture",
    STRIPE_WEBHOOK_SECRET: "whsec_privatefixture",
    ...Object.fromEntries(
      BILLING_EXPECTATIONS.map((x) => [x.key, `price_${x.plan}${x.interval}`]),
    ),
  };
}
function portal(isDefault = false) {
  return {
    id: isDefault ? "bpc_default" : "bpc_selected",
    active: true,
    livemode: false,
    is_default: isDefault,
    features: {
      subscription_cancel: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_update: { enabled: false },
    },
  };
}
function updateProducts() {
  return ["starter", "agency"].map((plan) => ({
    product: `prod_${plan}`,
    prices: BILLING_EXPECTATIONS.filter((item) => item.plan === plan).map(
      (item) => `price_${item.plan}${item.interval}`,
    ),
  }));
}
function api() {
  return {
    accounts: { retrieve: vi.fn(async () => ({ id: "acct_fixture" })) },
    prices: {
      retrieve: vi.fn(async (id) => {
        const x = BILLING_EXPECTATIONS.find(
          (item) => `price_${item.plan}${item.interval}` === id,
        );
        return {
          id,
          type: "recurring",
          active: true,
          livemode: false,
          product: `prod_${x.plan}`,
          currency: "eur",
          unit_amount: x.amount,
          recurring: { interval: x.interval, interval_count: 1 },
        };
      }),
    },
    products: {
      retrieve: vi.fn(async (id) => ({
        id,
        active: true,
        livemode: false,
        name: "MaintainCode Ads " + id,
      })),
    },
    webhookEndpoints: {
      list: vi.fn(async () => ({
        data: [
          {
            id: "we_fixture",
            url: "https://maintainflow.io/api/attribution/billing/webhook",
            livemode: false,
            status: "enabled",
            enabled_events: [
              "customer.subscription.created",
              "customer.subscription.updated",
              "customer.subscription.deleted",
            ],
          },
        ],
        has_more: false,
      })),
    },
    billingPortal: {
      configurations: {
        retrieve: vi.fn(async () => portal()),
        list: vi.fn(async () => ({
          data: [portal(true)],
          has_more: false,
        })),
      },
    },
  };
}
describe("test-mode billing readiness diagnostic", () => {
  it("reports missing/live configuration without exposing credentials or calling Stripe", async () => {
    const stripe = api();
    const result = await inspectRemoteBilling(
      { ...config(), STRIPE_SECRET_KEY: "sk_live_do_not_print" },
      stripe,
    );
    expect(result.remoteChecked).toBe(false);
    expect(JSON.stringify(result)).not.toContain("do_not_print");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    expect(inspectBillingConfiguration({}).issues).toHaveLength(6);
  });
  it("reads exact products, prices and webhook configuration without claiming payment completion", async () => {
    const result = await inspectRemoteBilling(config(), api());
    expect(result.ok).toBe(true);
    expect(result.prices).toHaveLength(4);
    expect(result.portalSelection).toBe("default");
    expect(result.portalConfigurationId).toBe("bpc_default");
    expect(result.unverified).toContain("hosted Checkout completion");
    expect(JSON.stringify(result)).not.toContain("privatefixture");
  });
  it("rejects a wrong amount and an incomplete webhook listing", async () => {
    const stripe = api();
    stripe.prices.retrieve.mockResolvedValueOnce({
      id: "price_wrong",
      active: true,
      livemode: false,
      product: "prod_starter",
      type: "recurring",
      currency: "usd",
      unit_amount: 4900,
      recurring: { interval: "month", interval_count: 1 },
    });
    stripe.webhookEndpoints.list.mockResolvedValue({
      data: [],
      has_more: true,
    });
    const result = await inspectRemoteBilling(config(), stripe);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("EUR test-mode");
    expect(result.issues.join(" ")).toContain("listing was incomplete");
  });

  it("retrieves the explicitly selected portal without consulting the shared default", async () => {
    const stripe = api();
    const result = await inspectRemoteBilling(
      {
        ...config(),
        MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_selected",
      },
      stripe,
    );
    expect(result.ok).toBe(true);
    expect(result.portalConfigurationId).toBe("bpc_selected");
    expect(result.portalSelection).toBe("configured");
    expect(
      stripe.billingPortal.configurations.retrieve,
    ).toHaveBeenCalledExactlyOnceWith("bpc_selected");
    expect(stripe.billingPortal.configurations.list).not.toHaveBeenCalled();
  });

  it.each(["config_wrong", "bpc_", " bpc_selected", "bpc_bad/path"])(
    "rejects malformed explicit portal ID %s before any Stripe request",
    async (id) => {
      const stripe = api();
      const result = await inspectRemoteBilling(
        { ...config(), MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: id },
        stripe,
      );
      expect(result.ok).toBe(false);
      expect(result.remoteChecked).toBe(false);
      expect(result.issues.join(" ")).toContain(
        "MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID",
      );
      expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
    },
  );

  it.each([
    "inactive",
    "live",
    "wrong-id",
    "no-cancellation",
    "no-payment-updates",
    "missing-update-feature",
  ])("rejects an explicit portal with %s", async (problem) => {
    const stripe = api(),
      selected = portal();
    if (problem === "inactive") selected.active = false;
    if (problem === "live") selected.livemode = true;
    if (problem === "wrong-id") selected.id = "bpc_other";
    if (problem === "no-cancellation")
      selected.features.subscription_cancel.enabled = false;
    if (problem === "no-payment-updates")
      delete selected.features.payment_method_update;
    if (problem === "missing-update-feature")
      delete selected.features.subscription_update;
    stripe.billingPortal.configurations.retrieve.mockResolvedValue(selected);
    const result = await inspectRemoteBilling(
      {
        ...config(),
        MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_selected",
      },
      stripe,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toMatch(/portal/i);
    expect(stripe.billingPortal.configurations.list).not.toHaveBeenCalled();
  });

  it("fails closed when the configured portal cannot be retrieved, without falling back to the default", async () => {
    const stripe = api();
    stripe.billingPortal.configurations.retrieve.mockRejectedValue(
      new Error("private provider detail"),
    );
    const result = await inspectRemoteBilling(
      {
        ...config(),
        MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_selected",
      },
      stripe,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("could not be retrieved");
    expect(JSON.stringify(result)).not.toContain("private provider detail");
    expect(stripe.billingPortal.configurations.list).not.toHaveBeenCalled();
  });

  it("does not pass when a configured portal response is missing", async () => {
    const stripe = api();
    stripe.billingPortal.configurations.retrieve.mockResolvedValue(null);
    const result = await inspectRemoteBilling(
      {
        ...config(),
        MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_selected",
      },
      stripe,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("not returned");
    expect(stripe.billingPortal.configurations.list).not.toHaveBeenCalled();
  });

  it("accepts only the current product-price mapping when portal subscription updates are enabled", async () => {
    const stripe = api(),
      selected = portal();
    selected.features.subscription_update = {
      enabled: true,
      products: updateProducts().reverse(),
    };
    stripe.billingPortal.configurations.retrieve.mockResolvedValue(selected);
    const result = await inspectRemoteBilling(
      {
        ...config(),
        MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_selected",
      },
      stripe,
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    "missing-list",
    "missing-price",
    "extra-legacy-product",
    "legacy-price",
    "wrong-product",
    "duplicate-product",
    "duplicate-price",
  ])("rejects enabled portal subscription updates with %s", async (problem) => {
    const stripe = api(),
      selected = portal(),
      products = updateProducts();
    if (problem === "missing-price") products[0].prices.pop();
    if (problem === "extra-legacy-product")
      products.push({ product: "prod_legacy", prices: ["price_legacy"] });
    if (problem === "legacy-price") products[0].prices[0] = "price_legacy";
    if (problem === "wrong-product")
      [products[0].prices, products[1].prices] = [
        products[1].prices,
        products[0].prices,
      ];
    if (problem === "duplicate-product")
      products[1] = structuredClone(products[0]);
    if (problem === "duplicate-price")
      products[0].prices.push(products[0].prices[0]);
    selected.features.subscription_update = {
      enabled: true,
      ...(problem === "missing-list" ? {} : { products }),
    };
    stripe.billingPortal.configurations.retrieve.mockResolvedValue(selected);
    const result = await inspectRemoteBilling(
      {
        ...config(),
        MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID: "bpc_selected",
      },
      stripe,
    );
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("product-price mapping");
  });

  it.each(["incomplete", "missing-default", "ambiguous-default"])(
    "does not declare default portal readiness from an %s list",
    async (problem) => {
      const stripe = api();
      stripe.billingPortal.configurations.list.mockResolvedValue({
        data:
          problem === "missing-default"
            ? []
            : problem === "ambiguous-default"
              ? [portal(true), { ...portal(true), id: "bpc_second" }]
              : [portal(true)],
        has_more: problem === "incomplete",
      });
      const result = await inspectRemoteBilling(config(), stripe);
      expect(result.ok).toBe(false);
      expect(result.issues.join(" ")).toMatch(/portal/i);
      expect(
        stripe.billingPortal.configurations.retrieve,
      ).not.toHaveBeenCalled();
    },
  );

  it("also rejects legacy subscription products in a shared default portal", async () => {
    const stripe = api(),
      selected = portal(true);
    selected.features.subscription_update = {
      enabled: true,
      products: [{ product: "prod_legacy", prices: ["price_legacy"] }],
    };
    stripe.billingPortal.configurations.list.mockResolvedValue({
      data: [selected],
      has_more: false,
    });
    const result = await inspectRemoteBilling(config(), stripe);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain("product-price mapping");
  });

  it("rejects duplicate configured price IDs before any Stripe request", async () => {
    const stripe = api(),
      env = config();
    env.STRIPE_PRICE_STARTER_YEAR = env.STRIPE_PRICE_STARTER_MONTH;
    const result = await inspectRemoteBilling(env, stripe);
    expect(result.ok).toBe(false);
    expect(result.remoteChecked).toBe(false);
    expect(result.issues.join(" ")).toContain("must be distinct");
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("rejects a two-product set that splits a plan's month/year prices across products", async () => {
    const stripe = api(),
      retrieve = stripe.prices.retrieve.getMockImplementation();
    stripe.prices.retrieve.mockImplementation(async (id) => ({
      ...(await retrieve(id)),
      product: id.endsWith("month") ? "prod_month" : "prod_year",
    }));
    const result = await inspectRemoteBilling(config(), stripe);
    expect(result.ok).toBe(false);
    expect(result.issues.join(" ")).toContain(
      "own distinct MaintainCode product",
    );
  });
});
