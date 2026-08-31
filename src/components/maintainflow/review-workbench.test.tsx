import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import { CampaignsView } from "./review-workbench";
import { MaintainFlowWorkbench } from "./review-workbench";
import { demoAccount } from "@/lib/openai-ads/demo-data";
import { unavailableConversionMeasurement } from "@/lib/openai-ads/measurement-readiness";

describe("CampaignsView", () => {
  it("does not render zero-valued or demo-currency metrics without a confirmed live snapshot", () => {
    const markup = renderToStaticMarkup(
      <CampaignsView
        ads={[]}
        creativeReviewHistory={[]}
        creativeHistoryReady={false}
        dataSource="live"
        campaigns={[]}
        performance={[]}
        currencyCode="USD"
        recommendationCount={0}
        onReview={() => undefined}
        reviewing={false}
        snapshotAvailable={false}
      />,
    );

    expect(markup).toContain("No confirmed live snapshot");
    expect(markup).toContain("Spend, conversion, campaign, and currency values stay hidden");
    expect(markup).not.toContain("Month-to-date spend");
    expect(markup).not.toContain("$0");
    expect(markup).not.toContain("No campaigns returned");
  });

  it("does not invent a completed review event when live sync has no snapshot", () => {
    const markup = renderToStaticMarkup(
      <MaintainFlowWorkbench
        initialTab="workspace"
        account={{ ...demoAccount, id: "adacct_live", name: "Live account" }}
        ads={[]}
        creativeReviewHistory={[]}
        creativeHistoryReady={false}
        campaigns={[]}
        performance={[]}
        initialRecommendations={[]}
        recommendationApprovalFingerprints={{}}
        recommendationFingerprints={{}}
        dataSource="live"
        writeMode="demo"
        snapshotAvailable={false}
        syncError="Live sync failed."
        operator={{ id: "operator", name: "Operator", initials: "OP" }}
        operatorAuthenticated={false}
        authConfigured={false}
        writeBlockers={["confirmed live Ads snapshot"]}
        approvalHistory={[]}
        monitoringWindows={[]}
        conversionMeasurement={unavailableConversionMeasurement({
          source: "live",
          message: "No confirmed snapshot.",
        })}
        approvalHistoryReady={false}
        workspaceSetupState="unavailable"
        workspaceMessage="Live sync is unavailable."
        conversionsConnection={{
          state: "unavailable",
          source: null,
          validationEnabled: false,
          credentialVersion: null,
          validatedAt: null,
          providerStatus: null,
          eventCount: null,
        }}
        availableAccounts={[]}
        agencyClientAttachEnabled={false}
        simulatedAccounts={[
          { accountId: "adacct_123", accountName: "Harbour Home" },
        ]}
        simulatorLabel="Direct merchant simulator"
        recommendationDecisionReady={false}
        canManageRecommendationDecisions={false}
        recommendationDecisionHistory={[]}
        readinessHistoryReady={false}
        initialReadinessHistory={[]}
        readinessHistoryCanSave={false}
      />,
    );

    expect(markup).toContain("Live sync failed");
    expect(markup).toContain("Workspace and account access");
    expect(markup).not.toContain("Account review completed");
    expect(markup).not.toContain("Demo snapshot");
    expect(markup).not.toContain("0 recommendations prepared");
  });
});
