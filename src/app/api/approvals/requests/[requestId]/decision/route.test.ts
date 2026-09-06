import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class ChangeApprovalRequestForbiddenError extends Error {}
  class ChangeApprovalRequestInvalidError extends Error {}
  class ChangeApprovalRequestStoreUnavailableError extends Error {}
  class ChangeApprovalRequestTransitionError extends Error {}
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}

  return {
    ChangeApprovalRequestForbiddenError,
    ChangeApprovalRequestInvalidError,
    ChangeApprovalRequestStoreUnavailableError,
    ChangeApprovalRequestTransitionError,
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    requireOperator: vi.fn(),
    decideChangeApprovalRequest: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    attemptApprovalNotificationDelivery: vi.fn(),
    approvalNotificationAttemptMessage: vi.fn(),
  };
});

vi.mock("@/lib/approvals/change-request-store.server", () => ({
  ChangeApprovalRequestForbiddenError:
    testState.ChangeApprovalRequestForbiddenError,
  ChangeApprovalRequestInvalidError: testState.ChangeApprovalRequestInvalidError,
  ChangeApprovalRequestStoreUnavailableError:
    testState.ChangeApprovalRequestStoreUnavailableError,
  ChangeApprovalRequestTransitionError:
    testState.ChangeApprovalRequestTransitionError,
  decideChangeApprovalRequest: testState.decideChangeApprovalRequest,
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

const requestId = "00000000-0000-4000-8000-000000000201";
const context = { params: Promise.resolve({ requestId }) };
const operator = {
  id: "user_agency_owner",
  name: "Rory Reviewer",
  initials: "RR",
};

function decisionRequest(
  body: Record<string, unknown> = { action: "approve", version: 1 },
) {
  return new Request(
    `http://localhost/api/approvals/requests/${requestId}/decision`,
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
  testState.decideChangeApprovalRequest.mockResolvedValue({
    id: requestId,
    status: "approved",
    version: 2,
    notificationDeliveryIds: [
      "00000000-0000-4000-8000-000000000202",
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

describe("agency approval decision route", () => {
  it("records approval for later execution with no external-write claim", async () => {
    const response = await POST(decisionRequest(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(testState.decideChangeApprovalRequest).toHaveBeenCalledWith({
      requestId,
      operator,
      action: "approve",
      note: undefined,
      expectedVersion: 1,
    });
    expect(payload).toEqual({
      id: requestId,
      status: "approved",
      version: 2,
      notification: {
        queued: 1,
        summary: null,
        operatorAttentionRequired: false,
      },
      message:
        "Approved for later execution. The requester email remains queued for retry. No external change was made.",
    });
    expect(payload).not.toHaveProperty("notificationDeliveryIds");
    expect(payload.message).not.toContain("applied");
  });

  it("records a trimmed request-changes note without an external write", async () => {
    testState.decideChangeApprovalRequest.mockResolvedValue({
      id: requestId,
      status: "changes_requested",
      version: 4,
      notificationDeliveryIds: [
        "00000000-0000-4000-8000-000000000203",
      ],
    });

    const response = await POST(
      decisionRequest({
        action: "request_changes",
        note: "  Add a safer rollback threshold.  ",
        version: 3,
      }),
      context,
    );

    expect(response.status).toBe(200);
    expect(testState.decideChangeApprovalRequest).toHaveBeenCalledWith({
      requestId,
      operator,
      action: "request_changes",
      note: "Add a safer rollback threshold.",
      expectedVersion: 3,
    });
    await expect(response.json()).resolves.toMatchObject({
      status: "changes_requested",
      message:
        "Changes requested. The requester email remains queued for retry. No external change was made.",
    });
  });

  it("rejects an insecure request before auth or store access", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await POST(decisionRequest(), context);

    expect(response.status).toBe(403);
    expect(testState.requireOperator).not.toHaveBeenCalled();
    expect(testState.decideChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("maps an unsigned operator to 401", async () => {
    testState.requireOperator.mockRejectedValue(
      new testState.OperatorUnauthorizedError("Sign in first."),
    );

    const response = await POST(decisionRequest(), context);

    expect(response.status).toBe(401);
    expect(testState.decideChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects an oversized decision before store access", async () => {
    const response = await POST(
      decisionRequest({
        action: "request_changes",
        note: "x".repeat(5_000),
        version: 1,
      }),
      context,
    );

    expect(response.status).toBe(413);
    expect(testState.decideChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("requires a strict action, note, and positive-version shape", async () => {
    for (const body of [
      { action: "execute", version: 1 },
      { action: "approve", version: 0 },
      { action: "approve", version: 1, organizationId: "other-agency" },
    ]) {
      const response = await POST(decisionRequest(body), context);
      expect(response.status).toBe(422);
    }
    expect(testState.decideChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects a malformed request id before store access", async () => {
    const response = await POST(decisionRequest(), {
      params: Promise.resolve({ requestId: "not-a-uuid" }),
    });

    expect(response.status).toBe(422);
    expect(testState.decideChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "self-decision",
      "The requester cannot approve or request changes on their own packet.",
    ],
    [
      "cross-tenant lookup",
      "This approval request is not available in your agency workspace.",
    ],
  ])("maps %s denial to 403", async (_label, message) => {
    testState.decideChangeApprovalRequest.mockRejectedValue(
      new testState.ChangeApprovalRequestForbiddenError(message),
    );

    const response = await POST(decisionRequest(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: message });
  });

  it("maps invalid notes and stale store transitions to conflicts", async () => {
    testState.decideChangeApprovalRequest.mockRejectedValueOnce(
      new testState.ChangeApprovalRequestInvalidError(
        "Explain the requested changes in at least 10 characters.",
      ),
    );
    const invalid = await POST(
      decisionRequest({ action: "request_changes", note: "short", version: 1 }),
      context,
    );

    testState.decideChangeApprovalRequest.mockRejectedValueOnce(
      new testState.ChangeApprovalRequestTransitionError(
        "This approval request changed. Refresh before recording a decision.",
      ),
    );
    const stale = await POST(decisionRequest(), context);

    expect(invalid.status).toBe(409);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({
      error: "This approval request changed. Refresh before recording a decision.",
    });
  });

  it("maps unavailable auth or approval persistence to 503", async () => {
    testState.decideChangeApprovalRequest.mockRejectedValueOnce(
      new testState.ChangeApprovalRequestStoreUnavailableError(
        "The agency approval queue is not configured.",
      ),
    );
    const storeUnavailable = await POST(decisionRequest(), context);

    testState.requireOperator.mockRejectedValueOnce(
      new testState.OperatorAuthUnavailableError("Authentication unavailable."),
    );
    const authUnavailable = await POST(decisionRequest(), context);

    expect(storeUnavailable.status).toBe(503);
    expect(authUnavailable.status).toBe(503);
  });
});
