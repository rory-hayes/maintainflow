import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isSecureSameOriginRequest,
  readBodyWithLimit,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
  requestBodyExceeds,
} from "./request-security.server";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sensitive route request boundary", () => {
  it("requires HTTPS and the same origin in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");

    expect(
      isSecureSameOriginRequest(
        new Request("https://maintainflow.io/api/onboarding/workspace", {
          headers: { Origin: "https://maintainflow.io" },
        }),
      ),
    ).toBe(true);
    expect(
      isSecureSameOriginRequest(
        new Request("https://maintainflow.io/api/onboarding/workspace", {
          headers: { Origin: "https://attacker.example" },
        }),
      ),
    ).toBe(false);
    expect(
      isSecureSameOriginRequest(
        new Request("http://maintainflow.io/api/onboarding/workspace", {
          headers: { Origin: "http://maintainflow.io" },
        }),
      ),
    ).toBe(false);
  });

  it("accepts a trusted HTTPS forwarding signal with a matching origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");
    vi.stubEnv("MAINTAINFLOW_TRUST_PROXY_HEADERS", "true");
    const request = new Request(
      "http://maintainflow.io/api/onboarding/workspace",
      {
        headers: {
          Origin: "https://maintainflow.io",
          "X-Forwarded-Proto": "https",
        },
      },
    );

    expect(isSecureSameOriginRequest(request)).toBe(true);
  });

  it("uses the public Host when the standalone server has an internal URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");
    vi.stubEnv("MAINTAINFLOW_TRUST_PROXY_HEADERS", "true");
    const request = new Request(
      "http://0.0.0.0:3000/api/onboarding/workspace",
      {
        headers: {
          Host: "maintainflow.io",
          Origin: "https://maintainflow.io",
          "X-Forwarded-Proto": "https",
        },
      },
    );

    expect(isSecureSameOriginRequest(request)).toBe(true);
  });

  it("fails closed without a canonical origin or explicit proxy trust", () => {
    vi.stubEnv("NODE_ENV", "production");
    const forwardedRequest = new Request(
      "http://maintainflow.io/api/onboarding/workspace",
      {
        headers: {
          Host: "maintainflow.io",
          Origin: "https://maintainflow.io",
          "X-Forwarded-Proto": "https",
        },
      },
    );

    expect(isSecureSameOriginRequest(forwardedRequest)).toBe(false);
    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");
    expect(isSecureSameOriginRequest(forwardedRequest)).toBe(false);
  });

  it("allows local development and caps declared request bodies", () => {
    vi.stubEnv("NODE_ENV", "development");
    const request = new Request("http://localhost/api/onboarding/workspace", {
      headers: { "Content-Length": "20000" },
    });

    expect(isSecureSameOriginRequest(request)).toBe(true);
    expect(requestBodyExceeds(request, 16_384)).toBe(true);
  });

  it("caps the bytes actually streamed when content length is absent", async () => {
    const request = new Request("http://localhost/api/readiness/audit", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com", pad: "x".repeat(5000) }),
    });

    await expect(readJsonBodyWithLimit(request, 4_096)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });

  it("parses a JSON body that is within the streamed limit", async () => {
    const request = new Request("http://localhost/api/readiness/audit", {
      method: "POST",
      body: JSON.stringify({ url: "https://example.com" }),
    });

    await expect(readJsonBodyWithLimit(request, 4_096)).resolves.toEqual({
      url: "https://example.com",
    });
  });

  it("caps an unexpected non-JSON body by the bytes actually received", async () => {
    const request = new Request("http://localhost/api/rollback", {
      method: "POST",
      body: "x".repeat(2_000),
    });

    await expect(readBodyWithLimit(request, 1_024)).rejects.toBeInstanceOf(
      RequestBodyTooLargeError,
    );
  });
});
