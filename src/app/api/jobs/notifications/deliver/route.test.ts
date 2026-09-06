import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => ({
  deliver: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/approvals/notification-delivery.server", () => ({
  deliverApprovalNotifications: testState.deliver,
}));

vi.mock("@/lib/observability/logger.server", () => ({
  createServerLogger: () => ({
    runId: "notification-run",
    info: testState.info,
    warn: vi.fn(),
    error: testState.error,
  }),
}));

import { GET } from "./route";

const secret = "n".repeat(32);

function request(authorization?: string) {
  return new Request("https://maintainflow.io/api/jobs/notifications/deliver", {
    headers: authorization ? { authorization } : {},
  });
}

function summary(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    claimed: 2,
    accepted: 2,
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
    ...overrides,
  };
}

describe("approval notification cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CRON_SECRET", secret);
    testState.deliver.mockResolvedValue(summary());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fails closed when the cron secret is absent or too short", async () => {
    vi.stubEnv("CRON_SECRET", "short");

    const response = await GET(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(testState.deliver).not.toHaveBeenCalled();
  });

  it("rejects a missing or incorrect bearer secret", async () => {
    const missing = await GET(request());
    const incorrect = await GET(request(`Bearer ${"x".repeat(32)}`));

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(missing.headers.get("cache-control")).toBe("no-store");
    expect(incorrect.headers.get("cache-control")).toBe("no-store");
    expect(testState.deliver).not.toHaveBeenCalled();
  });

  it("returns a privacy-safe successful summary", async () => {
    const response = await GET(request(`Bearer ${secret}`));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(payload).toEqual({ ok: true, ...summary() });
    expect(testState.deliver).toHaveBeenCalledWith({ limit: 25 });
    expect(testState.info).toHaveBeenCalledWith(
      "approval_notifications.run.completed",
      expect.objectContaining({
        status: 200,
        counts: expect.objectContaining({
          notificationClaimed: 2,
          notificationAccepted: 2,
        }),
      }),
    );
  });

  it("signals a retry when any claimed delivery was not safely finalized", async () => {
    testState.deliver.mockResolvedValue(
      summary({ accepted: 1, retryScheduled: 1 }),
    );

    const response = await GET(request(`Bearer ${secret}`));

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("300");
    expect(testState.error).toHaveBeenCalledWith(
      "approval_notifications.run.completed_with_failures",
      expect.objectContaining({ status: 503 }),
    );
  });

  it.each([
    ["cancelledIneligible", "notificationRecoveryCancelledIneligible"],
    [
      "retryScheduledAfterLeaseExpiry",
      "notificationRecoveryRetryScheduledAfterLeaseExpiry",
    ],
    [
      "permanentFailuresAfterLeaseExpiry",
      "notificationRecoveryPermanentFailuresAfterLeaseExpiry",
    ],
    [
      "permanentFailuresAfterIdempotencyExpiry",
      "notificationRecoveryPermanentFailuresAfterIdempotencyExpiry",
    ],
    [
      "permanentFailuresAfterConfirmationTimeout",
      "notificationRecoveryPermanentFailuresAfterConfirmationTimeout",
    ],
  ] as const)(
    "signals operator attention for recovered %s",
    async (recoveryField, logField) => {
      testState.deliver.mockResolvedValue(
        summary({
          claimed: 0,
          accepted: 0,
          recovery: {
            cancelledIneligible: 0,
            retryScheduledAfterLeaseExpiry: 0,
            permanentFailuresAfterLeaseExpiry: 0,
            permanentFailuresAfterIdempotencyExpiry: 0,
            permanentFailuresAfterConfirmationTimeout: 0,
            [recoveryField]: 1,
          },
        }),
      );

      const response = await GET(request(`Bearer ${secret}`));
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("300");
      expect(payload).toMatchObject({
        ok: false,
        recovery: { [recoveryField]: 1 },
      });
      expect(testState.error).toHaveBeenCalledWith(
        "approval_notifications.run.completed_with_failures",
        expect.objectContaining({
          status: 503,
          counts: expect.objectContaining({
            [logField]: 1,
          }),
        }),
      );
    },
  );

  it("does not expose a worker exception", async () => {
    testState.deliver.mockRejectedValue(new Error("postgres://private"));

    const response = await GET(request(`Bearer ${secret}`));
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain("postgres://private");
    expect(response.headers.get("retry-after")).toBe("300");
  });
});
