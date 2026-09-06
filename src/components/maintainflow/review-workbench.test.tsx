import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import {
  buildChangeApprovalRequestBody,
  buildDirectLiveApplyBody,
  canReconcileApprovalHistory,
  canRequestLiveAgencyApproval,
  CampaignsView,
  isConfirmedLiveApplyResponse,
  MaintainFlowWorkbench,
  RecommendationApprovalConfirmation,
  shouldShowAgencyApprovalInbox,
  writableApprovalAccountIdsForOrganization,
} from "./review-workbench";
import {
  demoAccount,
  demoRecommendations,
} from "@/lib/openai-ads/demo-data";
import { unavailableConversionMeasurement } from "@/lib/openai-ads/measurement-readiness";
import { buildLivePortfolioActionQueue } from "@/lib/openai-ads/action-queue";

const livePortfolioAccountsFixture = [
  {
    accountId: "adacct_current",
    accountName: "Harbour Home",
    hasConfirmedSnapshot: true,
    detectedSignalCount: 4,
    evidenceState: "confirmed_fresh" as const,
    evidenceAt: "2026-09-02T11:55:00.000Z",
    operationalExceptions: {
      changeIntegrityUnexplained: { count: 0, oldestAt: null },
      changeIntegrityIndeterminate: { count: 0, oldestAt: null },
      safeguardTriggered: {
        count: 2,
        oldestAt: "2026-09-01T10:00:00.000Z",
      },
      insufficientEvidence: { count: 0, oldestAt: null },
      monitoringFailures: { count: 0, oldestAt: null },
      reconciliationRequired: { count: 0, oldestAt: null },
    },
  },
  {
    accountId: "adacct_missing",
    accountName: "Oak & Thread",
    hasConfirmedSnapshot: false,
    detectedSignalCount: null,
    evidenceState: "not_confirmed" as const,
    evidenceAt: null,
    operationalExceptions: {
      changeIntegrityUnexplained: { count: 0, oldestAt: null },
      changeIntegrityIndeterminate: { count: 0, oldestAt: null },
      safeguardTriggered: { count: 0, oldestAt: null },
      insufficientEvidence: { count: 0, oldestAt: null },
      monitoringFailures: { count: 0, oldestAt: null },
      reconciliationRequired: {
        count: 1,
        oldestAt: "2026-08-31T09:00:00.000Z",
      },
    },
  },
  {
    accountId: "adacct_legacy",
    accountName: "Legacy client",
    hasConfirmedSnapshot: false,
    detectedSignalCount: null,
    evidenceState: "refresh_required" as const,
    evidenceAt: "2026-09-01T09:00:00.000Z",
    operationalExceptions: {
      changeIntegrityUnexplained: { count: 0, oldestAt: null },
      changeIntegrityIndeterminate: { count: 0, oldestAt: null },
      safeguardTriggered: { count: 0, oldestAt: null },
      insufficientEvidence: { count: 0, oldestAt: null },
      monitoringFailures: { count: 0, oldestAt: null },
      reconciliationRequired: { count: 0, oldestAt: null },
    },
  },
];

describe("CampaignsView", () => {
  it("requires a write-capable account role before reconciliation is enabled", () => {
    const baseAccess = {
      organizationId: "00000000-0000-4000-8000-000000000001",
      organizationName: "Northstar Agency",
      organizationType: "agency" as const,
      accountId: "adacct_client",
      accountName: "Client",
      connectionMode: "vault" as const,
      membershipRole: "admin" as const,
    };

    expect(
      canReconcileApprovalHistory(true, {
        ...baseAccess,
        accountRole: "manager",
      }),
    ).toBe(true);
    expect(
      canReconcileApprovalHistory(true, {
        ...baseAccess,
        accountRole: "viewer",
      }),
    ).toBe(false);
    expect(
      canReconcileApprovalHistory(false, {
        ...baseAccess,
        accountRole: "owner",
      }),
    ).toBe(false);
  });

  it("requires a write-capable agency account grant before requesting live approval", () => {
    const baseAccess = {
      organizationId: "00000000-0000-4000-8000-000000000001",
      organizationName: "Northstar Agency",
      organizationType: "agency" as const,
      accountId: "adacct_client",
      accountName: "Client",
      connectionMode: "vault" as const,
      membershipRole: "admin" as const,
    };

    expect(
      canRequestLiveAgencyApproval({
        ...baseAccess,
        membershipRole: "analyst",
        accountRole: "manager",
      }),
    ).toBe(true);
    expect(
      canRequestLiveAgencyApproval({
        ...baseAccess,
        accountRole: "viewer",
      }),
    ).toBe(false);
    expect(
      canRequestLiveAgencyApproval({
        ...baseAccess,
        organizationType: "advertiser",
        accountRole: "owner",
      }),
    ).toBe(false);
  });

  it("preserves an exact writable account path for each agency approval inbox", () => {
    const accountId = "adacct_shared";
    const baseAccess = {
      accountId,
      accountName: "Shared client",
      connectionMode: "vault" as const,
      membershipRole: "admin" as const,
      accountRole: "manager" as const,
      organizationType: "agency" as const,
    };

    expect(
      writableApprovalAccountIdsForOrganization(
        [
          {
            ...baseAccess,
            organizationId: "org_agency_one",
            organizationName: "Agency One",
          },
          {
            ...baseAccess,
            organizationId: "org_agency_two",
            organizationName: "Agency Two",
          },
        ],
        "org_agency_two",
      ),
    ).toEqual([accountId]);
  });

  it("never treats a downgraded 2xx no-write response as a live change", () => {
    expect(
      isConfirmedLiveApplyResponse({ mode: "demo", applied: false }),
    ).toBe(false);
    expect(
      isConfirmedLiveApplyResponse({ mode: "live", applied: true }),
    ).toBe(true);
  });

  it("builds distinct live agency-request and direct-apply contracts", () => {
    expect(
      buildChangeApprovalRequestBody({
        source: "live",
        organizationId: "org_agency",
        accountId: "adacct_live",
        recommendationId: "rec_live",
        recommendationFingerprint: "a".repeat(64),
        note: "Please review the exact live bid change.",
      }),
    ).toEqual({
      source: "live",
      organizationId: "org_agency",
      accountId: "adacct_live",
      recommendationId: "rec_live",
      recommendationFingerprint: "a".repeat(64),
      note: "Please review the exact live bid change.",
    });

    expect(
      buildDirectLiveApplyBody({
        organizationId: "org_direct",
        accountId: "adacct_direct",
        recommendationId: "rec_direct",
        recommendationFingerprint: "b".repeat(64),
      }),
    ).toEqual({
      authorization: "direct",
      organizationId: "org_direct",
      accountId: "adacct_direct",
      recommendationId: "rec_direct",
      recommendationSource: "live",
      recommendationFingerprint: "b".repeat(64),
    });
  });

  it("hides the agency queue only for an authenticated direct-only workspace", () => {
    expect(
      shouldShowAgencyApprovalInbox({
        operatorAuthenticated: true,
        workspaceOrganizationType: "advertiser",
        agencyOrganizationCount: 0,
      }),
    ).toBe(false);
    expect(
      shouldShowAgencyApprovalInbox({
        operatorAuthenticated: true,
        workspaceOrganizationType: "advertiser",
        agencyOrganizationCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldShowAgencyApprovalInbox({
        operatorAuthenticated: false,
        agencyOrganizationCount: 0,
      }),
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

    const agencyRequestMarkup = renderToStaticMarkup(
      <RecommendationApprovalConfirmation
        account={{ ...demoAccount, id: "adacct_live", name: "Live advertiser" }}
        recommendation={recommendation}
        dataSource="live"
        writeMode="demo"
        syncedAt="2026-09-02T08:30:00.000Z"
        intent="request"
      />,
    );
    expect(agencyRequestMarkup).toContain(
      "Live approval request for Live advertiser",
    );
    expect(agencyRequestMarkup).toContain(
      "Requesting approval sends no external write",
    );
    expect(agencyRequestMarkup).not.toContain("External write is locked");
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
        livePortfolioVisible={false}
        currentAccountId="adacct_live"
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
        livePortfolioVisible
        portfolioActionItems={buildLivePortfolioActionQueue(
          livePortfolioAccountsFixture,
        )}
        portfolioAccountCount={3}
        currentAccountId="adacct_current"
      />,
    );

    expect(markup).toContain("Portfolio action queue");
    expect(markup).toContain("3 client accounts");
    expect(markup).toContain("Actions requiring attention");
    expect(markup).toContain("Unquantified actions");
    expect(markup).toContain("Resolve unknown provider outcomes (1)");
    expect(markup).toContain("Review triggered safeguards (2)");
    expect(markup).toContain("Detected signals unknown");
    expect(markup).toContain("Create the first confirmed Ads snapshot");
    expect(markup).toContain("Review evidence");
    expect(markup).toContain(
      "/app?tab=experiments&amp;account=adacct_missing",
    );
    expect(markup.indexOf("Oak &amp; Thread")).toBeLessThan(
      markup.indexOf("Harbour Home"),
    );
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
