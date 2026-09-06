import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => ({
  getOrigin: vi.fn(),
  getOptionalOperator: vi.fn(),
  isWorkspaceAdmissionAllowed: vi.fn(),
  resolveDeepLink: vi.fn(),
}));

vi.mock("@/lib/approvals/notification-config.server", () => ({
  getApprovalNotificationAppOrigin: testState.getOrigin,
}));

vi.mock("@/lib/approvals/notification-delivery-store.server", () => ({
  resolveApprovalNotificationDeepLink: testState.resolveDeepLink,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  getOptionalOperator: testState.getOptionalOperator,
}));

vi.mock("@/lib/auth/config", () => ({
  isWorkspaceAdmissionAllowed: testState.isWorkspaceAdmissionAllowed,
}));

import { GET } from "./route";

const deliveryId = "00000000-0000-4000-8000-000000000501";
const approvalRequestId = "00000000-0000-4000-8000-000000000502";
const organizationId = "00000000-0000-4000-8000-000000000503";
const operator = { id: "user_reviewer", name: "Rory", initials: "RH" };

function context(id = deliveryId) {
  return { params: Promise.resolve({ deliveryId: id }) };
}

describe("approval notification deep link", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.getOrigin.mockReturnValue("https://maintainflow.io");
    testState.getOptionalOperator.mockResolvedValue(operator);
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(true);
    testState.resolveDeepLink.mockResolvedValue({
      approvalRequestId,
      organizationId,
      accountId: "adacct_123",
      source: "live",
      eventType: "review_requested",
    });
  });

  it("rejects malformed delivery identifiers before auth", async () => {
    const response = await GET(new Request("https://maintainflow.io"), context("bad"));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(testState.getOptionalOperator).not.toHaveBeenCalled();
  });

  it("sends an unauthenticated recipient through a bounded return path", async () => {
    testState.getOptionalOperator.mockResolvedValue(null);

    const response = await GET(new Request("https://maintainflow.io"), context());
    const location = new URL(response.headers.get("location")!);

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(location.origin).toBe("https://maintainflow.io");
    expect(location.pathname).toBe("/auth/sign-in");
    expect(location.searchParams.get("returnTo")).toBe(
      `/approvals/open/${deliveryId}`,
    );
  });

  it("redirects only the exact recipient to the tenant-scoped request", async () => {
    const response = await GET(new Request("https://maintainflow.io"), context());
    const location = new URL(response.headers.get("location")!);

    expect(testState.resolveDeepLink).toHaveBeenCalledWith({
      deliveryId,
      operatorId: operator.id,
    });
    expect(location.pathname).toBe("/app");
    expect(location.searchParams.get("tab")).toBe("approvals");
    expect(location.searchParams.get("approvalFilter")).toBe("needs-review");
    expect(location.searchParams.get("organization")).toBe(organizationId);
    expect(location.searchParams.get("approvalRequest")).toBe(
      approvalRequestId,
    );
  });

  it("does not disclose whether a delivery belongs to another operator", async () => {
    testState.resolveDeepLink.mockResolvedValue(null);

    const response = await GET(new Request("https://maintainflow.io"), context());

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found.");
  });

  it("does not resolve delivery data for an authenticated recipient removed from the beta", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    const response = await GET(new Request("https://maintainflow.io"), context());

    expect(response.status).toBe(404);
    expect(testState.resolveDeepLink).not.toHaveBeenCalled();
  });

  it("fails closed when authentication or persistence is unavailable", async () => {
    testState.getOptionalOperator.mockRejectedValueOnce(new Error("clerk unavailable"));
    const authFailure = await GET(
      new Request("https://maintainflow.io"),
      context(),
    );

    testState.resolveDeepLink.mockRejectedValueOnce(new Error("database unavailable"));
    const storeFailure = await GET(
      new Request("https://maintainflow.io"),
      context(),
    );

    expect(authFailure.status).toBe(503);
    expect(storeFailure.status).toBe(503);
  });
});
