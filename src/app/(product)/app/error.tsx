"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RefreshCcw, ShieldAlert } from "lucide-react";

import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("MaintainFlow workspace render failed", {
      digest: error.digest ?? "unavailable",
    });
  }, [error.digest]);

  return (
    <main className="min-h-screen bg-[#FAFAFA]">
      <header className="border-b bg-background">
        <div className="flex min-h-16 items-center px-4 md:px-6">
          <MaintainFlowBrand />
        </div>
      </header>
      <section className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-2xl place-items-center px-4 py-12 md:px-6">
        <Alert variant="destructive" className="bg-background p-6 shadow-sm">
          <ShieldAlert />
          <AlertTitle>Workspace unavailable</AlertTitle>
          <AlertDescription className="mt-2 grid gap-5">
            <p>
              MaintainFlow could not confirm the workspace state. No external
              Ads change was sent from this failed page load.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="button" onClick={reset}>
                <RefreshCcw data-icon="inline-start" />
                Try again
              </Button>
              <Button variant="outline" asChild>
                <Link href="/">Return to MaintainFlow</Link>
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </section>
    </main>
  );
}
