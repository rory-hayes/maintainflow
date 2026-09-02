import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class CredentialVaultUnavailableError extends Error {}
  class OpenAIAdsApiError extends Error {
    status: number;

    constructor(status: number) {
      super(`Provider status ${status}`);
      this.name = "OpenAIAdsApiError";
      this.status = status;
    }
  }
  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    CredentialVaultUnavailableError,
    OpenAIAdsApiError,
    requireOperatorId: vi.fn(),
    isBootstrapOperator: vi.fn(),
    isWorkspaceAdmissionAllowed: vi.fn(),
    fetchLiveAdAccount: vi.fn(),
    encryptAdsApiKey: vi.fn(),
    isCredentialVaultConfigured: vi.fn(),
    verifyCredentialStore: vi.fn(),
    verifyTenancyStore: vi.fn(),
    bootstrapWorkspace: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/auth/config", () => ({
  isBootstrapOperator: testState.isBootstrapOperator,
  isWorkspaceAdmissionAllowed: testState.isWorkspaceAdmissionAllowed,
}));

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: testState.fetchLiveAdAccount,
}));

vi.mock("@/lib/openai-ads/client.server", () => ({
  OpenAIAdsApiError: testState.OpenAIAdsApiError,
}));

vi.mock("@/lib/observability/logger.server", () => ({
  createServerLogger: () => ({
    info: testState.logInfo,
    warn: testState.logWarn,
    error: testState.logError,
  }),
}));

vi.mock("@/lib/credentials/crypto.server", () => ({
  CredentialVaultUnavailableError: testState.CredentialVaultUnavailableError,
  encryptAdsApiKey: testState.encryptAdsApiKey,
  isCredentialVaultConfigured: testState.isCredentialVaultConfigured,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  bootstrapWorkspace: testState.bootstrapWorkspace,
  verifyCredentialStore: testState.verifyCredentialStore,
  verifyTenancyStore: testState.verifyTenancyStore,
}));

vi.mock("@/lib/tenancy/schema", async () => {
  const { z } = await import("zod");
  return {
    workspaceBootstrapSchema: z.object({
      organizationName: z.string().trim().min(2).max(120),
      organizationType: z.enum(["advertiser", "agency"]),
      adsApiKey: z.string().trim().min(10).max(4096).optional(),
    }),
  };
});

vi.mock("@/lib/http/request-security.server", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/http/request-security.server")
  >()),
  isSecureSameOriginRequest: () => true,
}));

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new Request("http://localhost/api/onboarding/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.requireOperatorId.mockResolvedValue("user_customer");
  testState.isBootstrapOperator.mockReturnValue(false);
  testState.isWorkspaceAdmissionAllowed.mockReturnValue(true);
  testState.verifyTenancyStore.mockResolvedValue(true);
  testState.verifyCredentialStore.mockResolvedValue(true);
  testState.isCredentialVaultConfigured.mockReturnValue(true);
  testState.fetchLiveAdAccount.mockResolvedValue({
    id: "adacct_client",
    name: "Client account",
  });
  testState.encryptAdsApiKey.mockReturnValue({
    id: "00000000-0000-4000-8000-000000000003",
    provider: "openai_ads",
    algorithm: "aes-256-gcm",
    keyId: "v1",
    ciphertext: Buffer.from("ciphertext"),
    initializationVector: Buffer.alloc(12),
    authenticationTag: Buffer.alloc(16),
  });
  testState.bootstrapWorkspace.mockResolvedValue({
    organizationId: "00000000-0000-4000-8000-000000000001",
    accountId: "adacct_client",
  });
});

describe("customer workspace onboarding", () => {
  it("blocks an unadmitted customer before validating their provider key", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    const response = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
        adsApiKey: "ads_client_secret_123",
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.bootstrapWorkspace).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body before authentication or provider access", async () => {
    const response = await POST(
      request({
        organizationName: "x".repeat(17_000),
        organizationType: "agency",
      }),
    );

    expect(response.status).toBe(413);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
  });

  it("validates and vaults a client key without requiring pilot allowlisting", async () => {
    const response = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
        adsApiKey: "ads_client_secret_123",
      }),
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledWith({
      apiKey: "ads_client_secret_123",
    });
    expect(testState.encryptAdsApiKey).toHaveBeenCalledWith({
      apiKey: "ads_client_secret_123",
      externalAccountId: "adacct_client",
    });
    expect(testState.bootstrapWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "user_customer",
        accountId: "adacct_client",
        connection: expect.objectContaining({ mode: "vault" }),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain("ads_client_secret_123");
    expect(testState.logInfo).toHaveBeenCalledWith(
      "onboarding.workspace.completed",
      expect.objectContaining({ status: 200, durationMs: expect.any(Number) }),
    );
  });

  it("does not encrypt or persist a client key when provider validation fails", async () => {
    testState.fetchLiveAdAccount.mockRejectedValue(
      new testState.OpenAIAdsApiError(401),
    );

    const response = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
        adsApiKey: "ads_client_secret_123",
      }),
    );

    expect(response.status).toBe(400);
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
    expect(testState.bootstrapWorkspace).not.toHaveBeenCalled();
    expect(testState.logWarn).toHaveBeenCalledWith(
      "onboarding.workspace.rejected",
      expect.objectContaining({ status: 400 }),
    );
  });

  it("does not expose unexpected workspace persistence errors", async () => {
    testState.bootstrapWorkspace.mockRejectedValue(
      new Error("duplicate key value violates internal_customer_constraint"),
    );

    const response = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
        adsApiKey: "ads_client_secret_123",
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Unable to create workspace safely.",
    });
    expect(testState.logError).toHaveBeenCalledWith(
      "onboarding.workspace.failed",
      expect.objectContaining({
        status: 500,
        error: expect.any(Error),
      }),
    );
  });

  it("treats only request-schema errors as client faults", async () => {
    const invalidRequest = await POST(
      request({ organizationName: "x", organizationType: "agency" }),
    );
    expect(invalidRequest.status).toBe(422);

    testState.fetchLiveAdAccount.mockRejectedValue(
      new ZodError([
        {
          code: "custom",
          path: ["provider", "account"],
          message: "PLANTED_PROVIDER_SCHEMA_SECRET",
        },
      ]),
    );
    const providerSchemaFailure = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
        adsApiKey: "ads_client_secret_123",
      }),
    );

    expect(providerSchemaFailure.status).toBe(500);
    await expect(providerSchemaFailure.json()).resolves.toEqual({
      error: "Unable to create workspace safely.",
    });
  });

  it("does not let a non-bootstrap user claim the environment account", async () => {
    const response = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
      }),
    );

    expect(response.status).toBe(403);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.bootstrapWorkspace).not.toHaveBeenCalled();
  });

  it("does not validate a client key before the tenancy migration is ready", async () => {
    testState.verifyTenancyStore.mockResolvedValue(false);

    const response = await POST(
      request({
        organizationName: "Northstar Agency",
        organizationType: "agency",
        adsApiKey: "ads_client_secret_123",
      }),
    );

    expect(response.status).toBe(503);
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
  });
});
