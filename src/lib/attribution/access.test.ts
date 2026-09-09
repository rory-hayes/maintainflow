import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/operator.server", () => ({
  requireOperatorId: async () => "actor-a",
}));
const memberships = vi.hoisted(() => vi.fn());
vi.mock("@/lib/attribution/membership.server", () => ({
  listOrganizationMemberships: memberships,
}));
import {
  authorize,
  sameOrigin,
  localMode,
  publicWorkspace,
} from "./store.server";
import { emptyWorkspace, captureTouch, advanceEvidence } from "./model";
afterEach(() => vi.unstubAllEnvs());
describe("workspace boundary", () => {
  it("rejects read/write/export access through an unrelated organization ID", async () => {
    memberships.mockResolvedValue([
      { organizationId: "org-a", membershipRole: "owner" },
    ]);
    for (const write of [true, false])
      await expect(
        authorize(
          new Request("https://app.example/api/attribution/workspaces/org-b"),
          "org-b",
          write,
        ),
      ).rejects.toMatchObject({ status: 403 });
  });
  it("allows analyst reads but rejects mutations", async () => {
    memberships.mockResolvedValue([
      { organizationId: "org-a", membershipRole: "analyst" },
    ]);
    await expect(
      authorize(new Request("https://app.example"), "org-a"),
    ).resolves.toMatchObject({ membershipRole: "analyst" });
    await expect(
      authorize(new Request("https://app.example"), "org-a", true),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("does not enable local test identity in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINCODE_LOCAL_TEST", "1");
    expect(localMode()).toBe(false);
  });
  it("rejects cross-origin workspace mutations", () => {
    expect(() =>
      sameOrigin(
        new Request("https://app.example/api/attribution", {
          headers: { Origin: "https://other.example" },
        }),
      ),
    ).toThrow("workspace");
  });
  it("accepts the configured public origin when Next normalizes the request hostname", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://maintainflow.io/");
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3000/api/attribution/workspaces", {
          headers: { Origin: "https://maintainflow.io" },
        }),
      ),
    ).not.toThrow();
    for (const origin of [
      undefined,
      "null",
      "https://other.example",
      "http://localhost:3000",
    ]) {
      expect(() =>
        sameOrigin(
          new Request("http://localhost:3000/api/attribution/workspaces", {
            headers: {
              ...(origin ? { Origin: origin } : {}),
              "X-Forwarded-Host": "maintainflow.io",
            },
          }),
        ),
      ).toThrow("workspace");
    }
  });
  it("requires the exact configured local origin and preserves the development fallback", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "http://127.0.0.1:3218");
    const normalized = "http://localhost:3218/api/attribution/workspaces";
    expect(() =>
      sameOrigin(
        new Request(normalized, {
          headers: { Origin: "http://127.0.0.1:3218" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      sameOrigin(
        new Request(normalized, {
          headers: { Origin: "http://127.0.0.1:3217" },
        }),
      ),
    ).toThrow("workspace");
    vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "");
    expect(() =>
      sameOrigin(
        new Request(normalized, {
          headers: { Origin: "http://localhost:3218" },
        }),
      ),
    ).not.toThrow();
  });
  it.each([
    "",
    "http://maintainflow.io",
    "https://maintainflow.io/path",
    "https://user@maintainflow.io",
    "https://maintainflow.io?x=1",
    "https://maintainflow.io#x",
    "invalid",
  ])(
    "fails closed for an absent or invalid production origin: %s",
    (origin) => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("MAINTAINCODE_APP_ORIGIN", origin);
      expect(() =>
        sameOrigin(
          new Request("https://maintainflow.io/api/attribution/workspaces", {
            headers: { Origin: "https://maintainflow.io" },
          }),
        ),
      ).toThrow("origin");
    },
  );
  it("redacts click references and billing IDs from exported workspace data", () => {
    const w = emptyWorkspace("w", "Test");
    w.billing.customerId = "cus_private";
    w.billing.subscriptionId = "sub_private";
    w.billing.refreshGeneration = "refresh_private";
    w.billing.checkout = {
      id: "attempt_private",
      plan: "starter",
      interval: "month",
      priceId: "price_private",
      customerId: "cus_private",
      returnUrl: "https://maintainflow.io/app",
      requestedAt: 1,
      sessionId: "cs_private",
      leaseToken: "lease_private",
      leaseUntil: 2,
    };
    const evidence = advanceEvidence(
      null,
      captureTouch("https://site.example/?oppref=private-click"),
    );
    w.submissions.push({
      id: "s",
      siteId: "site",
      formId: "form",
      at: new Date().toISOString(),
      evidence,
      status: "confirmed",
      test: false,
    });
    const text = JSON.stringify(publicWorkspace(w));
    expect(text).not.toContain("private-click");
    expect(text).not.toContain("cus_private");
    for (const value of [
      "sub_private",
      "refresh_private",
      "attempt_private",
      "price_private",
      "cs_private",
      "lease_private",
    ])
      expect(text).not.toContain(value);
    expect(w.billing.checkout.id).toBe("attempt_private");
    expect(w.submissions[0].evidence.first.oppref).toBe("private-click");
  });
});
