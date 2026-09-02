import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getRuntimeDatabaseMock } = vi.hoisted(() => ({
  getRuntimeDatabaseMock: vi.fn(),
}));

vi.mock("../database/client.server", () => ({
  getRuntimeDatabase: getRuntimeDatabaseMock,
}));

import { OpenAIAdsApiError, type AdsApiCredential } from "./client.server";
import type { LiveWorkbenchData } from "./data.server";
import { demoAccount } from "./demo-data";
import { readLiveSyncState } from "./live-sync-store.server";
import {
  LIVE_SYNC_LEASE_MS,
  LIVE_SYNC_LEASE_RENEWAL_MS,
  LiveSyncUnavailableError,
  createLiveSyncCoordinator,
  type LiveSyncCoordinatorDependencies,
  type LiveSyncState,
} from "./live-sync.server";
import { LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION } from "./live-sync-snapshot";
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
    budgetGuardEvidence: [],
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

function fakeDatabase(responses: unknown[][]) {
  const calls: unknown[][] = [];
  const sql = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    return responses.shift() ?? [];
  });
  Object.assign(sql, { json: (value: unknown) => value });
  getRuntimeDatabaseMock.mockReturnValue(sql);
  return { calls };
}

function statement(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join("?").replace(/\s+/g, " ");
}

function storedWorkbench(accountId: string): LiveWorkbenchData {
  const syncedAt = "2026-08-30T11:59:00.000Z";
  return {
    account: { ...demoAccount, id: accountId },
    campaigns: [],
    ads: [],
    performance: [],
    budgetGuardEvidence: [],
    recommendations: [],
    conversionMeasurement: {
      source: "live",
      status: "ready",
      checkedAt: syncedAt,
      activeConversionCampaigns: 0,
      healthyCampaigns: 0,
      eventSettingCount: 0,
      checks: [],
      message: "Stored cache sentinel that must never be displayed.",
    },
    syncedAt,
  };
}

function unusableStoredRow(
  accountId: string,
  kind: "old-version" | "corrupt-current-version",
) {
  const cached = storedWorkbench(accountId);
  const payload =
    kind === "old-version"
      ? { schemaVersion: 0, data: cached }
      : {
          schemaVersion: LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION,
          data: { ...cached, campaigns: "corrupt-not-an-array" },
        };
  return {
    payload_schema_version: LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION,
    snapshot_payload: payload,
    snapshot_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
    synced_at: new Date(cached.syncedAt),
    fresh_until: new Date(NOW.getTime() + 60_000),
    stale_until: new Date(NOW.getTime() + 10 * 60_000),
    refresh_claim_id: null,
    refresh_claimed_at: null,
    refresh_claim_expires_at: null,
    consecutive_failures: 0,
    last_failure_code: null,
    last_failed_at: null,
    retry_after: null,
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgres://localhost/maintainflow";
});

describe("live Ads sync coordinator", () => {
  for (const kind of [
    "old-version",
    "corrupt-current-version",
  ] as const) {
    for (const policy of ["dashboard", "mutation"] as const) {
      it(`${policy} clears and refreshes an unusable ${kind} cache entry`, async () => {
        const accountId = `acct_${policy}_${kind}`;
        const credentialGeneration = `generation_${kind}`;
        const database = fakeDatabase([
          [unusableStoredRow(accountId, kind)],
          [{ cleared: true }],
        ]);
        const refreshed = workbench(accountId);
        const deps = dependencies({
          readLiveSyncState,
          fetchLiveWorkbenchData: vi.fn(async () => refreshed),
        });

        const result = await createLiveSyncCoordinator(deps).getLiveWorkbench({
          accountId,
          credential: credential(accountId),
          credentialGeneration,
          policy,
        });

        expect(result).toEqual({ data: refreshed, freshness: "refreshed" });
        expect(result.data).not.toEqual(storedWorkbench(accountId));
        expect(JSON.stringify(result.data)).not.toContain(
          "Stored cache sentinel",
        );
        expect(deps.fetchLiveWorkbenchData).toHaveBeenCalledOnce();
        expect(deps.completeLiveSyncRefresh).toHaveBeenCalledWith(
          expect.objectContaining({
            accountId,
            credentialGeneration,
            snapshot: refreshed,
          }),
        );
        expect(statement(database.calls[1])).toContain(
          "snapshot_payload = null",
        );
        expect(statement(database.calls[1])).toContain(
          "state.snapshot_payload = ?",
        );
        expect(database.calls[1].slice(1)).toContain(accountId);
        expect(database.calls[1].slice(1)).toContain(credentialGeneration);
      });
    }
  }

  it("preserves genuine snapshot-store read failures as unavailable", async () => {
    const deps = dependencies({
      readLiveSyncState: vi.fn(async () => {
        throw new Error("database connection failed");
      }),
    });

    await expect(
      createLiveSyncCoordinator(deps).getLiveWorkbench({
        accountId: "acct_store_failure",
        credential: credential("acct_store_failure"),
        credentialGeneration: "1",
        policy: "dashboard",
      }),
    ).rejects.toMatchObject({
      status: 503,
      refreshFailure: "store_unavailable",
    });
    expect(deps.claimLiveSyncRefresh).not.toHaveBeenCalled();
    expect(deps.fetchLiveWorkbenchData).not.toHaveBeenCalled();
  });

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
