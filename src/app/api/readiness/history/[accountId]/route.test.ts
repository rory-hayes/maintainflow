import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class ReadinessHistoryStoreUnavailableError extends Error {}

  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    ReadinessHistoryStoreUnavailableError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    verifyReadinessHistoryStore: vi.fn(),
    listReadinessAuditRuns: vi.fn(),
  };
});

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: state.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: state.OperatorUnauthorizedError,
  requireOperatorId: state.requireOperatorId,
}));
vi.mock("@/lib/readiness/history.server", () => ({
  ReadinessHistoryStoreUnavailableError:
    state.ReadinessHistoryStoreUnavailableError,
  verifyReadinessHistoryStore: state.verifyReadinessHistoryStore,
  listReadinessAuditRuns: state.listReadinessAuditRuns,
}));
vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: state.AccountAccessForbiddenError,
  TenancyStoreUnavailableError: state.TenancyStoreUnavailableError,
  requireAccountAccess: state.requireAccountAccess,
}));

import { GET } from "./route";

function request() {
  return new Request(
    "https://maintainflow.io/api/readiness/history/adacct_client",
  );
}

function context(accountId = "adacct_client") {
  return { params: Promise.resolve({ accountId }) };
}

describe("readiness history route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.requireOperatorId.mockResolvedValue("user_owner");
    state.requireAccountAccess.mockResolvedValue({ accountId: "adacct_client" });
    state.verifyReadinessHistoryStore.mockResolvedValue(true);
    state.listReadinessAuditRuns.mockResolvedValue([
      { id: "run_1", accountId: "adacct_client" },
    ]);
  });

  it("returns only the exact authorized account history without caching", async () => {
    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(state.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "read",
    );
    expect(state.listReadinessAuditRuns).toHaveBeenCalledWith({
      accountId: "adacct_client",
      operatorId: "user_owner",
      access: { accountId: "adacct_client" },
    });
    await expect(response.json()).resolves.toEqual({
      entries: [{ id: "run_1", accountId: "adacct_client" }],
    });
  });

  it("requires an authenticated operator", async () => {
    state.requireOperatorId.mockRejectedValue(
      new state.OperatorUnauthorizedError("Sign in first."),
    );

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    expect(state.requireAccountAccess).not.toHaveBeenCalled();
    expect(state.listReadinessAuditRuns).not.toHaveBeenCalled();
  });

  it("rejects access to another advertiser account", async () => {
    state.requireAccountAccess.mockRejectedValue(
      new state.AccountAccessForbiddenError("No account access."),
    );

    const response = await GET(request(), context("adacct_other"));

    expect(response.status).toBe(403);
    expect(state.listReadinessAuditRuns).not.toHaveBeenCalled();
  });

  it("fails closed when the history migration is not ready", async () => {
    state.verifyReadinessHistoryStore.mockResolvedValue(false);

    const response = await GET(request(), context());

    expect(response.status).toBe(503);
    expect(state.listReadinessAuditRuns).not.toHaveBeenCalled();
  });
});
