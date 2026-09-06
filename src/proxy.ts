import { clerkMiddleware } from "@clerk/nextjs/server";
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";

import { isClerkConfigured } from "@/lib/auth/config";
import { isSupabaseConfigured } from "@/lib/auth/supabase-config";
import { refreshSupabaseSession } from "@/lib/auth/supabase-proxy";

const configuredClerkMiddleware = isClerkConfigured()
  ? clerkMiddleware()
  : null;

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  // The repurposed product exposes attribution APIs only. Legacy operations
  // remain as reusable, tested modules but cannot mutate advertiser campaigns.
  if (
    request.nextUrl.pathname.startsWith("/api/") &&
    !request.nextUrl.pathname.startsWith("/api/attribution/") &&
    !["/api/health", "/api/health/ready"].includes(request.nextUrl.pathname)
  ) {
    return NextResponse.json(
      {
        error:
          "This legacy ad-operations endpoint is retired in MaintainCode Ads.",
      },
      { status: 410 },
    );
  }
  if (
    isSupabaseConfigured() &&
    (request.nextUrl.pathname === "/app" ||
      request.nextUrl.pathname.startsWith("/auth/") ||
      request.nextUrl.pathname.startsWith("/api/attribution/workspaces") ||
      request.nextUrl.pathname === "/api/attribution/billing")
  )
    return refreshSupabaseSession(request);
  if (!configuredClerkMiddleware) return NextResponse.next();
  return configuredClerkMiddleware(request, event);
}

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
