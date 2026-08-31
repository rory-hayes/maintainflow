import { SignIn } from "@clerk/nextjs";
import { LockKeyhole } from "lucide-react";
import { connection } from "next/server";

import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { isClerkConfigured, isPublicSignUpEnabled } from "@/lib/auth/config";

export default async function SignInPage() {
  await connection();
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-[#FAFAFA] p-4">
      {isClerkConfigured() ? (
        <SignIn
          path="/auth/sign-in"
          routing="path"
          fallbackRedirectUrl="/app"
          {...(isPublicSignUpEnabled()
            ? { signUpUrl: "/auth/sign-up" }
            : {})}
        />
      ) : (
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="gap-5">
            <MaintainFlowBrand />
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <LockKeyhole className="size-5" />
            </div>
            <div className="grid gap-1.5">
              <h1 className="font-semibold leading-none tracking-tight">
                Operator access is not configured
              </h1>
              <CardDescription className="leading-6">
                The local demo remains available, but MaintainFlow will not show a
                pretend sign-in or enable live Ads writes until Clerk credentials
                are configured on the server.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            Add the Clerk publishable and secret keys, then restart the app to
            activate authenticated operator access.
          </CardContent>
        </Card>
      )}
    </main>
  );
}
