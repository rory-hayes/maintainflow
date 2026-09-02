import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class ApprovalStoreUnavailableError extends Error {}
  class ApprovalTransitionError extends Error {}
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class AdvertiserCredentialUnavailableError extends Error {}
  class AdvertiserWriteBlockedError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class RequestBodyTooLargeError extends Error {}
  class AdsMutationPreconditionFailedError extends Error {
    approvalId: string;
    operation = "rollback" as const;
    reason: "provider_state_changed" | "provider_state_unavailable";
    requiresFreshReview: boolean;
    persistenceWarning: boolean;

    constructor(
      approvalId: string,
      reason: "provider_state_changed" | "provider_state_unavailable",
      persistenceWarning = false,
    ) {
      super("provider detail must not escape");
      this.approvalId = approvalId;
      this.reason = reason;
      this.requiresFreshReview = reason === "provider_state_changed";
      this.persistenceWarning = persistenceWarning;
    }
  }
  class AdsMutationReconciliationRequiredError extends Error {
    approvalId: string;
    operation = "rollback" as const;
    mustNotRetry = true;
    persistenceWarning: boolean;

    constructor(approvalId: string, persistenceWarning = false) {
      super("provider detail must not escape");
      this.approvalId = approvalId;
      this.persistenceWarning = persistenceWarning;
    }
  }
  class AdsMutationRejectedError extends Error {
    approvalId: string;

    constructor(approvalId: string) {
      super("provider detail must not escape");
      this.approvalId = approvalId;
    }
  }
  return {
    ApprovalStoreUnavailableError,
    ApprovalTransitionError,
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    AdvertiserCredentialUnavailableError,
    AdvertiserWriteBlockedError,
    TenancyStoreUnavailableError,
    RequestBodyTooLargeError,
    AdsMutationPreconditionFailedError,
    AdsMutationReconciliationRequiredError,
    AdsMutationRejectedError,
    getApprovalAccountId: vi.fn(),
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    getAdsCredentialMaterialForAccount: vi.fn(),
    getAdsRuntimeMode: vi.fn(),
    fetchLiveAdAccount: vi.fn(),
    applyStoredRollback: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    readBodyWithLimit: vi.fn(),
  };
});

vi.mock("@/lib/audit/approval-store.server", () => ({
  ApprovalStoreUnavailableError: testState.ApprovalStoreUnavailableError,
  ApprovalTransitionError: testState.ApprovalTransitionError,
  getApprovalAccountId: testState.getApprovalAccountId,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/http/request-security.server", () => ({
  RequestBodyTooLargeError: testState.RequestBodyTooLargeError,
  isSecureSameOriginRequest: testState.isSecureSameOriginRequest,
  readBodyWithLimit: testState.readBodyWithLimit,
}));

vi.mock("@/lib/openai-ads/client.server", () => ({
  AdsMutationPreconditionFailedError:
    testState.AdsMutationPreconditionFailedError,
  AdsMutationReconciliationRequiredError:
    testState.AdsMutationReconciliationRequiredError,
  AdsMutationRejectedError: testState.AdsMutationRejectedError,
  applyStoredRollback: testState.applyStoredRollback,
  getAdsRuntimeMode: testState.getAdsRuntimeMode,
}));

vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: testState.fetchLiveAdAccount,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError:
    testState.AdvertiserCredentialUnavailableError,
  AdvertiserWriteBlockedError: testState.AdvertiserWriteBlockedError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  getAdsCredentialMaterialForAccount:
    testState.getAdsCredentialMaterialForAccount,
  requireAccountAccess: testState.requireAccountAccess,
}));

import { POST } from "./route";

const approvalId = "00000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({ approvalId }) };
const access = {
  organizationId: "00000000-0000-4000-8000-000000000002",
  organizationName: "Northstar Agency",
  organizationType: "agency",
  accountId: "adacct_client",
  accountName: "Client account",
  connectionMode: "vault",
  membershipRole: "owner",
  accountRole: "manager",
};

function request() {
  return new Request(
    `http://localhost/api/ads/approvals/${approvalId}/rollback`,
    { method: "POST" },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.isSecureSameOriginRequest.mockReturnValue(true);
  testState.readBodyWithLimit.mockResolvedValue("");
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.getApprovalAccountId.mockResolvedValue("adacct_client");
  testState.requireAccountAccess.mockResolvedValue(access);
  testState.getAdsCredentialMaterialForAccount.mockResolvedValue({
    apiKey: "ads_private_key",
    credentialGeneration: "vault:credential-id:2",
  });
  testState.getAdsRuntimeMode.mockReturnValue({
    writeInfrastructureConfigured: true,
    writeBlockers: [],
  });
  testState.fetchLiveAdAccount.mockResolvedValue({ id: "adacct_client" });
  testState.applyStoredRollback.mockResolvedValue({
    mode: "live",
    applied: true,
    approvalId,
  });
});

describe("approval rollback route", () => {
  it("re-checks the account and generation before invoking the guarded rollback", async () => {
    const response = await POST(request(), context);

    expect(response.status).toBe(200);
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "write",
    );
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledWith({
      kind: "account_api_key",
      secret: "ads_private_key",
      expectedAccountId: "adacct_client",
    });
    expect(testState.applyStoredRollback).toHaveBeenCalledWith({
      approvalId,
      accountId: "adacct_client",
      operatorId: "user_owner",
      access,
      credential: {
        kind: "account_api_key",
        secret: "ads_private_key",
        expectedAccountId: "adacct_client",
      },
      credentialGeneration: "vault:credential-id:2",
    });
  });

  it("rejects an insecure request before reading approval or credentials", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(testState.requireOperatorId).not.toHaveBeenCalled();
    expect(testState.getApprovalAccountId).not.toHaveBeenCalled();
    expect(testState.getAdsCredentialMaterialForAccount).not.toHaveBeenCalled();
    expect(testState.applyStoredRollback).not.toHaveBeenCalled();
  });

  it("does not read credentials or contact OpenAI for a review-only operator", async () => {
    testState.requireAccountAccess.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Review-only access."),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(testState.getAdsCredentialMaterialForAccount).not.toHaveBeenCalled();
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.applyStoredRollback).not.toHaveBeenCalled();
  });

  it("returns a fixed must-not-retry response for an uncertain provider outcome", async () => {
    testState.applyStoredRollback.mockRejectedValue(
      new testState.AdsMutationReconciliationRequiredError(approvalId, true),
    );

    const response = await POST(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      error:
        "The Ads API rollback outcome is uncertain and requires manual reconciliation. Do not retry this action.",
      code: "reconciliation_required",
      approvalId,
      operation: "rollback",
      mustNotRetry: true,
      persistenceWarning: true,
    });
    expect(JSON.stringify(payload)).not.toContain("provider detail");
  });

  it("returns a no-write conflict when rollback precondition state drifted", async () => {
    testState.applyStoredRollback.mockRejectedValue(
      new testState.AdsMutationPreconditionFailedError(
        approvalId,
        "provider_state_changed",
      ),
    );

    const response = await POST(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      error:
        "OpenAI Ads changed after this rollback became eligible. No rollback was sent; reconcile the live state before retrying.",
      code: "provider_state_changed",
      approvalId,
      operation: "rollback",
      noMutationSent: true,
      requiresFreshReview: true,
      persistenceWarning: false,
    });
    expect(JSON.stringify(payload)).not.toContain("provider detail");
  });

  it("blocks rollback while the account has an unresolved provider operation", async () => {
    testState.applyStoredRollback.mockRejectedValue(
      new testState.AdvertiserWriteBlockedError(
        "Resolve the advertiser account's active or uncertain Ads operation before starting another live write.",
      ),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Resolve the advertiser account's active or uncertain Ads operation before starting another live write.",
    });
  });
});
