import { timingSafeEqual } from "node:crypto";

import { verifyApprovalStore } from "@/lib/audit/approval-store.server";
import { verifyRecommendationDecisionStore } from "@/lib/audit/recommendation-decision-store.server";
import { verifyDatabaseMigrationLedger } from "@/lib/database/readiness.server";
import { verifyCreativeHistoryStore } from "@/lib/openai-ads/creative-history.server";
import { verifyLiveSyncStore } from "@/lib/openai-ads/live-sync-store.server";
import { verifyReadinessHistoryStore } from "@/lib/readiness/history.server";
import { verifyReadinessRateLimitStore } from "@/lib/readiness/rate-limit.server";
import { resolveBuildRevision } from "@/lib/release/revision";
import {
  verifyConversionCredentialStore,
  verifyCredentialStore,
  verifyTenancyStore,
} from "@/lib/tenancy/store.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const RELEASE_STAGES = new Set(["demo", "private_read", "live_write"]);

type ReadinessCheck = readonly [string, () => Promise<boolean>];

function hasAuthorizedProbeHeader(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

function releaseStage() {
  const configured = process.env.MAINTAINFLOW_RELEASE_STAGE ?? "demo";
  return RELEASE_STAGES.has(configured) ? configured : "invalid";
}

function dependencyChecks(stage: string): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
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
  const secret = process.env.MAINTAINFLOW_READINESS_PROBE_SECRET;
  if (!secret || secret.length < 32) {
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

  const stage = releaseStage();
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
  if (!ok) {
    console.error("Deployment readiness checks failed", {
      stage,
      failedChecks,
    });
  }

  return Response.json(
    {
      ok,
      service: "maintainflow-ads",
      scope: "deployment_readiness",
      stage,
      revision: revision ?? "unknown",
      checks: {
        passed:
          results.filter((result) => result.ready).length +
          (revision ? 1 : 0) +
          (stage === "invalid" ? 0 : 1),
        total: results.length + 2,
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
