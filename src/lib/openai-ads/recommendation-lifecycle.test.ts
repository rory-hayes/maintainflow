import { describe, expect, it } from "vitest";

import type { ApprovalRecordDto } from "@/lib/audit/approval-schema";

import { demoRecommendations } from "./demo-data";
import {
  buildMonitoringWindows,
  suppressRecommendationsUnderActiveApproval,
} from "./recommendation-lifecycle";

const monitoringPlan = demoRecommendations[0].monitoringPlan!;

function approval(
  overrides: Partial<ApprovalRecordDto> = {},
): ApprovalRecordDto {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    accountId: "adacct_live",
    organizationName: "Alpine Retail",
    membershipRole: "owner",
    accountRole: "owner",
    recommendationId: demoRecommendations[0].id,
    recommendationTitle: demoRecommendations[0].title,
    entityId: demoRecommendations[0].entityId,
    rollbackMethod: demoRecommendations[0].rollback.method,
    rollbackPath: demoRecommendations[0].rollback.path,
    rollbackBody: demoRecommendations[0].rollback.body,
    safeguard: demoRecommendations[0].safeguard,
    status: "applied",
    errorMessage: null,
    reconciliationNote: null,
    monitoringPlan,
    monitoringStartedAt: "2026-08-30T00:00:00.000Z",
    monitoringEndsAt: "2026-09-06T00:00:00.000Z",
    monitoringOutcome: null,
    monitoringObservation: null,
    monitoringEvaluatedAt: null,
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    appliedAt: "2026-08-30T00:00:00.000Z",
    rolledBackAt: null,
    ...overrides,
  };
}

describe("durable recommendation lifecycle", () => {
  it("suppresses a recommendation while its approval is active or uncertain", () => {
    for (const status of [
      "pending",
      "applied",
      "reconciliation_required",
      "rollback_pending",
      "rollback_failed",
      "rollback_reconciliation_required",
    ] as const) {
      expect(
        suppressRecommendationsUnderActiveApproval(demoRecommendations, [
          approval({ status }),
        ]).map((item) => item.id),
      ).not.toContain(demoRecommendations[0].id);
    }
  });

  it("allows a fresh recommendation after a failed or completed rollback", () => {
    for (const status of ["failed", "rolled_back"] as const) {
      expect(
        suppressRecommendationsUnderActiveApproval(demoRecommendations, [
          approval({ status }),
        ]).map((item) => item.id),
      ).toContain(demoRecommendations[0].id);
    }
  });

  it("derives progress and review-due state without fabricating performance", () => {
    expect(
      buildMonitoringWindows(
        [approval()],
        new Date("2026-09-02T12:00:00.000Z"),
      )[0],
    ).toMatchObject({ status: "active", progress: 50, plan: monitoringPlan });

    expect(
      buildMonitoringWindows(
        [approval()],
        new Date("2026-09-07T00:00:00.000Z"),
      )[0],
    ).toMatchObject({ status: "review_due", progress: 100 });
  });

  it("surfaces rollback state but excludes windows without a confirmed start", () => {
    expect(
      buildMonitoringWindows([approval({ status: "rollback_pending" })])[0]
        .status,
    ).toBe("rollback_pending");
    expect(
      buildMonitoringWindows([
        approval({
          status: "reconciliation_required",
          monitoringStartedAt: null,
          monitoringEndsAt: null,
        }),
      ]),
    ).toEqual([]);
  });

  it("surfaces a persisted safeguard result without fabricating a rollback", () => {
    const observation = {
      rangeStart: 1_788_048_000,
      rangeEnd: 1_788_652_800,
      spend: 3_900,
      clickAttributedConversions: 12,
      cpa: 325,
      conversionChangePercent: -20,
      baselineClickAttributedConversions: 15,
      thresholdPercent: 15,
      evidenceState: "complete" as const,
    };
    expect(
      buildMonitoringWindows([
        approval({
          monitoringOutcome: "safeguard_triggered",
          monitoringObservation: observation,
          monitoringEvaluatedAt: "2026-09-06T01:00:00.000Z",
        }),
      ])[0],
    ).toMatchObject({
      status: "safeguard_triggered",
      outcome: "safeguard_triggered",
      observation,
    });
  });
});
