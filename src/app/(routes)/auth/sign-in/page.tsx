import { SignIn } from "@clerk/nextjs";
import { LockKeyhole } from "lucide-react";

import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isClerkConfigured } from "@/lib/auth/config";

export default function SignInPage() {
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-[#FAFAFA] p-4">
      {isClerkConfigured() ? (
        <SignIn
          path="/auth/sign-in"
          routing="path"
          fallbackRedirectUrl="/app"
          signUpUrl="/auth/sign-up"
        />
      ) : (
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="gap-5">
            <MaintainFlowBrand />
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <LockKeyhole className="size-5" />
            </div>
            <div className="grid gap-1.5">
              <CardTitle>Operator access is not configured</CardTitle>
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
