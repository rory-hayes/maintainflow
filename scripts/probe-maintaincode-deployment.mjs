import { fileURLToPath } from "node:url";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
export function deploymentProbeConfig(env) {
  const origin = new URL(
    env.MAINTAINCODE_PROBE_ORIGIN ?? "https://maintainflow.io",
  );
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    origin.hostname,
  );
  if (
    (origin.protocol !== "https:" &&
      !(
        env.MAINTAINCODE_PROBE_ALLOW_LOCAL === "true" &&
        loopback &&
        origin.protocol === "http:"
      )) ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  )
    throw new Error(
      "The deployment probe requires an exact HTTPS origin; HTTP is permitted only for explicitly enabled loopback tests.",
    );
  const revision = env.MAINTAINCODE_EXPECTED_BUILD_SHA?.toLowerCase();
  if (!revision || !SHA.test(revision))
    throw new Error(
      "MAINTAINCODE_EXPECTED_BUILD_SHA must be the exact full deployed commit SHA.",
    );
  const secret = env.MAINTAINFLOW_READINESS_PROBE_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("A 32-character readiness probe secret is required.");
  return { origin: origin.origin, revision, secret };
}

export async function probeMaintainCodeDeployment(config, fetcher = fetch) {
  const completed = [];
  async function get(path, { authenticated = false, status = 200 } = {}) {
    const response = await fetcher(`${config.origin}${path}`, {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      headers: {
        "Cache-Control": "no-cache",
        ...(authenticated ? { Authorization: `Bearer ${config.secret}` } : {}),
      },
    });
    if (response.status !== status)
      throw new Error(
        `${path} returned ${response.status}; expected ${status}.`,
      );
    return response;
  }
  const healthResponse = await get("/api/health");
  const health = await healthResponse.json();
  if (
    !health.ok ||
    health.service !== "maintaincode-ads" ||
    health.scope !== "process_liveness" ||
    health.revision !== config.revision ||
    !healthResponse.headers.get("cache-control")?.includes("no-store")
  )
    throw new Error(
      "Process health does not identify the expected uncached MaintainCode revision.",
    );
  completed.push("exact_compiled_revision");
  await get("/api/attribution/ready", { status: 401 });
  completed.push("readiness_authentication");
  const readyResponse = await get("/api/attribution/ready", {
    authenticated: true,
  });
  const ready = await readyResponse.json();
  if (
    !ready.ready ||
    ready.service !== "maintaincode-ads" ||
    ready.scope !== "runtime_database_only" ||
    ready.revision !== config.revision ||
    ready.checks?.runtimeRole !== true ||
    ready.checks?.tables !== 6 ||
    ready.checks?.isolationPolicies !== 6 ||
    !ready.checks?.maintenanceQueue
  )
    throw new Error(
      "The expected revision did not verify the dedicated database role, table grants and isolation policies.",
    );
  completed.push("runtime_database_configuration");
  const app = await (await get("/app")).text();
  if (!app.includes("MaintainCode Ads") || !app.includes("Sample data"))
    throw new Error(
      "The attribution application and its sample-data boundary did not render.",
    );
  completed.push("attribution_application");
  const tracker = await get("/mc-tracker.js");
  if (
    tracker.headers.get("cross-origin-resource-policy") !== "cross-origin" ||
    !(await tracker.text()).includes("MaintainCode")
  )
    throw new Error("The cross-origin browser tracker did not load.");
  completed.push("cross_origin_tracker");
  await get("/api/recommendations/apply", { status: 410 });
  completed.push("legacy_operations_retired");
  return {
    ok: true,
    origin: config.origin,
    revision: config.revision,
    checks: completed,
    unverified: [
      "interactive authentication",
      "cross-workspace access with real users",
      "CRM form delivery",
      "provider sync",
      "payments",
      "scheduled maintenance",
      "customer acceptance",
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(
        await probeMaintainCodeDeployment(deploymentProbeConfig(process.env)),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Deployment verification failed.",
    );
    process.exitCode = 1;
  }
}
