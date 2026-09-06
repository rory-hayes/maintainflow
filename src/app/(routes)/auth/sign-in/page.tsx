import { SignIn } from "@clerk/nextjs";
import { LockKeyhole } from "lucide-react";
import { connection } from "next/server";


import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { isClerkConfigured, isPublicSignUpEnabled } from "@/lib/auth/config";
import { safeSignInReturnTo } from "@/lib/auth/return-to";

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  await connection();
  const requested = (await searchParams).returnTo;
  const returnTo = requested ? safeSignInReturnTo(requested) : "/app?mode=live";
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-[#FAFAFA] p-4">
      {isClerkConfigured() ? (
        <SignIn
          path="/auth/sign-in"
          routing="path"
          fallbackRedirectUrl={returnTo}
          forceRedirectUrl={returnTo}
          {...(isPublicSignUpEnabled()
            ? { signUpUrl: "/auth/sign-up" }
            : {})}
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
                Workspace sign-in is not configured
              </h1>
              <CardDescription className="leading-6">
                The local demo remains available, but MaintainCode Ads will not show a
                workspace sign-in until Clerk credentials
                are configured on the server.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Add the Clerk publishable and secret keys, then restart the app to
            activate authenticated workspace access.
          </CardContent>
        </Card>
      )}
    </main>
  );
}
