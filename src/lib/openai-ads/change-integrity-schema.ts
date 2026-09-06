import { z } from "zod";

export const CHANGE_INTEGRITY_PROJECTION_VERSION = 1;
export const CHANGE_INTEGRITY_MAX_RESOURCES = 10_001;

export const changeIntegrityResourceTypeSchema = z.enum([
  "ad_account",
  "campaign",
  "ad_group",
  "ad",
]);

export const changeIntegrityClassificationSchema = z.enum([
  "maintainflow_consistent",
  "unexplained",
  "indeterminate",
]);

export const changeIntegrityChangeTypeSchema = z.enum([
  "created",
  "updated",
  "removed",
]);

export const changeIntegrityReviewStatusSchema = z.enum([
  "not_required",
  "open",
  "reviewed",
]);

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const boundedIdentifierSchema = z.string().min(1).max(512);
const boundedLabelSchema = z.string().min(1).max(1_000);
const configurationSchema = z.record(z.string(), z.unknown());

export const changeIntegrityResourceSchema = z
  .object({
    resourceType: changeIntegrityResourceTypeSchema,
    resourceId: boundedIdentifierSchema,
    parentResourceId: boundedIdentifierSchema.nullable(),
    resourceLabel: boundedLabelSchema,
    providerUpdatedAt: z.number().int().nonnegative().nullable(),
    configuration: configurationSchema,
    fingerprint: fingerprintSchema,
  })
  .strict();

export const changeIntegritySnapshotSchema = z
  .object({
    projectionVersion: z.literal(CHANGE_INTEGRITY_PROJECTION_VERSION),
    accountId: boundedIdentifierSchema,
    observationStartedAt: z.string().datetime(),
    observedAt: z.string().datetime(),
    resources: z
      .array(changeIntegrityResourceSchema)
      .min(1)
      .max(CHANGE_INTEGRITY_MAX_RESOURCES),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (
      Date.parse(snapshot.observationStartedAt) > Date.parse(snapshot.observedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["observationStartedAt"],
        message: "An integrity observation cannot start after it completes.",
      });
    }
    const keys = new Set<string>();
    let accountResources = 0;
    for (const [index, resource] of snapshot.resources.entries()) {
      const key = `${resource.resourceType}:${resource.resourceId}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "resourceId"],
          message: "Integrity resources must be unique within one snapshot.",
        });
      }
      keys.add(key);
      if (resource.resourceType === "ad_account") {
        accountResources += 1;
        if (
          resource.resourceId !== snapshot.accountId ||
          resource.parentResourceId !== null
        ) {
          context.addIssue({
            code: "custom",
            path: ["resources", index],
            message: "The account integrity resource must match the snapshot scope.",
          });
        }
      }
    }
    if (accountResources !== 1) {
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "An integrity snapshot must contain exactly one account resource.",
      });
    }
  });

export const changeIntegrityOperationEvidenceSchema = z
  .object({
    approvalId: z.string().uuid(),
    resourceType: changeIntegrityResourceTypeSchema.exclude(["ad_account"]),
    resourceId: boundedIdentifierSchema,
    mode: z.enum(["apply", "rollback"]),
    certainty: z.enum(["confirmed", "indeterminate"]),
    uncertaintyReason: z
      .enum(["provider_outcome", "snapshot_timing"])
      .nullable(),
    occurredAt: z.string().datetime(),
    expectedState: configurationSchema,
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      (operation.certainty === "confirmed" &&
        operation.uncertaintyReason !== null) ||
      (operation.certainty === "indeterminate" &&
        operation.uncertaintyReason === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["uncertaintyReason"],
        message:
          "Only indeterminate operation evidence must carry an uncertainty reason.",
      });
    }
  });

const changeIntegrityCandidateBaseSchema = z
  .object({
    eventFingerprint: fingerprintSchema,
    accountId: boundedIdentifierSchema,
    resourceType: changeIntegrityResourceTypeSchema,
    resourceId: boundedIdentifierSchema,
    parentResourceId: boundedIdentifierSchema.nullable(),
    resourceLabel: boundedLabelSchema,
    providerUpdatedAt: z.number().int().nonnegative().nullable(),
    changeType: changeIntegrityChangeTypeSchema,
    classification: changeIntegrityClassificationSchema,
    previousFingerprint: fingerprintSchema.nullable(),
    currentFingerprint: fingerprintSchema.nullable(),
    previousConfiguration: configurationSchema.nullable(),
    currentConfiguration: configurationSchema.nullable(),
    changedFieldPaths: z
      .array(z.string().min(1).max(512))
      .min(1)
      .max(2_000),
    explainedFieldPaths: z.array(z.string().min(1).max(512)).max(2_000),
    indeterminateFieldPaths: z.array(z.string().min(1).max(512)).max(2_000),
    unexplainedFieldPaths: z.array(z.string().min(1).max(512)).max(2_000),
    matchedOperations: z.array(changeIntegrityOperationEvidenceSchema).max(100),
    baselineObservationStartedAt: z.string().datetime(),
    baselineObservedAt: z.string().datetime(),
    detectionStartedAt: z.string().datetime(),
    detectedAt: z.string().datetime(),
  })
  .strict();

type ChangeIntegrityPathPartition = {
  classification: z.infer<typeof changeIntegrityClassificationSchema>;
  changedFieldPaths: string[];
  explainedFieldPaths: string[];
  indeterminateFieldPaths: string[];
  unexplainedFieldPaths: string[];
};

function validatePathPartition(
  value: ChangeIntegrityPathPartition & {
    baselineObservationStartedAt: string;
    baselineObservedAt: string;
    detectionStartedAt: string;
    detectedAt: string;
  },
  context: z.RefinementCtx,
) {
  const baselineStartedAt = Date.parse(value.baselineObservationStartedAt);
  const baselineObservedAt = Date.parse(value.baselineObservedAt);
  const detectionStartedAt = Date.parse(value.detectionStartedAt);
  const detectedAt = Date.parse(value.detectedAt);
  if (
    baselineStartedAt > baselineObservedAt ||
    baselineObservedAt > detectionStartedAt ||
    detectionStartedAt > detectedAt
  ) {
    context.addIssue({
      code: "custom",
      path: ["detectionStartedAt"],
      message:
        "Integrity evidence must retain two ordered, non-overlapping observation intervals.",
    });
  }
  const categories = [
    ["explainedFieldPaths", value.explainedFieldPaths],
    ["indeterminateFieldPaths", value.indeterminateFieldPaths],
    ["unexplainedFieldPaths", value.unexplainedFieldPaths],
  ] as const;
  const changed = new Set(value.changedFieldPaths);
  const categorized = new Map<string, number>();

  if (changed.size !== value.changedFieldPaths.length) {
    context.addIssue({
      code: "custom",
      path: ["changedFieldPaths"],
      message: "Changed field paths must be unique.",
    });
  }

  for (const [field, paths] of categories) {
    if (new Set(paths).size !== paths.length) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: "Integrity path categories must not contain duplicates.",
      });
    }
    for (const path of paths) {
      if (!changed.has(path)) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "Every categorized path must belong to the changed paths.",
        });
      }
      categorized.set(path, (categorized.get(path) ?? 0) + 1);
    }
  }

  if (
    value.changedFieldPaths.some((path) => categorized.get(path) !== 1) ||
    [...categorized.values()].some((count) => count !== 1)
  ) {
    context.addIssue({
      code: "custom",
      path: ["changedFieldPaths"],
      message:
        "Explained, indeterminate, and unexplained paths must form one exact partition of the changed paths.",
    });
  }

  const expectedClassification =
    value.unexplainedFieldPaths.length > 0
      ? "unexplained"
      : value.indeterminateFieldPaths.length > 0
        ? "indeterminate"
        : "maintainflow_consistent";
  if (value.classification !== expectedClassification) {
    context.addIssue({
      code: "custom",
      path: ["classification"],
      message: "The integrity classification must match its path partition.",
    });
  }
}

export const changeIntegrityCandidateSchema =
  changeIntegrityCandidateBaseSchema.superRefine(validatePathPartition);

export const changeIntegrityEventDtoSchema = changeIntegrityCandidateBaseSchema
  .omit({ eventFingerprint: true, accountId: true })
  .extend({
    id: z.string().uuid(),
    reviewStatus: changeIntegrityReviewStatusSchema,
    reviewedByName: z.string().min(1).max(120).nullable(),
    reviewNote: z.string().min(10).max(1_000).nullable(),
    reviewedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine(validatePathPartition);

export const changeIntegritySummarySchema = z
  .object({
    baselineReady: z.boolean(),
    lastCheckedAt: z.string().datetime().nullable(),
    retainedEventCount: z.number().int().nonnegative(),
    openUnexplainedCount: z.number().int().nonnegative(),
    openIndeterminateCount: z.number().int().nonnegative(),
    consistentCount: z.number().int().nonnegative(),
    reviewedCount: z.number().int().nonnegative(),
  })
  .strict();

export const changeIntegrityEventPageSchema = z
  .object({
    events: z.array(changeIntegrityEventDtoSchema).max(100),
    hasMore: z.boolean(),
    summary: changeIntegritySummarySchema,
  })
  .strict();

export type ChangeIntegrityResourceType = z.infer<
  typeof changeIntegrityResourceTypeSchema
>;
export type ChangeIntegrityClassification = z.infer<
  typeof changeIntegrityClassificationSchema
>;
export type ChangeIntegrityResource = z.infer<
  typeof changeIntegrityResourceSchema
>;
export type ChangeIntegritySnapshot = z.infer<
  typeof changeIntegritySnapshotSchema
>;
export type ChangeIntegrityOperationEvidence = z.infer<
  typeof changeIntegrityOperationEvidenceSchema
>;
export type ChangeIntegrityCandidate = z.infer<
  typeof changeIntegrityCandidateSchema
>;
export type ChangeIntegrityEventDto = z.infer<
  typeof changeIntegrityEventDtoSchema
>;
export type ChangeIntegritySummary = z.infer<
  typeof changeIntegritySummarySchema
>;
export type ChangeIntegrityEventPage = z.infer<
  typeof changeIntegrityEventPageSchema
>;

export function emptyChangeIntegrityEventPage(): ChangeIntegrityEventPage {
  return {
    events: [],
    hasMore: false,
    summary: {
      baselineReady: false,
      lastCheckedAt: null,
      retainedEventCount: 0,
      openUnexplainedCount: 0,
      openIndeterminateCount: 0,
      consistentCount: 0,
      reviewedCount: 0,
    },
  };
}
