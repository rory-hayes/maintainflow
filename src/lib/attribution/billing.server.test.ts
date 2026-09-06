import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { stripeClient } from "./billing.server";
afterEach(() => vi.unstubAllEnvs());
it("never creates real charges with a live key in development", () => {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_placeholder_for_test_only");
  expect(() => stripeClient()).toThrow("Live charges are disabled");
});
it("reports missing Stripe configuration without pretending checkout succeeded", () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  expect(() => stripeClient()).toThrow("No payment was initiated");
});
