import { z } from "zod";

import {
  storedAdsMutationSchema,
  storedRecommendationEvidenceSchema,
} from "../audit/approval-schema";
import type { Recommendation } from "../openai-ads/demo-data";
import { monitoringPlanSchema } from "../openai-ads/monitoring";
import { membershipRoleSchema } from "../tenancy/schema";

export const changeApprovalRequestSourceSchema = z.enum([
  "simulator",
  "live",
]);

export const changeApprovalRequestStatusSchema = z.enum([
  "awaiting_approval",
  "approved",
  "changes_requested",
  "cancelled",
  "expired",
]);

export const changeApprovalDecisionActionSchema = z.enum([
  "approve",
  "request_changes",
]);

export const changeApprovalRequestNoteSchema = z
  .string()
  .trim()
  .max(500)
  .optional();

export const changeApprovalDecisionNoteSchema = z
  .string()
  .trim()
  .max(500)
  .optional();

const changeApprovalDecisionContextBaseSchema = z.object({
  priority: z.enum(["high", "medium"]),
  summary: z.string(),
  entityLabel: z.string(),
  currentValue: z.string(),
  proposedValue: z.string(),
  estimatedImpact: z.string(),
  confidence: z.number().finite().min(0).max(100),
  nextStep: z.string(),
  monitoringPlan: monitoringPlanSchema.nullable(),
});

export const changeApprovalDecisionContextSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    changeApprovalDecisionContextBaseSchema.extend({
      schemaVersion: z.literal(1),
    }),
    changeApprovalDecisionContextBaseSchema.extend({
      schemaVersion: z.literal(2),
      rationale: z.string(),
    }),
  ],
);

export const changeApprovalRequestSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.string().uuid(),
  organizationName: z.string(),
  advertiserAccountId: z.string().uuid().nullable(),
  accountId: z.string(),
  accountName: z.string(),
  source: changeApprovalRequestSourceSchema,
  recommendationId: z.string(),
  recommendationTitle: z.string(),
  entityId: z.string(),
  recommendationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  decisionContext: changeApprovalDecisionContextSchema,
  mutation: storedAdsMutationSchema,
  rollback: storedAdsMutationSchema,
  evidence: storedRecommendationEvidenceSchema,
  safeguard: z.string(),
  requesterOperatorId: z.string(),
  requesterName: z.string(),
  requesterMembershipRole: membershipRoleSchema,
  requestNote: z.string().nullable(),
  status: changeApprovalRequestStatusSchema,
  decisionOperatorId: z.string().nullable(),
  decisionName: z.string().nullable(),
  decisionMembershipRole: membershipRoleSchema.nullable(),
  decisionNote: z.string().nullable(),
  requestedAt: z.date(),
  decidedAt: z.date().nullable(),
  expiresAt: z.date(),
  retiredAt: z.date().nullable(),
  version: z.number().int().positive(),
  createdAt: z.date(),
  updatedAt: z.date(),
  adsApprovalRecordId: z.string().uuid().nullable(),
});

export const changeApprovalRequestDtoSchema = changeApprovalRequestSchema
  .extend({
    requestedAt: z.string().datetime(),
    decidedAt: z.string().datetime().nullable(),
    expiresAt: z.string().datetime(),
    retiredAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  });

export type ChangeApprovalRequestSource = z.infer<
  typeof changeApprovalRequestSourceSchema
>;
export type ChangeApprovalRequestStatus = z.infer<
  typeof changeApprovalRequestStatusSchema
>;
export type ChangeApprovalDecisionAction = z.infer<
  typeof changeApprovalDecisionActionSchema
>;
export type ChangeApprovalRequest = z.infer<typeof changeApprovalRequestSchema>;
export type ChangeApprovalDecisionContext = z.infer<
  typeof changeApprovalDecisionContextSchema
>;
export type ChangeApprovalRequestDto = z.infer<
  typeof changeApprovalRequestDtoSchema
>;

export function toChangeApprovalRequestDto(
  request: ChangeApprovalRequest,
): ChangeApprovalRequestDto {
  return changeApprovalRequestDtoSchema.parse({
    ...request,
    requestedAt: request.requestedAt.toISOString(),
    decidedAt: request.decidedAt?.toISOString() ?? null,
    expiresAt: request.expiresAt.toISOString(),
    retiredAt: request.retiredAt?.toISOString() ?? null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  });
}

export function buildChangeApprovalDecisionContext(
  recommendation: Recommendation,
): ChangeApprovalDecisionContext {
  return changeApprovalDecisionContextSchema.parse({
    schemaVersion: 2,
    priority: recommendation.priority,
    summary: recommendation.summary,
    rationale: recommendation.rationale,
    entityLabel: recommendation.entityLabel,
    currentValue: recommendation.currentValue,
    proposedValue: recommendation.proposedValue,
    estimatedImpact: recommendation.estimatedImpact,
    confidence: recommendation.confidence,
    nextStep: recommendation.nextStep,
    monitoringPlan: recommendation.monitoringPlan ?? null,
  });
}
