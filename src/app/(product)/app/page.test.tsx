import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { listAccountAccessesMock } = vi.hoisted(() => ({
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
  getAdsRuntimeMode: vi.fn(() => ({
    hasKey: false,
    liveDataRequested: true,
    liveWritesRequested: false,
    releaseStage: "private_read",
    liveReadStage: true,
    liveWriteStage: false,
    dataSource: "demo",
    authConfigured: true,
    approvalStoreConfigured: true,
    writeInfrastructureConfigured: false,
    writeBlockers: ["OpenAI Ads account key"],
  })),
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
  getAdsCredentialMaterialForAccount: vi.fn(),
  listAccountAccesses: listAccountAccessesMock,
  verifyCredentialStore: vi.fn(async () => true),
  verifyTenancyStore: vi.fn(async () => true),
}));

import MaintainFlowAppPage from "./page";

describe("MaintainFlow app page live failure boundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    listAccountAccessesMock.mockReset();
  });

  it("clears demo fixtures when account discovery fails in a live-read stage", async () => {
    listAccountAccessesMock.mockRejectedValue(new Error("private database detail"));

    const element = await MaintainFlowAppPage({ searchParams: Promise.resolve({}) });
    const props = element.props;

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
});
