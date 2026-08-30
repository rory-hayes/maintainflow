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
  class LiveSyncUnavailableError extends Error {
    refreshFailure: string;
    retryAfter: Date | null;

    constructor(refreshFailure: string, retryAfter: Date | null = null) {
      super("Live sync unavailable");
      this.refreshFailure = refreshFailure;
      this.retryAfter = retryAfter;
    }
  }
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
    LiveSyncUnavailableError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    verifyRecommendationDecisionStore: vi.fn(),
    getAdsCredentialMaterialForAccount: vi.fn(),
    getAdsRuntimeMode: vi.fn(),
    getLiveWorkbench: vi.fn(),
    withAuthorizedAdsWriteFence: vi.fn(),
    dismissRecommendation: vi.fn(),
    restoreRecommendation: vi.fn(),
  };
});

vi.mock("@/lib/audit/approval-store.server", () => ({
  ApprovalStoreUnavailableError: testState.ApprovalStoreUnavailableError,
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

vi.mock("@/lib/openai-ads/live-sync.server", () => ({
  LiveSyncUnavailableError: testState.LiveSyncUnavailableError,
  getLiveWorkbench: testState.getLiveWorkbench,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError:
    testState.AdvertiserCredentialUnavailableError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  getAdsCredentialMaterialForAccount:
    testState.getAdsCredentialMaterialForAccount,
  requireAccountAccess: testState.requireAccountAccess,
  withAuthorizedAdsWriteFence: testState.withAuthorizedAdsWriteFence,
}));

import { POST } from "./route";
import { recommendationFingerprint } from "@/lib/audit/recommendation-decision";

const recommendation = {
  id: "live_bid_adgrp_1",
  entityId: "adgrp_1",
  source: "live",
};
const displayedFingerprint = recommendationFingerprint(
  recommendation as never,
);

function request(body: Record<string, unknown>) {
  const payload =
    "recommendationId" in body && !("recommendationFingerprint" in body)
      ? { ...body, recommendationFingerprint: displayedFingerprint }
      : body;
  return new Request(
    "http://localhost/api/ads/recommendations/decision",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
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
  testState.getAdsCredentialMaterialForAccount.mockResolvedValue({
    apiKey: "ads_account_key",
    credentialGeneration: "vault:credential-id:2",
  });
  testState.getAdsRuntimeMode.mockReturnValue({ dataSource: "live" });
  testState.getLiveWorkbench.mockResolvedValue({
    data: { recommendations: [recommendation] },
    freshness: "refreshed",
  });
  testState.dismissRecommendation.mockResolvedValue({ created: true });
  testState.restoreRecommendation.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000002",
  });
  testState.withAuthorizedAdsWriteFence.mockImplementation(
    async (options, operation) => {
      const access = await testState.requireAccountAccess(
        options.operatorId,
        options.accountId,
        "write",
      );
      const value = await operation({
        transaction: { test: "transaction" },
        access,
        credentialMaterial: {
          apiKey: "ads_account_key",
          credentialGeneration: options.expectedCredentialGeneration,
        },
      });
      return { value, access };
    },
  );
});

describe("durable recommendation decisions", () => {
  it("requires a fresh authorized live snapshot before storing a dismissal", async () => {
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
    expect(testState.getLiveWorkbench).toHaveBeenCalledWith({
      accountId: "adacct_client",
      credentialGeneration: "vault:credential-id:2",
      credential: {
        kind: "account_api_key",
        secret: "ads_account_key",
        expectedAccountId: "adacct_client",
      },
      policy: "dashboard",
    });
    expect(testState.withAuthorizedAdsWriteFence).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "user_owner",
        accountId: "adacct_client",
        expectedCredentialGeneration: "vault:credential-id:2",
      }),
      expect.any(Function),
    );
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

  it("rejects missing or stale displayed consent before a durable decision", async () => {
    for (const fingerprint of [undefined, "0".repeat(64)]) {
      const response = await POST(
        request({
          accountId: "adacct_client",
          recommendationId: recommendation.id,
          recommendationFingerprint: fingerprint,
          action: "restore",
        }),
      );

      expect(response.status).toBe(409);
    }
    expect(testState.withAuthorizedAdsWriteFence).not.toHaveBeenCalled();
    expect(testState.restoreRecommendation).not.toHaveBeenCalled();
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
    expect(testState.getLiveWorkbench).not.toHaveBeenCalled();
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
    expect(testState.getAdsCredentialMaterialForAccount).not.toHaveBeenCalled();
    expect(testState.getLiveWorkbench).not.toHaveBeenCalled();
  });

  it("refuses to store a decision when the credential resolves elsewhere", async () => {
    testState.getLiveWorkbench.mockRejectedValue(
      new testState.LiveSyncUnavailableError("account_mismatch"),
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
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });

  it("returns a bounded retry response when no fresh snapshot is available", async () => {
    testState.getLiveWorkbench.mockRejectedValue(
      new testState.LiveSyncUnavailableError(
        "provider_unavailable",
        new Date(Date.now() + 60_000),
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "The client declined this exact change.",
      }),
    );

    expect(response.status).toBe(503);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    await expect(response.json()).resolves.toEqual({
      error:
        "A current cached OpenAI Ads snapshot is required before recording this decision. Retry after live sync recovers.",
    });
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });

  it("does not dismiss a recommendation already under active approval", async () => {
    testState.dismissRecommendation.mockRejectedValue(
      new testState.RecommendationDecisionTransitionError(
        "This recommendation already has an active or unresolved approval and cannot be dismissed.",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "The client wants to defer this change.",
      }),
    );

    expect(response.status).toBe(409);
    expect(testState.dismissRecommendation).toHaveBeenCalledOnce();
  });

  it("does not store a decision when authority changes during snapshot review", async () => {
    testState.withAuthorizedAdsWriteFence.mockRejectedValue(
      new testState.AccountAccessForbiddenError(
        "Write access changed while live data was being reviewed.",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "dismiss",
        reason: "The client wants to defer this change.",
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.dismissRecommendation).not.toHaveBeenCalled();
  });

  it("does not store a decision when the credential rotates during review", async () => {
    testState.withAuthorizedAdsWriteFence.mockRejectedValue(
      new testState.AdvertiserCredentialUnavailableError(
        "The advertiser credential changed while live data was being reviewed.",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
        action: "restore",
      }),
    );

    expect(response.status).toBe(503);
    expect(testState.restoreRecommendation).not.toHaveBeenCalled();
  });
});
