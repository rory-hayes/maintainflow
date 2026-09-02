import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  evaluateScheduledMonitoringWindowsMock,
  isReadinessRateLimitConfiguredMock,
  pruneExpiredReadinessRateLimitBucketsMock,
  pruneExpiredLiveSyncSnapshotsMock,
  countUnresolvedApprovalOperationsMock,
  recoverStaleApprovalOperationsMock,
  summarizeDueMonitoringBacklogMock,
  verifyApprovalStoreMock,
  verifyCredentialStoreMock,
  verifyTenancyStoreMock,
  verifyLiveSyncStoreMock,
} = vi.hoisted(() => ({
  evaluateScheduledMonitoringWindowsMock: vi.fn(),
  isReadinessRateLimitConfiguredMock: vi.fn(),
  pruneExpiredReadinessRateLimitBucketsMock: vi.fn(),
  pruneExpiredLiveSyncSnapshotsMock: vi.fn(),
  countUnresolvedApprovalOperationsMock: vi.fn(),
  recoverStaleApprovalOperationsMock: vi.fn(),
  summarizeDueMonitoringBacklogMock: vi.fn(),
  verifyApprovalStoreMock: vi.fn(),
  verifyCredentialStoreMock: vi.fn(),
  verifyTenancyStoreMock: vi.fn(),
  verifyLiveSyncStoreMock: vi.fn(),
}));

vi.mock("@/lib/audit/approval-store.server", () => ({
  countUnresolvedApprovalOperations: countUnresolvedApprovalOperationsMock,
  recoverStaleApprovalOperations: recoverStaleApprovalOperationsMock,
  summarizeDueMonitoringBacklog: summarizeDueMonitoringBacklogMock,
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
const originalReleaseStage = process.env.MAINTAINFLOW_RELEASE_STAGE;

function request(authorization?: string) {
  return new Request("https://maintainflow.example/api/jobs/monitoring/evaluate", {
    headers: authorization ? { authorization } : undefined,
  });
}

describe("scheduled monitoring route", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    process.env.CRON_SECRET = "cron-secret-at-least-32-characters";
    process.env.MAINTAINFLOW_RELEASE_STAGE = "private_read";
    verifyApprovalStoreMock.mockReset();
    verifyCredentialStoreMock.mockReset();
    verifyTenancyStoreMock.mockReset();
    verifyLiveSyncStoreMock.mockReset();
    evaluateScheduledMonitoringWindowsMock.mockReset();
    isReadinessRateLimitConfiguredMock.mockReset();
    pruneExpiredReadinessRateLimitBucketsMock.mockReset();
    pruneExpiredLiveSyncSnapshotsMock.mockReset();
    countUnresolvedApprovalOperationsMock.mockReset();
    recoverStaleApprovalOperationsMock.mockReset();
    summarizeDueMonitoringBacklogMock.mockReset();
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
      deadlineExhausted: false,
    });
    isReadinessRateLimitConfiguredMock.mockReturnValue(true);
    pruneExpiredReadinessRateLimitBucketsMock.mockResolvedValue(0);
    pruneExpiredLiveSyncSnapshotsMock.mockResolvedValue(0);
    countUnresolvedApprovalOperationsMock.mockResolvedValue(0);
    recoverStaleApprovalOperationsMock.mockResolvedValue({
      recovered: 0,
      apply: 0,
      rollback: 0,
      backlog: false,
    });
    summarizeDueMonitoringBacklogMock.mockResolvedValue({
      dueAccounts: 0,
      dueWindows: 0,
      dueAccountsCapped: false,
      dueWindowsCapped: false,
    });
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
    if (originalReleaseStage === undefined) {
      delete process.env.MAINTAINFLOW_RELEASE_STAGE;
    } else {
      process.env.MAINTAINFLOW_RELEASE_STAGE = originalReleaseStage;
    }
    vi.restoreAllMocks();
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
      releaseStage: "private_read",
      providerMonitoringPaused: false,
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
      accountsSelected: 2,
      accountsProcessed: 2,
      accountsFailed: 0,
      due: 3,
      evaluated: 3,
      failed: 0,
      deadlineExhausted: false,
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
    expect(recoverStaleApprovalOperationsMock).toHaveBeenCalledWith({
      now: expect.any(Date),
      limit: 500,
    });
    const recoveryNow = recoverStaleApprovalOperationsMock.mock.calls[0]?.[0]
      ?.now;
    expect(countUnresolvedApprovalOperationsMock).toHaveBeenCalledWith({
      now: recoveryNow,
    });
    expect(evaluateScheduledMonitoringWindowsMock).toHaveBeenCalledWith({
      maxAccounts: 2,
      windowsPerAccount: 1,
      deadlineAt: expect.any(Number),
    });
    expect(console.info).toHaveBeenCalledOnce();
    expect(
      JSON.parse(String(vi.mocked(console.info).mock.calls[0][0])),
    ).toMatchObject({
      event: "monitoring.run.completed",
      status: 200,
      counts: { accountsProcessed: 2, evaluated: 3 },
    });
  });

  it("pauses provider monitoring in demo while reporting due work and completing maintenance", async () => {
    process.env.MAINTAINFLOW_RELEASE_STAGE = "demo";
    summarizeDueMonitoringBacklogMock.mockResolvedValue({
      dueAccounts: 2,
      dueWindows: 7,
      dueAccountsCapped: false,
      dueWindowsCapped: false,
    });

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(200);
    expect(evaluateScheduledMonitoringWindowsMock).not.toHaveBeenCalled();
    expect(recoverStaleApprovalOperationsMock).toHaveBeenCalledOnce();
    expect(pruneExpiredLiveSyncSnapshotsMock).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      releaseStage: "demo",
      providerMonitoringPaused: true,
      pausedBacklog: {
        dueAccounts: 2,
        dueWindows: 7,
        dueAccountsCapped: false,
        dueWindowsCapped: false,
      },
      accountsProcessed: 0,
      failed: 0,
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
    const log = JSON.parse(
      String(vi.mocked(console.error).mock.calls.at(-1)?.[0]),
    );
    expect(log).toMatchObject({
      event: "monitoring.run.completed_with_failures",
      status: 503,
      counts: { accountsFailed: 1, evaluated: 1 },
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

  it("surfaces recovered interrupted provider operations for operator reconciliation", async () => {
    recoverStaleApprovalOperationsMock.mockResolvedValue({
      recovered: 2,
      apply: 1,
      rollback: 1,
      backlog: false,
    });

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      approvalOperationsRecovered: 2,
      maintenanceFailed: false,
      maintenanceBacklog: false,
    });
  });

  it("keeps the scheduler unhealthy while provider outcomes remain unresolved", async () => {
    countUnresolvedApprovalOperationsMock.mockResolvedValue(2);

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("300");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      approvalOperationsRecovered: 0,
      unresolvedApprovalOperations: 2,
      maintenanceFailed: false,
    });
  });

  it("fails closed when interrupted-operation recovery is unavailable", async () => {
    recoverStaleApprovalOperationsMock.mockRejectedValue(
      new Error("private database detail"),
    );

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      approvalOperationsRecovered: 0,
      maintenanceFailed: true,
    });
  });

  it("fails closed when the unresolved-operation ledger cannot be counted", async () => {
    countUnresolvedApprovalOperationsMock.mockRejectedValue(
      new Error("private database detail"),
    );

    const response = await GET(
      request(`Bearer ${process.env.CRON_SECRET}`),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      unresolvedApprovalOperations: 0,
      maintenanceFailed: true,
    });
    const log = JSON.parse(
      String(vi.mocked(console.error).mock.calls.at(-2)?.[0]),
    );
    expect(log).toMatchObject({
      event: "monitoring.approval_ledger.failed",
      errorKind: "application_error",
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
