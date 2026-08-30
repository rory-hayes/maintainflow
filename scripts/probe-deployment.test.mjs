import { describe, expect, it, vi } from "vitest";

import {
  DeploymentProbeError,
  probeDeployment,
} from "./probe-deployment.mjs";

const revision = "a".repeat(40);
const readinessSecret = "readiness-secret-at-least-32-characters";
const cronSecret = "monitoring-secret-at-least-32-characters";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function successfulFetch() {
  return vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        service: "maintainflow-ads",
        scope: "process_liveness",
        revision,
      }),
    )
    .mockResolvedValueOnce(jsonResponse({ ok: false }, 401))
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        service: "maintainflow-ads",
        scope: "deployment_readiness",
        stage: "demo",
        revision,
        checks: { passed: 5, total: 5 },
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        monitoringUnavailable: false,
        maintenanceFailed: false,
        maintenanceBacklog: false,
        accountsFailed: 0,
        failed: 0,
        evaluated: 0,
      }),
    );
}

describe("hosted deployment probe", () => {
  it("proves liveness, auth denial, readiness, and one complete maintenance run", async () => {
    const fetchImpl = successfulFetch();

    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        fetchImpl,
      }),
    ).resolves.toEqual({
      ok: true,
      service: "maintainflow-ads",
      stage: "demo",
      revision,
      readinessChecks: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === "error"))
      .toBe(true);
    expect(fetchImpl.mock.calls[1][1]?.headers).toBeUndefined();
    expect(fetchImpl.mock.calls[2][1]?.headers).toEqual({
      Authorization: `Bearer ${readinessSecret}`,
    });
    expect(fetchImpl.mock.calls[3][1]?.headers).toEqual({
      Authorization: `Bearer ${cronSecret}`,
    });
  });

  it("fails on a revision mismatch without exposing a response body or secret", async () => {
    const plantedSecret = "PLANTED_PROBE_SECRET_46f913";
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        service: "maintainflow-ads",
        scope: "process_liveness",
        revision: "b".repeat(40),
        privateDetail: plantedSecret,
      }),
    );

    const outcome = await probeDeployment({
      origin: "https://staging.maintainflow.io",
      readinessSecret,
      cronSecret,
      expectedRevision: revision,
      expectedStage: "demo",
      fetchImpl,
    }).catch((error) => error);

    expect(outcome).toBeInstanceOf(DeploymentProbeError);
    expect(String(outcome)).not.toContain(plantedSecret);
    expect(String(outcome)).not.toContain(readinessSecret);
    expect(String(outcome)).toContain("expected service revision");
  });

  it("replaces network exception details with a fixed failure", async () => {
    const plantedSecret = "PLANTED_NETWORK_SECRET_5d81d8";
    const fetchImpl = vi.fn().mockRejectedValue(
      new Error(`Bearer ${plantedSecret}`),
    );

    const outcome = await probeDeployment({
      origin: "https://staging.maintainflow.io",
      readinessSecret,
      cronSecret,
      expectedRevision: revision,
      expectedStage: "demo",
      fetchImpl,
    }).catch((error) => error);

    expect(outcome).toBeInstanceOf(DeploymentProbeError);
    expect(String(outcome)).toBe(
      "DeploymentProbeError: Liveness probe request did not complete.",
    );
    expect(String(outcome)).not.toContain(plantedSecret);
  });

  it("rejects insecure or credential-bearing deployment origins", async () => {
    for (const origin of [
      "http://staging.maintainflow.io",
      "https://user:password@staging.maintainflow.io",
      "https://staging.maintainflow.io/not-the-deployment-root",
      "https://staging.maintainflow.io?token=unsafe",
    ]) {
      await expect(
        probeDeployment({
          origin,
          readinessSecret,
          cronSecret,
          expectedRevision: revision,
          expectedStage: "demo",
          fetchImpl: vi.fn(),
        }),
      ).rejects.toThrow("credential-free HTTPS origin");
    }
  });

  it("rejects an empty readiness check set", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          service: "maintainflow-ads",
          scope: "process_liveness",
          revision,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          service: "maintainflow-ads",
          scope: "deployment_readiness",
          stage: "demo",
          revision,
          checks: { passed: 0, total: 0 },
        }),
      );

    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        fetchImpl,
      }),
    ).rejects.toThrow("expected stage, revision, and checks");
  });

  it("rejects a monitoring response that omits completion evidence", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          service: "maintainflow-ads",
          scope: "process_liveness",
          revision,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: false }, 401))
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          service: "maintainflow-ads",
          scope: "deployment_readiness",
          stage: "demo",
          revision,
          checks: { passed: 5, total: 5 },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        fetchImpl,
      }),
    ).rejects.toThrow("complete maintenance run");
  });

  it("stops reading an oversized chunked response without exposing its body", async () => {
    const plantedSecret = "PLANTED_OVERSIZED_SECRET_d44a";
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          padding: plantedSecret.repeat(4_096),
        }),
      ),
    );

    const outcome = await probeDeployment({
      origin: "https://staging.maintainflow.io",
      readinessSecret,
      cronSecret,
      expectedRevision: revision,
      expectedStage: "demo",
      fetchImpl,
    }).catch((error) => error);

    expect(outcome).toBeInstanceOf(DeploymentProbeError);
    expect(String(outcome)).toContain("oversized response");
    expect(String(outcome)).not.toContain(plantedSecret);
  });
});
