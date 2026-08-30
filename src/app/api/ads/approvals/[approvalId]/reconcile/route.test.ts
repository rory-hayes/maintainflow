import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class ApprovalStoreUnavailableError extends Error {}
  class ApprovalTransitionError extends Error {}
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  return {
    ApprovalStoreUnavailableError,
    ApprovalTransitionError,
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    getApprovalAccountId: vi.fn(),
    reconcileApprovalRecord: vi.fn(),
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/observability/logger.server", () => ({
  createServerLogger: () => ({
    info: testState.logInfo,
    warn: testState.logWarn,
    error: testState.logError,
  }),
}));

vi.mock("@/lib/audit/approval-store.server", () => ({
  ApprovalStoreUnavailableError: testState.ApprovalStoreUnavailableError,
  ApprovalTransitionError: testState.ApprovalTransitionError,
  getApprovalAccountId: testState.getApprovalAccountId,
  reconcileApprovalRecord: testState.reconcileApprovalRecord,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/http/request-security.server")
  >()),
  isSecureSameOriginRequest: () => true,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  requireAccountAccess: testState.requireAccountAccess,
}));

import { POST } from "./route";

const access = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationName: "Northstar Agency",
  organizationType: "agency",
  accountId: "adacct_client",
  accountName: "Client account",
  connectionMode: "vault",
  membershipRole: "owner",
  accountRole: "manager",
};
const context = {
  params: Promise.resolve({ approvalId: "approval-123" }),
};

function request() {
  return new Request(
    "http://localhost/api/ads/approvals/approval-123/reconcile",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "mark_not_applied",
        note: "Verified that the change was not applied.",
      }),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://database.test/maintainflow");
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.getApprovalAccountId.mockResolvedValue("adacct_client");
  testState.requireAccountAccess.mockResolvedValue(access);
  testState.reconcileApprovalRecord.mockResolvedValue({ status: "failed" });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("approval reconciliation route", () => {
  it("passes the authorized account path into the transactional store commit", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "write",
    );
    expect(testState.reconcileApprovalRecord).toHaveBeenCalledWith({
      id: "approval-123",
      accountId: "adacct_client",
      operatorId: "user_owner",
      action: "mark_not_applied",
      note: "Verified that the change was not applied.",
      access,
    });
    expect(testState.logInfo).toHaveBeenCalledWith("ads.reconcile.completed");
  });

  it("rejects a role revoked between the route check and final store commit", async () => {
    testState.reconcileApprovalRecord.mockRejectedValue(
      new testState.AccountAccessForbiddenError(
        "Write access changed while this approval was being reconciled. Refresh before trying again.",
      ),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "Write access changed while this approval was being reconciled. Refresh before trying again.",
    });
    expect(testState.logWarn).toHaveBeenCalledWith("ads.reconcile.failed", {
      error: expect.any(Error),
      status: 403,
    });
  });

  it("does not expose unexpected reconciliation database errors", async () => {
    testState.reconcileApprovalRecord.mockRejectedValue(
      new Error("relation ads_approval_records does not exist"),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to reconcile approval safely.",
    });
    expect(testState.logError).toHaveBeenCalledWith("ads.reconcile.failed", {
      error: expect.any(Error),
      status: 400,
    });
  });
});
