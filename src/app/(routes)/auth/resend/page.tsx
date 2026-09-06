import { connection } from "next/server";
import { isSupabaseConfigured } from "@/lib/auth/supabase-config";
import { SupabaseAuthForm } from "@/components/auth/supabase-auth-form";
import { AuthUnavailable } from "@/components/auth/auth-unavailable";
export default async function ResendPage() {
  await connection();
  return isSupabaseConfigured() ? (
    <SupabaseAuthForm mode="resend" />
  ) : (
    <AuthUnavailable />
  );
}
