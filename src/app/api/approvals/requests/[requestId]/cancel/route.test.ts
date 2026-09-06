import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class ChangeApprovalRequestForbiddenError extends Error {}
  class ChangeApprovalRequestStoreUnavailableError extends Error {}
  class ChangeApprovalRequestTransitionError extends Error {}
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}

  return {
    ChangeApprovalRequestForbiddenError,
    ChangeApprovalRequestStoreUnavailableError,
    ChangeApprovalRequestTransitionError,
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    requireOperator: vi.fn(),
    cancelChangeApprovalRequest: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    attemptApprovalNotificationDelivery: vi.fn(),
    approvalNotificationAttemptMessage: vi.fn(),
  };
});

vi.mock("@/lib/approvals/change-request-store.server", () => ({
  ChangeApprovalRequestForbiddenError:
    testState.ChangeApprovalRequestForbiddenError,
  ChangeApprovalRequestStoreUnavailableError:
    testState.ChangeApprovalRequestStoreUnavailableError,
  ChangeApprovalRequestTransitionError:
    testState.ChangeApprovalRequestTransitionError,
  cancelChangeApprovalRequest: testState.cancelChangeApprovalRequest,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperator: testState.requireOperator,
}));

vi.mock("@/lib/approvals/notification-route.server", () => ({
  attemptApprovalNotificationDelivery:
    testState.attemptApprovalNotificationDelivery,
  approvalNotificationAttemptMessage:
    testState.approvalNotificationAttemptMessage,
}));

vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/http/request-security.server")
  >()),
  isSecureSameOriginRequest: testState.isSecureSameOriginRequest,
}));

import { POST } from "./route";

const requestId = "00000000-0000-4000-8000-000000000301";
const context = { params: Promise.resolve({ requestId }) };
const operator = {
  id: "user_agency_analyst",
  name: "Alex Analyst",
  initials: "AA",
};

function cancelRequest(body: Record<string, unknown> = { version: 2 }) {
  return new Request(
    `http://localhost/api/approvals/requests/${requestId}/cancel`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.isSecureSameOriginRequest.mockReturnValue(true);
  testState.requireOperator.mockResolvedValue(operator);
  testState.cancelChangeApprovalRequest.mockResolvedValue({
    id: requestId,
    status: "cancelled",
    version: 3,
    notificationDeliveryIds: [
      "00000000-0000-4000-8000-000000000302",
    ],
  });
  testState.attemptApprovalNotificationDelivery.mockResolvedValue({
    queued: 1,
    summary: null,
    operatorAttentionRequired: false,
  });
  testState.approvalNotificationAttemptMessage.mockReturnValue(
    "The requester email remains queued for retry.",
  );
});

describe("agency approval cancellation route", () => {
  it("cancels an awaiting packet without claiming an external write", async () => {
    const response = await POST(cancelRequest(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(testState.cancelChangeApprovalRequest).toHaveBeenCalledWith({
      requestId,
      operator,
      expectedVersion: 2,
    });
    expect(payload).toEqual({
      id: requestId,
      status: "cancelled",
      version: 3,
      notification: {
        queued: 1,
        summary: null,
        operatorAttentionRequired: false,
      },
      message:
        "Approval request cancelled. The requester email remains queued for retry. No external change was made.",
    });
    expect(payload).not.toHaveProperty("notificationDeliveryIds");
  });

  it("rejects an insecure request before auth or store access", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await POST(cancelRequest(), context);

    expect(response.status).toBe(403);
    expect(testState.requireOperator).not.toHaveBeenCalled();
    expect(testState.cancelChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("maps an unsigned operator to 401", async () => {
    testState.requireOperator.mockRejectedValue(
      new testState.OperatorUnauthorizedError("Sign in first."),
    );

    const response = await POST(cancelRequest(), context);

    expect(response.status).toBe(401);
    expect(testState.cancelChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects a cancellation body above 4 KB", async () => {
    const response = await POST(
      cancelRequest({ version: 2, padding: "x".repeat(5_000) }),
      context,
    );

    expect(response.status).toBe(413);
    expect(testState.cancelChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("accepts only a strict positive-version body", async () => {
    for (const body of [
      { version: 0 },
      { version: 2, operatorId: "user_other" },
      { version: 2, organizationId: "other-agency" },
    ]) {
      const response = await POST(cancelRequest(body), context);
      expect(response.status).toBe(422);
    }
    expect(testState.cancelChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects a malformed request id before store access", async () => {
    const response = await POST(cancelRequest(), {
      params: Promise.resolve({ requestId: "not-a-uuid" }),
    });

    expect(response.status).toBe(422);
    expect(testState.cancelChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "cross-tenant lookup",
      "This approval request is not available in your agency workspace.",
    ],
    [
      "another analyst's packet",
      "Only the requester or an agency owner or admin can cancel this packet.",
    ],
  ])("maps %s denial to 403", async (_label, message) => {
    testState.cancelChangeApprovalRequest.mockRejectedValue(
      new testState.ChangeApprovalRequestForbiddenError(message),
    );

    const response = await POST(cancelRequest(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: message });
  });

  it("maps a stale version or terminal packet to 409", async () => {
    testState.cancelChangeApprovalRequest.mockRejectedValue(
      new testState.ChangeApprovalRequestTransitionError(
        "This approval request changed before it could be cancelled.",
      ),
    );

    const response = await POST(cancelRequest(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This approval request changed before it could be cancelled.",
    });
  });

  it("maps unavailable approval persistence to 503", async () => {
    testState.cancelChangeApprovalRequest.mockRejectedValue(
      new testState.ChangeApprovalRequestStoreUnavailableError(
        "The agency approval queue is not configured.",
      ),
    );

    const response = await POST(cancelRequest(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "The agency approval queue is not configured.",
    });
  });
});
