import { describe, expect, it } from "vitest";

import {
  toApprovalRecordDto,
  type ApprovalRecord,
} from "./approval-schema";
import {
  buildChangeAssuranceReportHtml,
  changeAssuranceReportFileName,
  changeAssuranceReportSummary,
} from "./change-assurance-report";

const internalOperatorId = "user_internal_audit_actor";
const internalOrganizationId = "00000000-0000-4000-8000-000000000002";
const storedRecord: ApprovalRecord = {
  id: "00000000-0000-4000-8000-000000000001",
  accountId: "adacct_client",
  operatorId: internalOperatorId,
  organizationId: internalOrganizationId,
  organizationName: "Northstar <Agency>",
  membershipRole: "owner",
  accountRole: "manager",
  recommendationId: "rec_budget",
  recommendationTitle: "Reduce spend & verify",
  entityId: "adgrp_123",
  mutation: {
    method: "POST",
    path: "/ad_groups/adgrp_123",
    body: { max_bid_micros: 12_000_000, api_key: "must-not-leak" },
  },
  rollback: {
    method: "POST",
    path: "/ad_groups/adgrp_123",
    body: { max_bid_micros: 15_000_000 },
  },
  evidence: [
    { label: "CPA", value: "€42", detail: "Seven-day observed window" },
  ],
  safeguard: "Review if conversions decline more than 15%.",
  status: "reconciliation_required",
  errorMessage:
    "Provider outcome unknown: Bearer ads_private_report_secret?token=url-secret",
  reconciliationNote: "Checked https://example.com/?api_key=query-secret",
  monitoringPlan: {
    kind: "click_attributed_conversion_guardrail",
    windowDays: 7,
    baseline: {
      rangeStart: 1,
      rangeEnd: 2,
      spend: 1_000,
      clickAttributedConversions: 50,
      cpa: 20,
      configuredBidMicros: 15_000_000,
      currencyCode: "EUR",
    },
    rollbackRule: {
      metric: "click_attributed_conversions",
      comparison: "decrease_percent_greater_than",
      thresholdPercent: 15,
    },
  },
  monitoringStartedAt: new Date("2026-08-01T00:00:00.000Z"),
  monitoringEndsAt: new Date("2026-08-08T00:00:00.000Z"),
  monitoringOutcome: null,
  monitoringObservation: null,
  monitoringEvaluatedAt: null,
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:01:00.000Z"),
  appliedAt: null,
  rolledBackAt: null,
};
const record = toApprovalRecordDto(storedRecord);

describe("change assurance client report", () => {
  it("renders evidence, unresolved state, exact requests, and an honest live label", () => {
    const report = {
      generatedAt: "2026-09-02T10:00:00.000Z",
      dataSource: "live" as const,
      account: { id: record.accountId, name: "Client & Co" },
      records: [record],
    };
    const html = buildChangeAssuranceReportHtml(report);

    expect(html).toContain("LIVE ACCOUNT EVIDENCE");
    expect(html).toContain("Operator attention is still required");
    expect(html).toContain("Reduce spend &amp; verify");
    expect(html).toContain("Northstar &lt;Agency&gt;");
    expect(html).toContain("/ad_groups/adgrp_123");
    expect(html).toContain("[REDACTED]");
    expect(html).not.toContain("must-not-leak");
    expect(html).not.toContain("ads_private_report_secret");
    expect(html).not.toContain("url-secret");
    expect(html).not.toContain("query-secret");
    expect(html).not.toContain(storedRecord.id);
    expect(html).not.toContain(internalOperatorId);
    expect(html).not.toContain(internalOrganizationId);
    expect(JSON.stringify(record)).not.toContain(internalOperatorId);
    expect(JSON.stringify(record)).not.toContain(internalOrganizationId);
    expect(changeAssuranceReportSummary(report)).toEqual({
      total: 1,
      unresolved: 1,
      monitored: 0,
      canExport: true,
    });
  });

  it("makes simulator evidence unmistakable and creates a safe filename", () => {
    const report = {
      generatedAt: "2026-09-02T10:00:00.000Z",
      dataSource: "demo" as const,
      account: { id: "adacct_demo", name: "Demo / Harbour Home" },
      records: [record],
    };
    expect(buildChangeAssuranceReportHtml(report)).toContain(
      "SIMULATOR — NOT LIVE EVIDENCE",
    );
    expect(changeAssuranceReportFileName(report)).toBe(
      "maintainflow-change-assurance-demo-harbour-home-2026-09-02.html",
    );
  });
});
