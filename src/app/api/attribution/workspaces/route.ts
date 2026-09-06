import { z } from "zod";
import { listOrganizationMemberships } from "@/lib/attribution/membership.server";
import {
  createWorkspace,
  identity,
  readWorkspace,
  sameOrigin,
  AttributionError,
} from "@/lib/attribution/store.server";
import { failure, jsonBody } from "@/lib/attribution/http.server";
export async function GET(request: Request) {
  try {
    const operator = await identity(request);
    const memberships = await listOrganizationMemberships(operator);
    const workspaces = [];
    for (const m of memberships) {
      try {
        const w = await readWorkspace(m.organizationId);
        workspaces.push({ id: w.id, name: w.name, role: m.membershipRole });
      } catch (error) {
        if (!(error instanceof AttributionError) || error.status !== 404)
          throw error;
      }
    }
    return Response.json(
      { workspaces },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return failure(e);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const { name, agency } = z
      .object({
        name: z.string().trim().min(2).max(100),
        agency: z.boolean().default(false),
      })
      .strict()
      .parse(await jsonBody(request));
    return Response.json(await createWorkspace(request, name, agency), {
      status: 201,
    });
  } catch (e) {
    return failure(e);
  }
}
