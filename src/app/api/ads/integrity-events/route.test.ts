import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {
    readonly status: 401 | 403 = 401;
  }
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class ChangeIntegrityStoreUnavailableError extends Error {}
  class ChangeIntegrityTransitionError extends Error {}
  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    ChangeIntegrityStoreUnavailableError,
    ChangeIntegrityTransitionError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    verifyChangeIntegrityStore: vi.fn(),
    listChangeIntegrityEvents: vi.fn(),
    logInfo: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: state.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: state.OperatorUnauthorizedError,
  requireOperatorId: state.requireOperatorId,
}));
vi.mock("@/lib/openai-ads/change-integrity-store.server", () => ({
  ChangeIntegrityStoreUnavailableError:
    state.ChangeIntegrityStoreUnavailableError,
  ChangeIntegrityTransitionError: state.ChangeIntegrityTransitionError,
  verifyChangeIntegrityStore: state.verifyChangeIntegrityStore,
  listChangeIntegrityEvents: state.listChangeIntegrityEvents,
}));
vi.mock("@/lib/observability/logger.server", () => ({
  createServerLogger: () => ({ info: state.logInfo, error: state.logError }),
}));
vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: state.AccountAccessForbiddenError,
  TenancyStoreUnavailableError: state.TenancyStoreUnavailableError,
  requireAccountAccess: state.requireAccountAccess,
}));

import { GET } from "./route";

const accountId = "adacct_client";
const cursorId = "00000000-0000-4000-8000-000000000501";
const page = {
  events: [],
  hasMore: false,
  summary: {
    baselineReady: true,
    lastCheckedAt: "2026-09-04T09:10:00.000Z",
    retainedEventCount: 0,
    openUnexplainedCount: 0,
    openIndeterminateCount: 0,
    consistentCount: 0,
    reviewedCount: 0,
  },
};

function request(query = `accountId=${accountId}`) {
  return new Request(`https://maintainflow.io/api/ads/integrity-events?${query}`);
}

describe("change-integrity event page route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.requireOperatorId.mockResolvedValue("user_owner");
    state.requireAccountAccess.mockResolvedValue({ accountId });
    state.verifyChangeIntegrityStore.mockResolvedValue(true);
    state.listChangeIntegrityEvents.mockResolvedValue(page);
  });

  it("loads an authorized open-first keyset page without caching", async () => {
    const response = await GET(
      request(
        `accountId=${accountId}&limit=25&afterOpen=true&afterDetectedAt=2026-09-04T09%3A10%3A00.000Z&afterId=${cursorId}`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      accountId,
      "read",
    );
    expect(state.listChangeIntegrityEvents).toHaveBeenCalledWith({
      accountId,
      limit: 25,
      cursor: {
        reviewStatus: "open",
        detectedAt: "2026-09-04T09:10:00.000Z",
        id: cursorId,
      },
    });
    await expect(response.json()).resolves.toEqual(page);
  });

  it("rejects partial or malformed cursors before database access", async () => {
    const responses = await Promise.all([
      GET(request(`accountId=${accountId}&afterOpen=true`)),
      GET(request(`accountId=${accountId}&limit=101`)),
    ]);

    expect(responses.map((response) => response.status)).toEqual([422, 422]);
    expect(state.requireOperatorId).not.toHaveBeenCalled();
    expect(state.listChangeIntegrityEvents).not.toHaveBeenCalled();
  });

  it("requires an authenticated operator", async () => {
    state.requireOperatorId.mockRejectedValue(
      new state.OperatorUnauthorizedError("Sign in first."),
    );
    const response = await GET(request());
    expect(response.status).toBe(401);
    expect(state.requireAccountAccess).not.toHaveBeenCalled();
  });

  it("rejects another advertiser account and fails closed when storage is absent", async () => {
    state.requireAccountAccess.mockRejectedValueOnce(
      new state.AccountAccessForbiddenError("No account access."),
    );
    const forbidden = await GET(request());
    state.requireAccountAccess.mockResolvedValue({ accountId });
    state.verifyChangeIntegrityStore.mockResolvedValue(false);
    const unavailable = await GET(request());

    expect(forbidden.status).toBe(403);
    expect(unavailable.status).toBe(503);
    expect(state.listChangeIntegrityEvents).not.toHaveBeenCalled();
  });

  it("does not expose unexpected database errors", async () => {
    state.listChangeIntegrityEvents.mockRejectedValue(
      new Error("relation maintainflow_ads_config_integrity_events missing"),
    );
    const response = await GET(request());
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to load integrity events safely.",
    });
  });
});
