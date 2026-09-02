import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import { RollbackConfirmationDetails } from "./approval-history";
import type { ApprovalRecordDto } from "@/lib/audit/approval-schema";

const record = {
  id: "00000000-0000-4000-8000-000000000001",
  accountId: "adacct_live_client",
  operatorId: "user_owner",
  organizationId: "00000000-0000-4000-8000-000000000002",
  organizationName: "Northstar Agency",
  membershipRole: "owner",
  accountRole: "owner",
  recommendationId: "rec_bid_guard",
  recommendationTitle: "Reduce an inefficient CPA bid",
  entityId: "adgrp_live_123",
  rollbackMethod: "POST",
  rollbackPath: "/ad_groups/adgrp_live_123",
  rollbackBody: {
    bidding_config: {
      billing_event_type: "click",
      max_bid_micros: 270_000_000,
    },
  },
  safeguard: "Review rollback if conversions fall more than 15%.",
  status: "applied",
  errorMessage: null,
  reconciliationNote: null,
  monitoringPlan: null,
  monitoringStartedAt: null,
  monitoringEndsAt: null,
  monitoringOutcome: null,
  monitoringObservation: null,
  monitoringEvaluatedAt: null,
  createdAt: "2026-09-02T08:00:00.000Z",
  updatedAt: "2026-09-02T08:05:00.000Z",
  appliedAt: "2026-09-02T08:05:00.000Z",
  rolledBackAt: null,
} satisfies ApprovalRecordDto;

describe("rollback confirmation details", () => {
  it("binds the live rollback confirmation to the advertiser and exact change", () => {
    const markup = renderToStaticMarkup(
      <RollbackConfirmationDetails record={record} />,
    );

    expect(markup).toContain("adacct_live_client");
    expect(markup).toContain("Reduce an inefficient CPA bid");
    expect(markup).toContain("adgrp_live_123");
    expect(markup).toContain("POST /ad_groups/adgrp_live_123");
    expect(markup).toContain("270000000");
    expect(markup).toContain(record.safeguard);
  });
});
