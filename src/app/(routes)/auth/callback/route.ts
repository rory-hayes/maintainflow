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
  const code = url.searchParams.get("code");
  let destination = "/auth/sign-in?error=confirmation";
  if (code && code.length <= 2048) {
    try {
      const client = await createSupabaseServerClient(true);
      const { error } = await client.auth.exchangeCodeForSession(code);
      if (!error)
        destination = safeAuthCallbackPath(url.searchParams.get("next"));
    } catch {
      /* No session is inferred from an unsuccessful code exchange. */
    }
  }
  const response = NextResponse.redirect(new URL(destination, origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
