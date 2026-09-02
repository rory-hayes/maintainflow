import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  toRecommendationDecisionHistoryDto,
  type RecommendationDecisionHistory as StoredRecommendationDecisionHistory,
} from "@/lib/audit/recommendation-decision";

import { RecommendationDecisionHistory } from "./recommendation-decision-history";

const internalDecisionId = "00000000-0000-4000-8000-000000000021";
const internalOrganizationId = "00000000-0000-4000-8000-000000000022";
const dismissingOperatorId = "user_dismissed";
const restoringOperatorId = "user_restored";
const storedDecision: StoredRecommendationDecisionHistory = {
  id: internalDecisionId,
  accountId: "adacct_client",
  operatorId: dismissingOperatorId,
  organizationId: internalOrganizationId,
  organizationName: "Northstar Agency",
  membershipRole: "admin",
  accountRole: "manager",
  recommendationId: "live_bid_adgrp_1",
  recommendationTitle: "Lower the CPA bid by 20%",
  entityId: "adgrp_1",
  fingerprint: "a".repeat(64),
  reason: "Hold the bid until the client signs off on the seasonal test.",
  dismissedAt: new Date("2026-08-30T13:00:00.000Z"),
  restoredBy: restoringOperatorId,
  restoredOrganizationId: internalOrganizationId,
  restoredOrganizationName: "Northstar Agency",
  restoredMembershipRole: "owner",
  restoredAccountRole: "manager",
  restoredAt: new Date("2026-08-30T14:00:00.000Z"),
};
const restoredDecision = toRecommendationDecisionHistoryDto(storedDecision);

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
    expect(html).not.toContain(dismissingOperatorId);
    expect(html).not.toContain(restoringOperatorId);
    expect(html).not.toContain(internalOrganizationId);
    expect(html).not.toContain(internalDecisionId);
    expect(JSON.stringify(restoredDecision)).not.toContain(dismissingOperatorId);
    expect(JSON.stringify(restoredDecision)).not.toContain(restoringOperatorId);
    expect(JSON.stringify(restoredDecision)).not.toContain(internalOrganizationId);
    expect(JSON.stringify(restoredDecision)).not.toContain(internalDecisionId);
  });

  it("keeps demo history explicitly non-durable", () => {
    const html = renderToStaticMarkup(
      <RecommendationDecisionHistory records={[]} dataSource="demo" />,
    );

    expect(html).toContain("No durable decisions in simulator mode");
    expect(html).toContain("Simulator dismissals remain in the session audit");
  });
});
