import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class CredentialVaultUnavailableError extends Error {}
  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    CredentialVaultUnavailableError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    isCredentialVaultConfigured: vi.fn(),
    verifyCredentialStore: vi.fn(),
    fetchLiveAdAccount: vi.fn(),
    encryptAdsApiKey: vi.fn(),
    rotateAdsApiCredential: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/observability/logger.server", () => ({
  createServerLogger: () => ({
    info: testState.logInfo,
    warn: testState.logWarn,
    error: testState.logError,
  }),
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/credentials/crypto.server", () => ({
  CredentialVaultUnavailableError: testState.CredentialVaultUnavailableError,
  encryptAdsApiKey: testState.encryptAdsApiKey,
  isCredentialVaultConfigured: testState.isCredentialVaultConfigured,
}));

vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/http/request-security.server")
  >()),
  isSecureSameOriginRequest: () => true,
}));

vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: testState.fetchLiveAdAccount,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  rotateAdsApiCredential: testState.rotateAdsApiCredential,
  requireAccountAccess: testState.requireAccountAccess,
  verifyCredentialStore: testState.verifyCredentialStore,
}));

import { POST } from "./route";

function request() {
  return new Request(
    "http://localhost/api/connections/openai-ads/adacct_client",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ adsApiKey: "ads_replacement_secret_456" }),
    },
  );
}

const context = {
  params: Promise.resolve({ accountId: "adacct_client" }),
};

const access = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  organizationName: "Client organization",
  organizationType: "advertiser",
  accountId: "adacct_client",
  accountName: "Client account",
  connectionMode: "vault",
  membershipRole: "owner",
  accountRole: "owner",
};

beforeEach(() => {
  vi.clearAllMocks();
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.requireAccountAccess.mockResolvedValue(access);
  testState.isCredentialVaultConfigured.mockReturnValue(true);
  testState.verifyCredentialStore.mockResolvedValue(true);
  testState.fetchLiveAdAccount.mockResolvedValue({
    id: "adacct_client",
    name: "Client account",
  });
  testState.encryptAdsApiKey.mockReturnValue({
    id: "00000000-0000-4000-8000-000000000004",
    provider: "openai_ads",
    algorithm: "aes-256-gcm",
    keyId: "v2",
    ciphertext: Buffer.from("ciphertext"),
    initializationVector: Buffer.alloc(12),
    authenticationTag: Buffer.alloc(16),
  });
  testState.rotateAdsApiCredential.mockResolvedValue({ credentialVersion: 2 });
});

describe("advertiser credential rotation", () => {
  it("verifies the same account before replacing the encrypted key", async () => {
    const response = await POST(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "write",
    );
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledWith({
      kind: "account_api_key",
      secret: "ads_replacement_secret_456",
      expectedAccountId: "adacct_client",
    });
    expect(testState.rotateAdsApiCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "user_owner",
        accountId: "adacct_client",
        access,
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("ads_replacement_secret_456");
    expect(testState.logInfo).toHaveBeenCalledWith("connection.ads.rotated");
  });

  it("rejects a key belonging to another advertiser account", async () => {
    testState.fetchLiveAdAccount.mockResolvedValue({
      id: "adacct_other",
      name: "Other account",
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(422);
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
    expect(testState.rotateAdsApiCredential).not.toHaveBeenCalled();
    expect(testState.logWarn).toHaveBeenCalledWith(
      "connection.ads.account_mismatch",
      { error: expect.any(Error) },
    );
  });

  it("keeps the current credential active when provider validation fails", async () => {
    testState.fetchLiveAdAccount.mockRejectedValue(
      new Error("The provider rejected the replacement key."),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(400);
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
    expect(testState.rotateAdsApiCredential).not.toHaveBeenCalled();
  });

  it("does not validate a replacement key for a review-only operator", async () => {
    testState.requireAccountAccess.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Review-only access."),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
  });

  it("rejects stale access after provider verification", async () => {
    testState.rotateAdsApiCredential.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Account access changed."),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledTimes(1);
    expect(testState.rotateAdsApiCredential).toHaveBeenCalledWith(
      expect.objectContaining({ access }),
    );
  });
});
