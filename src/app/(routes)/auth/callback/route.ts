import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth/supabase.server";
import { safeAuthCallbackPath } from "@/lib/auth/supabase-config";

export async function GET(request: Request) {
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
  const response = NextResponse.redirect(new URL(destination, url.origin), 303);
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}
