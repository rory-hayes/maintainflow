import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  claimDueMonitoringRecordsMock,
  evaluateLiveMonitoringWindowMock,
  getAdsApiKeyForAccountMock,
  listDueMonitoringAccountIdsMock,
  recordMonitoringOutcomeMock,
} = vi.hoisted(() => ({
  claimDueMonitoringRecordsMock: vi.fn(),
  evaluateLiveMonitoringWindowMock: vi.fn(),
  getAdsApiKeyForAccountMock: vi.fn(),
  listDueMonitoringAccountIdsMock: vi.fn(),
  recordMonitoringOutcomeMock: vi.fn(),
}));

vi.mock("../audit/approval-store.server", () => ({
  claimDueMonitoringRecords: claimDueMonitoringRecordsMock,
  listDueMonitoringAccountIds: listDueMonitoringAccountIdsMock,
  recordMonitoringOutcome: recordMonitoringOutcomeMock,
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

describe("scheduled monitoring runner", () => {
  beforeEach(() => {
    claimDueMonitoringRecordsMock.mockReset();
    evaluateLiveMonitoringWindowMock.mockReset();
    getAdsApiKeyForAccountMock.mockReset();
    listDueMonitoringAccountIdsMock.mockReset();
    recordMonitoringOutcomeMock.mockReset();
    evaluateLiveMonitoringWindowMock.mockResolvedValue(result);
    recordMonitoringOutcomeMock.mockResolvedValue(true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves each account credential independently and preserves successful work", async () => {
    listDueMonitoringAccountIdsMock.mockResolvedValue([
      "adacct_alpha",
      "adacct_beta",
      "adacct_missing_key",
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
    });
    expect(JSON.stringify(summary)).not.toContain("adacct_");
    expect(listDueMonitoringAccountIdsMock).toHaveBeenCalledWith(now, 3);
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
  });

  it("keeps a failed provider read unevaluated for lease-expiry retry", async () => {
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
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).not.toContain("approval-adacct_alpha");
    expect(logged).not.toContain("Provider unavailable");
  });
});
