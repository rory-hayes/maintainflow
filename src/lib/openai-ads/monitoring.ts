import { z } from "zod";

export const monitoringPlanSchema = z
  .object({
    kind: z.literal("click_attributed_conversion_guardrail"),
    windowDays: z.number().int().min(1).max(30),
    baseline: z.object({
      rangeStart: z.number().int().nonnegative(),
      rangeEnd: z.number().int().positive(),
      spend: z.number().nonnegative(),
      clickAttributedConversions: z.number().nonnegative(),
      cpa: z.number().nonnegative(),
      configuredBidMicros: z.number().int().positive(),
      currencyCode: z.string().length(3),
    }),
    rollbackRule: z.object({
      metric: z.literal("click_attributed_conversions"),
      comparison: z.literal("decrease_percent_greater_than"),
      thresholdPercent: z.number().positive().max(100),
    }),
  })
  .superRefine((plan, context) => {
    if (plan.baseline.rangeEnd <= plan.baseline.rangeStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseline", "rangeEnd"],
        message: "The monitoring baseline must end after it starts.",
      });
    }
  });

export const monitoringOutcomeSchema = z.enum([
  "within_safeguard",
  "safeguard_triggered",
  "insufficient_evidence",
]);

export const monitoringEvidenceStateSchema = z.enum([
  "complete",
  "missing_delivery_insight",
  "missing_conversion_insight",
  "missing_delivery_and_conversion_insights",
  "insufficient_baseline",
]);

export const monitoringObservationSchema = z
  .object({
    rangeStart: z.number().int().nonnegative(),
    rangeEnd: z.number().int().positive(),
    spend: z.number().nonnegative().nullable(),
    clickAttributedConversions: z.number().nonnegative().nullable(),
    cpa: z.number().nonnegative().nullable(),
    conversionChangePercent: z.number().nullable(),
    baselineClickAttributedConversions: z.number().nonnegative(),
    thresholdPercent: z.number().positive().max(100),
    evidenceState: monitoringEvidenceStateSchema,
  })
  .superRefine((observation, context) => {
    if (observation.rangeEnd <= observation.rangeStart) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rangeEnd"],
        message: "The observed monitoring range must end after it starts.",
      });
    }
  });

export const monitoringWindowStatusSchema = z.enum([
  "active",
  "review_due",
  "within_safeguard",
  "safeguard_triggered",
  "insufficient_evidence",
  "rollback_pending",
  "rollback_outcome_unknown",
]);

export const monitoringWindowDtoSchema = z.object({
  approvalId: z.string().uuid(),
  accountId: z.string(),
  recommendationId: z.string(),
  recommendationTitle: z.string(),
  entityId: z.string(),
  safeguard: z.string(),
  status: monitoringWindowStatusSchema,
  startedAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  progress: z.number().int().min(0).max(100),
  plan: monitoringPlanSchema,
  outcome: monitoringOutcomeSchema.nullable(),
  observation: monitoringObservationSchema.nullable(),
  evaluatedAt: z.string().datetime().nullable(),
}).superRefine((window, context) => {
  const outcomeFields = [window.outcome, window.observation, window.evaluatedAt];
  const populated = outcomeFields.filter((value) => value !== null).length;
  if (populated !== 0 && populated !== outcomeFields.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["outcome"],
      message: "A monitoring result must include its outcome, observation, and evaluation time.",
    });
  }
});

export type MonitoringPlan = z.infer<typeof monitoringPlanSchema>;
export type MonitoringOutcome = z.infer<typeof monitoringOutcomeSchema>;
export type MonitoringObservation = z.infer<
  typeof monitoringObservationSchema
>;
export type MonitoringWindowDto = z.infer<typeof monitoringWindowDtoSchema>;

type MonitoringEvaluationInput = {
  plan: MonitoringPlan;
  rangeStart: number;
  rangeEnd: number;
  spend: number | null;
  clickAttributedConversions: number | null;
};

function roundedPercent(value: number) {
  return Math.round(value * 100) / 100;
}

export function evaluateMonitoringObservation({
  plan,
  rangeStart,
  rangeEnd,
  spend,
  clickAttributedConversions,
}: MonitoringEvaluationInput): {
  outcome: MonitoringOutcome;
  observation: MonitoringObservation;
} {
  const baseline = plan.baseline.clickAttributedConversions;
  const thresholdPercent = plan.rollbackRule.thresholdPercent;
  const evidenceState =
    baseline < 3
      ? "insufficient_baseline"
      : spend === null && clickAttributedConversions === null
        ? "missing_delivery_and_conversion_insights"
        : spend === null
          ? "missing_delivery_insight"
          : clickAttributedConversions === null
            ? "missing_conversion_insight"
            : "complete";
  const hasCompleteEvidence = evidenceState === "complete";
  const conversionChangePercent = hasCompleteEvidence
    ? roundedPercent(
        ((clickAttributedConversions! - baseline) / baseline) * 100,
      )
    : null;
  const cpa =
    hasCompleteEvidence && clickAttributedConversions! > 0
      ? spend! / clickAttributedConversions!
      : null;
  const outcome: MonitoringOutcome = !hasCompleteEvidence
    ? "insufficient_evidence"
    : conversionChangePercent! < -thresholdPercent
      ? "safeguard_triggered"
      : "within_safeguard";

  return {
    outcome,
    observation: monitoringObservationSchema.parse({
      rangeStart,
      rangeEnd,
      spend,
      clickAttributedConversions,
      cpa,
      conversionChangePercent,
      baselineClickAttributedConversions: baseline,
      thresholdPercent,
      evidenceState,
    }),
  };
}

export function monitoringProgress(
  startedAt: string,
  endsAt: string,
  now = new Date(),
) {
  const start = Date.parse(startedAt);
  const end = Date.parse(endsAt);
  const current = now.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  return Math.max(
    0,
    Math.min(100, Math.round(((current - start) / (end - start)) * 100)),
  );
}
