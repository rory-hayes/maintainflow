import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
type Cookie = {
  name: string;
  value: string;
  options: { httpOnly?: boolean; path?: string };
};
const state = vi.hoisted(() => ({
  getUser: vi.fn(),
  getClaims: vi.fn(),
  set: vi.fn(),
  options: null as null | {
    cookieOptions: Record<string, unknown>;
    cookies: { getAll: () => unknown; setAll: (values: Cookie[]) => void };
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: state.set }),
}));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: NonNullable<typeof state.options>,
  ) => {
    state.options = options;
    return { auth: { getUser: state.getUser, getClaims: state.getClaims } };
  },
}));
import {
  createSupabaseServerClient,
  verifiedSupabaseUser,
} from "./supabase.server";
import { refreshSupabaseSession } from "./supabase-proxy";
beforeEach(() => {
  vi.resetAllMocks();
  state.options = null;
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
});
afterEach(() => vi.unstubAllEnvs());
it("validates identity through getUser and discards an errored user response", async () => {
  state.getUser.mockResolvedValue({
    data: { user: { id: "unverified" } },
    error: { message: "invalid token" },
  });
  expect(await verifiedSupabaseUser()).toBeNull();
  expect(state.getUser).toHaveBeenCalledOnce();
  expect(state.options?.cookieOptions).toMatchObject({
    httpOnly: true,
    sameSite: "lax",
    path: "/",
  });
});
it("returns the provider-validated user", async () => {
  const user = { id: "verified-user" };
  state.getUser.mockResolvedValue({ data: { user }, error: null });
  expect(await verifiedSupabaseUser()).toEqual(user);
});
it("propagates refreshed cookies to both the route request and browser response", async () => {
  state.getClaims.mockImplementation(async () => {
    state.options!.cookies.setAll([
      {
        name: "sb-session",
        value: "refreshed",
        options: { httpOnly: true, path: "/" },
      },
    ]);
    return { data: { claims: { sub: "verified" } } };
  });
  const request = new NextRequest("https://maintainflow.io/app");
  const response = await refreshSupabaseSession(request);
  expect(state.getClaims).toHaveBeenCalledOnce();
  expect(request.cookies.get("sb-session")?.value).toBe("refreshed");
  expect(response.cookies.get("sb-session")).toMatchObject({
    value: "refreshed",
    httpOnly: true,
  });
  expect(response.headers.get("cache-control")).toBe("private, no-store");
});
it("does not silently lose a session cookie when a route-handler write fails", async () => {
  state.set.mockImplementation(() => {
    throw new Error("write failed");
  });
  await createSupabaseServerClient(true);
  expect(() =>
    state.options!.cookies.setAll([
      { name: "session", value: "value", options: {} },
    ]),
  ).toThrow("write failed");
});
