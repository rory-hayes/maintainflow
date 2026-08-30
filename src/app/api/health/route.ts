import { resolveBuildRevision } from "@/lib/release/revision";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export function GET() {
  return Response.json(
    {
      ok: true,
      service: "maintainflow-ads",
      scope: "process_liveness",
      revision: resolveBuildRevision() ?? "unknown",
    },
    { headers: NO_STORE_HEADERS },
  );
}
