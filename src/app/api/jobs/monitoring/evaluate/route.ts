import { timingSafeEqual } from "node:crypto";

import {
  countUnresolvedApprovalOperations,
  recoverStaleApprovalOperations,
  summarizeDueMonitoringBacklog,
  verifyApprovalStore,
} from "@/lib/audit/approval-store.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import { evaluateScheduledMonitoringWindows } from "@/lib/openai-ads/monitoring-runner.server";
import { resolveReleaseStage } from "@/lib/release/stage";
import {
  pruneExpiredLiveSyncSnapshots,
  verifyLiveSyncStore,
} from "@/lib/openai-ads/live-sync-store.server";
import {
  isReadinessRateLimitConfigured,
  pruneExpiredReadinessRateLimitBuckets,
} from "@/lib/readiness/rate-limit.server";
import {
  verifyCredentialStore,
  verifyTenancyStore,
} from "@/lib/tenancy/store.server";

export const runtime = "nodejs";
export const maxDuration = 60;

const LIVE_SNAPSHOT_CLEANUP_LIMIT = 5_000;
const RATE_LIMIT_CLEANUP_LIMIT = 5_000;
const APPROVAL_RECOVERY_LIMIT = 500;
const MONITORING_PROVIDER_DEADLINE_MS = 45_000;
const MONITORING_MAX_ACCOUNTS_PER_RUN = 2;
const MONITORING_WINDOWS_PER_ACCOUNT = 1;

const emptyMonitoringSummary = {
  accountsSelected: 0,
  accountsProcessed: 0,
  accountsFailed: 0,
  due: 0,
  evaluated: 0,
  failed: 0,
  selectedBacklogDueCount: 0,
  selectedBacklogDueCountCapped: false,
  oldestSelectedBacklogAgeSeconds: 0,
  oldestSelectedBacklogAgeCapped: false,
  deadlineExhausted: false,
};

const emptyPausedBacklog = {
  dueAccounts: 0,
  dueWindows: 0,
  dueAccountsCapped: false,
  dueWindowsCapped: false,
};

function hasAuthorizedCronHeader(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const log = createServerLogger("api.monitoring.cron");
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    log.error("monitoring.run.unconfigured", { status: 503 });
    return Response.json(
      { ok: false, error: "Scheduled monitoring is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!hasAuthorizedCronHeader(request, secret)) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const releaseStage = resolveReleaseStage();
    const providerMonitoringPaused = releaseStage === "demo";
    let monitoringUnavailable = false;
    let approvalStoreReady = false;
    let tenancyStoreReady = false;
    let credentialStoreReady = false;
    let summary = emptyMonitoringSummary;
    let pausedBacklog = emptyPausedBacklog;
    try {
      const [approvalReady, tenancyReady, credentialReady] =
        await Promise.all([
          verifyApprovalStore(),
          verifyTenancyStore(),
          providerMonitoringPaused
            ? Promise.resolve(true)
            : verifyCredentialStore(),
        ]);
      approvalStoreReady = approvalReady;
      tenancyStoreReady = tenancyReady;
      credentialStoreReady = credentialReady;
    } catch (error) {
      log.error("monitoring.store_verification.unavailable", { error });
      monitoringUnavailable = true;
    }

    let maintenanceFailed = false;
    let maintenanceBacklog = false;
    let approvalOperationsRecovered = 0;
    let unresolvedApprovalOperations = 0;
    if (approvalStoreReady) {
      const approvalMaintenanceNow = new Date();
      try {
        const recovery = await recoverStaleApprovalOperations({
          now: approvalMaintenanceNow,
          limit: APPROVAL_RECOVERY_LIMIT,
        });
        approvalOperationsRecovered = recovery.recovered;
        maintenanceBacklog ||= recovery.backlog;
      } catch (error) {
        log.error("monitoring.approval_recovery.failed", { error });
        maintenanceFailed = true;
      }
      try {
        unresolvedApprovalOperations =
          await countUnresolvedApprovalOperations({
            now: approvalMaintenanceNow,
          });
      } catch (error) {
        log.error("monitoring.approval_ledger.failed", { error });
        maintenanceFailed = true;
      }
    }
    if (isReadinessRateLimitConfigured()) {
      try {
        const pruned = await pruneExpiredReadinessRateLimitBuckets(
          new Date(),
          RATE_LIMIT_CLEANUP_LIMIT,
        );
        maintenanceBacklog ||= pruned === RATE_LIMIT_CLEANUP_LIMIT;
      } catch (error) {
        log.error("monitoring.readiness_cleanup.failed", { error });
        maintenanceFailed = true;
      }
    }
    const liveSyncStoreReady = await verifyLiveSyncStore().catch(() => false);
    if (!liveSyncStoreReady) {
      log.error("monitoring.snapshot_cleanup.unavailable");
      maintenanceFailed = true;
    } else {
      try {
        const pruned = await pruneExpiredLiveSyncSnapshots({
          now: new Date(),
          retentionMs: 24 * 60 * 60 * 1_000,
          limit: LIVE_SNAPSHOT_CLEANUP_LIMIT,
        });
        maintenanceBacklog ||= pruned === LIVE_SNAPSHOT_CLEANUP_LIMIT;
      } catch (error) {
        log.error("monitoring.snapshot_cleanup.failed", { error });
        maintenanceFailed = true;
      }
    }

    if (!monitoringUnavailable) {
      if (!approvalStoreReady || !tenancyStoreReady) {
        monitoringUnavailable = true;
      } else if (providerMonitoringPaused) {
        try {
          pausedBacklog = await summarizeDueMonitoringBacklog(new Date());
        } catch (error) {
          log.error("monitoring.paused_backlog.unavailable", { error });
          monitoringUnavailable = true;
        }
      } else if (
        releaseStage === "private_read" ||
        releaseStage === "live_write"
      ) {
        if (!credentialStoreReady) {
          monitoringUnavailable = true;
        } else {
          try {
            summary = await evaluateScheduledMonitoringWindows({
              maxAccounts: MONITORING_MAX_ACCOUNTS_PER_RUN,
              windowsPerAccount: MONITORING_WINDOWS_PER_ACCOUNT,
              deadlineAt: startedAt + MONITORING_PROVIDER_DEADLINE_MS,
            });
          } catch (error) {
            log.error("monitoring.evaluation.unavailable", { error });
            monitoringUnavailable = true;
          }
        }
      } else {
        monitoringUnavailable = true;
      }
    }
    const hasFailures =
      monitoringUnavailable ||
      summary.accountsFailed > 0 ||
      summary.failed > 0 ||
      summary.deadlineExhausted ||
      approvalOperationsRecovered > 0 ||
      unresolvedApprovalOperations > 0 ||
      maintenanceFailed ||
      maintenanceBacklog;
    const logFields = {
      status: hasFailures ? 503 : 200,
      durationMs: Date.now() - startedAt,
      counts: {
        accountsSelected: summary.accountsSelected,
        accountsProcessed: summary.accountsProcessed,
        accountsFailed: summary.accountsFailed,
        due: summary.due,
        evaluated: summary.evaluated,
        failed: summary.failed,
        pausedDueAccounts: pausedBacklog.dueAccounts,
        pausedDueWindows: pausedBacklog.dueWindows,
        approvalOperationsRecovered,
        unresolvedApprovalOperations,
      },
    };
    if (hasFailures) log.error("monitoring.run.completed_with_failures", logFields);
    else log.info("monitoring.run.completed", logFields);
    return Response.json(
      {
        ok: !hasFailures,
        releaseStage,
        providerMonitoringPaused,
        pausedBacklog,
        monitoringUnavailable,
        maintenanceFailed,
        maintenanceBacklog,
        approvalOperationsRecovered,
        unresolvedApprovalOperations,
        ...summary,
      },
      {
        status: hasFailures ? 503 : 200,
        headers: {
          "Cache-Control": "no-store",
          ...(hasFailures ? { "Retry-After": "300" } : {}),
        },
      },
    );
  } catch (error) {
    log.error("monitoring.run.failed", {
      error,
      status: 500,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(
      { ok: false, error: "Scheduled monitoring could not complete." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
