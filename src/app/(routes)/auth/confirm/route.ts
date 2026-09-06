import { NextResponse } from "next/server";
import { applicationOrigin } from "@/lib/application-origin.server";
import { createSupabaseServerClient } from "@/lib/auth/supabase.server";
import { safeAuthCallbackPath } from "@/lib/auth/supabase-config";

export async function GET(request: Request) {
  let origin: string;
  try {
    origin = applicationOrigin(request);
  } catch {
    return new Response("Customer sign-in is not available yet.", {
      status: 503,
      headers: {
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
      },
    });
  }
  const url = new URL(request.url);
  const token_hash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");
  let destination = "/auth/sign-in?error=confirmation";
  if (
    token_hash &&
    token_hash.length <= 2048 &&
    (type === "email" || type === "signup" || type === "recovery")
  ) {
    try {
      const client = await createSupabaseServerClient(true);
      const { error } = await client.auth.verifyOtp({ token_hash, type });
      if (!error)
        destination =
          type === "recovery"
            ? "/auth/update-password"
            : safeAuthCallbackPath(url.searchParams.get("next"));
    } catch {
      /* Expired/invalid links return to a recoverable screen. */
    }
  }
  const response = NextResponse.redirect(new URL(destination, origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
