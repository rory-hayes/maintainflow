import { z } from "zod";
import { failure, jsonBody } from "@/lib/attribution/http.server";
import { readWorkspace, sameOrigin } from "@/lib/attribution/store.server";
import {
  notificationIdentity,
  notificationStatus,
  saveNotificationPreferences,
} from "@/lib/attribution/notifications.server";
const inputSchema = z
  .object({
    health: z.boolean(),
    weekly: z.boolean(),
    resume: z.boolean().optional(),
  })
  .strict();
type Context = { params: Promise<{ id: string }> };
const headers = { "Cache-Control": "private, no-store" };
export async function GET(request: Request, context: Context) {
  try {
    const id = z
      .string()
      .uuid()
      .parse((await context.params).id);
    const user = await notificationIdentity(request, id, false);
    return Response.json(notificationStatus(await readWorkspace(id), user), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    sameOrigin(request);
    const id = z
      .string()
      .uuid()
      .parse((await context.params).id);
    const input = inputSchema.parse(await jsonBody(request, 1000));
    // A downgraded member can still stop their own reports.
    const user = await notificationIdentity(
      request,
      id,
      input.health || input.weekly,
    );
    await saveNotificationPreferences(id, user, input, input.resume);
    return Response.json(notificationStatus(await readWorkspace(id), user), {
      headers,
    });
  } catch (error) {
    return failure(error);
  }
}
