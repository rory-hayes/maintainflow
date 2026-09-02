import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  verifyDatabaseMigrationLedger: vi.fn(),
  verifyRuntimeDatabaseRole: vi.fn(),
  verifyReadinessRateLimitStore: vi.fn(),
  verifyTenancyStore: vi.fn(),
  verifyCredentialStore: vi.fn(),
  verifyConversionCredentialStore: vi.fn(),
  verifyLiveSyncStore: vi.fn(),
  verifyApprovalStore: vi.fn(),
  verifyRecommendationDecisionStore: vi.fn(),
  verifyCreativeHistoryStore: vi.fn(),
  verifyReadinessHistoryStore: vi.fn(),
  probeEnd: vi.fn(),
  createReadinessDatabase: vi.fn(),
  resolveBuildRevision: vi.fn(),
}));

vi.mock("@/lib/database/client.server", () => ({
  createReadinessDatabase: state.createReadinessDatabase,
}));

vi.mock("@/lib/database/readiness.server", () => ({
  verifyDatabaseMigrationLedger: state.verifyDatabaseMigrationLedger,
  verifyRuntimeDatabaseRole: state.verifyRuntimeDatabaseRole,
}));
vi.mock("@/lib/readiness/rate-limit.server", () => ({
  verifyReadinessRateLimitStore: state.verifyReadinessRateLimitStore,
}));
vi.mock("@/lib/tenancy/store.server", () => ({
  verifyTenancyStore: state.verifyTenancyStore,
  verifyCredentialStore: state.verifyCredentialStore,
  verifyConversionCredentialStore: state.verifyConversionCredentialStore,
}));
vi.mock("@/lib/openai-ads/live-sync-store.server", () => ({
  verifyLiveSyncStore: state.verifyLiveSyncStore,
}));
vi.mock("@/lib/audit/approval-store.server", () => ({
  verifyApprovalStore: state.verifyApprovalStore,
}));
vi.mock("@/lib/audit/recommendation-decision-store.server", () => ({
  verifyRecommendationDecisionStore:
    state.verifyRecommendationDecisionStore,
}));
vi.mock("@/lib/openai-ads/creative-history.server", () => ({
  verifyCreativeHistoryStore: state.verifyCreativeHistoryStore,
}));
vi.mock("@/lib/readiness/history.server", () => ({
  verifyReadinessHistoryStore: state.verifyReadinessHistoryStore,
}));
vi.mock("@/lib/release/revision", () => ({
  resolveBuildRevision: state.resolveBuildRevision,
}));

import { GET, maxDuration } from "./route";

function lastErrorRecord() {
  const line = vi.mocked(console.error).mock.calls.at(-1)?.[0];
  return JSON.parse(String(line));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "demo");
  vi.stubEnv("MAINTAINFLOW_READINESS_PROBE_SECRET", "p".repeat(32));
  vi.stubEnv("CRON_SECRET", "c".repeat(32));
  vi.stubEnv("DATABASE_URL", "postgres://runtime:secret@localhost/maintainflow");
  state.resolveBuildRevision.mockReturnValue("a".repeat(40));
  state.probeEnd.mockResolvedValue(undefined);
  state.createReadinessDatabase.mockReturnValue({ end: state.probeEnd });
  state.verifyDatabaseMigrationLedger.mockResolvedValue({ ready: true });
  state.verifyRuntimeDatabaseRole.mockResolvedValue(true);
  for (const check of [
    state.verifyReadinessRateLimitStore,
    state.verifyTenancyStore,
    state.verifyCredentialStore,
    state.verifyConversionCredentialStore,
    state.verifyLiveSyncStore,
    state.verifyApprovalStore,
    state.verifyRecommendationDecisionStore,
    state.verifyCreativeHistoryStore,
    state.verifyReadinessHistoryStore,
  ]) {
    check.mockResolvedValue(true);
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("deployment readiness route", () => {
  function request(secret = "p".repeat(32)) {
    return new Request("https://maintainflow.test/api/ready", {
      headers: { Authorization: `Bearer ${secret}` },
    });
  }

  it("proves a credential-free demo only after its revision, runtime role, ledger, and public quota are ready", async () => {
    expect(maxDuration).toBe(15);
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      service: "maintainflow-ads",
      scope: "deployment_readiness",
      stage: "demo",
      revision: "a".repeat(40),
      checks: { passed: 6, total: 6 },
    });
    expect(state.verifyTenancyStore).not.toHaveBeenCalled();
    expect(state.createReadinessDatabase).toHaveBeenCalledOnce();
    expect(state.verifyRuntimeDatabaseRole).toHaveBeenCalledWith(
      expect.objectContaining({ end: state.probeEnd }),
    );
    expect(state.probeEnd).toHaveBeenCalledWith({ timeout: 1 });
    expect(console.info).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(vi.mocked(console.info).mock.calls[0][0])),
    ).toMatchObject({
      event: "deployment.readiness.completed",
      status: 200,
      counts: { checksPassed: 6, checksTotal: 6 },
    });
  });

  it("fails a demo when the live snapshot store is unavailable", async () => {
    state.verifyLiveSyncStore.mockResolvedValue(false);
    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stage: "demo",
      checks: { passed: 5, total: 6 },
    });
    expect(state.verifyLiveSyncStore).toHaveBeenCalledTimes(1);
    expect(lastErrorRecord()).toMatchObject({
      event: "deployment.readiness.failed",
      failedChecks: ["live_sync"],
    });
  });

  it("fails when the deployment is not using the restricted runtime role", async () => {
    state.verifyRuntimeDatabaseRole.mockResolvedValue(false);
    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      checks: { passed: 5, total: 6 },
    });
    expect(lastErrorRecord()).toMatchObject({
      event: "deployment.readiness.failed",
      failedChecks: ["database_runtime_role"],
    });
  });

  it("fails closed without revision provenance or a current migration ledger", async () => {
    state.resolveBuildRevision.mockReturnValue(null);
    state.verifyDatabaseMigrationLedger.mockResolvedValue({ ready: false });

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stage: "demo",
      revision: "unknown",
      checks: { passed: 4, total: 6 },
    });
    expect(lastErrorRecord()).toMatchObject({
      event: "deployment.readiness.failed",
      failedChecks: ["build_revision", "database_migrations"],
    });
  });

  it("checks every live store without contacting OpenAI", async () => {
    vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "private_read");
    state.verifyCreativeHistoryStore.mockRejectedValue(new Error("offline"));
    const response = await GET(request());
    const payload = await response.json();

    expect(response.status).toBe(503);
    expect(payload).toMatchObject({
      ok: false,
      stage: "private_read",
      checks: { passed: 12, total: 13 },
    });
    expect(state.verifyTenancyStore).toHaveBeenCalledTimes(1);
    expect(state.verifyApprovalStore).toHaveBeenCalledTimes(1);
    const dedicatedDatabase = state.createReadinessDatabase.mock.results[0].value;
    for (const check of [
      state.verifyRuntimeDatabaseRole,
      state.verifyDatabaseMigrationLedger,
      state.verifyReadinessRateLimitStore,
      state.verifyLiveSyncStore,
      state.verifyTenancyStore,
      state.verifyCredentialStore,
      state.verifyConversionCredentialStore,
      state.verifyApprovalStore,
      state.verifyRecommendationDecisionStore,
      state.verifyCreativeHistoryStore,
      state.verifyReadinessHistoryStore,
    ]) {
      expect(check).toHaveBeenCalledWith(dedicatedDatabase);
    }
    expect(lastErrorRecord()).toMatchObject({
      event: "deployment.readiness.failed",
      failedChecks: ["creative_history"],
    });
  });

  it("rejects an unauthenticated probe before touching the database", async () => {
    const response = await GET(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(state.verifyDatabaseMigrationLedger).not.toHaveBeenCalled();
    expect(state.verifyRuntimeDatabaseRole).not.toHaveBeenCalled();
    expect(state.verifyReadinessRateLimitStore).not.toHaveBeenCalled();
    expect(state.createReadinessDatabase).not.toHaveBeenCalled();
    expect(state.probeEnd).not.toHaveBeenCalled();
  });

  it("does not accept the scheduler secret as a readiness credential", async () => {
    const response = await GET(request("c".repeat(32)));

    expect(response.status).toBe(401);
    expect(state.verifyDatabaseMigrationLedger).not.toHaveBeenCalled();
    expect(state.verifyLiveSyncStore).not.toHaveBeenCalled();
    expect(state.createReadinessDatabase).not.toHaveBeenCalled();
    expect(state.probeEnd).not.toHaveBeenCalled();
  });

  it("fails every database check without falling back to the shared pool when the dedicated pool is unavailable", async () => {
    state.createReadinessDatabase.mockImplementation(() => {
      throw new Error("unsafe database configuration");
    });

    const response = await GET(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stage: "demo",
      checks: { passed: 2, total: 6 },
    });
    expect(state.verifyRuntimeDatabaseRole).not.toHaveBeenCalled();
    expect(state.verifyDatabaseMigrationLedger).not.toHaveBeenCalled();
    expect(state.verifyReadinessRateLimitStore).not.toHaveBeenCalled();
    expect(state.verifyLiveSyncStore).not.toHaveBeenCalled();
    expect(state.probeEnd).not.toHaveBeenCalled();
  });

  it("fails within one parallel deadline when database checks never settle", async () => {
    vi.useFakeTimers();
    state.verifyRuntimeDatabaseRole.mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );
    state.verifyLiveSyncStore.mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );

    let settled = false;
    const responsePromise = GET(request()).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const response = await responsePromise;
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      stage: "demo",
      checks: { passed: 4, total: 6 },
    });
    expect(lastErrorRecord()).toMatchObject({
      event: "deployment.readiness.failed",
      failedChecks: ["database_runtime_role", "live_sync"],
      timedOutChecks: ["database_runtime_role", "live_sync"],
    });
    expect(state.probeEnd).toHaveBeenCalledOnce();
    expect(state.probeEnd).toHaveBeenCalledWith({ timeout: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears every dependency deadline after successful checks", async () => {
    vi.useFakeTimers();

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(state.probeEnd).toHaveBeenCalledWith({ timeout: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start dependency deadlines for an unauthorized request", async () => {
    vi.useFakeTimers();

    const response = await GET(request("wrong-secret"));

    expect(response.status).toBe(401);
    expect(state.createReadinessDatabase).not.toHaveBeenCalled();
    expect(state.probeEnd).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(state.verifyRuntimeDatabaseRole).not.toHaveBeenCalled();
  });
});
