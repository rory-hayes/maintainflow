import { z } from "zod";

export const readinessAuditRequestSchema = z
  .object({
    url: z.string().trim().min(1).max(2_048),
    accountId: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const readinessCheckStatusSchema = z.enum(["pass", "warning", "fail"]);

export const readinessCheckSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: readinessCheckStatusSchema,
  weight: z.number().int().min(0).max(100),
  evidence: z.string(),
  recommendation: z.string(),
});

export const measurementInstallationStatusSchema = z.enum([
  "detected",
  "needs_attention",
  "not_detected",
]);

export const measurementInstallationSchema = z.object({
  status: measurementInstallationStatusSchema,
  sdkDetected: z.boolean(),
  initializationDetected: z.boolean(),
  pixelIdDetected: z.boolean(),
  imageTagDetected: z.boolean(),
  consentSignalDetected: z.boolean(),
  eventNames: z.array(z.string()).max(20),
  csp: z.object({
    present: z.boolean(),
    compatible: z.boolean(),
    missingSources: z.array(z.string()).max(8),
  }),
  checks: z.array(readinessCheckSchema),
});

export const readinessAuditSchema = z.object({
  requestedUrl: z.string().url(),
  finalUrl: z.string().url(),
  scannedAt: z.string().datetime(),
  score: z.number().int().min(0).max(100),
  verdict: z.enum(["ready", "needs_work", "not_ready"]),
  checks: z.array(readinessCheckSchema),
  measurement: measurementInstallationSchema,
  limitations: z.array(z.string()),
});

export type ReadinessAudit = z.infer<typeof readinessAuditSchema>;
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;
export type ReadinessCheckStatus = z.infer<typeof readinessCheckStatusSchema>;
export type MeasurementInstallation = z.infer<
  typeof measurementInstallationSchema
>;
