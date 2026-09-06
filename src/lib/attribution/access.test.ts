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
  it("redacts click references and billing IDs from exported workspace data", () => {
    const w = emptyWorkspace("w", "Test");
    w.billing.customerId = "cus_private";
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
    expect(w.submissions[0].evidence.first.oppref).toBe("private-click");
  });
});
