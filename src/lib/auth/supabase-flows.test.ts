import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const testState = vi.hoisted(() => ({
  auth: {
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    resetPasswordForEmail: vi.fn(),
    resend: vi.fn(),
    getUser: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    verifyOtp: vi.fn(),
    exchangeCodeForSession: vi.fn(),
  },
  client: vi.fn(),
  publicSignUp: vi.fn(),
  admission: vi.fn(),
}));
vi.mock("./supabase.server", () => ({
  createSupabaseServerClient: testState.client,
}));
vi.mock("./config", () => ({
  isPublicSignUpEnabled: testState.publicSignUp,
  getWorkspaceAdmissionMode: testState.admission,
}));
import { POST } from "@/app/(routes)/auth/action/route";
import { GET as confirm } from "@/app/(routes)/auth/confirm/route";
import { GET as callback } from "@/app/(routes)/auth/callback/route";
import {
  safeSupabaseReturnTo,
  safeAuthCallbackPath,
  supabasePublicConfig,
} from "./supabase-config";
function request(body: unknown, origin = "https://maintainflow.io") {
  return new Request("https://maintainflow.io/auth/action", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://maintainflow.io");
  testState.client.mockResolvedValue({ auth: testState.auth });
  testState.publicSignUp.mockReturnValue(true);
  testState.admission.mockReturnValue("open");
  Object.values(testState.auth).forEach((fn) =>
    fn.mockResolvedValue({ data: {}, error: null }),
  );
});
afterEach(() => vi.unstubAllEnvs());

it("requires same-origin customer actions before invoking authentication", async () => {
  const result = await POST(
    request({ action: "sign-out" }, "https://different.example"),
  );
  expect(result.status).toBe(403);
  expect(testState.client).not.toHaveBeenCalled();
});
it("uses the configured public origin for proxied actions and recovery callbacks", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const result = await POST(
    new Request("http://localhost:3000/auth/action", {
      method: "POST",
      headers: {
        Origin: "https://maintainflow.io",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "recover",
        email: "customer@example.test",
      }),
    }),
  );
  expect(result.status).toBe(200);
  expect(testState.auth.resetPasswordForEmail).toHaveBeenCalledWith(
    "customer@example.test",
    {
      redirectTo:
        "https://maintainflow.io/auth/callback?next=%2Fauth%2Fupdate-password",
    },
  );
  for (const origin of [
    undefined,
    "http://localhost:3000",
    "https://other.example",
  ]) {
    const denied = await POST(
      new Request("http://localhost:3000/auth/action", {
        method: "POST",
        headers: {
          ...(origin ? { Origin: origin } : {}),
          "X-Forwarded-Host": "maintainflow.io",
        },
        body: JSON.stringify({ action: "sign-out" }),
      }),
    );
    expect(denied.status).toBe(403);
  }
  expect(testState.auth.signOut).not.toHaveBeenCalled();
});
it("redirects normalized callback/confirmation requests only to the configured public origin", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const exchanged = await callback(
    new Request(
      "http://localhost:3000/auth/callback?code=test-code&next=https://foreign.example",
    ),
  );
  expect(exchanged.headers.get("location")).toBe(
    "https://maintainflow.io/app?mode=live",
  );
  const verified = await confirm(
    new Request(
      "http://localhost:3000/auth/confirm?token_hash=test-hash&type=recovery",
    ),
  );
  expect(verified.headers.get("location")).toBe(
    "https://maintainflow.io/auth/update-password",
  );
});
it.each(["", "http://maintainflow.io", "https://maintainflow.io/path"])(
  "fails closed before provider actions when production origin is invalid: %s",
  async (origin) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINCODE_APP_ORIGIN", origin);
    expect((await POST(request({ action: "sign-out" }))).status).toBe(503);
    expect(
      (
        await callback(
          new Request("https://maintainflow.io/auth/callback?code=test-code"),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await confirm(
          new Request(
            "https://maintainflow.io/auth/confirm?token_hash=test-hash&type=email",
          ),
        )
      ).status,
    ).toBe(503);
    expect(testState.client).not.toHaveBeenCalled();
  },
);
it("only starts public registration when both release gates permit it", async () => {
  testState.publicSignUp.mockReturnValue(false);
  const result = await POST(
    request({
      action: "sign-up",
      email: "customer@example.test",
      password: "a-password-for-tests",
    }),
  );
  expect(result.status).toBe(403);
  expect(testState.auth.signUp).not.toHaveBeenCalled();
});
it("keeps an unconfirmed signup separate from an authenticated session", async () => {
  testState.auth.signUp.mockResolvedValue({
    data: { session: null },
    error: null,
  });
  const result = await POST(
    request({
      action: "sign-up",
      email: "customer@example.test",
      password: "a-password-for-tests",
      next: "https://different.example",
    }),
  );
  const body = await result.json();
  expect(body.redirect).toBeUndefined();
  expect(body.message).toContain("confirm your account");
  expect(testState.auth.signUp.mock.calls[0][0].options.emailRedirectTo).toBe(
    "https://maintainflow.io/auth/callback?next=%2Fapp%3Fmode%3Dlive",
  );
});
it("returns no auth token and sanitizes the post-login destination", async () => {
  testState.auth.signInWithPassword.mockResolvedValue({
    data: { session: { access_token: "never-return-me" } },
    error: null,
  });
  const result = await POST(
    request({
      action: "sign-in",
      email: "customer@example.test",
      password: "test",
      next: "/app?workspace=client-a&view=Leads&unrelated=private",
    }),
  );
  expect(await result.json()).toEqual({
    redirect: "/app?mode=live&view=Leads&workspace=client-a",
  });
  expect(result.headers.get("cache-control")).toContain("no-store");
});
it("maps provider credential errors to a useful message without raw provider details", async () => {
  testState.auth.signInWithPassword.mockResolvedValue({
    error: { code: "invalid_credentials", message: "raw detail" },
  });
  const result = await POST(
    request({
      action: "sign-in",
      email: "customer@example.test",
      password: "test",
    }),
  );
  expect(result.status).toBe(400);
  expect((await result.json()).error).toContain(
    "Email or password is incorrect",
  );
});
it("uses a neutral recovery response and sends the callback to password update", async () => {
  const result = await POST(
    request({ action: "recover", email: "customer@example.test" }),
  );
  expect((await result.json()).message).toContain(
    "If an account uses this email",
  );
  expect(testState.auth.resetPasswordForEmail).toHaveBeenCalledWith(
    "customer@example.test",
    {
      redirectTo:
        "https://maintainflow.io/auth/callback?next=%2Fauth%2Fupdate-password",
    },
  );
});
it("requires a server-verified user for password updates", async () => {
  testState.auth.getUser.mockResolvedValue({
    data: { user: null },
    error: null,
  });
  const result = await POST(
    request({ action: "update-password", password: "a-new-test-password" }),
  );
  expect(result.status).toBe(401);
  expect(testState.auth.updateUser).not.toHaveBeenCalled();
});
it("signs out the current browser through the provider and returns a clean destination", async () => {
  const result = await POST(request({ action: "sign-out" }));
  expect(testState.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(await result.json()).toEqual({
    redirect: "/auth/sign-in?notice=signed-out",
  });
});
it("exchanges recovery token hashes and removes the token from the destination", async () => {
  const result = await confirm(
    new Request(
      "https://maintainflow.io/auth/confirm?token_hash=test-hash&type=recovery&next=https://different.example",
    ),
  );
  expect(testState.auth.verifyOtp).toHaveBeenCalledWith({
    token_hash: "test-hash",
    type: "recovery",
  });
  expect(result.headers.get("location")).toBe(
    "https://maintainflow.io/auth/update-password",
  );
  expect(result.headers.get("referrer-policy")).toBe("no-referrer");
});
it("does not claim a session when a confirmation link has expired", async () => {
  testState.auth.verifyOtp.mockResolvedValue({
    error: { code: "otp_expired" },
  });
  const result = await confirm(
    new Request(
      "https://maintainflow.io/auth/confirm?token_hash=test-hash&type=email",
    ),
  );
  expect(result.headers.get("location")).toBe(
    "https://maintainflow.io/auth/sign-in?error=confirmation",
  );
});
it("requires a successful PKCE exchange before using the allowed app path", async () => {
  const result = await callback(
    new Request(
      "https://maintainflow.io/auth/callback?code=test-code&next=%2Fapp%3Fview%3DLeads",
    ),
  );
  expect(testState.auth.exchangeCodeForSession).toHaveBeenCalledWith(
    "test-code",
  );
  expect(result.headers.get("location")).toBe(
    "https://maintainflow.io/app?mode=live&view=Leads",
  );
});
it.each([
  "https://different.example",
  "//different.example",
  "/app/other",
  "/app\\different",
  ["/app"],
  "/auth/action",
  "/app?next=https://different.example",
])("limits auth redirects for %s", (value) => {
  expect(safeSupabaseReturnTo(value)).toBe("/app?mode=live");
});
it("permits only the explicit password recovery destination outside the app", () => {
  expect(safeAuthCallbackPath("/auth/update-password")).toBe(
    "/auth/update-password",
  );
  expect(
    safeAuthCallbackPath(
      "/auth/update-password?next=https://different.example",
    ),
  ).toBe("/app?mode=live");
});
it("refuses a secret key supplied in the public configuration slot", () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_secret_do-not-use");
  expect(() => supabasePublicConfig()).toThrow("configuration is invalid");
});
