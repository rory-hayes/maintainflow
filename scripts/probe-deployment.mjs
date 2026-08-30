import { fileURLToPath } from "node:url";

const MAX_RESPONSE_BYTES = 64 * 1024;
const REVISION_PATTERN = /^[a-f0-9]{7,64}$/i;
const RELEASE_STAGES = new Set(["demo", "private_read", "live_write"]);

export class DeploymentProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentProbeError";
  }
}

function requiredString(value, label, minimumLength = 1) {
  if (typeof value !== "string" || value.trim().length < minimumLength) {
    throw new DeploymentProbeError(`${label} is not configured.`);
  }
  return value.trim();
}

function deploymentOrigin(value) {
  const configured = requiredString(value, "Deployment origin");
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new DeploymentProbeError("Deployment origin is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new DeploymentProbeError(
      "Deployment origin must be a credential-free HTTPS origin without a path, query, or fragment.",
    );
  }
  return url.origin;
}

async function responseJson(response, label) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_RESPONSE_BYTES) {
    throw new DeploymentProbeError(`${label} returned an oversized response.`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new DeploymentProbeError(`${label} returned an empty response.`);
  }
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let body = "";
  while (true) {
    let chunk;
    try {
      chunk = await reader.read();
    } catch {
      throw new DeploymentProbeError(`${label} response could not be read.`);
    }
    const { done, value } = chunk;
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new DeploymentProbeError(`${label} returned an oversized response.`);
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  try {
    return JSON.parse(body);
  } catch {
    throw new DeploymentProbeError(`${label} did not return valid JSON.`);
  }
}

async function request(fetchImpl, url, label, init = {}) {
  try {
    return await fetchImpl(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new DeploymentProbeError(`${label} request did not complete.`);
  }
}

function assertStatus(response, expected, label) {
  if (response.status !== expected) {
    throw new DeploymentProbeError(
      `${label} returned HTTP ${response.status}; expected ${expected}.`,
    );
  }
}

export async function probeDeployment(options) {
  const origin = deploymentOrigin(options.origin);
  const readinessSecret = requiredString(
    options.readinessSecret,
    "Readiness probe secret",
    32,
  );
  const cronSecret = requiredString(options.cronSecret, "Cron secret", 32);
  const expectedRevision = requiredString(
    options.expectedRevision,
    "Expected build revision",
  ).toLowerCase();
  if (!REVISION_PATTERN.test(expectedRevision)) {
    throw new DeploymentProbeError("Expected build revision is invalid.");
  }
  const expectedStage = requiredString(
    options.expectedStage,
    "Expected release stage",
  );
  if (!RELEASE_STAGES.has(expectedStage)) {
    throw new DeploymentProbeError("Expected release stage is invalid.");
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  const healthResponse = await request(
    fetchImpl,
    `${origin}/api/health`,
    "Liveness probe",
  );
  assertStatus(healthResponse, 200, "Liveness probe");
  const health = await responseJson(healthResponse, "Liveness probe");
  if (
    health?.ok !== true ||
    health?.service !== "maintainflow-ads" ||
    health?.scope !== "process_liveness" ||
    health?.revision !== expectedRevision
  ) {
    throw new DeploymentProbeError(
      "Liveness probe did not confirm the expected service revision.",
    );
  }

  const unauthorizedResponse = await request(
    fetchImpl,
    `${origin}/api/ready`,
    "Unauthenticated readiness probe",
  );
  assertStatus(unauthorizedResponse, 401, "Unauthenticated readiness probe");

  const readinessResponse = await request(
    fetchImpl,
    `${origin}/api/ready`,
    "Authenticated readiness probe",
    { headers: { Authorization: `Bearer ${readinessSecret}` } },
  );
  assertStatus(readinessResponse, 200, "Authenticated readiness probe");
  const readiness = await responseJson(
    readinessResponse,
    "Authenticated readiness probe",
  );
  const minimumReadinessChecks = expectedStage === "demo" ? 5 : 12;
  if (
    readiness?.ok !== true ||
    readiness?.service !== "maintainflow-ads" ||
    readiness?.scope !== "deployment_readiness" ||
    readiness?.revision !== expectedRevision ||
    readiness?.stage !== expectedStage ||
    !Number.isInteger(readiness?.checks?.passed) ||
    !Number.isInteger(readiness?.checks?.total) ||
    readiness.checks.total < minimumReadinessChecks ||
    readiness.checks.passed !== readiness.checks.total
  ) {
    throw new DeploymentProbeError(
      "Readiness probe did not confirm the expected stage, revision, and checks.",
    );
  }

  const cronResponse = await request(
    fetchImpl,
    `${origin}/api/jobs/monitoring/evaluate`,
    "Monitoring probe",
    { headers: { Authorization: `Bearer ${cronSecret}` } },
  );
  assertStatus(cronResponse, 200, "Monitoring probe");
  const monitoring = await responseJson(cronResponse, "Monitoring probe");
  if (
    monitoring?.ok !== true ||
    monitoring?.monitoringUnavailable !== false ||
    monitoring?.maintenanceFailed !== false ||
    monitoring?.maintenanceBacklog !== false ||
    !Number.isInteger(monitoring?.accountsFailed) ||
    monitoring.accountsFailed !== 0 ||
    !Number.isInteger(monitoring?.failed) ||
    monitoring.failed !== 0
  ) {
    throw new DeploymentProbeError(
      "Monitoring probe did not confirm a complete maintenance run.",
    );
  }

  return {
    ok: true,
    service: "maintainflow-ads",
    stage: expectedStage,
    revision: expectedRevision,
    readinessChecks: readiness.checks.total,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  probeDeployment({
    origin: process.env.MAINTAINFLOW_PROBE_ORIGIN,
    readinessSecret: process.env.MAINTAINFLOW_READINESS_PROBE_SECRET,
    cronSecret: process.env.CRON_SECRET,
    expectedRevision: process.env.MAINTAINFLOW_EXPECTED_BUILD_SHA,
    expectedStage: process.env.MAINTAINFLOW_EXPECTED_RELEASE_STAGE,
  })
    .then((result) => {
      console.log(
        `Deployment probe passed for ${result.stage} at revision ${result.revision}.`,
      );
    })
    .catch((error) => {
      const message =
        error instanceof DeploymentProbeError
          ? error.message
          : "Deployment probe failed unexpectedly.";
      console.error(message);
      process.exitCode = 1;
    });
}
