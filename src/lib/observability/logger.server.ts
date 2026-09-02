import "server-only";

import { randomUUID } from "node:crypto";

import { resolveBuildRevision } from "../release/revision";
import { resolveReleaseStage } from "../release/stage";

const SERVICE = "maintainflow-ads";

const events = [
  "ads.apply.audit_persistence_failed",
  "ads.apply.completed",
  "ads.apply.execution_fence_lost",
  "ads.apply.execution_lease_lost",
  "ads.apply.precondition_blocked",
  "ads.apply.reconciliation_required",
  "ads.apply.rejected",
  "ads.reconcile.completed",
  "ads.reconcile.failed",
  "ads.reconcile.unavailable",
  "ads.rollback.audit_persistence_failed",
  "ads.rollback.completed",
  "ads.rollback.execution_fence_lost",
  "ads.rollback.execution_lease_lost",
  "ads.rollback.invalid_stored_request",
  "ads.rollback.precondition_blocked",
  "ads.rollback.reconciliation_required",
  "ads.rollback.rejected",
  "ads.recommendation_decision.completed",
  "ads.recommendation_decision.failed",
  "ads.recommendation_decision.rejected",
  "ads.recommendation_decision.unavailable",
  "agency.account_attach.completed",
  "agency.account_attach.failed",
  "agency.account_attach.rejected",
  "agency.account_attach.unavailable",
  "agency.account_verify.completed",
  "connection.ads.account_mismatch",
  "connection.ads.failed",
  "connection.ads.rotated",
  "connection.ads.unavailable",
  "connection.conversions.failed",
  "connection.conversions.provider_rejected",
  "connection.conversions.rotated",
  "connection.conversions.transport_unconfirmed",
  "connection.conversions.unavailable",
  "conversions.validate_only.completed",
  "conversions.validate_only.failed",
  "conversions.validate_only.rejected",
  "conversions.validate_only.unavailable",
  "deployment.readiness.completed",
  "deployment.readiness.failed",
  "deployment.readiness.unconfigured",
  "monitoring.account_evaluation.failed",
  "monitoring.account_attempt_release.failed",
  "monitoring.account_attempt_release.unconfirmed",
  "monitoring.approval_ledger.failed",
  "monitoring.approval_recovery.failed",
  "monitoring.claim_release.failed",
  "monitoring.claim_release.unconfirmed",
  "monitoring.evaluation.failed",
  "monitoring.evaluation.unavailable",
  "monitoring.paused_backlog.unavailable",
  "monitoring.readiness_cleanup.failed",
  "monitoring.run.completed",
  "monitoring.run.completed_with_failures",
  "monitoring.run.failed",
  "monitoring.run.unconfigured",
  "monitoring.snapshot_cleanup.failed",
  "monitoring.snapshot_cleanup.unavailable",
  "monitoring.store_verification.unavailable",
  "observability.invalid_event",
  "onboarding.workspace.completed",
  "onboarding.workspace.failed",
  "onboarding.workspace.rejected",
  "onboarding.workspace.unavailable",
  "readiness.audit.failed",
  "readiness.capacity_check.failed",
  "readiness.history_authorization.failed",
  "readiness.history_load.failed",
  "readiness.history_save.failed",
  "workspace.approval_history_sync_failed",
  "workspace.conversion_credential_status_failed",
  "workspace.creative_history_sync_failed",
  "workspace.live_portfolio_load_failed",
  "workspace.live_sync_failed",
  "workspace.monitoring_evaluation_failed",
  "workspace.readiness_history_load_failed",
  "workspace.recommendation_decision_sync_failed",
] as const;

const eventSet = new Set<string>(events);

const scopes = [
  "app.workspace",
  "api.readiness.audit",
  "api.readiness.history",
  "api.deployment.ready",
  "api.monitoring.cron",
  "monitoring.runner",
  "api.ads.apply",
  "api.ads.rollback",
  "api.ads.reconcile",
  "api.ads.recommendation_decision",
  "api.agency.account_attach",
  "api.connection.ads",
  "api.connection.conversions",
  "api.measurements.conversions_validate",
  "api.onboarding.workspace",
] as const;

const dependencyChecks = new Set([
  "approvals_and_monitoring",
  "build_revision",
  "conversion_credentials",
  "creative_history",
  "database_migrations",
  "database_runtime_role",
  "live_sync",
  "readiness_history",
  "readiness_quota",
  "recommendation_decisions",
  "release_stage",
  "tenancy",
  "ads_credentials",
]);

const countNames = new Set([
  "accountsFailed",
  "accountsProcessed",
  "accountsSelected",
  "approvalOperationsRecovered",
  "unresolvedApprovalOperations",
  "checksPassed",
  "checksTotal",
  "due",
  "evaluated",
  "failed",
  "pausedDueAccounts",
  "pausedDueWindows",
  "pruned",
]);

const errorKinds = new Map([
  ["AbortError", "timeout_error"],
  ["TimeoutError", "timeout_error"],
  ["SyntaxError", "validation_error"],
  ["ZodError", "validation_error"],
  ["WorkspaceRequestInvalidError", "validation_error"],
  ["AdvertiserAccountAttachRequestInvalidError", "validation_error"],
  ["RecommendationDecisionRequestInvalidError", "validation_error"],
  ["ConversionValidationRequestInvalidError", "validation_error"],
  ["RequestBodyTooLargeError", "request_too_large"],
  ["OpenAIAdsApiError", "provider_error"],
  ["OpenAIAdsLiveReadUnavailableError", "provider_unavailable"],
  ["LiveSyncUnavailableError", "provider_unavailable"],
  ["AdsMutationReconciliationRequiredError", "reconciliation_required"],
  ["AdsMutationRejectedError", "provider_rejected"],
  ["ConversionsApiProviderRejectedError", "provider_rejected"],
  ["ConversionsApiTransportUnconfirmedError", "transport_unconfirmed"],
  ["ConversionsApiPayloadInvalidError", "validation_error"],
  ["ConversionsApiValidationUnavailableError", "provider_unavailable"],
  ["OperatorUnauthorizedError", "authentication_error"],
  ["OperatorAuthUnavailableError", "authentication_unavailable"],
  ["AccountAccessForbiddenError", "authorization_error"],
  ["AdvertiserAccountAttachConflictError", "conflict_error"],
  ["AdvertiserWriteBlockedError", "conflict_error"],
  ["AdvertiserCredentialUnavailableError", "credential_error"],
  ["CredentialVaultUnavailableError", "credential_error"],
  ["LiveRecommendationDecisionUnavailableError", "conflict_error"],
  ["RecommendationDecisionTransitionError", "conflict_error"],
  ["TenancyStoreUnavailableError", "storage_error"],
  ["ApprovalStoreUnavailableError", "storage_error"],
  ["ApprovalProviderSendFenceUnavailableError", "conflict_error"],
  ["RecommendationDecisionStoreUnavailableError", "storage_error"],
  ["ReadinessHistoryStoreUnavailableError", "storage_error"],
  ["ReadinessRateLimitUnavailableError", "storage_error"],
  ["PostgresError", "storage_error"],
]);

export type ServerLogScope = (typeof scopes)[number];
export type ServerLogLevel = "info" | "warn" | "error";
export type ServerLogEvent = (typeof events)[number];

export type ServerLogFields = {
  error?: unknown;
  status?: number;
  durationMs?: number;
  failedChecks?: readonly string[];
  counts?: Readonly<Record<string, number>>;
};

function classifyError(error: unknown) {
  if (!(error instanceof Error)) return "unknown_error";
  return errorKinds.get(error.name) ?? "application_error";
}

function boundedInteger(value: unknown, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(maximum, Math.max(0, Math.round(value)));
}

function safeFailedChecks(values: readonly string[] | undefined) {
  if (!values) return undefined;
  const checks = [
    ...new Set(
      values.map((value) =>
        dependencyChecks.has(value) ? value : "unknown_check",
      ),
    ),
  ].sort();
  return checks.length > 0 ? checks : undefined;
}

function safeCounts(values: Readonly<Record<string, number>> | undefined) {
  if (!values) return undefined;
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!countNames.has(name)) continue;
    const bounded = boundedInteger(value, 1_000_000);
    if (bounded !== undefined) counts[name] = bounded;
  }
  return Object.keys(counts).length > 0 ? counts : undefined;
}

function emit(
  level: ServerLogLevel,
  scope: ServerLogScope,
  runId: string,
  event: ServerLogEvent,
  fields: ServerLogFields,
) {
  const status = boundedInteger(fields.status, 599);
  const durationMs = boundedInteger(fields.durationMs, 86_400_000);
  const failedChecks = safeFailedChecks(fields.failedChecks);
  const counts = safeCounts(fields.counts);
  const record = {
    timestamp: new Date().toISOString(),
    service: SERVICE,
    level,
    event: eventSet.has(event) ? event : "observability.invalid_event",
    scope: scopes.includes(scope) ? scope : "unknown_scope",
    runId,
    stage: resolveReleaseStage(),
    revision: resolveBuildRevision() ?? "unknown",
    ...(fields.error === undefined
      ? {}
      : { errorKind: classifyError(fields.error) }),
    ...(status === undefined ? {} : { status }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(failedChecks ? { failedChecks } : {}),
    ...(counts ? { counts } : {}),
  };
  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export function createServerLogger(scope: ServerLogScope) {
  const runId = randomUUID();
  return {
    runId,
    info(event: ServerLogEvent, fields: ServerLogFields = {}) {
      emit("info", scope, runId, event, fields);
    },
    warn(event: ServerLogEvent, fields: ServerLogFields = {}) {
      emit("warn", scope, runId, event, fields);
    },
    error(event: ServerLogEvent, fields: ServerLogFields = {}) {
      emit("error", scope, runId, event, fields);
    },
  };
}
