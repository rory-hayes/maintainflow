import { AttributionApp } from "@/components/attribution/app";
import { localMode } from "@/lib/attribution/store.server";
import { sampleWorkspace } from "@/lib/attribution/sample";
import { isSupabaseConfigured } from "@/lib/auth/supabase-config";
export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  const signedIn =
    isSupabaseConfigured() &&
    Boolean(
      await (
        await import("@/lib/auth/operator.server")
      ).getOptionalAdmittedOperator(),
    );
  const live = params.mode === "live" || (!params.mode && signedIn);
  return (
    <AttributionApp
      local={localMode()}
      initialView={params.view || "Overview"}
      initialLive={live}
      initialSample={live ? undefined : sampleWorkspace()}
      signedIn={signedIn}
    />
  );
}
