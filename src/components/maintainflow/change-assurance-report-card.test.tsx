import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ApprovalRecordDto } from "@/lib/audit/approval-schema";

import { ChangeAssuranceReportCard } from "./change-assurance-report-card";

const record: ApprovalRecordDto = {
  id: "00000000-0000-4000-8000-000000000001",
  accountId: "adacct_client",
  organizationName: "Northstar Agency",
  membershipRole: "owner",
  accountRole: "manager",
  recommendationId: "rec_budget",
  recommendationTitle: "Reduce bid",
  entityId: "adgrp_123",
  mutation: {
    method: "POST",
    path: "/ad_groups/adgrp_123",
    body: { max_bid_micros: 12_000_000 },
  },
  rollbackMethod: "POST",
  rollbackPath: "/ad_groups/adgrp_123",
  rollbackBody: { max_bid_micros: 15_000_000 },
  evidence: [],
  safeguard: "Review a conversion decline.",
  status: "reconciliation_required",
  errorMessage: null,
  reconciliationNote: null,
  monitoringPlan: null,
  monitoringStartedAt: null,
  monitoringEndsAt: null,
  monitoringOutcome: null,
  monitoringObservation: null,
  monitoringEvaluatedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  appliedAt: null,
  rolledBackAt: null,
};

describe("change assurance report card", () => {
  it("shows the evidence mode and unresolved record count", () => {
    const markup = renderToStaticMarkup(
      <ChangeAssuranceReportCard
        account={{ id: "adacct_client", name: "Client" }}
        dataSource="live"
        records={[record]}
      />,
    );

    expect(markup).toContain("Client change assurance report");
    expect(markup).toContain('role="heading"');
    expect(markup).toContain('aria-level="2"');
    expect(markup).toContain("Live evidence");
    expect(markup).toContain("1 unresolved item is called out");
    expect(markup).not.toContain('disabled=""');
  });

  it("keeps export disabled without a durable approval", () => {
    const markup = renderToStaticMarkup(
      <ChangeAssuranceReportCard
        account={{ id: "adacct_demo", name: "Demo" }}
        dataSource="demo"
        records={[]}
      />,
    );

    expect(markup).toContain("Simulator evidence");
    expect(markup).toContain("A simulator approval record is required");
    expect(markup).toContain('disabled=""');
  });
});
