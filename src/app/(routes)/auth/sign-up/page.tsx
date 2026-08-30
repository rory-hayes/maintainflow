import { SignUp } from "@clerk/nextjs";
import { LockKeyhole } from "lucide-react";

import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { isClerkConfigured } from "@/lib/auth/config";

export default function SignUpPage() {
  return (
    <main className="grid min-h-[calc(100vh-4rem)] place-items-center bg-[#FAFAFA] p-4">
      {isClerkConfigured() ? (
        <SignUp
          path="/auth/sign-up"
          routing="path"
          fallbackRedirectUrl="/app"
          signInUrl="/auth/sign-in"
        />
      ) : (
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader className="gap-5">
            <MaintainFlowBrand />
            <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <LockKeyhole className="size-5" />
            </div>
            <div className="grid gap-1.5">
              <CardTitle>Account creation is not configured</CardTitle>
              <CardDescription className="leading-6">
                MaintainFlow will enable customer registration after the Clerk
                tenant and production access policy are configured.
              </CardDescription>
            </div>
          </CardHeader>
        </Card>
      )}
    </main>
  );
}
