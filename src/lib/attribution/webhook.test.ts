import { afterEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import Stripe from "stripe";
import { POST } from "@/app/api/attribution/billing/webhook/route";
afterEach(() => vi.unstubAllEnvs());
it("verifies raw webhook signatures and rejects modified payloads before billing actions", async () => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_signature_verification_only");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_local_signature_test");
  const body = JSON.stringify({
    id: "evt_test",
    type: "invoice.created",
    data: { object: { id: "in_test" } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: "whsec_local_signature_test",
  });
  const request = (payload: string) =>
    new Request("https://app.test/api/attribution/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": signature },
      body: payload,
    });
  expect((await POST(request(body))).status).toBe(200);
  expect((await POST(request(body + " "))).status).toBe(400);
});
