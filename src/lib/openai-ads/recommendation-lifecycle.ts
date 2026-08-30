import type {
  ApprovalRecordDto,
  ApprovalStatus,
} from "@/lib/audit/approval-schema";

import type { Recommendation } from "./demo-data";
import {
  monitoringProgress,
  monitoringWindowDtoSchema,
  type MonitoringWindowDto,
} from "./monitoring";

const activeRecommendationStatuses = new Set<ApprovalStatus>([
  "pending",
  "applied",
  "reconciliation_required",
  "rollback_pending",
  "rollback_failed",
  "rollback_reconciliation_required",
]);

export function suppressRecommendationsUnderActiveApproval(
  recommendations: Recommendation[],
  approvals: ApprovalRecordDto[],
) {
  const activeKeys = new Set(
    approvals
      .filter((record) => activeRecommendationStatuses.has(record.status))
      .map(
        (record) =>
          `${record.recommendationId}\u0000${record.entityId}`,
      ),
  );

  return recommendations.filter(
    (recommendation) =>
      !activeKeys.has(`${recommendation.id}\u0000${recommendation.entityId}`),
  );
}

export function buildMonitoringWindows(
  approvals: ApprovalRecordDto[],
  now = new Date(),
): MonitoringWindowDto[] {
  return approvals.flatMap((record) => {
    if (
      !record.monitoringPlan ||
      !record.monitoringStartedAt ||
      !record.monitoringEndsAt ||
      ![
        "applied",
        "rollback_pending",
        "rollback_failed",
        "rollback_reconciliation_required",
      ].includes(record.status)
    ) {
      return [];
    }

    const progress = monitoringProgress(
      record.monitoringStartedAt,
      record.monitoringEndsAt,
      now,
    );
    const status =
      record.status === "rollback_pending"
        ? "rollback_pending"
        : record.status === "rollback_reconciliation_required"
          ? "rollback_outcome_unknown"
          : record.monitoringOutcome === "within_safeguard"
            ? "within_safeguard"
            : record.monitoringOutcome === "safeguard_triggered"
              ? "safeguard_triggered"
              : record.monitoringOutcome === "insufficient_evidence"
                ? "insufficient_evidence"
          : progress >= 100
            ? "review_due"
            : "active";

    return [
      monitoringWindowDtoSchema.parse({
        approvalId: record.id,
        accountId: record.accountId,
        recommendationId: record.recommendationId,
        recommendationTitle: record.recommendationTitle,
        entityId: record.entityId,
        safeguard: record.safeguard,
        status,
        startedAt: record.monitoringStartedAt,
        endsAt: record.monitoringEndsAt,
        progress,
        plan: record.monitoringPlan,
        outcome: record.monitoringOutcome,
        observation: record.monitoringObservation,
        evaluatedAt: record.monitoringEvaluatedAt,
      }),
    ];
  });
}
