import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  auditStorefrontMock,
  requireOperatorIdMock,
  requireAccountAccessMock,
  verifyReadinessHistoryStoreMock,
  recordReadinessAuditRunMock,
  isSecureSameOriginRequestMock,
  consumeReadinessAuditQuotaMock,
  getTrustedReadinessClientIpMock,
  isReadinessRateLimitConfiguredMock,
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  AccountAccessForbiddenError,
  TenancyStoreUnavailableError,
  ReadinessHistoryStoreUnavailableError,
} = vi.hoisted(() => ({
  auditStorefrontMock: vi.fn(),
  requireOperatorIdMock: vi.fn(),
  requireAccountAccessMock: vi.fn(),
  verifyReadinessHistoryStoreMock: vi.fn(),
  recordReadinessAuditRunMock: vi.fn(),
  isSecureSameOriginRequestMock: vi.fn(),
  consumeReadinessAuditQuotaMock: vi.fn(),
  getTrustedReadinessClientIpMock: vi.fn(),
  isReadinessRateLimitConfiguredMock: vi.fn(),
  OperatorAuthUnavailableError: class OperatorAuthUnavailableError extends Error {},
  OperatorUnauthorizedError: class OperatorUnauthorizedError extends Error {},
  AccountAccessForbiddenError: class AccountAccessForbiddenError extends Error {},
  TenancyStoreUnavailableError: class TenancyStoreUnavailableError extends Error {},
  ReadinessHistoryStoreUnavailableError:
    class ReadinessHistoryStoreUnavailableError extends Error {},
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId: requireOperatorIdMock,
}));
vi.mock("@/lib/readiness/audit.server", () => ({
  auditStorefront: auditStorefrontMock,
  normalizeAuditUrl: (input: string) => new URL(input),
}));
vi.mock("@/lib/readiness/history.server", () => ({
  ReadinessHistoryStoreUnavailableError,
  recordReadinessAuditRun: recordReadinessAuditRunMock,
  verifyReadinessHistoryStore: verifyReadinessHistoryStoreMock,
}));
vi.mock("@/lib/readiness/rate-limit.server", () => ({
  consumeReadinessAuditQuota: consumeReadinessAuditQuotaMock,
  getTrustedReadinessClientIp: getTrustedReadinessClientIpMock,
  isReadinessRateLimitConfigured: isReadinessRateLimitConfiguredMock,
}));
vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError,
  TenancyStoreUnavailableError,
  requireAccountAccess: requireAccountAccessMock,
}));
vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/request-security.server")>()),
  isSecureSameOriginRequest: isSecureSameOriginRequestMock,
}));

import { POST } from "./route";

const resetAt = new Date(Date.now() + 60 * 60 * 1_000);

function request(body: unknown, contentType = "application/json") {
  return new Request("https://maintainflow.io/api/readiness/audit", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("readiness audit route", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    auditStorefrontMock.mockReset();
    requireOperatorIdMock.mockReset();
    requireAccountAccessMock.mockReset();
    verifyReadinessHistoryStoreMock.mockReset();
    recordReadinessAuditRunMock.mockReset();
    isSecureSameOriginRequestMock.mockReset();
    consumeReadinessAuditQuotaMock.mockReset();
    getTrustedReadinessClientIpMock.mockReset();
    isReadinessRateLimitConfiguredMock.mockReset();
    isReadinessRateLimitConfiguredMock.mockReturnValue(true);
    isSecureSameOriginRequestMock.mockReturnValue(true);
    requireOperatorIdMock.mockResolvedValue("user_owner");
    requireAccountAccessMock.mockResolvedValue({
      accountId: "adacct_client",
      accountName: "Client account",
      organizationId: "2160af94-3b64-44ff-a72f-85e3c402df6a",
      organizationName: "Agency",
      organizationType: "agency",
      connectionMode: "vault",
      membershipRole: "owner",
      accountRole: "manager",
    });
    verifyReadinessHistoryStoreMock.mockResolvedValue(true);
    recordReadinessAuditRunMock.mockResolvedValue({
      id: "74a8941b-5732-4ba3-9a98-63f6bb21b3b3",
      accountId: "adacct_client",
      audit: { score: 88, verdict: "ready" },
      recordedAt: "2026-08-30T15:00:00.000Z",
    });
    getTrustedReadinessClientIpMock.mockReturnValue("203.0.113.20");
    consumeReadinessAuditQuotaMock.mockResolvedValue({
      allowed: true,
      limit: 6,
      remaining: 5,
      resetAt,
    });
    auditStorefrontMock.mockResolvedValue({ score: 88, verdict: "ready" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("checks shared capacity before starting the outbound audit", async () => {
    const response = await POST(request({ url: "https://shop.example/item" }));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("6");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("5");
    expect(consumeReadinessAuditQuotaMock).toHaveBeenCalledWith({
      clientIp: "203.0.113.20",
      hostname: "shop.example",
    });
    expect(
      consumeReadinessAuditQuotaMock.mock.invocationCallOrder[0],
    ).toBeLessThan(auditStorefrontMock.mock.invocationCallOrder[0]);
    expect(requireOperatorIdMock).not.toHaveBeenCalled();
    expect(recordReadinessAuditRunMock).not.toHaveBeenCalled();
  });

  it("authorizes an exact account before quota use and saves the server audit", async () => {
    const response = await POST(
      request({
        url: "https://shop.example/item",
        accountId: "adacct_client",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(requireAccountAccessMock).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "write",
    );
    expect(
      requireAccountAccessMock.mock.invocationCallOrder[0],
    ).toBeLessThan(consumeReadinessAuditQuotaMock.mock.invocationCallOrder[0]);
    expect(recordReadinessAuditRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "user_owner",
        accountId: "adacct_client",
        audit: { score: 88, verdict: "ready" },
      }),
    );
    expect(payload).toMatchObject({
      score: 88,
      historyEntry: { accountId: "adacct_client" },
    });
  });

  it("rejects every cross-origin audit before authentication or quota use", async () => {
    isSecureSameOriginRequestMock.mockReturnValue(false);

    const response = await POST(request({ url: "https://shop.example" }));

    expect(response.status).toBe(403);
    expect(requireOperatorIdMock).not.toHaveBeenCalled();
    expect(consumeReadinessAuditQuotaMock).not.toHaveBeenCalled();
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });

  it("rejects a simple cross-site content type before parsing or quota use", async () => {
    const response = await POST(
      request({ url: "https://shop.example" }, "text/plain"),
    );

    expect(response.status).toBe(415);
    expect(consumeReadinessAuditQuotaMock).not.toHaveBeenCalled();
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });

  it("rejects an unauthorized account before quota use or outbound fetch", async () => {
    requireAccountAccessMock.mockRejectedValue(
      new AccountAccessForbiddenError("No account access."),
    );

    const response = await POST(
      request({ url: "https://shop.example", accountId: "adacct_other" }),
    );

    expect(response.status).toBe(403);
    expect(consumeReadinessAuditQuotaMock).not.toHaveBeenCalled();
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });

  it("returns the audit with an explicit warning when history saving fails", async () => {
    recordReadinessAuditRunMock.mockRejectedValue(new Error("Database offline"));

    const response = await POST(
      request({ url: "https://shop.example", accountId: "adacct_client" }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      score: 88,
      historySaveError:
        "The scan completed, but its account history could not be saved.",
    });
    expect(payload).not.toHaveProperty("historyEntry");
  });

  it("keeps unexpected network details out of the public response and logs", async () => {
    const plantedSecret = "PLANTED_READINESS_SECRET_91a74";
    auditStorefrontMock.mockRejectedValue(
      new Error(`socket failure for https://${plantedSecret}.example`),
    );

    const response = await POST(request({ url: "https://shop.example/item" }));
    const body = await response.text();
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);

    expect(response.status).toBe(422);
    expect(body).toContain("could not be audited safely");
    expect(body).not.toContain(plantedSecret);
    expect(logged).not.toContain(plantedSecret);
  });

  it("returns 429 without an outbound fetch when the shared quota is exhausted", async () => {
    consumeReadinessAuditQuotaMock.mockResolvedValue({
      allowed: false,
      limit: 6,
      remaining: 0,
      resetAt,
    });

    const response = await POST(request({ url: "https://shop.example/item" }));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });

  it("fails closed in production when shared limiting is not configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    isReadinessRateLimitConfiguredMock.mockReturnValue(false);

    const response = await POST(request({ url: "https://shop.example/item" }));
    expect(response.status).toBe(503);
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });

  it("fails closed when the deployment cannot supply a trusted client address", async () => {
    getTrustedReadinessClientIpMock.mockReturnValue(null);

    const response = await POST(request({ url: "https://shop.example/item" }));
    expect(response.status).toBe(503);
    expect(consumeReadinessAuditQuotaMock).not.toHaveBeenCalled();
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });

  it("rejects an undeclared oversized stream before checking capacity", async () => {
    const response = await POST(
      request({ url: "https://shop.example", pad: "x".repeat(5000) }),
    );
    expect(response.status).toBe(413);
    expect(consumeReadinessAuditQuotaMock).not.toHaveBeenCalled();
    expect(auditStorefrontMock).not.toHaveBeenCalled();
  });
});
