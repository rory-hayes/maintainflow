import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AttributionError,
  mutateWorkspace,
  readWorkspace,
} from "@/lib/attribution/store.server";
import { pruneExpired } from "@/lib/attribution/model";
import { syncWorkspaceProvider } from "@/lib/attribution/sync.server";
import { failure } from "@/lib/attribution/http.server";
export const maxDuration = 300;
// Host-scheduled, per-workspace maintenance. The key is server-only; this is never
// invoked automatically by the customer's browser or a normal Ads connection.
export async function POST(request: Request) {
  try {
    const secret = process.env.MAINTAINCODE_MAINTENANCE_SECRET;
    if (!secret || secret.length < 32)
      throw new AttributionError(
        503,
        "Scheduled maintenance is not configured.",
      );
    const expected = Buffer.from(`Bearer ${secret}`),
      supplied = Buffer.from(request.headers.get("authorization") ?? "");
    if (
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      throw new AttributionError(401, "Unauthorized maintenance request.");
    const id = z
      .string()
      .uuid()
      .parse(new URL(request.url).searchParams.get("workspace"));
    await mutateWorkspace(id, (w) => pruneExpired(w));
    const state = await readWorkspace(id);
    const results = [];
    for (const c of state.connectors.filter((c) => c.status !== "revoked")) {
      try {
        await syncWorkspaceProvider(id, {
          action: "sync",
          provider: c.provider,
        });
        results.push({ provider: c.provider, status: "synced" });
      } catch {
        results.push({
          provider: c.provider,
          status: "failed",
          message: "Previous snapshot preserved. Inspect tracking health.",
        });
      }
    }
    return Response.json(
      { retention: "applied", results },
      {
        status: results.some((r) => r.status === "failed") ? 207 : 200,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return failure(error);
  }
}
