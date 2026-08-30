import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OpenAIAdsApiError, type AdsApiCredential } from "./client.server";
import type { LiveWorkbenchData } from "./data.server";
import {
  LIVE_SYNC_LEASE_MS,
  LIVE_SYNC_LEASE_RENEWAL_MS,
  LiveSyncUnavailableError,
  createLiveSyncCoordinator,
  type LiveSyncCoordinatorDependencies,
  type LiveSyncState,
} from "./live-sync.server";
import type { AdAccount } from "./schema";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function credential(accountId: string): AdsApiCredential {
  return {
    kind: "account_api_key",
    secret: `secret-for-${accountId}`,
    expectedAccountId: accountId,
  };
}

function workbench(
  accountId: string,
  syncedAt = NOW.toISOString(),
): LiveWorkbenchData {
  return {
    account: { id: accountId } as AdAccount,
    campaigns: [],
    ads: [],
    performance: [],
    recommendations: [],
    conversionMeasurement: {} as LiveWorkbenchData["conversionMeasurement"],
    syncedAt,
  };
}

function state(
  overrides: Partial<LiveSyncState> = {},
): LiveSyncState {
  return {
    snapshot: null,
    payloadSchemaVersion: null,
    snapshotBytes: null,
    syncedAt: null,
    freshUntil: null,
    staleUntil: null,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailedAt: null,
    retryAfter: null,
    claim: null,
    ...overrides,
  };
}

function snapshot(
  data: LiveWorkbenchData,
  freshness: "fresh" | "stale",
): Partial<LiveSyncState> {
  return {
    snapshot: data,
    payloadSchemaVersion: 1,
    snapshotBytes: 1,
    syncedAt: new Date(data.syncedAt),
    freshUntil: new Date(
      NOW.getTime() + (freshness === "fresh" ? 60_000 : -1),
    ),
    staleUntil: new Date(NOW.getTime() + 10 * 60_000),
  };
}

function claim(claimId = "claim_1") {
  return {
    claimId,
    claimedAt: NOW,
    expiresAt: new Date(NOW.getTime() + LIVE_SYNC_LEASE_MS),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function dependencies(
  overrides: Partial<LiveSyncCoordinatorDependencies> = {},
): LiveSyncCoordinatorDependencies {
  return {
    verifyLiveSyncStore: vi.fn(async () => true),
    readLiveSyncState: vi.fn(async () => state()),
    claimLiveSyncRefresh: vi.fn(async () => claim()),
    renewLiveSyncClaim: vi.fn(async () => true),
    completeLiveSyncRefresh: vi.fn(async () => true),
    failLiveSyncRefresh: vi.fn(async () => true),
    fetchLiveWorkbenchData: vi.fn(async (_account, suppliedCredential) =>
      workbench(
        (suppliedCredential as { expectedAccountId: string }).expectedAccountId,
      ),
    ),
    now: () => new Date(NOW),
    sleep: vi.fn(async () => {}),
    scheduleInterval: vi.fn(() => () => {}),
    ...overrides,
  };
}

describe("live Ads sync coordinator", () => {
  it("returns a fresh dashboard snapshot without claiming or calling the provider", async () => {
    const cached = workbench("acct_fresh", "2026-08-30T11:59:30.000Z");
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () =>
        state({ ...snapshot(cached, "fresh") }),
      ),
    });

    const result = await createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_fresh",
      credential: credential("acct_fresh"),
      credentialGeneration: "4",
      policy: "dashboard",
    });

    expect(result).toEqual({ data: cached, freshness: "fresh" });
    expect(deps.claimLiveSyncRefresh).not.toHaveBeenCalled();
    expect(deps.fetchLiveWorkbenchData).not.toHaveBeenCalled();
  });

  it("allows one refresh per account generation and serves stale data to a contending dashboard", async () => {
    const cached = workbench("acct_shared", "2026-08-30T11:50:00.000Z");
    const refreshed = workbench("acct_shared", "2026-08-30T12:00:01.000Z");
    let currentState = state({ ...snapshot(cached, "stale") });
    const provider = deferred<LiveWorkbenchData>();
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () => currentState),
      claimLiveSyncRefresh: vi.fn(async () => {
        const acquired = claim();
        currentState = { ...currentState, claim: acquired };
        return acquired;
      }),
      fetchLiveWorkbenchData: vi.fn(() => provider.promise),
    });
    const coordinator = createLiveSyncCoordinator(deps);
    const input = {
      accountId: "acct_shared",
      credential: credential("acct_shared"),
      credentialGeneration: "7",
      policy: "dashboard" as const,
    };

    const refreshing = coordinator.getLiveWorkbench(input);
    await vi.waitFor(() =>
      expect(deps.fetchLiveWorkbenchData).toHaveBeenCalledTimes(1),
    );
    const contending = await coordinator.getLiveWorkbench(input);
    provider.resolve(refreshed);

    await expect(refreshing).resolves.toEqual({
      data: refreshed,
      freshness: "refreshed",
    });
    expect(contending).toEqual({
      data: cached,
      freshness: "stale",
      refreshFailure: "refresh_contended",
    });
    expect(deps.fetchLiveWorkbenchData).toHaveBeenCalledTimes(1);
  });

  it("keeps claims and completions separated by account and credential generation", async () => {
    const deps = dependencies({
      claimLiveSyncRefresh: vi.fn(async (input) =>
        claim(`${input.accountId}_${input.credentialGeneration}`),
      ),
    });
    const coordinator = createLiveSyncCoordinator(deps);
    const keys = [
      { accountId: "acct_a", credentialGeneration: "1" },
      { accountId: "acct_a", credentialGeneration: "2" },
      { accountId: "acct_b", credentialGeneration: "1" },
    ];

    await Promise.all(
      keys.map((key) =>
        coordinator.getLiveWorkbench({
          ...key,
          credential: credential(key.accountId),
          policy: "dashboard",
        }),
      ),
    );

    for (const key of keys) {
      expect(deps.claimLiveSyncRefresh).toHaveBeenCalledWith(
        expect.objectContaining(key),
      );
      expect(deps.completeLiveSyncRefresh).toHaveBeenCalledWith(
        expect.objectContaining(key),
      );
    }
    expect(deps.fetchLiveWorkbenchData).toHaveBeenCalledTimes(3);
  });

  it("falls back to stale dashboard data and persists only a bounded safe failure", async () => {
    const cached = workbench("acct_stale", "2026-08-30T11:50:00.000Z");
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () =>
        state({
          ...snapshot(cached, "stale"),
          consecutiveFailures: 2,
        }),
      ),
      fetchLiveWorkbenchData: vi.fn(async () => {
        throw new OpenAIAdsApiError(429, "600", {
          retryAfterMs: 10 * 60_000,
        });
      }),
    });

    const result = await createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_stale",
      credential: credential("acct_stale"),
      credentialGeneration: "3",
      policy: "dashboard",
    });

    expect(result).toEqual({
      data: cached,
      freshness: "stale",
      refreshFailure: "provider_rate_limited",
    });
    expect(deps.failLiveSyncRefresh).toHaveBeenCalledWith({
      accountId: "acct_stale",
      credentialGeneration: "3",
      claimId: "claim_1",
      failureCode: "provider_rate_limited",
      now: NOW,
      retryAfter: new Date(NOW.getTime() + 5 * 60_000),
    });
    expect(JSON.stringify((deps.failLiveSyncRefresh as ReturnType<typeof vi.fn>).mock.calls))
      .not.toContain("600");
  });

  it("never accepts the snapshot present when a mutation request starts", async () => {
    const cached = workbench("acct_mutation", "2026-08-30T11:59:00.000Z");
    const initialState = state({ ...snapshot(cached, "fresh") });
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () => initialState),
      claimLiveSyncRefresh: vi.fn(async () => null),
    });

    const request = createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_mutation",
      credential: credential("acct_mutation"),
      credentialGeneration: "5",
      policy: "mutation",
    });

    await expect(request).rejects.toMatchObject({
      status: 503,
      code: "live_sync_unavailable",
      refreshFailure: "refresh_contended",
    });
    expect(deps.fetchLiveWorkbenchData).not.toHaveBeenCalled();
  });

  it("accepts a newer fresh snapshot that wins the claim race for a mutation", async () => {
    const cached = workbench("acct_race", "2026-08-30T11:55:00.000Z");
    const refreshed = workbench("acct_race", "2026-08-30T12:00:01.000Z");
    const states = [
      state({ ...snapshot(cached, "fresh") }),
      state({ ...snapshot(refreshed, "fresh") }),
    ];
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () => states.shift() ?? states[0] ?? null),
      claimLiveSyncRefresh: vi.fn(async () => null),
    });

    const result = await createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_race",
      credential: credential("acct_race"),
      credentialGeneration: "5",
      policy: "mutation",
    });

    expect(result).toEqual({ data: refreshed, freshness: "refreshed" });
    expect(deps.fetchLiveWorkbenchData).not.toHaveBeenCalled();
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it("lets a mutation use a newer snapshot completed by the in-flight current refresh", async () => {
    const cached = workbench("acct_wait", "2026-08-30T11:55:00.000Z");
    const refreshed = workbench("acct_wait", "2026-08-30T12:00:01.000Z");
    let currentState = state({
      ...snapshot(cached, "stale"),
      claim: claim("other_claim"),
    });
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () => currentState),
      sleep: vi.fn(async () => {
        currentState = state({ ...snapshot(refreshed, "fresh") });
      }),
    });

    const result = await createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_wait",
      credential: credential("acct_wait"),
      credentialGeneration: "2",
      policy: "mutation",
    });

    expect(result).toEqual({ data: refreshed, freshness: "refreshed" });
    expect(deps.claimLiveSyncRefresh).not.toHaveBeenCalled();
    expect(deps.fetchLiveWorkbenchData).not.toHaveBeenCalled();
  });

  it("discards refreshed provider data when completion reports a lost claim", async () => {
    const cached = workbench("acct_lost", "2026-08-30T11:50:00.000Z");
    const refreshed = workbench("acct_lost", "2026-08-30T12:00:01.000Z");
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () =>
        state({ ...snapshot(cached, "stale") }),
      ),
      fetchLiveWorkbenchData: vi.fn(async () => refreshed),
      completeLiveSyncRefresh: vi.fn(async () => false),
    });

    const result = await createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_lost",
      credential: credential("acct_lost"),
      credentialGeneration: "8",
      policy: "dashboard",
    });

    expect(result).toEqual({
      data: cached,
      freshness: "stale",
      refreshFailure: "claim_lost",
    });
  });

  it("fails closed and records a safe code when the provider account ID differs", async () => {
    const deps = dependencies({
      fetchLiveWorkbenchData: vi.fn(async () =>
        workbench("private-unexpected-account"),
      ),
    });
    const request = createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_expected",
      credential: credential("acct_expected"),
      credentialGeneration: "9",
      policy: "mutation",
    });

    const error = await request.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LiveSyncUnavailableError);
    expect(error).toMatchObject({
      status: 503,
      refreshFailure: "account_mismatch",
    });
    expect(deps.failLiveSyncRefresh).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "account_mismatch" }),
    );
    expect(error).not.toHaveProperty(
      "message",
      expect.stringContaining("private-unexpected-account"),
    );
  });

  it("renews a long-running claim every 20 seconds with a 90-second lease", async () => {
    const provider = deferred<LiveWorkbenchData>();
    let renewalCallback: (() => void) | undefined;
    const cancel = vi.fn();
    const deps = dependencies({
      fetchLiveWorkbenchData: vi.fn(() => provider.promise),
      scheduleInterval: vi.fn((callback, milliseconds) => {
        renewalCallback = callback;
        expect(milliseconds).toBe(LIVE_SYNC_LEASE_RENEWAL_MS);
        return cancel;
      }),
    });
    const request = createLiveSyncCoordinator(deps).getLiveWorkbench({
      accountId: "acct_renew",
      credential: credential("acct_renew"),
      credentialGeneration: "6",
      policy: "dashboard",
    });
    await vi.waitFor(() => expect(renewalCallback).toBeTypeOf("function"));

    renewalCallback?.();
    await vi.waitFor(() =>
      expect(deps.renewLiveSyncClaim).toHaveBeenCalledWith({
        accountId: "acct_renew",
        credentialGeneration: "6",
        claimId: "claim_1",
        now: NOW,
        leaseMs: LIVE_SYNC_LEASE_MS,
      }),
    );
    provider.resolve(workbench("acct_renew"));

    await expect(request).resolves.toMatchObject({ freshness: "refreshed" });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
