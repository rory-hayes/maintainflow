import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class AdvertiserCredentialUnavailableError extends Error {}
  class AdvertiserWriteBlockedError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class ApprovalStoreUnavailableError extends Error {}
  class ApprovalTransitionError extends Error {}
  class RequestBodyTooLargeError extends Error {}
  class AdsMutationPreconditionFailedError extends Error {
    approvalId: string;
    operation = "apply" as const;
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
    operation: "apply" | "rollback";
    persistenceWarning = false;

    constructor(approvalId: string, operation: "apply" | "rollback") {
      super("provider detail must not escape");
      this.approvalId = approvalId;
      this.operation = operation;
    }
  }
  class AdsMutationRejectedError extends Error {
    approvalId: string;

    constructor(approvalId: string) {
      super("provider detail must not escape");
      this.approvalId = approvalId;
    }
  }
  class OpenAIAdsApiError extends Error {
    status: number;
    retryAfterMs: number | null;

    constructor(status: number, retryAfterMs: number | null = null) {
      super("provider detail must not escape");
      this.status = status;
      this.retryAfterMs = retryAfterMs;
    }
  }
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
    AdvertiserWriteBlockedError,
    TenancyStoreUnavailableError,
    ApprovalStoreUnavailableError,
    ApprovalTransitionError,
    RequestBodyTooLargeError,
    AdsMutationPreconditionFailedError,
    AdsMutationReconciliationRequiredError,
    AdsMutationRejectedError,
    OpenAIAdsApiError,
    LiveSyncUnavailableError,
    applyAdsMutation: vi.fn(),
    getAdsRuntimeMode: vi.fn(),
    fetchLiveAdAccount: vi.fn(),
    getLiveWorkbench: vi.fn(),
    getDemoRecommendation: vi.fn(),
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    getAdsCredentialMaterialForAccount: vi.fn(),
  };
});

vi.mock("@/lib/openai-ads/client.server", () => ({
  AdsMutationPreconditionFailedError:
    testState.AdsMutationPreconditionFailedError,
  AdsMutationReconciliationRequiredError:
    testState.AdsMutationReconciliationRequiredError,
  AdsMutationRejectedError: testState.AdsMutationRejectedError,
  OpenAIAdsApiError: testState.OpenAIAdsApiError,
  applyAdsMutation: testState.applyAdsMutation,
  getAdsRuntimeMode: testState.getAdsRuntimeMode,
}));

vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: testState.fetchLiveAdAccount,
}));

vi.mock("@/lib/openai-ads/live-sync.server", () => ({
  LiveSyncUnavailableError: testState.LiveSyncUnavailableError,
  getLiveWorkbench: testState.getLiveWorkbench,
}));

vi.mock("@/lib/openai-ads/demo-data", () => ({
  demoAccount: { id: "demo-account" },
  getDemoRecommendation: testState.getDemoRecommendation,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/audit/approval-store.server", () => ({
  ApprovalStoreUnavailableError: testState.ApprovalStoreUnavailableError,
  ApprovalTransitionError: testState.ApprovalTransitionError,
}));

vi.mock("@/lib/http/request-security.server", () => ({
  RequestBodyTooLargeError: testState.RequestBodyTooLargeError,
  isSecureSameOriginRequest: () => true,
  readJsonBodyWithLimit: (request: Request) => request.json(),
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
import { recommendationApprovalFingerprint } from "@/lib/audit/recommendation-decision";

const recommendation = {
  id: "live_bid_adgrp_1",
  entityId: "adgrp_1",
  source: "live",
};
const displayedFingerprint = recommendationApprovalFingerprint(
  recommendation as never,
);

function request(body: Record<string, unknown>) {
  const recommendationSource =
    body.recommendationSource === "demo" ? "demo" : "live";
  const payload =
    "recommendationId" in body && !("recommendationFingerprint" in body)
      ? {
          ...body,
          recommendationFingerprint:
            recommendationSource === "live"
              ? displayedFingerprint
              : recommendationApprovalFingerprint({
                  ...recommendation,
                  source: "demo",
                } as never),
        }
      : body;
  return new Request("http://localhost/api/ads/recommendations/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.getAdsRuntimeMode.mockReturnValue({
    dataSource: "live",
    liveDataRequested: true,
    liveReadStage: true,
  });
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.requireAccountAccess.mockResolvedValue({
    organizationId: "00000000-0000-4000-8000-000000000001",
    membershipRole: "owner",
    accountRole: "owner",
  });
  testState.getAdsCredentialMaterialForAccount.mockResolvedValue({
    apiKey: "ads_account_key",
    credentialGeneration: "vault:credential-id:2",
  });
  testState.getLiveWorkbench.mockResolvedValue({
    data: { account: { id: "adacct_client" }, recommendations: [recommendation] },
    freshness: "refreshed",
  });
  testState.getDemoRecommendation.mockReturnValue({
    ...recommendation,
    source: "demo",
  });
  testState.applyAdsMutation.mockResolvedValue({
    mode: "live",
    message: "Applied",
  });
});

describe("live recommendation application", () => {
  it("uses a fresh generation-scoped snapshot before applying", async () => {
    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(200);
    expect(testState.getLiveWorkbench).toHaveBeenCalledWith({
      accountId: "adacct_client",
      credentialGeneration: "vault:credential-id:2",
      credential: {
        kind: "account_api_key",
        secret: "ads_account_key",
        expectedAccountId: "adacct_client",
      },
      policy: "mutation",
    });
    expect(testState.applyAdsMutation).toHaveBeenCalledWith(
      recommendation,
      expect.objectContaining({
        accountId: "adacct_client",
        operatorId: "user_owner",
        credentialGeneration: "vault:credential-id:2",
      }),
    );
  });

  it("requires an explicit authorized account before any legacy live lookup", async () => {
    const response = await POST(
      request({
        recommendationId: recommendation.id,
        recommendationSource: "live",
      }),
    );

    expect(response.status).toBe(422);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.requireOperatorId).not.toHaveBeenCalled();
    expect(testState.getLiveWorkbench).not.toHaveBeenCalled();
    expect(testState.applyAdsMutation).not.toHaveBeenCalled();
  });

  it("keeps an explicitly fingerprinted demo approval provider-free", async () => {
    testState.applyAdsMutation.mockResolvedValue({
      mode: "demo",
      applied: false,
      message: "Demo approval recorded.",
    });

    const response = await POST(
      request({
        recommendationId: recommendation.id,
        recommendationSource: "demo",
      }),
    );

    expect(response.status).toBe(200);
    expect(testState.requireOperatorId).not.toHaveBeenCalled();
    expect(testState.getAdsCredentialMaterialForAccount).not.toHaveBeenCalled();
    expect(testState.getLiveWorkbench).not.toHaveBeenCalled();
    expect(testState.applyAdsMutation).toHaveBeenCalledWith(
      expect.objectContaining({ source: "demo" }),
      expect.objectContaining({ accountId: "demo-account" }),
    );
  });

  it("rejects missing or stale displayed consent before applying", async () => {
    for (const fingerprint of [undefined, "0".repeat(64)]) {
      const response = await POST(
        request({
          accountId: "adacct_client",
          recommendationId: recommendation.id,
          recommendationFingerprint: fingerprint,
        }),
      );

      expect(response.status).toBe(409);
    }
    expect(testState.applyAdsMutation).not.toHaveBeenCalled();
  });

  it("rejects a refreshed monitoring plan that was not displayed for approval", async () => {
    testState.getLiveWorkbench.mockResolvedValue({
      data: {
        account: { id: "adacct_client" },
        recommendations: [
          {
            ...recommendation,
            monitoringPlan: {
              kind: "click_attributed_conversion_guardrail",
              windowDays: 7,
              baseline: { spend: 500, clickAttributedConversions: 10 },
            },
          },
        ],
      },
      freshness: "refreshed",
    });

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(409);
    expect(testState.applyAdsMutation).not.toHaveBeenCalled();
  });

  it("does not call the provider or read credentials before write access", async () => {
    testState.requireAccountAccess.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Review-only access."),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.getAdsCredentialMaterialForAccount).not.toHaveBeenCalled();
    expect(testState.getLiveWorkbench).not.toHaveBeenCalled();
    expect(testState.applyAdsMutation).not.toHaveBeenCalled();
  });

  it("returns retry guidance and never applies when fresh sync is unavailable", async () => {
    testState.getLiveWorkbench.mockRejectedValue(
      new testState.LiveSyncUnavailableError("provider_unavailable"),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(testState.applyAdsMutation).not.toHaveBeenCalled();
  });

  it("does not expose provider error bodies after an attempted mutation", async () => {
    testState.applyAdsMutation.mockRejectedValue(
      new testState.OpenAIAdsApiError(500, 12_000),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("12");
    expect(body).not.toContain("provider detail must not escape");
    expect(testState.applyAdsMutation).toHaveBeenCalledOnce();
  });

  it("preserves reconciliation-required and must-not-retry semantics", async () => {
    testState.applyAdsMutation.mockRejectedValue(
      new testState.AdsMutationReconciliationRequiredError(
        "approval-uncertain",
        "apply",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "The Ads API outcome is uncertain and requires manual reconciliation. Do not retry this action.",
      code: "reconciliation_required",
      approvalId: "approval-uncertain",
      operation: "apply",
      mustNotRetry: true,
      persistenceWarning: false,
    });
  });

  it("returns a no-write conflict when provider state changed after review", async () => {
    testState.applyAdsMutation.mockRejectedValue(
      new testState.AdsMutationPreconditionFailedError(
        "approval-drifted",
        "provider_state_changed",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "OpenAI Ads changed after this recommendation was reviewed. No write was sent; refresh and review the current recommendation.",
      code: "provider_state_changed",
      approvalId: "approval-drifted",
      operation: "apply",
      noMutationSent: true,
      requiresFreshReview: true,
      persistenceWarning: false,
    });
  });

  it("returns retry guidance when the final provider-state read is unavailable", async () => {
    testState.applyAdsMutation.mockRejectedValue(
      new testState.AdsMutationPreconditionFailedError(
        "approval-read-failed",
        "provider_state_unavailable",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      code: "provider_state_unavailable",
      approvalId: "approval-read-failed",
      noMutationSent: true,
      requiresFreshReview: false,
    });
  });

  it("returns a conflict when an active dismissal blocks direct apply", async () => {
    testState.applyAdsMutation.mockRejectedValue(
      new testState.ApprovalTransitionError(
        "This recommendation is actively dismissed. Restore it first.",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "This recommendation is actively dismissed. Restore it first.",
    });
  });

  it("blocks a new write while the account has an unresolved provider operation", async () => {
    testState.applyAdsMutation.mockRejectedValue(
      new testState.AdvertiserWriteBlockedError(
        "Resolve the advertiser account's active or uncertain Ads operation before starting another live write.",
      ),
    );

    const response = await POST(
      request({
        accountId: "adacct_client",
        recommendationId: recommendation.id,
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Resolve the advertiser account's active or uncertain Ads operation before starting another live write.",
    });
  });
});
