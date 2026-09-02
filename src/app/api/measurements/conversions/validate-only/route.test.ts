import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => {
  class OperatorAuthUnavailableError extends Error {}
  class OperatorUnauthorizedError extends Error {}
  class AccountAccessForbiddenError extends Error {}
  class TenancyStoreUnavailableError extends Error {}
  class RequestBodyTooLargeError extends Error {}
  class ConversionsApiValidationUnavailableError extends Error {}
  class ConversionsApiTransportUnconfirmedError extends Error {}
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
    RequestBodyTooLargeError,
    ConversionsApiValidationUnavailableError,
    ConversionsApiTransportUnconfirmedError,
    ConversionsApiPayloadInvalidError,
    ConversionsApiProviderRejectedError,
    requireOperatorId: vi.fn(),
    requireAccountAccess: vi.fn(),
    validateConversionsApiPayload: vi.fn(),
    isSecureSameOriginRequest: vi.fn(),
    readJsonBodyWithLimit: vi.fn(),
    logInfo: vi.fn(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock("@/lib/auth/operator.server", () => ({
  OperatorAuthUnavailableError: testState.OperatorAuthUnavailableError,
  OperatorUnauthorizedError: testState.OperatorUnauthorizedError,
  requireOperatorId: testState.requireOperatorId,
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

const requestBody = {
  accountId: "adacct_pilot",
  payload: {
    validate_only: true,
    events: [{ id: "private_event_id", source_url: "https://shop.example/private" }],
  },
};

function request() {
  return new Request(
    "http://localhost/api/measurements/conversions/validate-only",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.isSecureSameOriginRequest.mockReturnValue(true);
  testState.readJsonBodyWithLimit.mockImplementation((input: Request) =>
    input.json(),
  );
  testState.requireOperatorId.mockResolvedValue("user_owner");
  testState.requireAccountAccess.mockResolvedValue({ accountRole: "owner" });
  testState.validateConversionsApiPayload.mockResolvedValue({
    status: "validated",
    mode: "validate_only",
    eventCount: 1,
    providerStatus: 202,
  });
});

describe("protected Conversions API validation route", () => {
  it("authorizes write access and returns only a no-store validation receipt", async () => {
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(testState.requireAccountAccess).toHaveBeenCalledWith(
      "user_owner",
      "adacct_pilot",
      "write",
    );
    expect(testState.validateConversionsApiPayload).toHaveBeenCalledWith({
      accountId: "adacct_pilot",
      payload: requestBody.payload,
    });
    expect(payload).toMatchObject({
      status: "validated",
      mode: "validate_only",
      eventCount: 1,
      providerStatus: 202,
    });
    expect(JSON.stringify(payload)).not.toContain("private_event_id");
    expect(JSON.stringify(payload)).not.toContain("shop.example");
    expect(testState.logInfo).toHaveBeenCalledWith(
      "conversions.validate_only.completed",
      expect.objectContaining({ status: 200, durationMs: expect.any(Number) }),
    );
  });

  it("rejects an insecure or cross-origin request before authentication", async () => {
    testState.isSecureSameOriginRequest.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(testState.requireOperatorId).not.toHaveBeenCalled();
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
  });

  it("requires an authenticated operator", async () => {
    testState.requireOperatorId.mockRejectedValue(
      new testState.OperatorUnauthorizedError("Sign in first."),
    );

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(testState.requireAccountAccess).not.toHaveBeenCalled();
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
  });

  it("requires write access to the exact account", async () => {
    testState.requireAccountAccess.mockRejectedValue(
      new testState.AccountAccessForbiddenError("Review-only access."),
    );

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
  });

  it("returns 413 when the bounded reader rejects an oversized request", async () => {
    testState.readJsonBodyWithLimit.mockRejectedValue(
      new testState.RequestBodyTooLargeError("Too large."),
    );

    const response = await POST(request());

    expect(response.status).toBe(413);
    expect(testState.requireAccountAccess).not.toHaveBeenCalled();
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
  });

  it("returns a privacy-safe schema failure", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiPayloadInvalidError("Invalid payload.", {
        eventCount: 1,
        blockerCount: 2,
      }),
    );

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(422);
    expect(payload).toEqual({
      error: "Invalid payload.",
      eventCount: 1,
      blockerCount: 2,
    });
    expect(JSON.stringify(payload)).not.toContain("private_event_id");
    expect(JSON.stringify(payload)).not.toContain("shop.example");
  });

  it("classifies only the request boundary as client schema input", async () => {
    testState.readJsonBodyWithLimit.mockResolvedValue({
      accountId: "",
      payload: {},
    });

    const response = await POST(request());

    expect(response.status).toBe(422);
    expect(testState.validateConversionsApiPayload).not.toHaveBeenCalled();
    expect(testState.logWarn).toHaveBeenCalledWith(
      "conversions.validate_only.rejected",
      expect.objectContaining({ status: 422 }),
    );
  });

  it("fails closed when the account-bound validation configuration is unavailable", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiValidationUnavailableError("Not configured."),
    );

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("maps provider rejection to a status-only upstream failure", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiProviderRejectedError(
        "OpenAI rejected validation.",
        422,
      ),
    );

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({
      error: "OpenAI rejected validation.",
      providerStatus: 422,
    });
    expect(testState.logWarn).toHaveBeenCalledWith(
      "conversions.validate_only.rejected",
      expect.objectContaining({ status: 502 }),
    );
    expect(testState.logError).not.toHaveBeenCalledWith(
      "conversions.validate_only.failed",
      expect.anything(),
    );
  });

  it("does not claim a result after an unconfirmed transport failure", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new testState.ConversionsApiTransportUnconfirmedError(
        "Validation was not confirmed.",
      ),
    );

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(502);
    expect(payload).toEqual({ error: "Validation was not confirmed." });
    expect(payload).not.toHaveProperty("status");
    expect(testState.logError).toHaveBeenCalledWith(
      "conversions.validate_only.unavailable",
      expect.objectContaining({ status: 502 }),
    );
  });

  it("returns and logs an exact generic 500 for an unexpected validation fault", async () => {
    const secret = "Bearer PLANTED_CONVERSION_SECRET";
    testState.validateConversionsApiPayload.mockRejectedValue(new Error(secret));

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(payload).toEqual({
      error: "OpenAI conversion validation could not be completed.",
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(testState.logError).toHaveBeenCalledWith(
      "conversions.validate_only.failed",
      expect.objectContaining({
        status: 500,
        error: expect.objectContaining({ message: secret }),
      }),
    );
  });

  it("does not present a downstream schema failure as a 422 client error", async () => {
    testState.validateConversionsApiPayload.mockRejectedValue(
      new ZodError([
        {
          code: "custom",
          path: ["provider", "receipt"],
          message: "PLANTED_PROVIDER_RECEIPT_SECRET",
        },
      ]),
    );

    const response = await POST(request());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "OpenAI conversion validation could not be completed.",
    });
  });
});
