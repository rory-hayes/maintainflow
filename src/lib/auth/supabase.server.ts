import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabasePublicConfig } from "./supabase-config";

export async function createSupabaseServerClient(writable = false) {
  const { url, key } = supabasePublicConfig();
  const store = await cookies();
  return createServerClient(url, key, {
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
    },
    global: {
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          cache: "no-store",
          signal: init?.signal
            ? AbortSignal.any([init.signal, AbortSignal.timeout(12000)])
            : AbortSignal.timeout(12000),
        }),
    },
    cookies: {
      getAll: () => store.getAll(),
      setAll(values) {
        try {
          values.forEach(({ name, value, options }) =>
            store.set(name, value, options),
          );
        } catch (error) {
          // Server Components cannot write cookies. Proxy refreshes their
          // session; route handlers must propagate any failed cookie write.
          if (writable) throw error;
        }
      },
    },
  });
}

export async function verifiedSupabaseUser() {
  const client = await createSupabaseServerClient();
  const { data, error } = await client.auth.getUser();
  return error ? null : data.user;
}
