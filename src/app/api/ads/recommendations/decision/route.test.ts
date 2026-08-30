import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class AdvertiserCredentialUnavailableError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class RecommendationDecisionStoreUnavailableError extends Error {}
  class RecommendationDecisionTransitionError extends Error {}
  class ApprovalStoreUnavailableError extends Error {}
  class RequestBodyTooLargeError extends Error {}
  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    AdvertiserCredentialUnavailableError,
    TenancyStoreUnavailableError,
    RecommendationDecisionStoreUnavailableError,
    RecommendationDecisionTransitionError,
    ApprovalStoreUnavailableError,
    RequestBodyTooLargeError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    verifyRecommendationDecisionStore: vi.fn(),
    getAdsApiKeyForAccount: vi.fn(),
    getAdsRuntimeMode: vi.fn(),
    fetchLiveAdAccount: vi.fn(),
    fetchLiveWorkbenchData: vi.fn(),
    dismissRecommendation: vi.fn(),
    restoreRecommendation: vi.fn(),
    listActiveApprovalRecords: vi.fn(),
  };
});

vi.mock("@/lib/audit/approval-store.server", () => ({
  ApprovalStoreUnavailableError: testState.ApprovalStoreUnavailableError,
  listActiveApprovalRecords: testState.listActiveApprovalRecords,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/audit/recommendation-decision-store.server", () => ({
  RecommendationDecisionStoreUnavailableError:
    testState.RecommendationDecisionStoreUnavailableError,
  RecommendationDecisionTransitionError:
    testState.RecommendationDecisionTransitionError,
  verifyRecommendationDecisionStore:
    testState.verifyRecommendationDecisionStore,
  dismissRecommendation: testState.dismissRecommendation,
  restoreRecommendation: testState.restoreRecommendation,
}));

vi.mock("@/lib/http/request-security.server", () => ({
  RequestBodyTooLargeError: testState.RequestBodyTooLargeError,
  isSecureSameOriginRequest: () => true,
  readJsonBodyWithLimit: (request: Request) => request.json(),
}));

vi.mock("@/lib/openai-ads/client.server", () => ({
  getAdsRuntimeMode: testState.getAdsRuntimeMode,
}));

vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: testState.fetchLiveAdAccount,
  fetchLiveWorkbenchData: testState.fetchLiveWorkbenchData,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError:
    testState.AdvertiserCredentialUnavailableError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  getAdsApiKeyForAccount: testState.getAdsApiKeyForAccount,
  requireAccountAccess: testState.requireAccountAccess,
}));

import { POST } from "./route";

const recommendation = {
  id: "live_bid_adgrp_1",
  entityId: "adgrp_1",
  source: "live",
};

function request(body: Record<string, unknown>) {
  return new Request(
    "http://localhost/api/ads/recommendations/decision",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.requireAccountAccess.mockResolvedValue({
    organizationId: "00000000-0000-4000-8000-000000000001",
    membershipRole: "owner",
    accountRole: "owner",
  });
  testState.verifyRecommendationDecisionStore.mockResolvedValue(true);
  testState.getAdsApiKeyForAccount.mockResolvedValue("ads_account_key");
  testState.getAdsRuntimeMode.mockReturnValue({ dataSource: "live" });
  testState.fetchLiveAdAccount.mockResolvedValue({
    id: "adacct_client",
    name: "Client account",
  });
  testState.fetchLiveWorkbenchData.mockResolvedValue({
    recommendations: [recommendation],
  });
  testState.dismissRecommendation.mockResolvedValue({ created: true });
  testState.listActiveApprovalRecords.mockResolvedValue([]);
  testState.restoreRecommendation.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000002",
  });
});

describe("durable recommendation decisions", () => {
  it("re-reads the authorized live account before storing a dismissal", async () => {
    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "  Budget is committed to the current bid test.  ",
      }),
    );

    expect(response.status).toBe(200);
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "write",
    );
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledWith({
      kind: "account_api_key",
      secret: "ads_account_key",
      expectedAccountId: "adacct_client",
    });
    expect(testState.dismissRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "adacct_client",
        operatorId: "user_owner",
        recommendation,
        reason: "Budget is committed to the current bid test.",
      }),
    );
  });

  it("restores only the matching current live recommendation", async () => {
    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "restore",
      }),
    );

    expect(response.status).toBe(200);
    expect(testState.restoreRecommendation).toHaveBeenCalledWith(
      expect.objectContaining({ recommendation }),
    );
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });

  it("rejects a short or absent dismissal reason before any provider read", async () => {
    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "no",
      }),
    );

    expect(response.status).toBe(422);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });

  it("rejects review-only access before reading the account credential", async () => {
    testState.requireAccountAccess.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Review-only access."),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "The client declined this exact change.",
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.getAdsApiKeyForAccount).not.toHaveBeenCalled();
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
  });

  it("refuses to store a decision when the credential resolves elsewhere", async () => {
    testState.fetchLiveAdAccount.mockResolvedValue({
      id: "adacct_other",
      name: "Other account",
    });

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "The client declined this exact change.",
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.fetchLiveWorkbenchData).not.toHaveBeenCalled();
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });

  it("does not dismiss a recommendation already under active approval", async () => {
    testState.listActiveApprovalRecords.mockResolvedValue([
      {
        recommendationId: recommendation.id,
        entityId: recommendation.entityId,
      },
    ]);

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "The client wants to defer this change.",
      }),
    );

    expect(response.status).toBe(409);
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });
});
