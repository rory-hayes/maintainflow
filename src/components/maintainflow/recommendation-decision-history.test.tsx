import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RecommendationDecisionHistoryDto } from "@/lib/audit/recommendation-decision";

import { RecommendationDecisionHistory } from "./recommendation-decision-history";

const restoredDecision: RecommendationDecisionHistoryDto = {
  id: "00000000-0000-4000-8000-000000000021",
  accountId: "adacct_client",
  operatorId: "user_dismissed",
  organizationId: "00000000-0000-4000-8000-000000000022",
  organizationName: "Northstar Agency",
  membershipRole: "admin",
  accountRole: "manager",
  recommendationId: "live_bid_adgrp_1",
  recommendationTitle: "Lower the CPA bid by 20%",
  entityId: "adgrp_1",
  fingerprint: "a".repeat(64),
  reason: "Hold the bid until the client signs off on the seasonal test.",
  dismissedAt: "2026-08-30T13:00:00.000Z",
  restoredBy: "user_restored",
  restoredOrganizationId: "00000000-0000-4000-8000-000000000022",
  restoredOrganizationName: "Northstar Agency",
  restoredMembershipRole: "owner",
  restoredAccountRole: "manager",
  restoredAt: "2026-08-30T14:00:00.000Z",
};

describe("recommendation decision history", () => {
  it("renders the durable reason and both actor contexts", () => {
    const html = renderToStaticMarkup(
      <RecommendationDecisionHistory
        records={[restoredDecision]}
        dataSource="live"
      />,
    );

    expect(html).toContain("Recommendation decisions");
    expect(html).toContain("Restored");
    expect(html).toContain(restoredDecision.reason);
    expect(html).toContain("Northstar Agency · admin/manager");
    expect(html).toContain("Northstar Agency · owner/manager");
    expect(html).toContain("user_dismissed");
    expect(html).toContain("user_restored");
  });

  it("keeps demo history explicitly non-durable", () => {
    const html = renderToStaticMarkup(
      <RecommendationDecisionHistory records={[]} dataSource="demo" />,
    );

    expect(html).toContain("No durable decisions in simulator mode");
    expect(html).toContain("Simulator dismissals remain in the session audit");
  });
});
