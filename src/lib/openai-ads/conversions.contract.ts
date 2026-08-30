import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ConversionsApiPayloadInvalidError,
  ConversionsApiProviderRejectedError,
  ConversionsApiTransportUnconfirmedError,
  ConversionsApiValidationUnavailableError,
  getConversionsApiConnectionStatus,
  validateConversionsApiPayload,
} from "./conversions.server";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const originalFetch = globalThis.fetch;

function validPayload() {
  return {
    validate_only: true,
    integration_source: "customer_value_is_not_forwarded",
    events: [
      {
        id: "order_private_123",
        type: "order_created",
        timestamp_ms: NOW.getTime(),
        source_url: "https://shop.example/private-order",
        action_source: "web",
        data: {
          type: "contents",
          amount: 2599,
          currency: "EUR",
          contents: [
            {
              id: "sku_private_123",
              content_type: "product",
              quantity: 1,
            },
          ],
        },
      },
    ],
  };
}

function configure() {
  vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "private_read");
  vi.stubEnv("OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED", "true");
  vi.stubEnv("OPENAI_CONVERSIONS_ACCOUNT_ID", "adacct_pilot");
  vi.stubEnv("OPENAI_CONVERSIONS_PIXEL_ID", "pixel/id with reserved?");
  vi.stubEnv("OPENAI_CONVERSIONS_API_KEY", "capi_contract_secret");
}

beforeEach(() => {
  configure();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenAI Conversions API validate-only wire contract", () => {
  it("reports the server-managed fallback without exposing its Pixel or key", async () => {
    const status = await getConversionsApiConnectionStatus("adacct_pilot");

    expect(status).toEqual({
      state: "configured",
      source: "environment",
      validationEnabled: true,
      credentialVersion: null,
      validatedAt: null,
      providerStatus: null,
      eventCount: null,
    });
    expect(JSON.stringify(status)).not.toContain("pixel/id with reserved?");
    expect(JSON.stringify(status)).not.toContain("capi_contract_secret");
  });

  it("sends the documented server-only request and ignores undocumented response fields", async () => {
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;

      expect(url.origin).toBe("https://bzr.openai.com");
      expect(url.pathname).toBe("/v1/events");
      expect([...url.searchParams.keys()]).toEqual(["pid"]);
      expect(url.searchParams.get("pid")).toBe("pixel/id with reserved?");
      expect(init?.method).toBe("POST");
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("Content-Type")).toBe("application/json");
      expect(headers.get("Authorization")).toBe(
        "Bearer capi_contract_secret",
      );
      expect(body.validate_only).toBe(true);
      expect(body.integration_source).toBe("maintainflow");
      expect(body.events).toEqual(validPayload().events);

      return new Response(
        JSON.stringify({
          undocumented: "must-not-be-relied-on",
          reflected_private_value: "order_private_123",
        }),
        { status: 202 },
      );
    });

    const result = await validateConversionsApiPayload({
      accountId: "adacct_pilot",
      payload: validPayload(),
      now: NOW,
    });

    expect(result).toEqual({
      status: "validated",
      mode: "validate_only",
      eventCount: 1,
      providerStatus: 202,
    });
    expect(JSON.stringify(result)).not.toContain("order_private_123");
    expect(JSON.stringify(result)).not.toContain("capi_contract_secret");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("validates an authorized candidate pair without falling back to pilot credentials", async () => {
    vi.stubEnv("OPENAI_CONVERSIONS_ACCOUNT_ID", "adacct_other");
    vi.stubEnv("OPENAI_CONVERSIONS_PIXEL_ID", "");
    vi.stubEnv("OPENAI_CONVERSIONS_API_KEY", "");
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      const headers = new Headers(init?.headers);
      expect(url.searchParams.get("pid")).toBe("candidate_pixel");
      expect(headers.get("Authorization")).toBe("Bearer candidate_capi_key");
      return new Response(null, { status: 204 });
    });

    await expect(
      validateConversionsApiPayload({
        accountId: "adacct_pilot",
        credential: {
          pixelId: "candidate_pixel",
          apiKey: "candidate_capi_key",
        },
        payload: validPayload(),
        now: NOW,
      }),
    ).resolves.toEqual({
      status: "validated",
      mode: "validate_only",
      eventCount: 1,
      providerStatus: 204,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["disabled", "OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED", "false"],
    ["demo release stage", "MAINTAINFLOW_RELEASE_STAGE", "demo"],
    ["missing key", "OPENAI_CONVERSIONS_API_KEY", ""],
    ["missing Pixel ID", "OPENAI_CONVERSIONS_PIXEL_ID", ""],
    ["account mismatch", "OPENAI_CONVERSIONS_ACCOUNT_ID", "adacct_other"],
  ])("fails closed when the pilot configuration is %s", async (_label, key, value) => {
    vi.stubEnv(key, value);
    globalThis.fetch = vi.fn();

    await expect(
      validateConversionsApiPayload({
        accountId: "adacct_pilot",
        payload: validPayload(),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ConversionsApiValidationUnavailableError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects non-dry-run and invalid batches before opening a network connection", async () => {
    globalThis.fetch = vi.fn();

    await expect(
      validateConversionsApiPayload({
        accountId: "adacct_pilot",
        payload: { ...validPayload(), validate_only: false },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ConversionsApiPayloadInvalidError);

    await expect(
      validateConversionsApiPayload({
        accountId: "adacct_pilot",
        payload: {
          ...validPayload(),
          events: [{ id: "broken", type: "not_documented" }],
        },
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ConversionsApiPayloadInvalidError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("reports only the provider status when OpenAI rejects a batch", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: "provider detail with order_private_123 and capi_contract_secret",
        }),
        { status: 422 },
      ),
    );

    const error = await validateConversionsApiPayload({
      accountId: "adacct_pilot",
      payload: validPayload(),
      now: NOW,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConversionsApiProviderRejectedError);
    expect((error as ConversionsApiProviderRejectedError).providerStatus).toBe(422);
    expect((error as Error).message).not.toContain("order_private_123");
    expect((error as Error).message).not.toContain("capi_contract_secret");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unconfirmed transport failure", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("network failed with capi_contract_secret");
    });

    await expect(
      validateConversionsApiPayload({
        accountId: "adacct_pilot",
        payload: validPayload(),
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(ConversionsApiTransportUnconfirmedError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
