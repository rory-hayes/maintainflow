import { z } from "zod";

import {
  monitoringObservationSchema,
  monitoringOutcomeSchema,
  monitoringPlanSchema,
} from "../openai-ads/monitoring";

export const approvalStatusSchema = z.enum([
  "pending",
  "applied",
  "failed",
  "reconciliation_required",
  "rollback_pending",
  "rolled_back",
  "rollback_failed",
  "rollback_reconciliation_required",
]);

export const storedAdsMutationSchema = z.object({
  method: z.literal("POST"),
  path: z.string(),
  body: z.record(z.string(), z.unknown()).nullable(),
});

export const approvalRecordSchema = z.object({
  id: z.string().uuid(),
  accountId: z.string(),
  operatorId: z.string(),
  organizationId: z.string().uuid().nullable(),
  organizationName: z.string().nullable(),
  membershipRole: z.enum(["owner", "admin", "analyst"]).nullable(),
  accountRole: z.enum(["owner", "manager", "viewer"]).nullable(),
  recommendationId: z.string(),
  recommendationTitle: z.string(),
  entityId: z.string(),
  rollback: storedAdsMutationSchema,
  safeguard: z.string(),
  status: approvalStatusSchema,
  errorMessage: z.string().nullable(),
  reconciliationNote: z.string().nullable(),
  monitoringPlan: monitoringPlanSchema.nullable(),
  monitoringStartedAt: z.date().nullable(),
  monitoringEndsAt: z.date().nullable(),
  monitoringOutcome: monitoringOutcomeSchema.nullable(),
  monitoringObservation: monitoringObservationSchema.nullable(),
  monitoringEvaluatedAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  appliedAt: z.date().nullable(),
  rolledBackAt: z.date().nullable(),
});

export const approvalRecordDtoSchema = approvalRecordSchema
  .omit({ rollback: true })
  .extend({
    rollbackPath: z.string(),
    monitoringStartedAt: z.string().datetime().nullable(),
    monitoringEndsAt: z.string().datetime().nullable(),
    monitoringEvaluatedAt: z.string().datetime().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    appliedAt: z.string().nullable(),
    rolledBackAt: z.string().nullable(),
  });

export const reconciliationActionSchema = z.enum([
  "mark_applied",
  "mark_not_applied",
  "mark_rolled_back",
  "mark_still_applied",
]);

export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type ApprovalRecordDto = z.infer<typeof approvalRecordDtoSchema>;
export type ReconciliationAction = z.infer<typeof reconciliationActionSchema>;

export function toApprovalRecordDto(
  record: ApprovalRecord,
): ApprovalRecordDto {
  return approvalRecordDtoSchema.parse({
    ...record,
    rollback: undefined,
    rollbackPath: record.rollback.path,
    monitoringStartedAt: record.monitoringStartedAt?.toISOString() ?? null,
    monitoringEndsAt: record.monitoringEndsAt?.toISOString() ?? null,
    monitoringEvaluatedAt:
      record.monitoringEvaluatedAt?.toISOString() ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    appliedAt: record.appliedAt?.toISOString() ?? null,
    rolledBackAt: record.rolledBackAt?.toISOString() ?? null,
  });
}
