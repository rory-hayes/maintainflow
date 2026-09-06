import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {
    status: 401 | 403 = 401;
  }
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class ChangeIntegrityStoreUnavailableError extends Error {}
  class ChangeIntegrityTransitionError extends Error {}
  class ChangeIntegrityAuthorizationError extends Error {}
  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    ChangeIntegrityStoreUnavailableError,
    ChangeIntegrityTransitionError,
    ChangeIntegrityAuthorizationError,
    secureSameOrigin: true,
    requireOperator: vi.fn(),
    requireAccountAccess: vi.fn(),
    verifyChangeIntegrityStore: vi.fn(),
    acknowledgeChangeIntegrityEvent: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperator: testState.requireOperator,
}));

vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/http/request-security.server")
  >()),
  isSecureSameOriginRequest: () => testState.secureSameOrigin,
}));

vi.mock("@/lib/openai-ads/change-integrity-store.server", () => ({
  ChangeIntegrityStoreUnavailableError:
    testState.ChangeIntegrityStoreUnavailableError,
  ChangeIntegrityTransitionError: testState.ChangeIntegrityTransitionError,
  ChangeIntegrityAuthorizationError:
    testState.ChangeIntegrityAuthorizationError,
  verifyChangeIntegrityStore: testState.verifyChangeIntegrityStore,
  acknowledgeChangeIntegrityEvent: testState.acknowledgeChangeIntegrityEvent,
}));

vi.mock("@/lib/observability/logger.server", () => ({
  createServerLogger: () => ({
    info: testState.logInfo,
    warn: testState.logWarn,
    error: testState.logError,
  }),
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  requireAccountAccess: testState.requireAccountAccess,
}));

import { POST } from "./route";

const eventId = "00000000-0000-4000-8000-000000000501";
const accountId = "adacct_client";
const access = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationName: "Northstar Agency",
  organizationType: "agency",
  accountId,
  accountName: "Client account",
  connectionMode: "vault",
  membershipRole: "owner",
  accountRole: "manager",
};
const reviewedEvent = {
  id: eventId,
  reviewStatus: "reviewed",
  reviewedByName: "Rory Hayes",
  reviewNote: "Verified in the provider account.",
};

function context(id = eventId) {
  return { params: Promise.resolve({ eventId: id }) };
}

function request(
  body: unknown = {
    accountId,
    note: "Verified in the provider account.",
  },
) {
  return new Request(
    `http://localhost/api/ads/integrity-events/${eventId}/acknowledge`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.secureSameOrigin = true;
  testState.requireOperator.mockResolvedValue({
    id: "user_owner",
    name: "Rory Hayes",
    initials: "RH",
  });
  testState.requireAccountAccess.mockResolvedValue(access);
  testState.verifyChangeIntegrityStore.mockResolvedValue(true);
  testState.acknowledgeChangeIntegrityEvent.mockResolvedValue(reviewedEvent);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("change-integrity acknowledgement route", () => {
  it("records the authoritative operator and authorized account without an Ads write", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      accountId,
      "write",
    );
    expect(testState.acknowledgeChangeIntegrityEvent).toHaveBeenCalledWith({
      accountId,
      eventId,
      operatorId: "user_owner",
      reviewerName: "Rory Hayes",
      access,
      note: "Verified in the provider account.",
    });
    await expect(response.json()).resolves.toMatchObject({
      reviewed: true,
      event: reviewedEvent,
    });
    expect(testState.logInfo).toHaveBeenCalledWith(
      "ads.integrity_review.completed",
      { status: 200 },
    );
  });

  it("rejects cross-origin requests before authentication or database work", async () => {
    testState.secureSameOrigin = false;

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    expect(testState.requireOperator).not.toHaveBeenCalled();
    expect(testState.requireAccountAccess).not.toHaveBeenCalled();
    expect(testState.acknowledgeChangeIntegrityEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers and notes", async () => {
    const [identifierResponse, noteResponse] = await Promise.all([
      POST(request(), context("not-a-uuid")),
      POST(request({ accountId, note: "short" }), context()),
    ]);

    expect(identifierResponse.status).toBe(422);
    expect(noteResponse.status).toBe(422);
    expect(testState.acknowledgeChangeIntegrityEvent).not.toHaveBeenCalled();
  });

  it("rejects oversized bodies before authorization", async () => {
    const response = await POST(
      request(JSON.stringify({ accountId, note: "x".repeat(5_000) })),
      context(),
    );

    expect(response.status).toBe(413);
    expect(testState.requireAccountAccess).not.toHaveBeenCalled();
    expect(testState.acknowledgeChangeIntegrityEvent).not.toHaveBeenCalled();
  });

  it("returns 409 when the event is no longer open or belongs to another account", async () => {
    testState.acknowledgeChangeIntegrityEvent.mockRejectedValue(
      new testState.ChangeIntegrityTransitionError(
        "This open change-integrity event was not found in the connected account.",
      ),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "This open change-integrity event was not found in the connected account.",
    });
  });

  it("returns 403 when write authority changes during the database transition", async () => {
    testState.acknowledgeChangeIntegrityEvent.mockRejectedValue(
      new testState.ChangeIntegrityAuthorizationError(
        "Advertiser write access changed while this integrity event was being reviewed. Refresh before trying again.",
      ),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "Advertiser write access changed while this integrity event was being reviewed. Refresh before trying again.",
    });
  });

  it("returns 503 when the integrity store is not ready", async () => {
    testState.verifyChangeIntegrityStore.mockResolvedValue(false);

    const response = await POST(request(), context());

    expect(response.status).toBe(503);
    expect(testState.acknowledgeChangeIntegrityEvent).not.toHaveBeenCalled();
  });

  it("does not expose unexpected database errors", async () => {
    testState.acknowledgeChangeIntegrityEvent.mockRejectedValue(
      new Error("relation maintainflow_ads_config_integrity_events missing"),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: "Unable to record the integrity review safely.",
    });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("relation");
  });
});
