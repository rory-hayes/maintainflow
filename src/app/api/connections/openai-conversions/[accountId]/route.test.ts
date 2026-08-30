import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class CredentialVaultUnavailableError extends Error {}
  class ConversionsCredentialUnavailableError extends Error {}
  class ConversionsApiValidationUnavailableError extends Error {}
  class ConversionsApiTransportUnconfirmedError extends Error {}
  class RequestBodyTooLargeError extends Error {}
  class ConversionsApiPayloadInvalidError extends Error {
    audit: { eventCount: number; blockerCount: number };

    constructor(
      message: string,
      audit: { eventCount: number; blockerCount: number },
    ) {
      super(message);
      this.audit = audit;
    }
  }
  class ConversionsApiProviderRejectedError extends Error {
    providerStatus: number;

    constructor(message: string, providerStatus: number) {
      super(message);
      this.providerStatus = providerStatus;
    }
  }

  return {
    OperatorAuthUnavailableError,
    OperatorUnauthorizedError,
    AccountAccessForbiddenError,
    TenancyStoreUnavailableError,
    CredentialVaultUnavailableError,
    ConversionsCredentialUnavailableError,
    ConversionsApiValidationUnavailableError,
    ConversionsApiTransportUnconfirmedError,
    RequestBodyTooLargeError,
    ConversionsApiPayloadInvalidError,
    ConversionsApiProviderRejectedError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    isCredentialVaultConfigured: vi.fn(),
    verifyConversionCredentialStore: vi.fn(),
    validateConversionsApiPayload: vi.fn(),
    encryptConversionsApiCredential: vi.fn(),
    rotateConversionsApiCredential: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    readJsonBodyWithLimit: vi.fn(),
  };
});

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
}));

vi.mock("@/lib/credentials/crypto.server", () => ({
  CredentialVaultUnavailableError: testState.CredentialVaultUnavailableError,
  encryptConversionsApiCredential:
    testState.encryptConversionsApiCredential,
  isCredentialVaultConfigured: testState.isCredentialVaultConfigured,
}));

vi.mock("@/lib/http/request-security.server", () => ({
  RequestBodyTooLargeError: testState.RequestBodyTooLargeError,
  isSecureSameOriginRequest: testState.isSecureSameOriginRequest,
  readJsonBodyWithLimit: testState.readJsonBodyWithLimit,
}));

vi.mock("@/lib/openai-ads/conversions.server", () => ({
  ConversionsApiPayloadInvalidError: testState.ConversionsApiPayloadInvalidError,
  ConversionsApiProviderRejectedError:
    testState.ConversionsApiProviderRejectedError,
  ConversionsApiTransportUnconfirmedError:
    testState.ConversionsApiTransportUnconfirmedError,
  ConversionsApiValidationUnavailableError:
    testState.ConversionsApiValidationUnavailableError,
  validateConversionsApiPayload: testState.validateConversionsApiPayload,
}));

vi.mock("@/lib/tenancy/store.server", () => ({
  AccountAccessForbiddenError: testState.AccountAccessForbiddenError,
  ConversionsCredentialUnavailableError:
    testState.ConversionsCredentialUnavailableError,
  TenancyStoreUnavailableError: testState.TenancyStoreUnavailableError,
  requireAccountAccess: testState.requireAccountAccess,
  rotateConversionsApiCredential: testState.rotateConversionsApiCredential,
  verifyConversionCredentialStore: testState.verifyConversionCredentialStore,
}));

import { POST } from "./route";

const validationPayload = {
  validate_only: true,
  events: [{ id: "private_event_id", type: "order_created" }],
};

const requestBody = {
  pixelId: "pixel_private_123",
  conversionsApiKey: "capi_private_secret_456",
  validationPayload,
};

function request() {
  return new Request(
    "http://localhost/api/connections/openai-conversions/adacct_client",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
  );
}

const context = {
  params: Promise.resolve({ accountId: "adacct_client" }),
};

const access = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  accountId: "adacct_client",
  membershipRole: "owner",
  accountRole: "owner",
};

const encrypted = {
  id: "00000000-0000-4000-8000-000000000010",
  provider: "openai_conversions",
  algorithm: "aes-256-gcm",
  keyId: "v1",
  ciphertext: Buffer.from("ciphertext"),
  initializationVector: Buffer.alloc(12),
  authenticationTag: Buffer.alloc(16),
};

beforeEach(() => {
  vi.clearAllMocks();
  testState.isSecureSameOriginRequest.mockReturnValue(true);
  testState.readJsonBodyWithLimit.mockImplementation((input: Request) =>
    input.json(),
  );
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.requireAccountAccess.mockResolvedValue(access);
  testState.isCredentialVaultConfigured.mockReturnValue(true);
  testState.verifyConversionCredentialStore.mockResolvedValue(true);
  testState.validateConversionsApiPayload.mockResolvedValue({
    status: "validated",
    mode: "validate_only",
    eventCount: 1,
    providerStatus: 202,
  });
  testState.encryptConversionsApiCredential.mockReturnValue(encrypted);
  testState.rotateConversionsApiCredential.mockImplementation(
    async ({ validatedAt }: { validatedAt: Date }) => ({
      credentialVersion: 2,
      validatedAt,
    }),
  );
});

describe("per-account conversion credential connection", () => {
  it("validates before encrypting and atomically rotating the selected account", async () => {
    const response = await POST(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_client",
      "write",
    );
    expect(testState.validateConversionsApiPayload).toHaveBeenCalledWith({
      accountId: "adacct_client",
      credential: {
        pixelId: "pixel_private_123",
        apiKey: "capi_private_secret_456",
      },
      payload: validationPayload,
    });
    expect(testState.encryptConversionsApiCredential).toHaveBeenCalledWith({
      credential: {
        pixelId: "pixel_private_123",
        apiKey: "capi_private_secret_456",
      },
      externalAccountId: "adacct_client",
    });
    expect(testState.rotateConversionsApiCredential).toHaveBeenCalledWith(
      expect.objectContaining({
        operatorId: "user_owner",
        accountId: "adacct_client",
        access,
        credential: encrypted,
        validatedAt: expect.any(Date),
        validation: { providerStatus: 202, eventCount: 1 },
      }),
    );
    expect(
      testState.validateConversionsApiPayload.mock.invocationCallOrder[0],
    ).toBeLessThan(
      testState.rotateConversionsApiCredential.mock.invocationCallOrder[0],
    );
    expect(payload).toMatchObject({
      connected: true,
      mode: "validate_only",
      credentialVersion: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("pixel_private_123");
    expect(JSON.stringify(payload)).not.toContain("capi_private_secret_456");
    expect(JSON.stringify(payload)).not.toContain("private_event_id");
  });

  it("rejects insecure requests before reading credentials", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(testState.requireOperatorId).not.toHaveBeenCalled();
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
  });

  it("does not validate candidate credentials for a review-only operator", async () => {
    testState.requireAccountAccess.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Review-only access."),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
    expect(testState.rotateConversionsApiCredential).not.toHaveBeenCalled();
  });

  it("does not contact OpenAI when encrypted storage is unavailable", async () => {
    testState.verifyConversionCredentialStore.mockResolvedValue(false);

    const response = await POST(request(), context);

    expect(response.status).toBe(503);
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
    expect(testState.encryptConversionsApiCredential).not.toHaveBeenCalled();
  });

  it("does not store credentials rejected by OpenAI", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiProviderRejectedError(
        "OpenAI rejected validation.",
        401,
      ),
    );

    const response = await POST(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toEqual({
      error: "OpenAI rejected validation.",
      providerStatus: 401,
    });
    expect(testState.encryptConversionsApiCredential).not.toHaveBeenCalled();
    expect(testState.rotateConversionsApiCredential).not.toHaveBeenCalled();
  });

  it("does not store a locally invalid dry-run payload", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiPayloadInvalidError("Invalid payload.", {
        eventCount: 1,
        blockerCount: 2,
      }),
    );

    const response = await POST(request(), context);
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toEqual({
      error: "Invalid payload.",
      eventCount: 1,
      blockerCount: 2,
    });
    expect(testState.encryptConversionsApiCredential).not.toHaveBeenCalled();
    expect(testState.rotateConversionsApiCredential).not.toHaveBeenCalled();
  });

  it("does not persist an unconfirmed transport attempt", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiTransportUnconfirmedError(
        "Validation was not confirmed.",
      ),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(502);
    expect(testState.encryptConversionsApiCredential).not.toHaveBeenCalled();
    expect(testState.rotateConversionsApiCredential).not.toHaveBeenCalled();
  });

  it("rejects an oversized request before account access or provider validation", async () => {
    testState.readJsonBodyWithLimit.mockRejectedValue(
      new testState.RequestBodyTooLargeError("Too large."),
    );

    const response = await POST(request(), context);

    expect(response.status).toBe(413);
    expect(testState.requireAccountAccess).not.toHaveBeenCalled();
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
  });
});
