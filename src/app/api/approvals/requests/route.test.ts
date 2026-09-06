import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class ChangeApprovalRequestForbiddenError extends Error {}
  class ChangeApprovalRequestInvalidError extends Error {}
  class ChangeApprovalRequestStoreUnavailableError extends Error {}
  class ChangeApprovalRequestTransitionError extends Error {}
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {
    readonly status: 401 | 403 = 401;
  }
  class OperatorAdmissionForbiddenError extends OperatorUnauthorizedError {
    override readonly status = 403 as const;
  }
  class AccountAccessForbiddenError extends Error {}
  class AdvertiserCredentialUnavailableError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class OpenAIAdsApiError extends Error {
    status: number;
    constructor(status: number) {
      super("Provider error");
      this.status = status;
    }
  }
  class LiveSyncUnavailableError extends Error {
    retryAfter: Date | null;
    constructor(retryAfter: Date | null = null) {
      super("Live sync unavailable");
      this.retryAfter = retryAfter;
    }
  }

  return {
    ChangeApprovalRequestForbiddenError,
    ChangeApprovalRequestInvalidError,
    ChangeApprovalRequestStoreUnavailableError,
    ChangeApprovalRequestTransitionError,
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    OperatorAdmissionForbiddenError,
    AccountAccessForbiddenError,
    AdvertiserCredentialUnavailableError,
    TenancyStoreUnavailableError,
    OpenAIAdsApiError,
    LiveSyncUnavailableError,
    requireOperator: vi.fn(),
    createSimulatorChangeApprovalRequest: vi.fn(),
    createLiveChangeApprovalRequest: vi.fn(),
    listChangeApprovalRequestPage: vi.fn(),
    recommendationApprovalFingerprint: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    listAgencySimulatedAccountIds: vi.fn(),
    resolveSimulatedWorkspace: vi.fn(),
    getAdsRuntimeMode: vi.fn(),
    getLiveWorkbench: vi.fn(),
    getAdsCredentialMaterialForAccount: vi.fn(),
    requireOrganizationAccountAccess: vi.fn(),
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
  createSimulatorChangeApprovalRequest:
    testState.createSimulatorChangeApprovalRequest,
  createLiveChangeApprovalRequest: testState.createLiveChangeApprovalRequest,
  listChangeApprovalRequestPage: testState.listChangeApprovalRequestPage,
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

vi.mock("@/lib/audit/recommendation-decision", () => ({
  recommendationApprovalFingerprint:
    testState.recommendationApprovalFingerprint,
}));

vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/http/request-security.server")
  >()),
  isSecureSameOriginRequest: testState.isSecureSameOriginRequest,
}));

vi.mock("@/lib/openai-ads/simulated-workspaces", () => ({
  listAgencySimulatedAccountIds: testState.listAgencySimulatedAccountIds,
  resolveSimulatedWorkspace: testState.resolveSimulatedWorkspace,
}));

vi.mock("@/lib/openai-ads/client.server", () => ({
  OpenAIAdsApiError: testState.OpenAIAdsApiError,
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
  requireOrganizationAccountAccess:
    testState.requireOrganizationAccountAccess,
}));

import { GET, POST } from "./route";

const organizationId = "00000000-0000-4000-8000-000000000101";
const account = { id: "adacct_sim_northstar", name: "Northstar Home" };
const recommendation = {
  id: "rec_bid_northstar",
  title: "Reduce an inefficient CPA bid",
  entityId: "adgrp_northstar_301",
  source: "demo",
  mutation: {
    method: "POST",
    path: "/ad_groups/adgrp_northstar_301",
    body: { bidding_config: { max_bid_micros: 240_000_000 } },
  },
  rollback: {
    method: "POST",
    path: "/ad_groups/adgrp_northstar_301",
    body: { bidding_config: { max_bid_micros: 300_000_000 } },
  },
  evidence: [],
  safeguard: "Review before any later execution.",
};
const fingerprint = "a".repeat(64);
const liveRecommendation = {
  ...recommendation,
  source: "live",
  status: "ready",
};
const operator = {
  id: "user_agency_analyst",
  name: "Alex Analyst",
  initials: "AA",
};

function approvalRequest(
  body: Record<string, unknown> = {
    organizationId,
    accountId: account.id,
    recommendationId: recommendation.id,
    recommendationFingerprint: fingerprint,
    note: "Please review this simulator packet.",
  },
) {
  return new Request("http://localhost/api/approvals/requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "simulator", ...body }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.isSecureSameOriginRequest.mockReturnValue(true);
  testState.requireOperator.mockResolvedValue(operator);
  testState.listAgencySimulatedAccountIds.mockReturnValue([account.id]);
  testState.resolveSimulatedWorkspace.mockReturnValue({
    account,
    recommendations: [recommendation],
  });
  testState.recommendationApprovalFingerprint.mockReturnValue(fingerprint);
  testState.createSimulatorChangeApprovalRequest.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000102",
    created: true,
    eligibleReviewerCount: 1,
    notificationDeliveryIds: [
      "00000000-0000-4000-8000-000000000103",
    ],
  });
  testState.createLiveChangeApprovalRequest.mockResolvedValue({
    id: "00000000-0000-4000-8000-000000000105",
    created: true,
    eligibleReviewerCount: 1,
    notificationDeliveryIds: [
      "00000000-0000-4000-8000-000000000106",
    ],
  });
  testState.attemptApprovalNotificationDelivery.mockResolvedValue({
    queued: 1,
    summary: {
      enabled: true,
      claimed: 1,
      accepted: 1,
      retryScheduled: 0,
      permanentlyFailed: 0,
      cancelled: 0,
      lostClaims: 0,
    },
    operatorAttentionRequired: false,
  });
  testState.approvalNotificationAttemptMessage.mockReturnValue(
    "The reviewer email was accepted for delivery.",
  );
  testState.getAdsRuntimeMode.mockReturnValue({ dataSource: "live" });
  testState.requireOrganizationAccountAccess.mockResolvedValue({
    organizationId,
    organizationName: "Northstar Agency",
    organizationType: "agency",
    accountId: "adacct_live_client",
    accountName: "Live Client",
    connectionMode: "vault",
    membershipRole: "analyst",
    accountRole: "manager",
  });
  testState.getAdsCredentialMaterialForAccount.mockResolvedValue({
    apiKey: "ads_live_key",
    credentialGeneration: "vault:credential-id:3",
  });
  testState.getLiveWorkbench.mockResolvedValue({
    data: { recommendations: [liveRecommendation] },
    freshness: "refreshed",
  });
  testState.listChangeApprovalRequestPage.mockResolvedValue({
    requests: [],
    nextCursor: "next-page-cursor",
  });
});

describe("agency simulator approval request route", () => {
  it("loads a bounded organization-scoped approval page", async () => {
    const response = await GET(
      new Request(
        `http://localhost/api/approvals/requests?organizationId=${organizationId}&cursor=current-page-cursor`,
      ),
    );

    expect(response.status).toBe(200);
    expect(testState.listChangeApprovalRequestPage).toHaveBeenCalledWith({
      operatorId: operator.id,
      organizationId,
      cursor: "current-page-cursor",
      pageSize: 50,
    });
    await expect(response.json()).resolves.toEqual({
      requests: [],
      nextCursor: "next-page-cursor",
    });
  });

  it("rejects duplicate or unknown approval-page query parameters", async () => {
    const duplicate = await GET(
      new Request(
        `http://localhost/api/approvals/requests?organizationId=${organizationId}&organizationId=${organizationId}`,
      ),
    );
    const unknown = await GET(
      new Request(
        `http://localhost/api/approvals/requests?organizationId=${organizationId}&accountId=other`,
      ),
    );

    expect(duplicate.status).toBe(422);
    expect(unknown.status).toBe(422);
    expect(testState.listChangeApprovalRequestPage).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin approval-page read before authentication", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await GET(
      new Request(
        `http://localhost/api/approvals/requests?organizationId=${organizationId}`,
      ),
    );

    expect(response.status).toBe(403);
    expect(testState.requireOperator).not.toHaveBeenCalled();
    expect(testState.listChangeApprovalRequestPage).not.toHaveBeenCalled();
  });

  it("creates an immutable simulator packet without claiming an external write", async () => {
    const response = await POST(approvalRequest());
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(testState.createSimulatorChangeApprovalRequest).toHaveBeenCalledWith({
      organizationId,
      operator,
      account,
      recommendation,
      displayedFingerprint: fingerprint,
      note: "Please review this simulator packet.",
    });
    expect(payload).toMatchObject({ created: true });
    expect(payload.message).toContain("shared agency queue");
    expect(payload.message).toContain(
      "The reviewer email was accepted for delivery.",
    );
    expect(payload.message).toContain("No external change was sent.");
    expect(payload).not.toHaveProperty("notificationDeliveryIds");
  });

  it("creates a live packet from an exact agency path and fresh mutation snapshot", async () => {
    const response = await POST(
      approvalRequest({
        source: "live",
        organizationId,
        accountId: "adacct_live_client",
        recommendationId: liveRecommendation.id,
        recommendationFingerprint: fingerprint,
        note: "Please approve this live bid correction.",
      }),
    );

    expect(response.status).toBe(201);
    expect(testState.requireOrganizationAccountAccess).toHaveBeenCalledWith(
      operator.id,
      organizationId,
      "adacct_live_client",
      "read",
    );
    expect(testState.getLiveWorkbench).toHaveBeenCalledWith({
      accountId: "adacct_live_client",
      credentialGeneration: "vault:credential-id:3",
      credential: {
        kind: "account_api_key",
        secret: "ads_live_key",
        expectedAccountId: "adacct_live_client",
      },
      policy: "mutation",
    });
    expect(testState.createLiveChangeApprovalRequest).toHaveBeenCalledWith({
      operator,
      access: expect.objectContaining({
        organizationId,
        organizationType: "agency",
        accountId: "adacct_live_client",
      }),
      recommendation: liveRecommendation,
      displayedFingerprint: fingerprint,
      note: "Please approve this live bid correction.",
    });
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      message:
        "Approval requested. Waiting for another agency owner or admin. The reviewer email was accepted for delivery. No external change was sent.",
    });
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects a non-agency live path before reading its credential", async () => {
    testState.requireOrganizationAccountAccess.mockResolvedValue({
      organizationId,
      organizationName: "Direct Brand",
      organizationType: "advertiser",
      accountId: "adacct_live_client",
      accountName: "Live Client",
      connectionMode: "vault",
      membershipRole: "owner",
      accountRole: "owner",
    });

    const response = await POST(
      approvalRequest({
        source: "live",
        organizationId,
        accountId: "adacct_live_client",
        recommendationId: liveRecommendation.id,
        recommendationFingerprint: fingerprint,
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.getAdsCredentialMaterialForAccount).not.toHaveBeenCalled();
    expect(testState.getLiveWorkbench).not.toHaveBeenCalled();
    expect(testState.createLiveChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("returns the existing packet for an idempotent duplicate", async () => {
    testState.createSimulatorChangeApprovalRequest.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000103",
      created: false,
      eligibleReviewerCount: 1,
    });

    const response = await POST(approvalRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: "00000000-0000-4000-8000-000000000103",
      created: false,
      message:
        "This exact packet is already awaiting approval. No duplicate was created and no notification or external change was sent.",
    });
  });

  it("does not imply delivery when no second reviewer is eligible", async () => {
    testState.createSimulatorChangeApprovalRequest.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000104",
      created: true,
      eligibleReviewerCount: 0,
    });

    const response = await POST(approvalRequest());
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.message).toContain("no other owner or admin");
    expect(payload.message).toContain("no notification");
    expect(payload.message).not.toContain("sent to");
  });

  it("rejects an insecure request before authentication or simulator lookup", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await POST(approvalRequest());

    expect(response.status).toBe(403);
    expect(testState.requireOperator).not.toHaveBeenCalled();
    expect(testState.resolveSimulatedWorkspace).not.toHaveBeenCalled();
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("maps an unsigned operator to 401 without persisting", async () => {
    testState.requireOperator.mockRejectedValue(
      new testState.OperatorUnauthorizedError("Sign in first."),
    );

    const response = await POST(approvalRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Sign in first." });
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("maps an operator admission denial to 403 without persisting", async () => {
    testState.requireOperator.mockRejectedValue(
      new testState.OperatorAdmissionForbiddenError(
        "This account is not admitted to the workspace.",
      ),
    );

    const response = await POST(approvalRequest());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "This account is not admitted to the workspace.",
    });
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects a streamed body above 4 KB before persistence", async () => {
    const response = await POST(
      approvalRequest({
        organizationId,
        accountId: account.id,
        recommendationId: recommendation.id,
        recommendationFingerprint: fingerprint,
        note: "x".repeat(5_000),
      }),
    );

    expect(response.status).toBe(413);
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("uses a strict request shape", async () => {
    const response = await POST(
      approvalRequest({
        organizationId,
        accountId: account.id,
        recommendationId: recommendation.id,
        recommendationFingerprint: fingerprint,
        unexpectedTenantOverride: "other-agency",
      }),
    );

    expect(response.status).toBe(422);
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects an account outside the labelled agency simulator set", async () => {
    const response = await POST(
      approvalRequest({
        organizationId,
        accountId: "adacct_unlabelled",
        recommendationId: recommendation.id,
        recommendationFingerprint: fingerprint,
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: "Select a labelled agency simulator account.",
    });
    expect(testState.resolveSimulatedWorkspace).not.toHaveBeenCalled();
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("rejects a stale displayed fingerprint before persistence", async () => {
    const response = await POST(
      approvalRequest({
        organizationId,
        accountId: account.id,
        recommendationId: recommendation.id,
        recommendationFingerprint: "0".repeat(64),
      }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "This recommendation changed after it was displayed. Refresh before requesting approval.",
    });
    expect(testState.createSimulatorChangeApprovalRequest).not.toHaveBeenCalled();
  });

  it("maps cross-tenant denial and store transitions without exposing internals", async () => {
    testState.createSimulatorChangeApprovalRequest.mockRejectedValueOnce(
      new testState.ChangeApprovalRequestForbiddenError(
        "This approval request is not available in your agency workspace.",
      ),
    );
    const forbidden = await POST(approvalRequest());

    testState.createSimulatorChangeApprovalRequest.mockRejectedValueOnce(
      new testState.ChangeApprovalRequestTransitionError(
        "The approval queue changed concurrently.",
      ),
    );
    const conflict = await POST(approvalRequest());

    expect(forbidden.status).toBe(403);
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "The approval queue changed concurrently.",
    });
  });

  it("maps approval-store unavailability to a retryable service error", async () => {
    testState.createSimulatorChangeApprovalRequest.mockRejectedValue(
      new testState.ChangeApprovalRequestStoreUnavailableError(
        "Apply the approval migration first.",
      ),
    );

    const response = await POST(approvalRequest());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Apply the approval migration first.",
    });
  });
});
