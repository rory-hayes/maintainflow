import { redirect } from "next/navigation";
import { isSupabaseConfigured } from "@/lib/auth/supabase-config";
import { verifiedSupabaseUser } from "@/lib/auth/supabase.server";
import { SupabaseAuthForm } from "@/components/auth/supabase-auth-form";
import { AuthUnavailable } from "@/components/auth/auth-unavailable";
export default async function UpdatePasswordPage() {
  if (!isSupabaseConfigured()) return <AuthUnavailable />;
  if (!(await verifiedSupabaseUser()))
    redirect("/auth/sign-in?error=confirmation");
  return <SupabaseAuthForm mode="update-password" />;
}
