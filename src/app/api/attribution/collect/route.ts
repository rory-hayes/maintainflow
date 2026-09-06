import { z } from "zod";
import {
  evidenceSchema,
  upsertSubmission,
  captureAllowance,
  normalizeEvidence,
} from "@/lib/attribution/model";
import {
  AttributionError,
  mutateWorkspace,
  siteOwner,
} from "@/lib/attribution/store.server";
import { failure, jsonBody } from "@/lib/attribution/http.server";
const payload = z
  .object({
    id: z.string().uuid(),
    siteId: z.string().uuid(),
    formId: z.string().min(1).max(200),
    at: z.string().datetime(),
    evidence: evidenceSchema,
    test: z.boolean(),
    status: z.enum(["attempted", "confirmed"]),
  })
  .strict();
export async function OPTIONS(request: Request) {
  const origin = request.headers.get("origin");
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": origin ?? "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600",
      Vary: "Origin",
    },
  });
}
export async function POST(request: Request) {
  let origin = "";
  try {
    const data = payload.parse(await jsonBody(request, 16000));
    const owner = await siteOwner(data.siteId);
    origin = owner.origin;
    if (request.headers.get("origin") !== origin)
      throw new AttributionError(403, "Origin does not match this website.");
    const now = Date.now();
    if (
      Math.abs(Date.parse(data.at) - now) > 86400000 ||
      Date.parse(data.evidence.first.at) > now + 60000 ||
      Date.parse(data.evidence.latest.at) > now + 60000 ||
      Date.parse(data.evidence.expiresAt) <= now
    )
      throw new AttributionError(
        400,
        "Capture timestamp is outside the supported window.",
      );
    await mutateWorkspace(owner.organizationId, (w) => {
      const site = w.sites.find((s) => s.id === data.siteId);
      if (!site || site.paused)
        throw new AttributionError(409, "Tracking is paused.");
      if (
        w.submissions.length >= 10000 &&
        !w.submissions.some((s) => s.id === data.id)
      )
        throw new AttributionError(
          429,
          "Capture storage is full. Your business form can still submit.",
        );
      try {
        data.evidence = normalizeEvidence(data.evidence, site);
        if (
          Date.parse(data.evidence.expiresAt) <= now ||
          Date.parse(data.evidence.latest.at) > Date.parse(data.at) + 60000
        )
          throw new Error("Expired capture.");
      } catch {
        throw new AttributionError(
          400,
          "Capture evidence does not match the website or retention window.",
        );
      }
      const restriction = captureAllowance(w, data.id, data.test);
      if (restriction) throw new AttributionError(429, restriction);
      site.installedAt = new Date().toISOString();
      upsertSubmission(w, {
        ...data,
        confirmation:
          data.status === "confirmed" ? "browser_success" : undefined,
      });
    });
    return Response.json(
      { received: true },
      {
        status: 202,
        headers: {
          "Access-Control-Allow-Origin": origin,
          Vary: "Origin",
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (e) {
    const response = failure(e);
    if (origin) response.headers.set("Access-Control-Allow-Origin", origin);
    return response;
  }
}
