import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getAdsCredentialMaterialForAccountMock,
  getConversionsApiConnectionStatusMock,
  getLiveWorkbenchMock,
  listAccountAccessesMock,
} = vi.hoisted(() => ({
  getAdsCredentialMaterialForAccountMock: vi.fn(),
  getConversionsApiConnectionStatusMock: vi.fn(),
  getLiveWorkbenchMock: vi.fn(),
  listAccountAccessesMock: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/auth/operator.server", () => ({
  getOptionalOperator: vi.fn(async () => ({
    id: "operator_live",
    name: "Live operator",
    initials: "LO",
  })),
}));
vi.mock("@/lib/auth/config", () => ({
  isBootstrapOperator: vi.fn(() => false),
  isWorkspaceAdmissionAllowed: vi.fn(() => true),
}));
vi.mock("@/lib/openai-ads/client.server", () => ({
  getAdsRuntimeMode: vi.fn((options: { hasAccountKey?: boolean } = {}) => ({
    hasKey: options.hasAccountKey ?? false,
    liveDataRequested: true,
    liveWritesRequested: false,
    releaseStage: "private_read",
    liveReadStage: true,
    liveWriteStage: false,
    dataSource: options.hasAccountKey ? "live" : "demo",
    authConfigured: true,
    approvalStoreConfigured: true,
    writeInfrastructureConfigured: false,
    writeBlockers: ["OpenAI Ads account key"],
  })),
}));
vi.mock("@/lib/openai-ads/conversions.server", () => ({
  getConversionsApiConnectionStatus: getConversionsApiConnectionStatusMock,
}));
vi.mock("@/lib/openai-ads/live-sync.server", () => ({
  getLiveWorkbench: getLiveWorkbenchMock,
}));
vi.mock("@/lib/audit/approval-store.server", () => ({
  listActiveApprovalRecords: vi.fn(),
  listApprovalRecords: vi.fn(),
  verifyApprovalStore: vi.fn(async () => true),
}));
vi.mock("@/lib/audit/recommendation-decision-store.server", () => ({
  listActiveRecommendationDismissals: vi.fn(),
  listRecommendationDecisionHistory: vi.fn(),
  verifyRecommendationDecisionStore: vi.fn(async () => true),
}));
vi.mock("@/lib/openai-ads/creative-history.server", () => ({
  listCreativeReviewEvents: vi.fn(),
  recordCreativeReviewSnapshot: vi.fn(),
  verifyCreativeHistoryStore: vi.fn(async () => true),
}));
vi.mock("@/lib/readiness/history.server", () => ({
  listReadinessAuditRuns: vi.fn(),
  verifyReadinessHistoryStore: vi.fn(async () => true),
}));
vi.mock("@/lib/tenancy/store.server", () => ({
  getAdsCredentialMaterialForAccount: getAdsCredentialMaterialForAccountMock,
  listAccountAccesses: listAccountAccessesMock,
  verifyCredentialStore: vi.fn(async () => true),
  verifyTenancyStore: vi.fn(async () => true),
}));

import MaintainFlowAppPage from "./page";

const access = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationName: "Alpine Retail",
  organizationType: "advertiser" as const,
  accountId: "adacct_123",
  accountName: "Alpine Home",
  connectionMode: "vault" as const,
  membershipRole: "owner" as const,
  accountRole: "owner" as const,
};

describe("MaintainFlow app page live failure boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    listAccountAccessesMock.mockReset();
    getAdsCredentialMaterialForAccountMock.mockReset();
    getConversionsApiConnectionStatusMock.mockReset();
    getLiveWorkbenchMock.mockReset();
    getAdsCredentialMaterialForAccountMock.mockResolvedValue({
      apiKey: "ads_private_test_key",
      credentialGeneration: "vault:credential-id:1",
    });
    getConversionsApiConnectionStatusMock.mockResolvedValue({
      state: "not_connected",
      source: null,
      validationEnabled: false,
      credentialVersion: null,
      validatedAt: null,
      providerStatus: null,
      eventCount: null,
    });
  });

  it("clears demo fixtures when account discovery fails in a live-read stage", async () => {
    listAccountAccessesMock.mockRejectedValue(new Error("private database detail"));

    const element = await MaintainFlowAppPage({
      searchParams: Promise.resolve({ tab: "readiness" }),
    });
    const props = element.props;

    expect(props.initialTab).toBe("readiness");
    expect(props.dataSource).toBe("live");
    expect(props.writeMode).toBe("demo");
    expect(props.snapshotAvailable).toBe(false);
    expect(props.ads).toEqual([]);
    expect(props.campaigns).toEqual([]);
    expect(props.performance).toEqual([]);
    expect(props.initialRecommendations).toEqual([]);
    expect(props.account.name).toBe("Live account unavailable");
    expect(props.workspaceSetupState).toBe("unavailable");
    expect(props.syncError).toContain("demo fixtures are not substituted");
    expect(JSON.stringify(props)).not.toContain("Northstar Home EU");
  });

  it("retains account access and exposes credential recovery when the first live sync fails", async () => {
    listAccountAccessesMock.mockResolvedValue([access]);
    getLiveWorkbenchMock.mockRejectedValue(
      new Error("The provider rejected a required read scope."),
    );

    const element = await MaintainFlowAppPage({
      searchParams: Promise.resolve({
        account: access.accountId,
        tab: "experiments",
      }),
    });
    const props = element.props;

    expect(props.initialTab).toBe("experiments");
    expect(props.workspaceSetupState).toBe("connection_error");
    expect(props.workspaceAccess).toEqual(access);
    expect(props.availableAccounts).toEqual([access]);
    expect(props.workspaceMessage).toContain("replace its client key");
    expect(props.dataSource).toBe("live");
    expect(props.writeMode).toBe("demo");
    expect(props.snapshotAvailable).toBe(false);
    expect(props.ads).toEqual([]);
    expect(props.campaigns).toEqual([]);
    expect(props.performance).toEqual([]);
    expect(props.initialRecommendations).toEqual([]);
    expect(props.syncError).toContain("disabled all external writes");
    expect(getAdsCredentialMaterialForAccountMock).toHaveBeenCalledWith(
      access.accountId,
    );
  });
});
