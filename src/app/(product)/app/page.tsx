import { AttributionApp } from "@/components/attribution/app";
import { localMode } from "@/lib/attribution/store.server";
import { sampleWorkspace } from "@/lib/attribution/sample";
export default async function AppPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const params = await searchParams;
  return (
    <AttributionApp
      local={localMode()}
      initialView={params.view || "Overview"}
      initialLive={params.mode === "live"}
      initialSample={params.mode === "live" ? undefined : sampleWorkspace()}
    />
  );
}
