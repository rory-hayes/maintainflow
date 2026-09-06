import { SignUp } from "@clerk/nextjs";
import { LockKeyhole } from "lucide-react";
import { connection } from "next/server";

import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader } from "@/components/ui/card";
import Link from "next/link";
import { isClerkConfigured, isPublicSignUpEnabled } from "@/lib/auth/config";
import { isSupabaseConfigured } from "@/lib/auth/supabase-config";
import { SupabaseAuthForm } from "@/components/auth/supabase-auth-form";
import { AuthUnavailable } from "@/components/auth/auth-unavailable";

export default async function SignUpPage() {
  await connection();
  if (isSupabaseConfigured())
    return isPublicSignUpEnabled() ? (
      <SupabaseAuthForm mode="sign-up" />
    ) : (
      <AuthUnavailable />
    );
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-[#FAFAFA] p-4">
      {isClerkConfigured() && isPublicSignUpEnabled() ? (
        <SignUp
          path="/auth/sign-up"
          routing="path"
          fallbackRedirectUrl="/app?mode=live"
          signInUrl="/auth/sign-in"
        />
      ) : (
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="gap-5">
            <strong>MaintainCode Ads</strong>
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <LockKeyhole className="size-5" />
            </div>
            <div className="grid gap-1.5">
              <h1 className="font-semibold leading-none tracking-tight">
                {isClerkConfigured()
                  ? "MaintainCode Ads is invitation-only"
                  : "Account creation is not configured"}
              </h1>
              <CardDescription className="leading-6">
                {isClerkConfigured()
                  ? "Private-beta operators are provisioned directly. Public registration stays closed so an unadmitted account cannot create a MaintainCode Ads workspace or access advertiser data."
                  : "MaintainCode Ads will enable customer registration after the Clerk tenant and production access policy are configured."}
              </CardDescription>
              {isClerkConfigured() ? (
                <Button asChild className="mt-2 w-fit">
                  <Link href="/auth/sign-in">
                    Sign in to an invited account
                  </Link>
                </Button>
              ) : null}
            </div>
          </CardHeader>
        </Card>
      )}
    </main>
  );
}
