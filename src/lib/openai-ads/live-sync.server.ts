import "server-only";

import {
  OpenAIAdsApiError,
  type AdsApiCredential,
} from "./client.server";
import {
  AdsProviderBudgetExceededError,
  fetchLiveWorkbenchData,
  type LiveWorkbenchData,
} from "./data.server";
import {
  claimLiveSyncRefresh,
  completeLiveSyncRefresh,
  failLiveSyncRefresh,
  readLiveSyncState,
  renewLiveSyncClaim,
  verifyLiveSyncStore,
  type LiveSyncState as StoredLiveSyncState,
} from "./live-sync-store.server";
import type { AdAccount } from "./schema";

export const LIVE_SYNC_FRESH_FOR_MS = 2 * 60_000;
export const LIVE_SYNC_STALE_FOR_MS = 15 * 60_000;
export const LIVE_SYNC_LEASE_MS = 90_000;
export const LIVE_SYNC_LEASE_RENEWAL_MS = 20_000;
export const LIVE_SYNC_WAIT_MS = 10_000;
export const LIVE_SYNC_POLL_MS = 250;

const LIVE_SYNC_FAILURE_BASE_DELAY_MS = 30_000;
const LIVE_SYNC_FAILURE_MAX_DELAY_MS = 5 * 60_000;

export type LiveSyncPolicy = "dashboard" | "mutation";

export type LiveSyncFailureCode =
  | "account_mismatch"
  | "claim_lost"
  | "provider_authentication"
  | "provider_budget"
  | "provider_not_found"
  | "provider_rate_limited"
  | "provider_rejected"
  | "provider_unavailable"
  | "refresh_contended"
  | "refresh_cooldown"
  | "refresh_failed"
  | "store_unavailable";

type PersistedLiveSyncFailureCode = Exclude<
  LiveSyncFailureCode,
  | "claim_lost"
  | "refresh_contended"
  | "refresh_cooldown"
  | "store_unavailable"
>;

export type LiveSyncClaim = {
  claimId: string;
  expiresAt: Date;
};

export type LiveSyncState = StoredLiveSyncState;

type LiveSyncKey = {
  accountId: string;
  credentialGeneration: string;
};

type ClaimInput = LiveSyncKey & {
  now: Date;
  leaseMs: number;
};

type OwnedClaimInput = ClaimInput & {
  claimId: string;
};

export type LiveSyncCoordinatorDependencies = {
  verifyLiveSyncStore: () => Promise<boolean>;
  readLiveSyncState: (input: LiveSyncKey) => Promise<LiveSyncState | null>;
  claimLiveSyncRefresh: (input: ClaimInput) => Promise<LiveSyncClaim | null>;
  renewLiveSyncClaim: (input: OwnedClaimInput) => Promise<boolean>;
  completeLiveSyncRefresh: (
    input: LiveSyncKey & {
      claimId: string;
      snapshot: LiveWorkbenchData;
      now: Date;
      freshForMs: number;
      staleForMs: number;
    },
  ) => Promise<boolean>;
  failLiveSyncRefresh: (
    input: LiveSyncKey & {
      claimId: string;
      failureCode: PersistedLiveSyncFailureCode;
      retryAfter: Date;
      now: Date;
    },
  ) => Promise<boolean>;
  fetchLiveWorkbenchData: (
    prefetchedAccount?: AdAccount,
    credential?: AdsApiCredential,
  ) => Promise<LiveWorkbenchData>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  scheduleInterval?: (callback: () => void, milliseconds: number) => () => void;
};

export type GetLiveWorkbenchInput = LiveSyncKey & {
  credential: AdsApiCredential;
  policy: LiveSyncPolicy;
  prefetchedAccount?: AdAccount;
};

export type GetLiveWorkbenchResult = {
  data: LiveWorkbenchData;
  freshness: "fresh" | "refreshed" | "stale";
  refreshFailure?: LiveSyncFailureCode;
};

export class LiveSyncUnavailableError extends Error {
  readonly status = 503;
  readonly code = "live_sync_unavailable";
  readonly refreshFailure: LiveSyncFailureCode;
  readonly retryAfter: Date | null;

  constructor(
    refreshFailure: LiveSyncFailureCode,
    retryAfter: Date | null = null,
  ) {
    super("Live OpenAI Ads data is temporarily unavailable.");
    this.name = "LiveSyncUnavailableError";
    this.refreshFailure = refreshFailure;
    this.retryAfter = retryAfter;
  }
}

class LiveSyncAccountMismatchError extends Error {
  constructor() {
    super("The provider returned a different advertiser account.");
    this.name = "LiveSyncAccountMismatchError";
  }
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function defaultScheduleInterval(
  callback: () => void,
  milliseconds: number,
) {
  const handle = setInterval(callback, milliseconds);
  handle.unref?.();
  return () => clearInterval(handle);
}

function validDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function emptyLiveSyncState(): LiveSyncState {
  return {
    snapshot: null,
    payloadSchemaVersion: null,
    snapshotBytes: null,
    syncedAt: null,
    freshUntil: null,
    staleUntil: null,
    claim: null,
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastFailedAt: null,
    retryAfter: null,
  };
}

function hasActiveClaim(state: LiveSyncState, now: Date) {
  return Boolean(
    state.claim &&
      validDate(state.claim.expiresAt) &&
      state.claim.expiresAt.getTime() > now.getTime(),
  );
}

function isFresh(state: LiveSyncState, now: Date) {
  return Boolean(
    state.snapshot &&
      validDate(state.freshUntil) &&
      state.freshUntil.getTime() > now.getTime(),
  );
}

function isStaleUsable(state: LiveSyncState, now: Date) {
  return Boolean(
    state.snapshot &&
      validDate(state.staleUntil) &&
      state.staleUntil.getTime() > now.getTime(),
  );
}

function snapshotVersion(state: LiveSyncState) {
  const syncedAt = state.syncedAt;
  return validDate(syncedAt) ? syncedAt.getTime() : Number.NEGATIVE_INFINITY;
}

function failureDelayMs(consecutiveFailures: number, providerDelayMs: number | null) {
  const failures = Number.isSafeInteger(consecutiveFailures)
    ? Math.max(0, Math.min(16, consecutiveFailures))
    : 0;
  const exponentialDelay = Math.min(
    LIVE_SYNC_FAILURE_BASE_DELAY_MS * 2 ** failures,
    LIVE_SYNC_FAILURE_MAX_DELAY_MS,
  );
  const boundedProviderDelay =
    providerDelayMs === null || !Number.isFinite(providerDelayMs)
      ? providerDelayMs === Number.POSITIVE_INFINITY
        ? LIVE_SYNC_FAILURE_MAX_DELAY_MS
        : 0
      : Math.max(0, Math.min(providerDelayMs, LIVE_SYNC_FAILURE_MAX_DELAY_MS));
  return Math.max(exponentialDelay, boundedProviderDelay);
}

function classifyRefreshFailure(error: unknown): {
  code: PersistedLiveSyncFailureCode;
  providerDelayMs: number | null;
} {
  if (error instanceof LiveSyncAccountMismatchError) {
    return { code: "account_mismatch", providerDelayMs: null };
  }
  if (error instanceof AdsProviderBudgetExceededError) {
    return { code: "provider_budget", providerDelayMs: null };
  }
  if (error instanceof OpenAIAdsApiError) {
    if (error.status === 401 || error.status === 403) {
      return { code: "provider_authentication", providerDelayMs: null };
    }
    if (error.status === 404) {
      return { code: "provider_not_found", providerDelayMs: null };
    }
    if (error.status === 429) {
      return {
        code: "provider_rate_limited",
        providerDelayMs: error.retryAfterMs,
      };
    }
    if (error.status >= 500) {
      return { code: "provider_unavailable", providerDelayMs: null };
    }
    return { code: "provider_rejected", providerDelayMs: null };
  }
  return { code: "refresh_failed", providerDelayMs: null };
}

function staleResult(
  state: LiveSyncState,
  refreshFailure: LiveSyncFailureCode,
): GetLiveWorkbenchResult {
  if (!state.snapshot) {
    throw new LiveSyncUnavailableError(refreshFailure, state.retryAfter);
  }
  return {
    data: state.snapshot,
    freshness: "stale",
    refreshFailure,
  };
}

export function createLiveSyncCoordinator(
  dependencies: LiveSyncCoordinatorDependencies,
) {
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? defaultSleep;
  const scheduleInterval =
    dependencies.scheduleInterval ?? defaultScheduleInterval;

  async function ensureStore() {
    try {
      if (await dependencies.verifyLiveSyncStore()) return;
    } catch {
      // Store errors are intentionally normalized below.
    }
    throw new LiveSyncUnavailableError("store_unavailable");
  }

  async function readState(key: LiveSyncKey) {
    try {
      return (await dependencies.readLiveSyncState(key)) ?? emptyLiveSyncState();
    } catch {
      throw new LiveSyncUnavailableError("store_unavailable");
    }
  }

  function startLeaseRenewal(key: LiveSyncKey, claim: LiveSyncClaim) {
    let active = true;
    let owned = true;
    let renewal = Promise.resolve();
    const cancel = scheduleInterval(() => {
      renewal = renewal.then(async () => {
        if (!active || !owned) return;
        try {
          owned = await dependencies.renewLiveSyncClaim({
            ...key,
            claimId: claim.claimId,
            now: now(),
            leaseMs: LIVE_SYNC_LEASE_MS,
          });
        } catch {
          owned = false;
        }
      });
    }, LIVE_SYNC_LEASE_RENEWAL_MS);

    return async () => {
      active = false;
      cancel();
      await renewal;
      return owned;
    };
  }

  async function waitForCurrentRefresh(
    key: LiveSyncKey,
    baselineSnapshotVersion: number,
  ): Promise<GetLiveWorkbenchResult> {
    const attempts = Math.max(1, Math.ceil(LIVE_SYNC_WAIT_MS / LIVE_SYNC_POLL_MS));
    let latest: LiveSyncState | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await sleep(LIVE_SYNC_POLL_MS);
      latest = await readState(key);
      const observedAt = now();
      if (
        latest.snapshot &&
        snapshotVersion(latest) > baselineSnapshotVersion &&
        isFresh(latest, observedAt)
      ) {
        return { data: latest.snapshot, freshness: "refreshed" };
      }
      if (!hasActiveClaim(latest, observedAt)) break;
    }

    throw new LiveSyncUnavailableError(
      latest?.retryAfter && latest.retryAfter.getTime() > now().getTime()
        ? "refresh_cooldown"
        : "refresh_contended",
      latest?.retryAfter ?? null,
    );
  }

  async function refreshWithClaim(
    input: GetLiveWorkbenchInput,
    claim: LiveSyncClaim,
    previousState: LiveSyncState,
  ): Promise<GetLiveWorkbenchResult> {
    const key: LiveSyncKey = {
      accountId: input.accountId,
      credentialGeneration: input.credentialGeneration,
    };
    const stopLeaseRenewal = startLeaseRenewal(key, claim);

    let data: LiveWorkbenchData;
    try {
      data = await dependencies.fetchLiveWorkbenchData(
        input.prefetchedAccount,
        input.credential,
      );
      if (data.account.id !== input.accountId) {
        throw new LiveSyncAccountMismatchError();
      }
    } catch (error) {
      const stillOwned = await stopLeaseRenewal();
      if (!stillOwned) {
        if (
          input.policy === "dashboard" &&
          isStaleUsable(previousState, now())
        ) {
          return staleResult(previousState, "claim_lost");
        }
        throw new LiveSyncUnavailableError("claim_lost");
      }

      const failure = classifyRefreshFailure(error);
      const failedAt = now();
      const retryAfter = new Date(
        failedAt.getTime() +
          failureDelayMs(
            previousState.consecutiveFailures,
            failure.providerDelayMs,
          ),
      );
      let failureCode: LiveSyncFailureCode = failure.code;
      try {
        const recorded = await dependencies.failLiveSyncRefresh({
          ...key,
          claimId: claim.claimId,
          failureCode: failure.code,
          retryAfter,
          now: failedAt,
        });
        if (!recorded) failureCode = "claim_lost";
      } catch {
        failureCode = "store_unavailable";
      }

      if (
        input.policy === "dashboard" &&
        isStaleUsable(previousState, now())
      ) {
        return staleResult(previousState, failureCode);
      }
      throw new LiveSyncUnavailableError(failureCode, retryAfter);
    }

    const stillOwned = await stopLeaseRenewal();
    if (!stillOwned) {
      if (
        input.policy === "dashboard" &&
        isStaleUsable(previousState, now())
      ) {
        return staleResult(previousState, "claim_lost");
      }
      throw new LiveSyncUnavailableError("claim_lost");
    }

    const completedAt = now();
    let completed = false;
    try {
      completed = await dependencies.completeLiveSyncRefresh({
        ...key,
        claimId: claim.claimId,
        snapshot: data,
        now: completedAt,
        freshForMs: LIVE_SYNC_FRESH_FOR_MS,
        staleForMs: LIVE_SYNC_STALE_FOR_MS,
      });
    } catch {
      if (
        input.policy === "dashboard" &&
        isStaleUsable(previousState, now())
      ) {
        return staleResult(previousState, "store_unavailable");
      }
      throw new LiveSyncUnavailableError("store_unavailable");
    }

    if (!completed) {
      if (
        input.policy === "dashboard" &&
        isStaleUsable(previousState, now())
      ) {
        return staleResult(previousState, "claim_lost");
      }
      throw new LiveSyncUnavailableError("claim_lost");
    }

    return { data, freshness: "refreshed" };
  }

  async function getLiveWorkbench(
    input: GetLiveWorkbenchInput,
  ): Promise<GetLiveWorkbenchResult> {
    await ensureStore();
    const key: LiveSyncKey = {
      accountId: input.accountId,
      credentialGeneration: input.credentialGeneration,
    };
    let state = await readState(key);
    const observedAt = now();
    const baselineVersion = snapshotVersion(state);

    if (
      input.policy === "dashboard" &&
      state.snapshot &&
      isFresh(state, observedAt)
    ) {
      return { data: state.snapshot, freshness: "fresh" };
    }

    if (hasActiveClaim(state, observedAt)) {
      if (
        input.policy === "dashboard" &&
        isStaleUsable(state, observedAt)
      ) {
        return staleResult(state, "refresh_contended");
      }
      return waitForCurrentRefresh(key, baselineVersion);
    }

    if (state.retryAfter && state.retryAfter.getTime() > observedAt.getTime()) {
      if (
        input.policy === "dashboard" &&
        isStaleUsable(state, observedAt)
      ) {
        return staleResult(state, "refresh_cooldown");
      }
      throw new LiveSyncUnavailableError("refresh_cooldown", state.retryAfter);
    }

    let claim: LiveSyncClaim | null;
    try {
      claim = await dependencies.claimLiveSyncRefresh({
        ...key,
        now: observedAt,
        leaseMs: LIVE_SYNC_LEASE_MS,
      });
    } catch {
      if (
        input.policy === "dashboard" &&
        isStaleUsable(state, observedAt)
      ) {
        return staleResult(state, "store_unavailable");
      }
      throw new LiveSyncUnavailableError("store_unavailable");
    }

    if (claim) return refreshWithClaim(input, claim, state);

    state = await readState(key);
    const rereadAt = now();
    if (
      state.snapshot &&
      snapshotVersion(state) > baselineVersion &&
      isFresh(state, rereadAt)
    ) {
      return { data: state.snapshot, freshness: "refreshed" };
    }
    if (
      input.policy === "dashboard" &&
      isStaleUsable(state, rereadAt)
    ) {
      return staleResult(state, "refresh_contended");
    }
    if (hasActiveClaim(state, rereadAt)) {
      return waitForCurrentRefresh(key, baselineVersion);
    }
    throw new LiveSyncUnavailableError(
      state.retryAfter && state.retryAfter.getTime() > rereadAt.getTime()
        ? "refresh_cooldown"
        : "refresh_contended",
      state.retryAfter,
    );
  }

  return { getLiveWorkbench };
}

const defaultCoordinator = createLiveSyncCoordinator({
  verifyLiveSyncStore,
  readLiveSyncState,
  claimLiveSyncRefresh,
  renewLiveSyncClaim,
  completeLiveSyncRefresh,
  failLiveSyncRefresh,
  fetchLiveWorkbenchData,
});

export const getLiveWorkbench = defaultCoordinator.getLiveWorkbench;
