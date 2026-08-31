import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  getOptionalOperatorMock,
  getAdsCredentialMaterialForAccountMock,
  getConversionsApiConnectionStatusMock,
  getLiveWorkbenchMock,
  listAccountAccessesMock,
} = vi.hoisted(() => ({
  getOptionalOperatorMock: vi.fn(),
  getAdsCredentialMaterialForAccountMock: vi.fn(),
  getConversionsApiConnectionStatusMock: vi.fn(),
  getLiveWorkbenchMock: vi.fn(),
  listAccountAccessesMock: vi.fn(),
}));

vi.mock("next/server", () => ({ connection: vi.fn() }));
vi.mock("@/lib/auth/operator.server", () => ({
  getOptionalOperator: getOptionalOperatorMock,
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
import { demoAccount } from "@/lib/openai-ads/demo-data";
import { unavailableConversionMeasurement } from "@/lib/openai-ads/measurement-readiness";
import { agencySimulatorEntryAccountId } from "@/lib/openai-ads/simulated-workspaces";

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

const agencyAccess = {
  ...access,
  organizationId: "00000000-0000-4000-8000-000000000002",
  organizationName: "Northstar Agency",
  organizationType: "agency" as const,
  accountId: "adacct_agency_client",
  accountName: "Harbour Home Ireland",
  accountRole: "manager" as const,
};

describe("MaintainFlow app page live failure boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    listAccountAccessesMock.mockReset();
    getAdsCredentialMaterialForAccountMock.mockReset();
    getConversionsApiConnectionStatusMock.mockReset();
    getLiveWorkbenchMock.mockReset();
    getOptionalOperatorMock.mockReset();
    getOptionalOperatorMock.mockResolvedValue({
      id: "operator_live",
      name: "Live operator",
      initials: "LO",
    });
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
        account: agencySimulatorEntryAccountId,
        tab: "experiments",
      }),
    });
    const props = element.props;

    expect(props.initialTab).toBe("experiments");
    expect(props.workspaceSetupState).toBe("connection_error");
    expect(props.workspaceAccess).toEqual(access);
    expect(props.agencyClientAttachEnabled).toBe(false);
    expect(props.account.id).toBe(access.accountId);
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

  it("renders the five-account agency simulator without fabricating live access", async () => {
    getOptionalOperatorMock.mockResolvedValue(undefined);

    const element = await MaintainFlowAppPage({
      searchParams: Promise.resolve({
        account: agencySimulatorEntryAccountId,
        tab: "campaigns",
      }),
    });
    const props = element.props;

    expect(props.initialTab).toBe("campaigns");
    expect(props.dataSource).toBe("demo");
    expect(props.writeMode).toBe("demo");
    expect(props.account.id).toBe(agencySimulatorEntryAccountId);
    expect(props.account.currency_code).toBe("EUR");
    expect(props.simulatedAccounts).toHaveLength(5);
    expect(props.simulatorLabel).toBe("Agency portfolio simulator");
    expect(props.workspaceAccess).toBeUndefined();
    expect(props.availableAccounts).toEqual([]);
    expect(props.operatorAuthenticated).toBe(false);
    expect(props.agencyClientAttachEnabled).toBe(false);
  });

  it("enables another client connection only for a ready live agency owner", async () => {
    listAccountAccessesMock.mockResolvedValue([agencyAccess]);
    getLiveWorkbenchMock.mockResolvedValue({
      data: {
        account: {
          ...demoAccount,
          id: agencyAccess.accountId,
          name: agencyAccess.accountName,
          currency_code: "EUR",
          timezone: "Europe/Dublin",
        },
        ads: [],
        campaigns: [],
        performance: [],
        recommendations: [],
        conversionMeasurement: unavailableConversionMeasurement({
          source: "live",
          checkedAt: "2026-08-31T10:00:00.000Z",
          message: "No active conversion campaigns require a measurement check.",
        }),
        syncedAt: "2026-08-31T10:00:00.000Z",
      },
      freshness: "fresh",
    });

    const element = await MaintainFlowAppPage({
      searchParams: Promise.resolve({
        account: agencyAccess.accountId,
        tab: "workspace",
      }),
    });
    const props = element.props;

    expect(props.workspaceSetupState).toBe("ready");
    expect(props.dataSource).toBe("live");
    expect(props.workspaceAccess).toEqual(agencyAccess);
    expect(props.agencyClientAttachEnabled).toBe(true);
  });
});
