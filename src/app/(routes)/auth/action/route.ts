import { z } from "zod";
import { createSupabaseServerClient } from "@/lib/auth/supabase.server";
import {
  authErrorMessage,
  isSupabaseConfigured,
  safeSupabaseReturnTo,
} from "@/lib/auth/supabase-config";
import {
  isPublicSignUpEnabled,
  getWorkspaceAdmissionMode,
} from "@/lib/auth/config";

const email = z.string().trim().email().max(254);
const password = z.string().min(12).max(128);
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("sign-in"),
      email,
      password: z.string().min(1).max(128),
      next: z.string().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("sign-up"),
      email,
      password,
      next: z.string().optional(),
    })
    .strict(),
  z.object({ action: z.literal("recover"), email }).strict(),
  z.object({ action: z.literal("resend"), email }).strict(),
  z.object({ action: z.literal("update-password"), password }).strict(),
  z.object({ action: z.literal("sign-out") }).strict(),
]);
function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return json(
      { error: "Open this form from your workspace to continue." },
      403,
    );
  if (!isSupabaseConfigured() || getWorkspaceAdmissionMode() !== "open")
    return json(
      {
        error: "Customer sign-in is not available yet. Please try again later.",
      },
      503,
    );
  try {
    const body = await request.text();
    if (body.length > 8000)
      return json({ error: "This request is too large." }, 413);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return json({ error: "The request is invalid. Please try again." }, 400);
    }
    const parsed = schema.safeParse(decoded);
    if (!parsed.success)
      return json(
        {
          error:
            "Enter a valid email address and use at least 12 characters for a new password.",
        },
        400,
      );
    const input = parsed.data;
    const client = await createSupabaseServerClient(true);
    const origin =
      process.env.MAINTAINCODE_APP_ORIGIN || new URL(request.url).origin;
    const callback = new URL("/auth/callback", origin);
    if (input.action === "sign-in") {
      const { error } = await client.auth.signInWithPassword({
        email: input.email,
        password: input.password,
      });
      if (error) return json({ error: authErrorMessage(error.code) }, 400);
      return json({ redirect: safeSupabaseReturnTo(input.next) });
    }
    if (input.action === "sign-up") {
      if (!isPublicSignUpEnabled())
        return json({ error: "New registration is not available yet." }, 403);
      callback.searchParams.set("next", safeSupabaseReturnTo(input.next));
      const { data, error } = await client.auth.signUp({
        email: input.email,
        password: input.password,
        options: { emailRedirectTo: callback.toString() },
      });
      if (error) return json({ error: authErrorMessage(error.code) }, 400);
      return data.session
        ? json({ redirect: safeSupabaseReturnTo(input.next) })
        : json({
            message:
              "Check your email to confirm your account. If you already have an account, sign in or reset your password.",
          });
    }
    if (input.action === "recover") {
      callback.searchParams.set("next", "/auth/update-password");
      const { error } = await client.auth.resetPasswordForEmail(input.email, {
        redirectTo: callback.toString(),
      });
      if (error) return json({ error: authErrorMessage(error.code) }, 400);
      return json({
        message:
          "If an account uses this email, a password reset link is on its way. Check your inbox and spam folder.",
      });
    }
    if (input.action === "resend") {
      const { error } = await client.auth.resend({
        type: "signup",
        email: input.email,
        options: { emailRedirectTo: callback.toString() },
      });
      if (error) return json({ error: authErrorMessage(error.code) }, 400);
      return json({
        message:
          "If this account needs confirmation, a new link is on its way. Check your inbox and spam folder.",
      });
    }
    if (input.action === "update-password") {
      const { data, error: identityError } = await client.auth.getUser();
      if (identityError || !data.user)
        return json(
          {
            error:
              "Your reset session has expired. Request a new password reset link.",
          },
          401,
        );
      const { error } = await client.auth.updateUser({
        password: input.password,
      });
      if (error) return json({ error: authErrorMessage(error.code) }, 400);
      return json({
        message:
          "Your password has been updated. You can now open your workspace.",
      });
    }
    const { error } = await client.auth.signOut({ scope: "local" });
    if (error)
      return json({ error: "Could not sign out. Please try again." }, 503);
    return json({ redirect: "/auth/sign-in?notice=signed-out" });
  } catch {
    return json(
      { error: "We could not complete this request. Please try again." },
      503,
    );
  }
}
