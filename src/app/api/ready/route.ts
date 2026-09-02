import { timingSafeEqual } from "node:crypto";

import { verifyApprovalStore } from "@/lib/audit/approval-store.server";
import { verifyRecommendationDecisionStore } from "@/lib/audit/recommendation-decision-store.server";
import {
  verifyDatabaseMigrationLedger,
  verifyRuntimeDatabaseRole,
} from "@/lib/database/readiness.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import { verifyCreativeHistoryStore } from "@/lib/openai-ads/creative-history.server";
import { verifyLiveSyncStore } from "@/lib/openai-ads/live-sync-store.server";
import { verifyReadinessHistoryStore } from "@/lib/readiness/history.server";
import { verifyReadinessRateLimitStore } from "@/lib/readiness/rate-limit.server";
import { resolveBuildRevision } from "@/lib/release/revision";
import { resolveReleaseStage } from "@/lib/release/stage";
import {
  verifyConversionCredentialStore,
  verifyCredentialStore,
  verifyTenancyStore,
} from "@/lib/tenancy/store.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

type ReadinessCheck = readonly [string, () => Promise<boolean>];

function hasAuthorizedProbeHeader(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function dependencyChecks(stage: string): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    ["database_runtime_role", verifyRuntimeDatabaseRole],
    [
      "database_migrations",
      async () => (await verifyDatabaseMigrationLedger()).ready,
    ],
    ["readiness_quota", verifyReadinessRateLimitStore],
    ["live_sync", verifyLiveSyncStore],
  ];

  if (stage !== "demo") {
    checks.push(
      ["tenancy", verifyTenancyStore],
      ["ads_credentials", verifyCredentialStore],
      ["conversion_credentials", verifyConversionCredentialStore],
      ["approvals_and_monitoring", verifyApprovalStore],
      ["recommendation_decisions", verifyRecommendationDecisionStore],
      ["creative_history", verifyCreativeHistoryStore],
      ["readiness_history", verifyReadinessHistoryStore],
    );
  }

  return checks;
}

async function runCheck([name, check]: ReadinessCheck) {
  try {
    return { name, ready: (await check()) === true };
  } catch {
    return { name, ready: false };
  }
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const log = createServerLogger("api.deployment.ready");
  const secret = process.env.MAINTAINFLOW_READINESS_PROBE_SECRET;
  if (!secret || secret.length < 32) {
    log.error("deployment.readiness.unconfigured", {
      status: 503,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(
      {
        ok: false,
        service: "maintainflow-ads",
        scope: "deployment_readiness",
        error: "Deployment readiness is not configured.",
      },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }
  if (!hasAuthorizedProbeHeader(request, secret)) {
    return Response.json(
      {
        ok: false,
        service: "maintainflow-ads",
        scope: "deployment_readiness",
        error: "Unauthorized.",
      },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }

  const stage = resolveReleaseStage();
  const revision = resolveBuildRevision();
  const results = await Promise.all(
    dependencyChecks(stage).map((check) => runCheck(check)),
  );
  const failedChecks = results
    .filter((result) => !result.ready)
    .map((result) => result.name);
  if (!revision) failedChecks.unshift("build_revision");
  if (stage === "invalid") failedChecks.unshift("release_stage");

  const ok = failedChecks.length === 0;
  const passed =
    results.filter((result) => result.ready).length +
    (revision ? 1 : 0) +
    (stage === "invalid" ? 0 : 1);
  const total = results.length + 2;
  const logFields = {
    status: ok ? 200 : 503,
    durationMs: Date.now() - startedAt,
    failedChecks,
    counts: { checksPassed: passed, checksTotal: total },
  };
  if (ok) log.info("deployment.readiness.completed", logFields);
  else log.error("deployment.readiness.failed", logFields);

  return Response.json(
    {
      ok,
      service: "maintainflow-ads",
      scope: "deployment_readiness",
      stage,
      revision: revision ?? "unknown",
      checks: {
        passed,
        total,
      },
    },
    {
      status: ok ? 200 : 503,
      headers: {
        ...NO_STORE_HEADERS,
        ...(ok ? {} : { "Retry-After": "30" }),
      },
    },
  );
}
