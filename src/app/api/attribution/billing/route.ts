import { z } from "zod";
import { authorize, sameOrigin } from "@/lib/attribution/store.server";
import { billingSession } from "@/lib/attribution/billing.server";
import { failure, jsonBody } from "@/lib/attribution/http.server";
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const data = z
      .object({
        workspaceId: z.string().uuid(),
        action: z.enum(["checkout", "portal"]),
        plan: z.enum(["starter", "agency"]).default("starter"),
        interval: z.enum(["month", "year"]).default("month"),
      })
      .parse(await jsonBody(request));
    const access = await authorize(request, data.workspaceId, true);
    if (access.membershipRole !== "owner")
      return Response.json(
        { error: "Only a workspace owner can manage billing." },
        { status: 403 },
      );
    const session = await billingSession(
      data.workspaceId,
      data.action,
      data.plan,
      data.interval,
    );
    return Response.json({ url: session.url });
  } catch (e) {
    return failure(e);
  }
}
