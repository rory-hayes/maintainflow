import { timingSafeEqual } from "node:crypto";

import type { Sql } from "postgres";

import { verifyApprovalStore } from "@/lib/audit/approval-store.server";
import { verifyRecommendationDecisionStore } from "@/lib/audit/recommendation-decision-store.server";
import {
  type RuntimeDatabaseTransactionDiagnostic,
  verifyDatabaseMigrationLedger,
  verifyRuntimeDatabaseRole,
  verifyRuntimeDatabaseTransaction,
} from "@/lib/database/readiness.server";
import { createReadinessDatabase } from "@/lib/database/client.server";
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
export const maxDuration = 15;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const DEPENDENCY_CHECK_TIMEOUT_MS = 10_000;
const DEPENDENCY_TIMEOUT = Symbol("dependency_timeout");

type ReadinessCheck = readonly [string, () => Promise<boolean>];
type ReadinessDiagnostics = {
  databaseTransaction?: RuntimeDatabaseTransactionDiagnostic;
};

function hasAuthorizedProbeHeader(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function dependencyChecks(
  stage: string,
  diagnostics: ReadinessDiagnostics,
  database?: Sql,
): ReadinessCheck[] {
  const unavailable = async () => false;
  const checks: ReadinessCheck[] = [
    [
      "database_runtime_role",
      database ? () => verifyRuntimeDatabaseRole(database) : unavailable,
    ],
    [
      "database_transaction",
      database
        ? () =>
            verifyRuntimeDatabaseTransaction(database, (diagnostic) => {
              diagnostics.databaseTransaction = diagnostic;
            })
        : unavailable,
    ],
    [
      "database_migrations",
      database
        ? async () => (await verifyDatabaseMigrationLedger(database)).ready
        : unavailable,
    ],
    [
      "readiness_quota",
      database
        ? () => verifyReadinessRateLimitStore(database)
        : unavailable,
    ],
    [
      "live_sync",
      database ? () => verifyLiveSyncStore(database) : unavailable,
    ],
  ];

  if (stage !== "demo") {
    checks.push(
      ["tenancy", database ? () => verifyTenancyStore(database) : unavailable],
      [
        "ads_credentials",
        database ? () => verifyCredentialStore(database) : unavailable,
      ],
      [
        "conversion_credentials",
        database
          ? () => verifyConversionCredentialStore(database)
          : unavailable,
      ],
      [
        "approvals_and_monitoring",
        database ? () => verifyApprovalStore(database) : unavailable,
      ],
      [
        "recommendation_decisions",
        database
          ? () => verifyRecommendationDecisionStore(database)
          : unavailable,
      ],
      [
        "creative_history",
        database ? () => verifyCreativeHistoryStore(database) : unavailable,
      ],
      [
        "readiness_history",
        database ? () => verifyReadinessHistoryStore(database) : unavailable,
      ],
    );
  }

  return checks;
}

async function runCheck([name, check]: ReadinessCheck) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(check),
      new Promise<typeof DEPENDENCY_TIMEOUT>((resolve) => {
        timeout = setTimeout(
          () => resolve(DEPENDENCY_TIMEOUT),
          DEPENDENCY_CHECK_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      name,
      ready: outcome === true,
      timedOut: outcome === DEPENDENCY_TIMEOUT,
    };
  } catch {
    return { name, ready: false, timedOut: false };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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
  let database: Sql | undefined;
  try {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString) {
      database = createReadinessDatabase(connectionString);
    }
  } catch {
    database = undefined;
  }

  const diagnostics: ReadinessDiagnostics = {};
  const results = await Promise.all(
    dependencyChecks(stage, diagnostics, database).map((check) => runCheck(check)),
  );
  const timedOutChecks = results
    .filter((result) => result.timedOut)
    .map((result) => result.name);
  if (database) {
    // Readiness owns this pool. Destroy it immediately after a timeout so the
    // losing query cannot retain a slot, without touching customer traffic.
    await database
      .end({ timeout: timedOutChecks.length > 0 ? 0 : 1 })
      .catch(() => undefined);
  }
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
    timedOutChecks,
    counts: { checksPassed: passed, checksTotal: total },
    diagnosticCode: diagnostics.databaseTransaction?.code,
    databaseErrorCode: diagnostics.databaseTransaction?.databaseErrorCode,
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
