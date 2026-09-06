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
        list: vi.fn(async () => ({
          data: [
            {
              is_default: true,
              features: {
                subscription_cancel: { enabled: true },
                payment_method_update: { enabled: true },
              },
            },
          ],
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
});
