import { describe, expect, it, vi } from "vitest";
import {
  deploymentProbeConfig,
  probeMaintainCodeDeployment,
} from "./probe-maintaincode-deployment.mjs";
const revision = "a".repeat(40);
const config = {
  origin: "https://maintainflow.io",
  revision,
  secret: "p".repeat(32),
};
function responses(overrides = {}) {
  return vi.fn(async (url, options) => {
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path](options);
    if (path === "/api/health")
      return Response.json(
        {
          ok: true,
          service: "maintaincode-ads",
          scope: "process_liveness",
          revision,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    if (path === "/api/attribution/ready")
      return options.headers.Authorization
        ? Response.json({
            ready: true,
            service: "maintaincode-ads",
            scope: "runtime_database_only",
            revision,
            checks: {
              runtimeRole: true,
              tables: 6,
              isolationPolicies: 6,
              maintenanceQueue: true,
            },
          })
        : Response.json({}, { status: 401 });
    if (path === "/app") return new Response("MaintainCode Ads Sample data");
    if (path === "/mc-tracker.js")
      return new Response("window.MaintainCode={}", {
        headers: { "Cross-Origin-Resource-Policy": "cross-origin" },
      });
    return Response.json({}, { status: 410 });
  });
}
describe("MaintainCode deployment probe", () => {
  it("checks exact revision and runtime configuration without submitting data", async () => {
    const fetcher = responses();
    const result = await probeMaintainCodeDeployment(config, fetcher);
    expect(result.checks).toHaveLength(6);
    expect(result.unverified).toContain("CRM form delivery");
    expect(
      fetcher.mock.calls.every(
        ([, options]) => !options.method || options.method === "GET",
      ),
    ).toBe(true);
    expect(
      fetcher.mock.calls.filter(([, options]) => options.headers.Authorization),
    ).toHaveLength(1);
    expect(
      fetcher.mock.calls.every(([, options]) => options.redirect === "manual"),
    ).toBe(true);
  });
  it("rejects a stale or legacy process even when it is healthy", async () => {
    await expect(
      probeMaintainCodeDeployment(
        config,
        responses({
          "/api/health": () =>
            Response.json(
              {
                ok: true,
                service: "maintainflow-ads",
                scope: "process_liveness",
                revision,
              },
              { headers: { "Cache-Control": "no-store" } },
            ),
        }),
      ),
    ).rejects.toThrow("expected uncached MaintainCode revision");
  });
  it("rejects local database proof at a hosted deployment", async () => {
    await expect(
      probeMaintainCodeDeployment(
        config,
        responses({
          "/api/attribution/ready": (options) =>
            options.headers.Authorization
              ? Response.json({ ready: true, scope: "local_database_only" })
              : Response.json({}, { status: 401 }),
        }),
      ),
    ).rejects.toThrow("dedicated database role");
  });
  it("rejects a redirect before sending a readiness secret elsewhere", async () => {
    await expect(
      probeMaintainCodeDeployment(
        config,
        responses({
          "/api/attribution/ready": () =>
            new Response(null, {
              status: 307,
              headers: { Location: "https://another.example" },
            }),
        }),
      ),
    ).rejects.toThrow("returned 307");
  });
  it("requires a supplied commit and secret and refuses non-loopback HTTP", () => {
    expect(() => deploymentProbeConfig({})).toThrow(
      "exact full deployed commit",
    );
    expect(() =>
      deploymentProbeConfig({
        MAINTAINCODE_PROBE_ORIGIN: "http://maintainflow.io",
        MAINTAINCODE_PROBE_ALLOW_LOCAL: "true",
      }),
    ).toThrow("exact HTTPS origin");
    expect(
      deploymentProbeConfig({
        MAINTAINCODE_PROBE_ORIGIN: "http://127.0.0.1:3217",
        MAINTAINCODE_PROBE_ALLOW_LOCAL: "true",
        MAINTAINCODE_EXPECTED_BUILD_SHA: revision,
        MAINTAINFLOW_READINESS_PROBE_SECRET: config.secret,
      }).origin,
    ).toBe("http://127.0.0.1:3217");
  });
});
