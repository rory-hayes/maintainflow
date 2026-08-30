import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  evaluateScheduledMonitoringWindowsMock,
  isReadinessRateLimitConfiguredMock,
  pruneExpiredReadinessRateLimitBucketsMock,
  pruneExpiredLiveSyncSnapshotsMock,
  verifyApprovalStoreMock,
  verifyCredentialStoreMock,
  verifyTenancyStoreMock,
  verifyLiveSyncStoreMock,
} = vi.hoisted(() => ({
  evaluateScheduledMonitoringWindowsMock: vi.fn(),
  isReadinessRateLimitConfiguredMock: vi.fn(),
  pruneExpiredReadinessRateLimitBucketsMock: vi.fn(),
  pruneExpiredLiveSyncSnapshotsMock: vi.fn(),
  verifyApprovalStoreMock: vi.fn(),
  verifyCredentialStoreMock: vi.fn(),
  verifyTenancyStoreMock: vi.fn(),
  verifyLiveSyncStoreMock: vi.fn(),
}));

vi.mock("@/lib/audit/approval-store.server", () => ({
  verifyApprovalStore: verifyApprovalStoreMock,
}));
vi.mock("@/lib/openai-ads/monitoring-runner.server", () => ({
  evaluateScheduledMonitoringWindows: evaluateScheduledMonitoringWindowsMock,
}));
vi.mock("@/lib/openai-ads/live-sync-store.server", () => ({
  pruneExpiredLiveSyncSnapshots: pruneExpiredLiveSyncSnapshotsMock,
  verifyLiveSyncStore: verifyLiveSyncStoreMock,
}));
vi.mock("@/lib/readiness/rate-limit.server", () => ({
  isReadinessRateLimitConfigured: isReadinessRateLimitConfiguredMock,
  pruneExpiredReadinessRateLimitBuckets:
    pruneExpiredReadinessRateLimitBucketsMock,
}));
vi.mock("@/lib/tenancy/store.server", () => ({
  verifyCredentialStore: verifyCredentialStoreMock,
  verifyTenancyStore: verifyTenancyStoreMock,
}));

import { GET } from "./route";

const originalSecret = process.env.CRON_SECRET;

function request(authorization?: string) {
  return new Request("https://maintainflow.example/api/jobs/monitoring/evaluate", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("scheduled monitoring route", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret-at-least-32-characters";
    verifyApprovalStoreMock.mockReset();
    verifyCredentialStoreMock.mockReset();
    verifyTenancyStoreMock.mockReset();
    verifyLiveSyncStoreMock.mockReset();
    evaluateScheduledMonitoringWindowsMock.mockReset();
    isReadinessRateLimitConfiguredMock.mockReset();
    pruneExpiredReadinessRateLimitBucketsMock.mockReset();
    pruneExpiredLiveSyncSnapshotsMock.mockReset();
    verifyApprovalStoreMock.mockResolvedValue(true);
    verifyCredentialStoreMock.mockResolvedValue(true);
    verifyTenancyStoreMock.mockResolvedValue(true);
    verifyLiveSyncStoreMock.mockResolvedValue(true);
    evaluateScheduledMonitoringWindowsMock.mockResolvedValue({
      accountsSelected: 2,
      accountsProcessed: 2,
      accountsFailed: 0,
      due: 3,
      evaluated: 3,
      failed: 0,
    });
    isReadinessRateLimitConfiguredMock.mockReturnValue(true);
    pruneExpiredReadinessRateLimitBucketsMock.mockResolvedValue(0);
    pruneExpiredLiveSyncSnapshotsMock.mockResolvedValue(0);
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });

  it("rejects missing or incorrect bearer authorization before any database read", async () => {
    await expect(GET(request())).resolves.toMatchObject({ status: 401 });
    await expect(GET(request("Bearer wrong-secret"))).resolves.toMatchObject({
      status: 401,
    });
    expect(verifyApprovalStoreMock).not.toHaveBeenCalled();
    expect(evaluateScheduledMonitoringWindowsMock).not.toHaveBeenCalled();
  });

  it("returns a non-cached aggregate without exposing account identifiers", async () => {
    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({
      ok: true,
      monitoringUnavailable: false,
      maintenanceFailed: false,
      maintenanceBacklog: false,
      accountsSelected: 2,
      accountsProcessed: 2,
      accountsFailed: 0,
      due: 3,
      evaluated: 3,
      failed: 0,
    });
    expect(JSON.stringify(payload)).not.toContain("adacct_");
    expect(pruneExpiredReadinessRateLimitBucketsMock).toHaveBeenCalledWith(
      expect.any(Date),
      5_000,
    );
    expect(pruneExpiredLiveSyncSnapshotsMock).toHaveBeenCalledWith({
      now: expect.any(Date),
      retentionMs: 86_400_000,
      limit: 5_000,
    });
  });

  it("surfaces partial account failures to the scheduler without discarding successful work", async () => {
    evaluateScheduledMonitoringWindowsMock.mockResolvedValue({
      accountsSelected: 2,
      accountsProcessed: 1,
      accountsFailed: 1,
      due: 1,
      evaluated: 1,
      failed: 0,
    });

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      accountsFailed: 1,
      evaluated: 1,
    });
  });

  it("fails closed when the encrypted credential store is not ready", async () => {
    verifyCredentialStoreMock.mockResolvedValue(false);

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );
    expect(response.status).toBe(503);
    expect(evaluateScheduledMonitoringWindowsMock).not.toHaveBeenCalled();
    expect(pruneExpiredLiveSyncSnapshotsMock).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      monitoringUnavailable: true,
      maintenanceFailed: false,
    });
  });

  it("surfaces snapshot-retention failure without discarding monitoring results", async () => {
    pruneExpiredLiveSyncSnapshotsMock.mockRejectedValue(
      new Error("private database detail"),
    );

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      maintenanceFailed: true,
      evaluated: 3,
    });
  });

  it("still evaluates monitoring when snapshot storage is unavailable", async () => {
    verifyLiveSyncStoreMock.mockResolvedValue(false);

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(evaluateScheduledMonitoringWindowsMock).toHaveBeenCalledOnce();
    expect(pruneExpiredLiveSyncSnapshotsMock).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      maintenanceFailed: true,
      evaluated: 3,
    });
  });

  it("surfaces a bounded maintenance backlog for external alerting", async () => {
    pruneExpiredLiveSyncSnapshotsMock.mockResolvedValue(5_000);

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      maintenanceBacklog: true,
      maintenanceFailed: false,
      evaluated: 3,
    });
  });

  it("fails closed when the cron secret is absent", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request("Bearer undefined"));
    expect(response.status).toBe(503);
    expect(verifyApprovalStoreMock).not.toHaveBeenCalled();
  });

  it("fails closed when the cron secret is shorter than 32 characters", async () => {
    process.env.CRON_SECRET = "c".repeat(31);
    const response = await GET(request(`Bearer ${process.env.CRON_SECRET}`));
    expect(response.status).toBe(503);
    expect(verifyApprovalStoreMock).not.toHaveBeenCalled();
  });
});
