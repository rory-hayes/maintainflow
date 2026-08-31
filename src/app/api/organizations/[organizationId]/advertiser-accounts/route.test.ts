import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class AdvertiserAccountAttachConflictError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class CredentialVaultUnavailableError extends Error {}
  class OpenAIAdsApiError extends Error {
    constructor(readonly status: number) {
      super(`Provider status ${status}`);
    }
  }

  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    AdvertiserAccountAttachConflictError,
    TenancyStoreUnavailableError,
    CredentialVaultUnavailableError,
    OpenAIAdsApiError,
    isWorkspaceAdmissionAllowed: vi.fn(),
    requireOperatorId: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    isCredentialVaultConfigured: vi.fn(),
    verifyAdvertiserAccountAttachStore: vi.fn(),
    requireAgencyAccountAttachAuthorization: vi.fn(),
    fetchLiveAdAccount: vi.fn(),
    encryptAdsApiKey: vi.fn(),
    attachAdvertiserAccountToAgency: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/auth/config", () => ({
  isWorkspaceAdmissionAllowed: testState.isWorkspaceAdmissionAllowed,
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
  isSecureSameOriginRequest: testState.isSecureSameOriginRequest,
}));

vi.mock("@/lib/openai-ads/client.server", () => ({
  OpenAIAdsApiError: testState.OpenAIAdsApiError,
}));

vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: testState.fetchLiveAdAccount,
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
  AdvertiserAccountAttachConflictError:
    testState.AdvertiserAccountAttachConflictError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  attachAdvertiserAccountToAgency:
    testState.attachAdvertiserAccountToAgency,
  requireAgencyAccountAttachAuthorization:
    testState.requireAgencyAccountAttachAuthorization,
  verifyAdvertiserAccountAttachStore:
    testState.verifyAdvertiserAccountAttachStore,
}));

import { POST } from "./route";

const organizationId = "00000000-0000-4000-8000-000000000011";
const credential = {
  id: "00000000-0000-4000-8000-000000000012",
  provider: "openai_ads",
  algorithm: "aes-256-gcm",
  keyId: "v1",
  ciphertext: Buffer.from("ciphertext"),
  initializationVector: Buffer.alloc(12),
  authenticationTag: Buffer.alloc(16),
};
const access = {
  organizationId,
  organizationName: "Northstar Agency",
  organizationType: "agency",
  accountId: "adacct_new_client",
  accountName: "New Client",
  connectionMode: "vault",
  membershipRole: "owner",
  accountRole: "manager",
};

function request(
  body: Record<string, unknown> = {
    adsApiKey: "ads_client_secret_123",
  },
) {
  return new Request(
    `http://localhost/api/organizations/${organizationId}/advertiser-accounts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function context(value = organizationId) {
  return { params: Promise.resolve({ organizationId: value }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.isWorkspaceAdmissionAllowed.mockReturnValue(true);
  testState.requireOperatorId.mockResolvedValue("user_agency_owner");
  testState.isSecureSameOriginRequest.mockReturnValue(true);
  testState.isCredentialVaultConfigured.mockReturnValue(true);
  testState.verifyAdvertiserAccountAttachStore.mockResolvedValue(true);
  testState.requireAgencyAccountAttachAuthorization.mockResolvedValue({
    organizationId,
    organizationName: "Northstar Agency",
    membershipRole: "owner",
  });
  testState.fetchLiveAdAccount.mockResolvedValue({
    id: "adacct_new_client",
    name: "New Client",
  });
  testState.encryptAdsApiKey.mockReturnValue(credential);
  testState.attachAdvertiserAccountToAgency.mockResolvedValue({
    created: true,
    access,
  });
});

describe("agency advertiser account attachment", () => {
  it("authorizes the agency before deriving and storing the provider account", async () => {
    const response = await POST(request(), context());
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(testState.requireAgencyAccountAttachAuthorization).toHaveBeenCalledWith(
      "user_agency_owner",
      organizationId,
    );
    expect(
      testState.requireAgencyAccountAttachAuthorization.mock.invocationCallOrder[0],
    ).toBeLessThan(testState.fetchLiveAdAccount.mock.invocationCallOrder[0]!);
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledWith({
      apiKey: "ads_client_secret_123",
    });
    expect(testState.encryptAdsApiKey).toHaveBeenCalledWith({
      apiKey: "ads_client_secret_123",
      externalAccountId: "adacct_new_client",
    });
    expect(testState.attachAdvertiserAccountToAgency).toHaveBeenCalledWith({
      operatorId: "user_agency_owner",
      organizationId,
      accountId: "adacct_new_client",
      accountName: "New Client",
      credential,
      verifiedAt: expect.any(Date),
    });
    expect(payload).toMatchObject({ created: true, access });
    expect(JSON.stringify(payload)).not.toContain("ads_client_secret_123");
    expect(testState.logInfo).toHaveBeenCalledWith(
      "agency.account_attach.completed",
      expect.objectContaining({ status: 201, durationMs: expect.any(Number) }),
    );
  });

  it("returns the existing access on an idempotent same-agency retry", async () => {
    testState.attachAdvertiserAccountToAgency.mockResolvedValue({
      created: false,
      access,
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      created: false,
      access,
    });
  });

  it("blocks non-admin agency members before provider access", async () => {
    testState.requireAgencyAccountAttachAuthorization.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Owner or admin required."),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    expect(testState.verifyAdvertiserAccountAttachStore).not.toHaveBeenCalled();
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
  });

  it("blocks an unadmitted operator before agency or provider access", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error:
        "This account is not admitted to the MaintainFlow private beta yet.",
    });
    expect(testState.requireAgencyAccountAttachAuthorization).not.toHaveBeenCalled();
    expect(testState.verifyAdvertiserAccountAttachStore).not.toHaveBeenCalled();
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
    expect(testState.logWarn).toHaveBeenCalledWith(
      "agency.account_attach.rejected",
      expect.objectContaining({ status: 403 }),
    );
  });

  it("takes the organization only from a valid path UUID", async () => {
    const bodySelectedOrganization = await POST(
      request({
        adsApiKey: "ads_client_secret_123",
        organizationId: "00000000-0000-4000-8000-000000000099",
      }),
      context(),
    );
    const invalidPath = await POST(request(), context("current-agency"));

    expect(bodySelectedOrganization.status).toBe(422);
    expect(invalidPath.status).toBe(422);
    expect(testState.requireAgencyAccountAttachAuthorization).not.toHaveBeenCalled();
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
  });

  it("does not call the provider when the encrypted store is unavailable", async () => {
    testState.verifyAdvertiserAccountAttachStore.mockResolvedValue(false);

    const response = await POST(request(), context());

    expect(response.status).toBe(503);
    expect(testState.requireAgencyAccountAttachAuthorization).toHaveBeenCalled();
    expect(testState.fetchLiveAdAccount).not.toHaveBeenCalled();
  });

  it("does not encrypt or persist a key rejected by the provider", async () => {
    testState.fetchLiveAdAccount.mockRejectedValue(
      new testState.OpenAIAdsApiError(401),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(400);
    expect(testState.encryptAdsApiKey).not.toHaveBeenCalled();
    expect(testState.attachAdvertiserAccountToAgency).not.toHaveBeenCalled();
  });

  it("surfaces an existing-account claim as a conflict without exposing the key", async () => {
    testState.attachAdvertiserAccountToAgency.mockRejectedValue(
      new testState.AdvertiserAccountAttachConflictError(
        "This Ads account is already connected to another workspace.",
      ),
    );

    const response = await POST(request(), context());
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({
      error: "This Ads account is already connected to another workspace.",
    });
    expect(JSON.stringify(payload)).not.toContain("ads_client_secret_123");
  });

  it("rejects stale authority after provider verification", async () => {
    testState.attachAdvertiserAccountToAgency.mockRejectedValue(
      new testState.AccountAccessForbiddenError(
        "Agency account-connection access changed.",
      ),
    );

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    expect(testState.fetchLiveAdAccount).toHaveBeenCalledOnce();
    expect(testState.attachAdvertiserAccountToAgency).toHaveBeenCalledOnce();
  });
});
