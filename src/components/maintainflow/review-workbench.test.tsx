import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  CampaignsView,
  isConfirmedLiveApplyResponse,
  MaintainFlowWorkbench,
  RecommendationApprovalConfirmation,
} from "./review-workbench";
import {
  demoAccount,
  demoRecommendations,
} from "@/lib/openai-ads/demo-data";
import { unavailableConversionMeasurement } from "@/lib/openai-ads/measurement-readiness";

describe("CampaignsView", () => {
  it("never treats a downgraded 2xx no-write response as a live change", () => {
    expect(
      isConfirmedLiveApplyResponse({ mode: "demo", applied: false }),
    ).toBe(false);
    expect(
      isConfirmedLiveApplyResponse({ mode: "live", applied: true }),
    ).toBe(true);
  });

  it("shows the exact live advertiser, request, rollback, snapshot, and safeguard before approval", () => {
    const recommendation = demoRecommendations[0];
    const markup = renderToStaticMarkup(
      <RecommendationApprovalConfirmation
        account={{ ...demoAccount, id: "adacct_live", name: "Live advertiser" }}
        recommendation={recommendation}
        dataSource="live"
        writeMode="live"
        syncedAt="2026-09-02T08:30:00.000Z"
      />,
    );

    expect(markup).toContain("Live write to Live advertiser");
    expect(markup).toContain("adacct_live");
    expect(markup).toContain(
      `${recommendation.mutation.method} ${recommendation.mutation.path}`,
    );
    expect(markup).toContain(
      `${recommendation.rollback.method} ${recommendation.rollback.path}`,
    );
    expect(markup).toContain("Evidence source");
    expect(markup).toContain(recommendation.safeguard);
    expect(markup).toContain("non-idempotent change");
    expect(markup).toContain("Exact request body");
    expect(markup).toContain("Exact stored rollback body");
    expect(markup).toContain(
      String(
        (
          recommendation.mutation.body?.bidding_config as
            | { max_bid_micros?: number }
            | undefined
        )?.max_bid_micros,
      ),
    );
    expect(markup).toContain(
      `aria-label="Current ${recommendation.currentValue}; proposed ${recommendation.proposedValue}"`,
    );
  });

  it("does not render zero-valued or demo-currency metrics without a confirmed live snapshot", () => {
    const markup = renderToStaticMarkup(
      <CampaignsView
        ads={[]}
        creativeReviewHistory={[]}
        creativeHistoryReady={false}
        dataSource="live"
        campaigns={[]}
        performance={[]}
        budgetGuardEvidence={[]}
        currencyCode="USD"
        recommendationCount={0}
        onReview={() => undefined}
        reviewing={false}
        snapshotAvailable={false}
        portfolioAccounts={[]}
        livePortfolioVisible={false}
        livePortfolioAccounts={[]}
        currentAccountId="adacct_live"
        onOpenAccount={() => undefined}
      />,
    );

    expect(markup).toContain("No confirmed live snapshot");
    expect(markup).toContain("Spend, conversion, campaign, and currency values stay hidden");
    expect(markup).not.toContain("Month-to-date spend");
    expect(markup).not.toContain("$0");
    expect(markup).not.toContain("No campaigns returned");
  });

  it("renders bounded live agency evidence without treating missing signals as zero", () => {
    const markup = renderToStaticMarkup(
      <CampaignsView
        ads={[]}
        creativeReviewHistory={[]}
        creativeHistoryReady={false}
        dataSource="live"
        campaigns={[]}
        performance={[]}
        budgetGuardEvidence={[]}
        currencyCode="USD"
        recommendationCount={0}
        onReview={() => undefined}
        reviewing={false}
        snapshotAvailable={false}
        portfolioAccounts={[]}
        livePortfolioVisible
        livePortfolioAccounts={[
          {
            accountId: "adacct_current",
            accountName: "Harbour Home",
            hasConfirmedSnapshot: true,
            detectedSignalCount: 4,
            evidenceState: "confirmed_fresh",
            evidenceAt: "2026-09-02T11:55:00.000Z",
          },
          {
            accountId: "adacct_missing",
            accountName: "Oak & Thread",
            hasConfirmedSnapshot: false,
            detectedSignalCount: null,
            evidenceState: "not_confirmed",
            evidenceAt: null,
          },
          {
            accountId: "adacct_legacy",
            accountName: "Legacy client",
            hasConfirmedSnapshot: false,
            detectedSignalCount: null,
            evidenceState: "refresh_required",
            evidenceAt: "2026-09-01T09:00:00.000Z",
          },
        ]}
        currentAccountId="adacct_current"
        onOpenAccount={() => undefined}
      />,
    );

    expect(markup).toContain("Live client evidence");
    expect(markup).toContain("3 active clients");
    expect(markup).toContain("Usable snapshots");
    expect(markup).toContain(
      "2 expired, missing, rejected, or requiring refresh",
    );
    expect(markup).toContain("Detected signals");
    expect(markup).toContain("unknown accounts excluded");
    expect(markup).toContain("Unknown");
    expect(markup).toContain("Refresh required");
    expect(markup).toContain("Open account");
    expect(markup).not.toContain("Projected weekly exposure");
    expect(markup).not.toContain("$0");
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
        budgetGuardEvidence={[]}
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
        livePortfolioVisible={false}
        livePortfolioAccounts={[]}
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
    expect(markup).toContain('aria-label="Open profile menu"');
  });
});
