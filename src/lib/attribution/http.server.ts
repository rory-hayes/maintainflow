import { ZodError } from "zod";
import { AttributionError } from "./store.server";
export async function jsonBody(request: Request, max = 600000) {
  const body = await request.text();
  if (body.length > max)
    throw new AttributionError(413, "Request is too large.");
  try {
    return JSON.parse(body);
  } catch {
    throw new AttributionError(400, "Invalid JSON request.");
  }
}
export function failure(error: unknown) {
  const status =
    error instanceof AttributionError
      ? error.status
      : error instanceof ZodError
        ? 400
        : error instanceof Error && /Unauthorized/.test(error.name)
          ? 401
          : 503;
  const message =
    error instanceof AttributionError
      ? error.message
      : error instanceof ZodError
        ? error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ")
        : status === 401
          ? "Sign in to open your workspace."
          : "This operation is unavailable. Check authentication, database migrations and provider configuration, then retry.";
  return Response.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
