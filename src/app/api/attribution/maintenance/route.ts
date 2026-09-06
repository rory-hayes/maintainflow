import { z } from "zod";
import { AttributionError } from "@/lib/attribution/store.server";
import { failure } from "@/lib/attribution/http.server";
import {
  authorizeMaintenance,
  maintainWorkspace,
  maintenanceQueue,
  MAINTENANCE_LIMITS,
  runMaintenanceBatch,
} from "@/lib/attribution/maintenance.server";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

// Vercel Cron calls the production deployment with its CRON_SECRET bearer token.
export async function GET(request: Request) {
  try {
    authorizeMaintenance(request, process.env.CRON_SECRET);
    const result = await runMaintenanceBatch();
    return Response.json(result, { status: result.ok ? 200 : 207, headers });
  } catch (error) {
    return failure(error);
  }
}

// Explicit per-workspace operator run, using its independent maintenance secret.
export async function POST(request: Request) {
  try {
    authorizeMaintenance(request, process.env.MAINTAINCODE_MAINTENANCE_SECRET);
    const id = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("workspace"));
    const claim = await maintenanceQueue.claim(id);
    if (!claim)
      throw new AttributionError(
        409,
        "This workspace is already being maintained or is not registered. Check migration 025.",
      );
    try {
      const result = await maintainWorkspace(
        id,
        AbortSignal.timeout(MAINTENANCE_LIMITS.runBudgetMs),
      );
      const status =
        result.providers.some((provider) => provider.status === "failed") ||
        (result.notifications &&
          !["complete", "unavailable"].includes(result.notifications.status))
          ? "partial"
          : "complete";
      const finished = await maintenanceQueue.finish(claim, status);
      if (!finished)
        throw new AttributionError(
          409,
          "A newer maintenance run replaced this lease.",
        );
      return Response.json(result, {
        status: status === "complete" ? 200 : 207,
        headers,
      });
    } catch (error) {
      await maintenanceQueue.finish(claim, "failed");
      throw error;
    }
  } catch (error) {
    return failure(error);
  }
}
