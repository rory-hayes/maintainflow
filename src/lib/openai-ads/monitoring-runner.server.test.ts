import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  claimDueMonitoringAccountsMock,
  claimDueMonitoringRecordsMock,
  completeMonitoringAccountAttemptMock,
  evaluateLiveMonitoringWindowMock,
  getAdsApiKeyForAccountMock,
  recordMonitoringOutcomeMock,
  releaseMonitoringAccountAttemptMock,
  releaseMonitoringClaimMock,
} = vi.hoisted(() => ({
  claimDueMonitoringAccountsMock: vi.fn(),
  claimDueMonitoringRecordsMock: vi.fn(),
  completeMonitoringAccountAttemptMock: vi.fn(),
  evaluateLiveMonitoringWindowMock: vi.fn(),
  getAdsApiKeyForAccountMock: vi.fn(),
  recordMonitoringOutcomeMock: vi.fn(),
  releaseMonitoringAccountAttemptMock: vi.fn(),
  releaseMonitoringClaimMock: vi.fn(),
}));

vi.mock("../audit/approval-store.server", () => ({
  claimDueMonitoringAccounts: claimDueMonitoringAccountsMock,
  claimDueMonitoringRecords: claimDueMonitoringRecordsMock,
  completeMonitoringAccountAttempt: completeMonitoringAccountAttemptMock,
  recordMonitoringOutcome: recordMonitoringOutcomeMock,
  releaseMonitoringAccountAttempt: releaseMonitoringAccountAttemptMock,
  releaseMonitoringClaim: releaseMonitoringClaimMock,
}));
vi.mock("../tenancy/store.server", () => ({
  getAdsApiKeyForAccount: getAdsApiKeyForAccountMock,
}));
vi.mock("./monitoring.server", () => ({
  evaluateLiveMonitoringWindow: evaluateLiveMonitoringWindowMock,
}));

import {
  evaluateDueMonitoringWindows,
  evaluateScheduledMonitoringWindows,
} from "./monitoring-runner.server";

const now = new Date("2026-08-30T12:00:00.000Z");
const startedAt = new Date("2026-08-20T00:00:00.000Z");
const endsAt = new Date("2026-08-27T00:00:00.000Z");
const monitoringPlan = {
  kind: "click_attributed_conversion_guardrail" as const,
  windowDays: 7,
  baseline: {
    rangeStart: 1_787_356_800,
    rangeEnd: 1_787_961_600,
    spend: 2_000,
    clickAttributedConversions: 100,
    cpa: 20,
    configuredBidMicros: 25_000_000,
    currencyCode: "EUR",
  },
  rollbackRule: {
    metric: "click_attributed_conversions" as const,
    comparison: "decrease_percent_greater_than" as const,
    thresholdPercent: 15,
  },
};
const result = {
  outcome: "within_safeguard" as const,
  observation: {
    rangeStart: Math.floor(startedAt.getTime() / 1_000),
    rangeEnd: Math.floor(endsAt.getTime() / 1_000),
    spend: 2_100,
    clickAttributedConversions: 105,
    cpa: 20,
    conversionChangePercent: 5,
    baselineClickAttributedConversions: 100,
    thresholdPercent: 15,
    evidenceState: "complete" as const,
  },
};

function record(accountId: string) {
  return {
    id: `approval-${accountId}`,
    entityId: `adgroup-${accountId}`,
    monitoringPlan,
    monitoringStartedAt: startedAt,
    monitoringEndsAt: endsAt,
  };
}

function dueAccount(
  accountId: string,
  dueCount = 1,
  oldestDueAt = endsAt,
) {
  return {
    accountId,
    attemptId: `attempt-${accountId}`,
    dueCount,
    oldestDueAt,
  };
}

describe("scheduled monitoring runner", () => {
  beforeEach(() => {
    claimDueMonitoringAccountsMock.mockReset();
    claimDueMonitoringRecordsMock.mockReset();
    completeMonitoringAccountAttemptMock.mockReset();
    evaluateLiveMonitoringWindowMock.mockReset();
    getAdsApiKeyForAccountMock.mockReset();
    recordMonitoringOutcomeMock.mockReset();
    releaseMonitoringAccountAttemptMock.mockReset();
    releaseMonitoringClaimMock.mockReset();
    completeMonitoringAccountAttemptMock.mockResolvedValue(true);
    evaluateLiveMonitoringWindowMock.mockResolvedValue(result);
    recordMonitoringOutcomeMock.mockResolvedValue(true);
    releaseMonitoringAccountAttemptMock.mockResolvedValue(true);
    releaseMonitoringClaimMock.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves each account credential independently and preserves successful work", async () => {
    claimDueMonitoringAccountsMock.mockResolvedValue([
      dueAccount("adacct_alpha"),
      dueAccount("adacct_beta"),
      dueAccount("adacct_missing_key"),
    ]);
    getAdsApiKeyForAccountMock.mockImplementation(async (accountId: string) => {
      if (accountId === "adacct_missing_key") {
        throw new Error("Credential unavailable");
      }
      return `key-for-${accountId}`;
    });
    claimDueMonitoringRecordsMock.mockImplementation(
      async ({ accountId }: { accountId: string }) => [record(accountId)],
    );

    const summary = await evaluateScheduledMonitoringWindows({
      now,
      maxAccounts: 3,
      windowsPerAccount: 1,
    });

    expect(summary).toEqual({
      accountsSelected: 3,
      accountsProcessed: 2,
      accountsFailed: 1,
      due: 2,
      evaluated: 2,
      failed: 0,
      selectedBacklogDueCount: 3,
      selectedBacklogDueCountCapped: false,
      oldestSelectedBacklogAgeSeconds: 302_400,
      oldestSelectedBacklogAgeCapped: false,
      deadlineExhausted: false,
    });
    expect(JSON.stringify(summary)).not.toContain("adacct_");
    expect(claimDueMonitoringAccountsMock).toHaveBeenCalledWith({
      attemptId: expect.any(String),
      now,
      limit: 3,
    });
    expect(
      claimDueMonitoringAccountsMock.mock.invocationCallOrder[0],
    ).toBeLessThan(getAdsApiKeyForAccountMock.mock.invocationCallOrder[0]);
    expect(getAdsApiKeyForAccountMock).toHaveBeenCalledTimes(3);
    expect(claimDueMonitoringRecordsMock).toHaveBeenCalledTimes(2);
    expect(evaluateLiveMonitoringWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "adgroup-adacct_alpha",
        credential: {
          kind: "account_api_key",
          secret: "key-for-adacct_alpha",
          expectedAccountId: "adacct_alpha",
        },
      }),
    );
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("adacct_missing_key");
    expect(logged).not.toContain("Credential unavailable");
    expect(evaluateLiveMonitoringWindowMock).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "adgroup-adacct_beta",
        credential: {
          kind: "account_api_key",
          secret: "key-for-adacct_beta",
          expectedAccountId: "adacct_beta",
        },
      }),
    );
    expect(completeMonitoringAccountAttemptMock).toHaveBeenCalledWith({
      accountId: "adacct_alpha",
      attemptId: "attempt-adacct_alpha",
      succeeded: true,
      now,
    });
    expect(completeMonitoringAccountAttemptMock).toHaveBeenCalledWith({
      accountId: "adacct_beta",
      attemptId: "attempt-adacct_beta",
      succeeded: true,
      now,
    });
    expect(completeMonitoringAccountAttemptMock).toHaveBeenCalledWith({
      accountId: "adacct_missing_key",
      attemptId: "attempt-adacct_missing_key",
      succeeded: false,
      now,
    });
  });

  it("does not claim provider work without enough route deadline remaining", async () => {
    await expect(
      evaluateScheduledMonitoringWindows({
        now,
        deadlineAt: 10_000,
        clock: () => 8_001,
      }),
    ).resolves.toEqual({
      accountsSelected: 0,
      accountsProcessed: 0,
      accountsFailed: 0,
      due: 0,
      evaluated: 0,
      failed: 0,
      selectedBacklogDueCount: 0,
      selectedBacklogDueCountCapped: false,
      oldestSelectedBacklogAgeSeconds: 0,
      oldestSelectedBacklogAgeCapped: false,
      deadlineExhausted: true,
    });
    expect(claimDueMonitoringAccountsMock).not.toHaveBeenCalled();
  });

  it("releases selected account attempts if the provider deadline expires after selection", async () => {
    claimDueMonitoringAccountsMock.mockResolvedValue([
      dueAccount("adacct_alpha"),
      dueAccount("adacct_beta"),
    ]);
    const clock = vi.fn().mockReturnValueOnce(0).mockReturnValue(9_000);

    await expect(
      evaluateScheduledMonitoringWindows({
        now,
        maxAccounts: 2,
        windowsPerAccount: 1,
        deadlineAt: 10_000,
        clock,
      }),
    ).resolves.toMatchObject({
      accountsSelected: 2,
      accountsProcessed: 0,
      accountsFailed: 2,
      deadlineExhausted: true,
    });
    expect(getAdsApiKeyForAccountMock).not.toHaveBeenCalled();
    expect(releaseMonitoringAccountAttemptMock).toHaveBeenCalledWith({
      accountId: "adacct_alpha",
      attemptId: "attempt-adacct_alpha",
      now,
    });
    expect(releaseMonitoringAccountAttemptMock).toHaveBeenCalledWith({
      accountId: "adacct_beta",
      attemptId: "attempt-adacct_beta",
      now,
    });
    expect(completeMonitoringAccountAttemptMock).not.toHaveBeenCalled();
  });

  it("releases record and account claims without backoff when the shared provider budget expires", async () => {
    vi.useFakeTimers();
    try {
      claimDueMonitoringAccountsMock.mockResolvedValue([
        dueAccount("adacct_alpha"),
      ]);
      getAdsApiKeyForAccountMock.mockResolvedValue("key-for-adacct_alpha");
      claimDueMonitoringRecordsMock.mockResolvedValue([
        record("adacct_alpha"),
      ]);
      evaluateLiveMonitoringWindowMock.mockImplementation(
        async ({ providerBudget }: { providerBudget: { signal: AbortSignal } }) =>
          new Promise((_resolve, reject) => {
            providerBudget.signal.addEventListener(
              "abort",
              () => reject(providerBudget.signal.reason),
              { once: true },
            );
          }),
      );

      const pending = evaluateScheduledMonitoringWindows({
        now,
        maxAccounts: 1,
        windowsPerAccount: 1,
        deadlineAt: 3_000,
        clock: () => 0,
      });
      await vi.advanceTimersByTimeAsync(3_000);

      await expect(pending).resolves.toMatchObject({
        accountsSelected: 1,
        accountsProcessed: 0,
        accountsFailed: 1,
        deadlineExhausted: true,
      });
      expect(releaseMonitoringClaimMock).toHaveBeenCalledOnce();
      expect(releaseMonitoringAccountAttemptMock).toHaveBeenCalledWith({
        accountId: "adacct_alpha",
        attemptId: "attempt-adacct_alpha",
        now,
      });
      expect(completeMonitoringAccountAttemptMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves past six broken accounts and processes the seventh account on the next run", async () => {
    const brokenAccounts = Array.from(
      { length: 6 },
      (_, index) => `adacct_broken_${index + 1}`,
    );
    claimDueMonitoringAccountsMock
      .mockResolvedValueOnce(
        brokenAccounts.map((accountId, index) =>
          dueAccount(
            accountId,
            4,
            new Date(endsAt.getTime() + index * 60_000),
          ),
        ),
      )
      .mockResolvedValueOnce([dueAccount("adacct_seventh")]);
    getAdsApiKeyForAccountMock.mockImplementation(async (accountId: string) => {
      if (accountId.startsWith("adacct_broken_")) {
        throw new Error("Credential unavailable");
      }
      return `key-for-${accountId}`;
    });
    claimDueMonitoringRecordsMock.mockImplementation(
      async ({ accountId }: { accountId: string }) => [record(accountId)],
    );

    const first = await evaluateScheduledMonitoringWindows({
      now,
      maxAccounts: 6,
      windowsPerAccount: 1,
    });
    const second = await evaluateScheduledMonitoringWindows({
      now: new Date(now.getTime() + 1_000),
      maxAccounts: 6,
      windowsPerAccount: 1,
    });

    expect(first).toMatchObject({
      accountsSelected: 6,
      accountsProcessed: 0,
      accountsFailed: 6,
      selectedBacklogDueCount: 24,
    });
    expect(second).toMatchObject({
      accountsSelected: 1,
      accountsProcessed: 1,
      accountsFailed: 0,
      due: 1,
      evaluated: 1,
    });
    expect(claimDueMonitoringRecordsMock).toHaveBeenCalledTimes(1);
    expect(claimDueMonitoringRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "adacct_seventh" }),
    );
    const firstAttemptId =
      claimDueMonitoringAccountsMock.mock.calls[0]?.[0].attemptId;
    const secondAttemptId =
      claimDueMonitoringAccountsMock.mock.calls[1]?.[0].attemptId;
    expect(firstAttemptId).not.toBe(secondAttemptId);
    for (const accountId of brokenAccounts) {
      expect(completeMonitoringAccountAttemptMock).toHaveBeenCalledWith({
        accountId,
        attemptId: `attempt-${accountId}`,
        succeeded: false,
        now,
      });
    }
    expect(completeMonitoringAccountAttemptMock).toHaveBeenCalledWith({
      accountId: "adacct_seventh",
      attemptId: "attempt-adacct_seventh",
      succeeded: true,
      now: new Date(now.getTime() + 1_000),
    });
  });

  it("rotates a successful high-backlog cohort behind an untouched account", async () => {
    const firstCohort = Array.from(
      { length: 6 },
      (_, index) => `adacct_backlog_${index + 1}`,
    );
    claimDueMonitoringAccountsMock
      .mockResolvedValueOnce(
        firstCohort.map((accountId) => dueAccount(accountId, 100)),
      )
      .mockResolvedValueOnce([dueAccount("adacct_backlog_7", 1)]);
    getAdsApiKeyForAccountMock.mockImplementation(
      async (accountId: string) => `key-for-${accountId}`,
    );
    claimDueMonitoringRecordsMock.mockImplementation(
      async ({ accountId }: { accountId: string }) => [record(accountId)],
    );

    await evaluateScheduledMonitoringWindows({
      now,
      maxAccounts: 6,
      windowsPerAccount: 1,
    });
    await evaluateScheduledMonitoringWindows({
      now: new Date(now.getTime() + 1_000),
      maxAccounts: 6,
      windowsPerAccount: 1,
    });

    expect(claimDueMonitoringRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "adacct_backlog_7" }),
    );
    expect(getAdsApiKeyForAccountMock).toHaveBeenCalledWith(
      "adacct_backlog_7",
    );
  });

  it("releases the exact claim after a handled provider read failure", async () => {
    claimDueMonitoringRecordsMock.mockResolvedValue([
      record("adacct_alpha"),
    ]);
    evaluateLiveMonitoringWindowMock.mockRejectedValue(
      new Error("Provider unavailable"),
    );

    await expect(
      evaluateDueMonitoringWindows({
        accountId: "adacct_alpha",
        credential: { apiKey: "key-for-adacct_alpha" },
        now,
        limit: 1,
      }),
    ).resolves.toEqual({ due: 1, evaluated: 0, failed: 1 });
    expect(recordMonitoringOutcomeMock).not.toHaveBeenCalled();
    expect(claimDueMonitoringRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "adacct_alpha",
        now,
        limit: 1,
        claimId: expect.any(String),
      }),
    );
    const claimId = claimDueMonitoringRecordsMock.mock.calls[0]?.[0].claimId;
    expect(releaseMonitoringClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseMonitoringClaimMock).toHaveBeenCalledWith({
      id: "approval-adacct_alpha",
      accountId: "adacct_alpha",
      claimId,
    });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("approval-adacct_alpha");
    expect(logged).not.toContain("Provider unavailable");
  });

  it("releases the exact claim after a handled outcome persistence failure", async () => {
    claimDueMonitoringRecordsMock.mockResolvedValue([
      record("adacct_alpha"),
    ]);
    recordMonitoringOutcomeMock.mockRejectedValue(
      new Error("Persistence unavailable"),
    );

    await expect(
      evaluateDueMonitoringWindows({
        accountId: "adacct_alpha",
        credential: { apiKey: "key-for-adacct_alpha" },
        now,
        limit: 1,
      }),
    ).resolves.toEqual({ due: 1, evaluated: 0, failed: 1 });

    const claimId = claimDueMonitoringRecordsMock.mock.calls[0]?.[0].claimId;
    expect(recordMonitoringOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "approval-adacct_alpha",
        accountId: "adacct_alpha",
        claimId,
      }),
    );
    expect(releaseMonitoringClaimMock).toHaveBeenCalledTimes(1);
    expect(releaseMonitoringClaimMock).toHaveBeenCalledWith({
      id: "approval-adacct_alpha",
      accountId: "adacct_alpha",
      claimId,
    });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("approval-adacct_alpha");
    expect(logged).not.toContain("Persistence unavailable");
  });
});
