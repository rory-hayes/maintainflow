"use client";
import { useState } from "react";
import Link from "next/link";
import { safeSupabaseReturnTo } from "@/lib/auth/supabase-config";

type Mode = "sign-in" | "sign-up" | "recover" | "resend" | "update-password";
const copy: Record<Mode, { title: string; body: string; button: string }> = {
  "sign-in": {
    title: "Welcome back.",
    body: "Sign in to your marketing attribution workspace.",
    button: "Sign in",
  },
  "sign-up": {
    title: "Follow the enquiry through to the sale.",
    body: "Create your account, connect your website and verify your first lead.",
    button: "Create account",
  },
  recover: {
    title: "Reset your password.",
    body: "We will send a secure recovery link to your account email.",
    button: "Send reset link",
  },
  resend: {
    title: "Confirm your email.",
    body: "Request a fresh link if the first one expired or did not arrive.",
    button: "Send confirmation link",
  },
  "update-password": {
    title: "Choose a new password.",
    body: "Use at least 12 characters that you do not use for another account.",
    button: "Update password",
  },
};
export function SupabaseAuthForm({
  mode,
  signUpEnabled = false,
  next,
  initialError = "",
  initialNotice = "",
}: {
  mode: Mode;
  signUpEnabled?: boolean;
  next?: string;
  initialError?: string;
  initialNotice?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState(initialNotice);
  const newPassword = mode === "sign-up" || mode === "update-password";
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError("");
    setMessage("");
    if (newPassword && data.get("password") !== data.get("confirmPassword")) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    try {
      const body: Record<string, unknown> = { action: mode };
      if (mode !== "update-password") body.email = data.get("email");
      if (newPassword || mode === "sign-in")
        body.password = data.get("password");
      if (mode === "sign-up" || mode === "sign-in")
        body.next = safeSupabaseReturnTo(next);
      const response = await fetch("/auth/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Please try again.");
      if (result.redirect) {
        window.location.assign(result.redirect);
        return;
      }
      setMessage(result.message);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name !== "TimeoutError"
          ? cause.message
          : "The request timed out. Please try again.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <main className="grid min-h-[calc(100vh-5rem)] place-items-center bg-[#fafbfa] px-5 py-12">
      <section className="w-full max-w-md rounded-2xl border border-[#dfe7e1] bg-white p-7 shadow-sm sm:p-9">
        <h1 className="text-3xl font-semibold leading-tight tracking-tight text-[#18382b]">
          {copy[mode].title}
        </h1>
        <p className="mb-7 mt-3 text-sm leading-6 text-[#5a6860]">
          {copy[mode].body}
        </p>
        <form onSubmit={submit}>
          <fieldset
            disabled={pending}
            className="grid gap-5 disabled:opacity-60"
          >
            {mode !== "update-password" && (
              <label className="grid gap-2 text-sm font-medium">
                Email address
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  maxLength={254}
                  className="min-h-11 rounded-lg border border-[#c9d5cd] px-3 outline-none focus:border-[#215e45] focus:ring-2 focus:ring-[#dcefe3]"
                />
              </label>
            )}
            {(newPassword || mode === "sign-in") && (
              <label className="grid gap-2 text-sm font-medium">
                {newPassword ? "New password" : "Password"}
                <input
                  name="password"
                  type="password"
                  required
                  minLength={newPassword ? 12 : 1}
                  maxLength={128}
                  autoComplete={
                    newPassword ? "new-password" : "current-password"
                  }
                  className="min-h-11 rounded-lg border border-[#c9d5cd] px-3 outline-none focus:border-[#215e45] focus:ring-2 focus:ring-[#dcefe3]"
                />
              </label>
            )}
            {newPassword && (
              <label className="grid gap-2 text-sm font-medium">
                Confirm password
                <input
                  name="confirmPassword"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete="new-password"
                  className="min-h-11 rounded-lg border border-[#c9d5cd] px-3 outline-none focus:border-[#215e45] focus:ring-2 focus:ring-[#dcefe3]"
                />
              </label>
            )}
            {mode === "sign-up" && (
              <label className="flex items-start gap-3 text-sm leading-6">
                <input type="checkbox" required className="mt-1.5" />
                <span>
                  I agree to the{" "}
                  <Link href="/terms" className="underline">
                    terms
                  </Link>{" "}
                  and have read the{" "}
                  <Link href="/privacy" className="underline">
                    privacy notice
                  </Link>
                  .
                </span>
              </label>
            )}
            <button className="min-h-11 rounded-lg bg-[#245a43] px-4 py-3 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-[#245a43] focus-visible:ring-offset-2">
              {pending ? "Please wait…" : copy[mode].button}
            </button>
          </fieldset>
        </form>
        {error && (
          <p
            role="alert"
            className="mt-5 rounded-lg bg-red-50 p-3 text-sm leading-6 text-red-800"
          >
            {error}
          </p>
        )}
        {message && (
          <p
            role="status"
            className="mt-5 rounded-lg bg-emerald-50 p-3 text-sm leading-6 text-emerald-900"
          >
            {message}
          </p>
        )}
        <div className="mt-6 flex flex-wrap gap-x-5 gap-y-3 text-sm text-[#245a43]">
          {mode !== "sign-in" && (
            <Link href="/auth/sign-in" className="underline">
              Back to sign in
            </Link>
          )}
          {mode === "sign-in" && signUpEnabled && (
            <Link href="/auth/sign-up" className="underline">
              Create an account
            </Link>
          )}
          {mode !== "recover" && (
            <Link href="/auth/recover" className="underline">
              Reset password
            </Link>
          )}
          {(mode === "sign-in" || mode === "sign-up") && (
            <Link href="/auth/resend" className="underline">
              Resend confirmation
            </Link>
          )}
          {mode === "update-password" && message && (
            <Link href="/app?mode=live" className="underline">
              Open workspace
            </Link>
          )}
        </div>
      </section>
    </main>
  );
}

export function CustomerSignOut() {
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <button
        disabled={pending}
        className="mc-link"
        onClick={async () => {
          setPending(true);
          setError("");
          try {
            const response = await fetch("/auth/action", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "sign-out" }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error);
            window.location.assign(result.redirect);
          } catch {
            setError("Could not sign out. Please try again.");
            setPending(false);
          }
        }}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
