import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  ApprovalHistory,
  ReconciliationDecisionContext,
  RollbackConfirmationDetails,
} from "./approval-history";
import {
  toApprovalRecordDto,
  type ApprovalRecord,
} from "@/lib/audit/approval-schema";

const internalOperatorId = "user_internal_audit_actor";
const internalOrganizationId = "00000000-0000-4000-8000-000000000002";
const storedRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  accountId: "adacct_live_client",
  operatorId: internalOperatorId,
  organizationId: internalOrganizationId,
  organizationName: "Northstar Agency",
  membershipRole: "owner",
  accountRole: "owner",
  recommendationId: "rec_bid_guard",
  recommendationTitle: "Reduce an inefficient CPA bid",
  entityId: "adgrp_live_123",
  mutation: null,
  rollback: {
    method: "POST",
    path: "/ad_groups/adgrp_live_123",
    body: {
      bidding_config: {
        billing_event_type: "click",
        max_bid_micros: 270_000_000,
      },
    },
  },
  evidence: [],
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
  createdAt: new Date("2026-09-02T08:00:00.000Z"),
  updatedAt: new Date("2026-09-02T08:05:00.000Z"),
  appliedAt: new Date("2026-09-02T08:05:00.000Z"),
  rolledBackAt: null,
} satisfies ApprovalRecord;
const record = toApprovalRecordDto(storedRecord);

describe("approval history", () => {
  it("exposes its section title as a level-two heading", () => {
    const markup = renderToStaticMarkup(
      <ApprovalHistory
        records={[]}
        dataSource="demo"
        canRollback={false}
        canReconcile={false}
      />,
    );

    expect(markup).toContain("Durable approval history");
    expect(markup).toContain('role="heading"');
    expect(markup).toContain('aria-level="2"');
  });
});

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
    expect(JSON.stringify(record)).not.toContain(internalOperatorId);
    expect(JSON.stringify(record)).not.toContain(internalOrganizationId);
  });
});

describe("reconciliation decision context", () => {
  it("shows the stored incident evidence before an operator chooses an outcome", () => {
    const markup = renderToStaticMarkup(
      <ReconciliationDecisionContext
        record={{
          ...record,
          accountRole: "manager",
          status: "rollback_reconciliation_required",
          errorMessage: "Provider timed out after accepting the rollback request.",
          reconciliationNote:
            "A prior review confirmed the original change was still applied.",
        }}
      />,
    );

    expect(markup).toContain("Read-only incident context");
    expect(markup).toContain("adacct_live_client");
    expect(markup).toContain("Northstar Agency");
    expect(markup).not.toContain(storedRecord.id);
    expect(markup).not.toContain(internalOrganizationId);
    expect(markup).not.toContain(internalOperatorId);
    expect(markup).toContain("Workspace Owner");
    expect(markup).toContain("Advertiser account Manager");
    expect(markup).toContain("Reduce an inefficient CPA bid");
    expect(markup).toContain("adgrp_live_123");
    expect(markup).toContain("Check rollback");
    expect(markup).toContain("rollback_reconciliation_required");
    expect(markup).toContain(
      "Provider timed out after accepting the rollback request.",
    );
    expect(markup).toContain(
      "A prior review confirmed the original change was still applied.",
    );
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("<textarea");
  });

  it("omits unavailable organization, role, error, and prior-note fields", () => {
    const markup = renderToStaticMarkup(
      <ReconciliationDecisionContext
        record={{
          ...record,
          organizationName: null,
          membershipRole: null,
          accountRole: null,
          status: "reconciliation_required",
        }}
      />,
    );

    expect(markup).toContain("Advertiser account");
    expect(markup).toContain("Current status");
    expect(markup).toContain("Recommendation and entity");
    expect(markup).not.toContain("Organization");
    expect(markup).not.toContain("Recorded roles");
    expect(markup).not.toContain("Stored provider error");
    expect(markup).not.toContain("Prior reconciliation note");
  });
});
