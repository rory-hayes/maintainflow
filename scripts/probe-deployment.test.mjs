import { describe, expect, it, vi } from "vitest";

import {
  DeploymentProbeError,
  probeDeployment,
} from "./probe-deployment.mjs";

const revision = "a".repeat(40);
const readinessSecret = "readiness-secret-at-least-32-characters";
const cronSecret = "monitoring-secret-at-least-32-characters";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function successfulFetch({
  approvalEmailEnabled,
  landingHtml,
  monitoringOverrides,
  notificationOverrides,
  notificationResponseHeaders = { "Cache-Control": "no-store" },
  notificationStatus = 200,
  readinessOverrides,
  stage = "demo",
  unauthorizedNotificationHeaders = { "Cache-Control": "no-store" },
  unauthorizedNotificationStatus = 401,
} = {}) {
  const expectedReadinessChecks = stage === "demo" ? 9 : 16;
  const notificationsEnabled = approvalEmailEnabled ?? stage !== "demo";
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
        stage,
        revision,
        checks: {
          passed: expectedReadinessChecks,
          total: expectedReadinessChecks,
          ...readinessOverrides,
        },
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse(
        { ok: false },
        unauthorizedNotificationStatus,
        unauthorizedNotificationHeaders,
      ),
    )
    .mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        releaseStage: stage,
        providerMonitoringPaused: stage === "demo",
        pausedBacklog: {
          dueAccounts: 0,
          dueWindows: 0,
          dueAccountsCapped: false,
          dueWindowsCapped: false,
        },
        monitoringUnavailable: false,
        maintenanceFailed: false,
        maintenanceBacklog: false,
        approvalOperationsRecovered: 0,
        unresolvedApprovalOperations: 0,
        accountsFailed: 0,
        failed: 0,
        deadlineExhausted: false,
        evaluated: 0,
        ...monitoringOverrides,
      }),
    )
    .mockResolvedValueOnce(
      jsonResponse(
        {
          ok: true,
          enabled: notificationsEnabled,
          claimed: 0,
          accepted: 0,
          retryScheduled: 0,
          permanentlyFailed: 0,
          cancelled: 0,
          lostClaims: 0,
          recovery: {
            cancelledIneligible: 0,
            retryScheduledAfterLeaseExpiry: 0,
            permanentFailuresAfterLeaseExpiry: 0,
            permanentFailuresAfterIdempotencyExpiry: 0,
            permanentFailuresAfterConfirmationTimeout: 0,
          },
          ...notificationOverrides,
        },
        notificationStatus,
        notificationResponseHeaders,
      ),
    )
    .mockResolvedValueOnce(
      htmlResponse(
        landingHtml ??
          "<main><h1>Deploy every ChatGPT Ads change</h1><p>Audit your store</p></main>",
      ),
    )
    .mockResolvedValueOnce(
      htmlResponse(
        "<main><h1>Privacy at MaintainFlow</h1><p>Privacy requests</p></main>",
      ),
    )
    .mockResolvedValueOnce(
      htmlResponse(
        "<main><h1>MaintainFlow service terms</h1><h2>Support and notices</h2></main>",
      ),
    )
    .mockResolvedValueOnce(
      htmlResponse(
        "<main><h1>MaintainFlow is invitation-only</h1></main>",
      ),
    )
    .mockResolvedValueOnce(
      htmlResponse(
        "<main><h1>Is your commerce stack ready for ChatGPT?</h1><button>Load sample audit</button></main>",
      ),
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
      readinessChecks: 9,
      notificationDeliveryEnabled: false,
      surfaceChecks: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(11);
    expect(fetchImpl.mock.calls.every(([, init]) => init?.redirect === "error"))
      .toBe(true);
    expect(fetchImpl.mock.calls[1][1]?.headers).toBeUndefined();
    expect(fetchImpl.mock.calls[2][1]?.headers).toEqual({
      Authorization: `Bearer ${readinessSecret}`,
    });
    expect(fetchImpl.mock.calls[3][1]?.headers).toBeUndefined();
    expect(fetchImpl.mock.calls[4][1]?.headers).toEqual({
      Authorization: `Bearer ${cronSecret}`,
    });
    expect(fetchImpl.mock.calls[5][1]?.headers).toEqual({
      Authorization: `Bearer ${cronSecret}`,
    });
    expect(fetchImpl.mock.calls.slice(6).map(([url]) => url)).toEqual([
      "https://staging.maintainflow.io/",
      "https://staging.maintainflow.io/privacy",
      "https://staging.maintainflow.io/terms",
      "https://staging.maintainflow.io/auth/sign-up",
      "https://staging.maintainflow.io/app?tab=readiness",
    ]);
    expect(
      fetchImpl.mock.calls.slice(6).every(([, init]) => !init?.headers),
    ).toBe(true);
  });

  it.each([
    ["private_read", 16],
    ["live_write", 16],
  ])(
    "requires the complete %s readiness contract",
    async (expectedStage, expectedReadinessChecks) => {
      await expect(
        probeDeployment({
          origin: "https://staging.maintainflow.io",
          readinessSecret,
          cronSecret,
          expectedRevision: revision,
          expectedStage,
          expectedApprovalEmailEnabled: true,
          fetchImpl: successfulFetch({ stage: expectedStage }),
        }),
      ).resolves.toMatchObject({
        ok: true,
        stage: expectedStage,
        readinessChecks: expectedReadinessChecks,
        notificationDeliveryEnabled: true,
      });
    },
  );

  it.each(["private_read", "live_write"])(
    "accepts an explicitly disabled notification worker in %s",
    async (expectedStage) => {
      await expect(
        probeDeployment({
          origin: "https://staging.maintainflow.io",
          readinessSecret,
          cronSecret,
          expectedRevision: revision,
          expectedStage,
          expectedApprovalEmailEnabled: false,
          fetchImpl: successfulFetch({
            approvalEmailEnabled: false,
            stage: expectedStage,
          }),
        }),
      ).resolves.toMatchObject({
        notificationDeliveryEnabled: false,
      });
    },
  );

  it("requires an explicit notification state for account-backed stages", async () => {
    const fetchImpl = vi.fn();

    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "private_read",
        fetchImpl,
      }),
    ).rejects.toThrow("Expected approval email state is not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects an enabled notification expectation in demo", async () => {
    const fetchImpl = vi.fn();

    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        expectedApprovalEmailEnabled: true,
        fetchImpl,
      }),
    ).rejects.toThrow("cannot be expected in the demo release stage");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a clean enabled notification run with accepted and cancelled work", async () => {
    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "private_read",
        expectedApprovalEmailEnabled: true,
        fetchImpl: successfulFetch({
          stage: "private_read",
          notificationOverrides: {
            claimed: 2,
            accepted: 1,
            cancelled: 1,
          },
        }),
      }),
    ).resolves.toMatchObject({ notificationDeliveryEnabled: true });
  });

  it("rejects a notification enablement mismatch", async () => {
    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        expectedApprovalEmailEnabled: false,
        fetchImpl: successfulFetch({ approvalEmailEnabled: true }),
      }),
    ).rejects.toThrow("complete clean delivery run");
  });

  it.each([
    ["negative", { claimed: -1 }],
    ["fractional", { claimed: 0.5 }],
    ["unsafe", { claimed: Number.MAX_SAFE_INTEGER + 1 }],
    ["over-cap", { claimed: 26, accepted: 26 }],
    ["accounting mismatch", { claimed: 2, accepted: 1 }],
    ["retry", { claimed: 1, retryScheduled: 1 }],
    ["permanent failure", { claimed: 1, permanentlyFailed: 1 }],
    ["lost claim", { claimed: 1, lostClaims: 1 }],
  ])("rejects an unsafe notification summary: %s", async (_label, overrides) => {
    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "private_read",
        expectedApprovalEmailEnabled: true,
        fetchImpl: successfulFetch({
          stage: "private_read",
          notificationOverrides: overrides,
        }),
      }),
    ).rejects.toThrow("complete clean delivery run");
  });

  it.each([
    "cancelledIneligible",
    "retryScheduledAfterLeaseExpiry",
    "permanentFailuresAfterLeaseExpiry",
    "permanentFailuresAfterIdempotencyExpiry",
    "permanentFailuresAfterConfirmationTimeout",
  ])("rejects notification recovery activity: %s", async (recoveryField) => {
    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "private_read",
        expectedApprovalEmailEnabled: true,
        fetchImpl: successfulFetch({
          stage: "private_read",
          notificationOverrides: {
            recovery: {
              cancelledIneligible: 0,
              retryScheduledAfterLeaseExpiry: 0,
              permanentFailuresAfterLeaseExpiry: 0,
              permanentFailuresAfterIdempotencyExpiry: 0,
              permanentFailuresAfterConfirmationTimeout: 0,
              [recoveryField]: 1,
            },
          },
        }),
      }),
    ).rejects.toThrow("complete clean delivery run");
  });

  it.each([
    ["anonymous status", { unauthorizedNotificationStatus: 200 }],
    ["anonymous caching", { unauthorizedNotificationHeaders: {} }],
    ["authenticated caching", { notificationResponseHeaders: {} }],
    ["authenticated failure", { notificationStatus: 503 }],
  ])("rejects an unsafe notification HTTP contract: %s", async (_label, fixture) => {
    await expect(
      probeDeployment({
        origin: "https://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        fetchImpl: successfulFetch(fixture),
      }),
    ).rejects.toBeInstanceOf(DeploymentProbeError);
  });

  it("fails closed when a public surface returns the wrong application", async () => {
    const plantedSecret = "PLANTED_SURFACE_SECRET_f8f24a";
    const fetchImpl = successfulFetch({
      landingHtml: `<main>Unrelated deployment ${plantedSecret}</main>`,
    });

    const outcome = await probeDeployment({
      origin: "https://staging.maintainflow.io",
      readinessSecret,
      cronSecret,
      expectedRevision: revision,
      expectedStage: "demo",
      fetchImpl,
    }).catch((error) => error);

    expect(outcome).toBeInstanceOf(DeploymentProbeError);
    expect(String(outcome)).toContain(
      "Public landing page did not render the expected deployment surface",
    );
    expect(String(outcome)).not.toContain(plantedSecret);
    expect(String(outcome)).not.toContain(readinessSecret);
    expect(String(outcome)).not.toContain(cronSecret);
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
      "http://127.0.0.1:3000",
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

  it("requires a full immutable Git object id for the expected revision", async () => {
    for (const expectedRevision of ["a".repeat(7), "b".repeat(41)]) {
      await expect(
        probeDeployment({
          origin: "https://staging.maintainflow.io",
          readinessSecret,
          cronSecret,
          expectedRevision,
          expectedStage: "demo",
          fetchImpl: successfulFetch(),
        }),
      ).rejects.toThrow("Expected build revision is invalid");
    }
  });

  it("allows an explicit loopback-only HTTP probe for container CI", async () => {
    await expect(
      probeDeployment({
        origin: "http://127.0.0.1:3000",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        allowInsecureLoopback: true,
        fetchImpl: successfulFetch(),
      }),
    ).resolves.toMatchObject({
      ok: true,
      revision,
      surfaceChecks: 5,
    });

    await expect(
      probeDeployment({
        origin: "http://staging.maintainflow.io",
        readinessSecret,
        cronSecret,
        expectedRevision: revision,
        expectedStage: "demo",
        allowInsecureLoopback: true,
        fetchImpl: successfulFetch(),
      }),
    ).rejects.toThrow("credential-free HTTPS origin");
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

  it.each([8, 10])(
    "rejects a demo readiness response with %i checks",
    async (reportedChecks) => {
      await expect(
        probeDeployment({
          origin: "https://staging.maintainflow.io",
          readinessSecret,
          cronSecret,
          expectedRevision: revision,
          expectedStage: "demo",
          fetchImpl: successfulFetch({
            readinessOverrides: {
              passed: reportedChecks,
              total: reportedChecks,
            },
          }),
        }),
      ).rejects.toThrow("expected stage, revision, and checks");
    },
  );

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
          checks: { passed: 9, total: 9 },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ ok: false }, 401, { "Cache-Control": "no-store" }),
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

  it("rejects a maintenance run that recovered an ambiguous Ads operation", async () => {
    const fetchImpl = successfulFetch({
      monitoringOverrides: { approvalOperationsRecovered: 1 },
    });

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

  it("rejects a maintenance run with a persistent unresolved Ads operation", async () => {
    const fetchImpl = successfulFetch({
      monitoringOverrides: { unresolvedApprovalOperations: 1 },
    });

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
