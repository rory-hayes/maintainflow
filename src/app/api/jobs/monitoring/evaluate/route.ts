import { timingSafeEqual } from "node:crypto";

import { verifyApprovalStore } from "@/lib/audit/approval-store.server";
import { evaluateScheduledMonitoringWindows } from "@/lib/openai-ads/monitoring-runner.server";
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

const emptyMonitoringSummary = {
  accountsSelected: 0,
  accountsProcessed: 0,
  accountsFailed: 0,
  due: 0,
  evaluated: 0,
  failed: 0,
};

function hasAuthorizedCronHeader(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
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
    let monitoringUnavailable = false;
    let summary = emptyMonitoringSummary;
    try {
      const [approvalStoreReady, tenancyStoreReady, credentialStoreReady] =
        await Promise.all([
          verifyApprovalStore(),
          verifyTenancyStore(),
          verifyCredentialStore(),
        ]);
      if (
        !approvalStoreReady ||
        !tenancyStoreReady ||
        !credentialStoreReady
      ) {
        monitoringUnavailable = true;
      } else {
        summary = await evaluateScheduledMonitoringWindows();
      }
    } catch {
      console.error("Scheduled monitoring evaluation unavailable");
      monitoringUnavailable = true;
    }

    let maintenanceFailed = false;
    let maintenanceBacklog = false;
    if (isReadinessRateLimitConfigured()) {
      try {
        const pruned = await pruneExpiredReadinessRateLimitBuckets(
          new Date(),
          RATE_LIMIT_CLEANUP_LIMIT,
        );
        maintenanceBacklog ||= pruned === RATE_LIMIT_CLEANUP_LIMIT;
      } catch {
        console.error("Readiness rate-limit cleanup failed");
        maintenanceFailed = true;
      }
    }
    const liveSyncStoreReady = await verifyLiveSyncStore().catch(() => false);
    if (!liveSyncStoreReady) {
      console.error("Live snapshot storage is not ready for cleanup");
      maintenanceFailed = true;
    } else {
      try {
        const pruned = await pruneExpiredLiveSyncSnapshots({
          now: new Date(),
          retentionMs: 24 * 60 * 60 * 1_000,
          limit: LIVE_SNAPSHOT_CLEANUP_LIMIT,
        });
        maintenanceBacklog ||= pruned === LIVE_SNAPSHOT_CLEANUP_LIMIT;
      } catch {
        console.error("Live snapshot cleanup failed");
        maintenanceFailed = true;
      }
    }
    const hasFailures =
      monitoringUnavailable ||
      summary.accountsFailed > 0 ||
      summary.failed > 0 ||
      maintenanceFailed ||
      maintenanceBacklog;
    if (hasFailures) {
      console.error("Scheduled monitoring completed with failures", {
        accountsSelected: summary.accountsSelected,
        accountsProcessed: summary.accountsProcessed,
        accountsFailed: summary.accountsFailed,
        due: summary.due,
        evaluated: summary.evaluated,
        failed: summary.failed,
      });
    }
    return Response.json(
      {
        ok: !hasFailures,
        monitoringUnavailable,
        maintenanceFailed,
        maintenanceBacklog,
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
  } catch {
    console.error("Scheduled monitoring run failed");
    return Response.json(
      { ok: false, error: "Scheduled monitoring could not complete." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
