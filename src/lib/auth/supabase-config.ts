export function isSupabaseConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function supabasePublicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error("Customer authentication is not configured.");
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !key.startsWith("sb_publishable_")
  ) {
    throw new Error("Customer authentication configuration is invalid.");
  }
  return { url: parsed.origin, key };
}

// Auth destinations are deliberately limited to this product. No arbitrary
// redirect, protocol-relative URL, or legacy approval route is accepted.
export function safeSupabaseReturnTo(value: unknown) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/app") ||
    value.includes("\\")
  )
    return "/app?mode=live";
  try {
    const url = new URL(value, "https://maintaincode.invalid");
    if (
      url.origin !== "https://maintaincode.invalid" ||
      url.pathname !== "/app"
    )
      return "/app?mode=live";
    const clean = new URLSearchParams({ mode: "live" });
    for (const key of ["view", "workspace"]) {
      const value = url.searchParams.get(key);
      if (value && value.length <= 100) clean.set(key, value);
    }
    return `/app?${clean}`;
  } catch {
    return "/app?mode=live";
  }
}

export function safeAuthCallbackPath(value: unknown) {
  return value === "/auth/update-password"
    ? value
    : safeSupabaseReturnTo(value);
}

export function authErrorMessage(code?: string) {
  if (code === "email_not_confirmed")
    return "Confirm your email before signing in. You can request a new confirmation below.";
  if (code === "invalid_credentials")
    return "Email or password is incorrect. Try again or reset your password.";
  if (code === "weak_password")
    return "Choose a stronger password with at least 12 characters.";
  if (code === "same_password")
    return "Choose a password different from your current password.";
  if (
    code?.includes("rate_limit") ||
    code === "over_email_send_rate_limit" ||
    code === "over_request_rate_limit"
  )
    return "Too many requests. Wait a few minutes, then try again.";
  return "We could not complete this request. Please try again. If it continues, contact support.";
}
