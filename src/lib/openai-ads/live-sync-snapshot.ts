import { z } from "zod";

import type { LiveWorkbenchData } from "./data.server";
import { conversionMeasurementReadinessSchema } from "./measurement-readiness";
import { monitoringPlanSchema } from "./monitoring";
import { adAccountSchema, adSchema, campaignSchema } from "./schema";

export const LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION = 1;
export const LIVE_WORKBENCH_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;

const campaignPerformanceSchema = z
  .object({
    campaignId: z.string(),
    spend: z.number().finite().nonnegative(),
    impressions: z.number().finite().nonnegative(),
    clicks: z.number().finite().nonnegative(),
    conversions: z.number().finite().nonnegative(),
    viewThroughConversions: z.number().finite().nonnegative().optional(),
    trend: z.string(),
  })
  .strict();

const adsMutationSchema = z
  .object({
    method: z.literal("POST"),
    path: z.string(),
    body: z.record(z.unknown()).nullable(),
  })
  .strict();

const recommendationSchema = z
  .object({
    id: z.string(),
    source: z.literal("live"),
    title: z.string(),
    summary: z.string(),
    rationale: z.string(),
    priority: z.enum(["high", "medium"]),
    confidence: z.number().finite().min(0).max(100),
    status: z.enum(["ready", "monitoring", "dismissed"]),
    entityLabel: z.string(),
    entityId: z.string(),
    currentValue: z.string(),
    proposedValue: z.string(),
    estimatedImpact: z.string(),
    safeguard: z.string(),
    nextStep: z.string(),
    evidence: z.array(
      z
        .object({
          label: z.string(),
          value: z.string(),
          detail: z.string(),
        })
        .strict(),
    ),
    monitoringPlan: monitoringPlanSchema.optional(),
    dismissal: z
      .object({
        reason: z.string(),
        dismissedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    mutation: adsMutationSchema,
    rollback: adsMutationSchema,
  })
  .strict();

export const liveWorkbenchDataSchema = z
  .object({
    account: adAccountSchema,
    campaigns: z.array(campaignSchema),
    ads: z.array(adSchema.extend({ ad_group_id: z.string() })),
    performance: z.array(campaignPerformanceSchema),
    recommendations: z.array(recommendationSchema),
    conversionMeasurement: conversionMeasurementReadinessSchema,
    syncedAt: z.string().datetime(),
  })
  .strict();

export const liveWorkbenchSnapshotEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION),
    data: liveWorkbenchDataSchema,
  })
  .strict();

export type LiveWorkbenchSnapshotEnvelope = z.infer<
  typeof liveWorkbenchSnapshotEnvelopeSchema
>;

export class LiveWorkbenchSnapshotValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiveWorkbenchSnapshotValidationError";
  }
}

function serializedBytes(value: unknown) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (error) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The live workbench snapshot could not be serialized.",
      { cause: error },
    );
  }
}

export function parseLiveWorkbenchSnapshot(
  value: unknown,
  options: {
    expectedAccountId: string;
    recordedSchemaVersion?: number | null;
    recordedBytes?: number | null;
  },
): LiveWorkbenchData {
  let envelope: LiveWorkbenchSnapshotEnvelope;
  try {
    envelope = liveWorkbenchSnapshotEnvelopeSchema.parse(value);
  } catch (error) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The stored live workbench snapshot is invalid.",
      { cause: error },
    );
  }

  if (
    options.recordedSchemaVersion !== undefined &&
    options.recordedSchemaVersion !== null &&
    options.recordedSchemaVersion !== envelope.schemaVersion
  ) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The stored live workbench snapshot version is inconsistent.",
    );
  }
  if (envelope.data.account.id !== options.expectedAccountId) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The stored live workbench snapshot belongs to a different advertiser account.",
    );
  }

  const bytes = serializedBytes(envelope);
  if (bytes > LIVE_WORKBENCH_SNAPSHOT_MAX_BYTES) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The live workbench snapshot exceeds the 8 MiB storage limit.",
    );
  }
  if (
    options.recordedBytes !== undefined &&
    options.recordedBytes !== null &&
    options.recordedBytes !== bytes
  ) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The stored live workbench snapshot size is inconsistent.",
    );
  }
  return envelope.data as LiveWorkbenchData;
}

export function serializeLiveWorkbenchSnapshot(
  snapshot: LiveWorkbenchData,
  expectedAccountId: string,
) {
  const envelope = liveWorkbenchSnapshotEnvelopeSchema.parse({
    schemaVersion: LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION,
    data: snapshot,
  });
  const bytes = serializedBytes(envelope);
  if (bytes > LIVE_WORKBENCH_SNAPSHOT_MAX_BYTES) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The live workbench snapshot exceeds the 8 MiB storage limit.",
    );
  }
  if (envelope.data.account.id !== expectedAccountId) {
    throw new LiveWorkbenchSnapshotValidationError(
      "The live workbench snapshot belongs to a different advertiser account.",
    );
  }
  return { envelope, bytes, snapshot: envelope.data as LiveWorkbenchData };
}
