import { z } from "zod";

import {
  readinessAuditSchema,
  type ReadinessAudit,
  type ReadinessCheck,
} from "./schema";

export const READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION = 1;
export const READINESS_HISTORY_RULESET_VERSION =
  "openai-ads-readiness-2026-08-30";
export const READINESS_HISTORY_SCANNER_VERSION = "1.0.0";
export const READINESS_HISTORY_SOURCE_CHECKED_AT = "2026-08-30";

export const readinessTargetAssociationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("manual_unverified"),
    providerResourceType: z.null(),
    providerResourceId: z.null(),
  }),
  z.object({
    type: z.literal("provider_destination"),
    providerResourceType: z.enum(["campaign", "ad_group", "ad"]),
    providerResourceId: z.string().min(1),
  }),
]);

export const readinessAuditHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  accountId: z.string(),
  audit: readinessAuditSchema,
  payloadSchemaVersion: z.number().int().positive(),
  rulesetVersion: z.string().min(1),
  scannerVersion: z.string().min(1),
  sourceCheckedAt: z.string().date(),
  targetAssociation: readinessTargetAssociationSchema,
  queryParametersRedacted: z.boolean(),
  recordedAt: z.string().datetime(),
});

export type ReadinessAuditHistoryEntry = z.infer<
  typeof readinessAuditHistoryEntrySchema
>;

export type ReadinessAuditComparison = {
  current: ReadinessAuditHistoryEntry;
  previous: ReadinessAuditHistoryEntry | null;
  compatible: boolean;
  incompatibilityReason: string | null;
  scoreDelta: number | null;
  verdictChanged: boolean;
  improvedChecks: ReadinessCheck[];
  regressedChecks: ReadinessCheck[];
};

const statusRank: Record<ReadinessCheck["status"], number> = {
  fail: 0,
  warning: 1,
  pass: 2,
};

function allChecks(audit: ReadinessAudit) {
  return [...audit.checks, ...audit.measurement.checks];
}

function comparableUrl(value: string) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString();
}

export function sanitizeReadinessAuditForHistory(audit: ReadinessAudit) {
  const parsed = readinessAuditSchema.parse(audit);
  const requestedUrl = new URL(parsed.requestedUrl);
  const finalUrl = new URL(parsed.finalUrl);
  const queryParametersRedacted =
    requestedUrl.search.length > 0 || finalUrl.search.length > 0;
  requestedUrl.search = "";
  requestedUrl.hash = "";
  finalUrl.search = "";
  finalUrl.hash = "";

  return {
    audit: readinessAuditSchema.parse({
      ...parsed,
      requestedUrl: requestedUrl.toString(),
      finalUrl: finalUrl.toString(),
    }),
    queryParametersRedacted,
  };
}

export function compareReadinessAuditHistory(
  entries: ReadinessAuditHistoryEntry[],
): ReadinessAuditComparison | null {
  const current = entries[0];
  if (!current) return null;

  const currentUrl = comparableUrl(current.audit.finalUrl);
  const previous =
    entries
      .slice(1)
      .find(
        (entry) => comparableUrl(entry.audit.finalUrl) === currentUrl,
      ) ?? null;
  if (!previous) {
    return {
      current,
      previous: null,
      compatible: false,
      incompatibilityReason: null,
      scoreDelta: null,
      verdictChanged: false,
      improvedChecks: [],
      regressedChecks: [],
    };
  }

  const compatible =
    current.payloadSchemaVersion === previous.payloadSchemaVersion &&
    current.rulesetVersion === previous.rulesetVersion &&
    current.scannerVersion === previous.scannerVersion;
  if (!compatible) {
    return {
      current,
      previous,
      compatible: false,
      incompatibilityReason:
        "These scans used different readiness rules or scanner versions, so their scores are not compared.",
      scoreDelta: null,
      verdictChanged: false,
      improvedChecks: [],
      regressedChecks: [],
    };
  }

  const previousChecks = new Map(
    allChecks(previous.audit).map((check) => [check.id, check]),
  );
  const improvedChecks: ReadinessCheck[] = [];
  const regressedChecks: ReadinessCheck[] = [];

  for (const check of allChecks(current.audit)) {
    const prior = previousChecks.get(check.id);
    if (!prior) continue;
    const delta = statusRank[check.status] - statusRank[prior.status];
    if (delta > 0) improvedChecks.push(check);
    if (delta < 0) regressedChecks.push(check);
  }

  return {
    current,
    previous,
    compatible: true,
    incompatibilityReason: null,
    scoreDelta: current.audit.score - previous.audit.score,
    verdictChanged: current.audit.verdict !== previous.audit.verdict,
    improvedChecks,
    regressedChecks,
  };
}
