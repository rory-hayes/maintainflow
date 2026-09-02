import { createHash } from "node:crypto";

import { z } from "zod";

import type { Recommendation } from "../openai-ads/demo-data";
import {
  accountAccessRoleSchema,
  membershipRoleSchema,
} from "../tenancy/schema";

export const recommendationDecisionActionSchema = z.enum([
  "dismiss",
  "restore",
]);

export const recommendationDismissalReasonSchema = z
  .string()
  .trim()
  .min(5)
  .max(500);

export const recommendationDismissalSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string(),
  operatorId: z.string(),
  organizationId: z.string().uuid(),
  membershipRole: membershipRoleSchema,
  accountRole: accountAccessRoleSchema,
  recommendationId: z.string(),
  recommendationTitle: z.string(),
  entityId: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  reason: recommendationDismissalReasonSchema,
  dismissedAt: z.date(),
});

export const recommendationDecisionHistorySchema =
  recommendationDismissalSchema.extend({
    organizationName: z.string(),
    restoredBy: z.string().nullable(),
    restoredOrganizationId: z.string().uuid().nullable(),
    restoredOrganizationName: z.string().nullable(),
    restoredMembershipRole: membershipRoleSchema.nullable(),
    restoredAccountRole: accountAccessRoleSchema.nullable(),
    restoredAt: z.date().nullable(),
  });

export const recommendationDecisionHistoryDtoSchema =
  recommendationDecisionHistorySchema
    .omit({
      id: true,
      accountId: true,
      operatorId: true,
      organizationId: true,
      fingerprint: true,
      restoredBy: true,
      restoredOrganizationId: true,
      dismissedAt: true,
      restoredAt: true,
    })
    .extend({
      dismissedAt: z.string().datetime(),
      restoredAt: z.string().datetime().nullable(),
    });

export type RecommendationDecisionAction = z.infer<
  typeof recommendationDecisionActionSchema
>;
export type RecommendationDismissal = z.infer<
  typeof recommendationDismissalSchema
>;
export type RecommendationDecisionHistory = z.infer<
  typeof recommendationDecisionHistorySchema
>;
export type RecommendationDecisionHistoryDto = z.infer<
  typeof recommendationDecisionHistoryDtoSchema
>;

export function toRecommendationDecisionHistoryDto(
  decision: RecommendationDecisionHistory,
): RecommendationDecisionHistoryDto {
  return recommendationDecisionHistoryDtoSchema.parse({
    ...decision,
    dismissedAt: decision.dismissedAt.toISOString(),
    restoredAt: decision.restoredAt?.toISOString() ?? null,
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

/**
 * A dismissal follows the proposed change, not every refreshed measurement.
 * An external config change, a changed action, or a changed priority produces a
 * new fingerprint and lets MaintainFlow surface the recommendation again.
 */
export function recommendationFingerprint(
  recommendation: Recommendation,
) {
  const versionedChange = canonicalize({
    version: 1,
    recommendationId: recommendation.id,
    entityId: recommendation.entityId,
    priority: recommendation.priority,
    mutation: recommendation.mutation,
    rollback: recommendation.rollback,
  });
  return createHash("sha256")
    .update(JSON.stringify(versionedChange))
    .digest("hex");
}

/**
 * Exact consent boundary for an external write. Unlike a dismissal, approval
 * depends on the evidence, confidence, monitoring baseline, safeguards, and
 * every value presented alongside the proposed request and rollback.
 */
export function recommendationApprovalFingerprint(
  recommendation: Recommendation,
) {
  const displayedDecision = canonicalize({
    version: 1,
    recommendationId: recommendation.id,
    source: recommendation.source,
    title: recommendation.title,
    priority: recommendation.priority,
    summary: recommendation.summary,
    entityId: recommendation.entityId,
    entityLabel: recommendation.entityLabel,
    currentValue: recommendation.currentValue,
    proposedValue: recommendation.proposedValue,
    estimatedImpact: recommendation.estimatedImpact,
    confidence: recommendation.confidence,
    evidence: recommendation.evidence,
    mutation: recommendation.mutation,
    rollback: recommendation.rollback,
    safeguard: recommendation.safeguard,
    nextStep: recommendation.nextStep,
    monitoringPlan: recommendation.monitoringPlan ?? null,
  });
  return createHash("sha256")
    .update(JSON.stringify(displayedDecision))
    .digest("hex");
}

export function applyRecommendationDismissals(
  recommendations: Recommendation[],
  dismissals: RecommendationDismissal[],
) {
  const active = new Map(
    dismissals.map((dismissal) => [
      `${dismissal.recommendationId}\u0000${dismissal.entityId}\u0000${dismissal.fingerprint}`,
      dismissal,
    ]),
  );

  return recommendations.map((recommendation) => {
    // An active or unresolved approval always takes precedence over an older
    // dismissal for the same proposed change.
    if (recommendation.status !== "ready") return recommendation;
    const fingerprint = recommendationFingerprint(recommendation);
    const dismissal = active.get(
      `${recommendation.id}\u0000${recommendation.entityId}\u0000${fingerprint}`,
    );
    if (!dismissal) return recommendation;
    return {
      ...recommendation,
      status: "dismissed" as const,
      dismissal: {
        reason: dismissal.reason,
        dismissedAt: dismissal.dismissedAt.toISOString(),
      },
    };
  });
}
