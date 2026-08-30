import { timingSafeEqual } from "node:crypto";

import { verifyApprovalStore } from "@/lib/audit/approval-store.server";
import { evaluateScheduledMonitoringWindows } from "@/lib/openai-ads/monitoring-runner.server";
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
    const [approvalStoreReady, tenancyStoreReady, credentialStoreReady] =
      await Promise.all([
        verifyApprovalStore(),
        verifyTenancyStore(),
        verifyCredentialStore(),
      ]);
    if (!approvalStoreReady || !tenancyStoreReady || !credentialStoreReady) {
      return Response.json(
        {
          ok: false,
          error: "Scheduled monitoring storage is not ready.",
        },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }

    const summary = await evaluateScheduledMonitoringWindows();
    if (isReadinessRateLimitConfigured()) {
      try {
        await pruneExpiredReadinessRateLimitBuckets();
      } catch (error) {
        console.error("Readiness rate-limit cleanup failed", error);
      }
    }
    const hasFailures = summary.accountsFailed > 0 || summary.failed > 0;
    return Response.json(
      { ok: !hasFailures, ...summary },
      {
        status: hasFailures ? 207 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error("Scheduled monitoring run failed", error);
    return Response.json(
      { ok: false, error: "Scheduled monitoring could not complete." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
