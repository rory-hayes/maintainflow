import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getTrustedReadinessClientIp } from "./rate-limit.server";

function request(headers: Record<string, string> = {}) {
  return new Request("https://maintainflow.io/api/readiness/audit", {
    headers,
  });
}

describe("readiness client address trust", () => {
  it("uses Vercel's protected forwarded address on Vercel", () => {
    expect(
      getTrustedReadinessClientIp(
        request({
          "x-vercel-forwarded-for": "203.0.113.20",
          "x-forwarded-for": "198.51.100.4",
        }),
        { vercel: true, production: true },
      ),
    ).toBe("203.0.113.20");
  });

  it("only trusts a custom proxy header when explicitly enabled", () => {
    const forwarded = request({ "x-forwarded-for": "198.51.100.4" });
    expect(
      getTrustedReadinessClientIp(forwarded, {
        vercel: false,
        trustForwardedFor: false,
        production: true,
      }),
    ).toBeNull();
    expect(
      getTrustedReadinessClientIp(forwarded, {
        vercel: false,
        trustForwardedFor: true,
        production: true,
      }),
    ).toBe("198.51.100.4");
  });

  it("rejects malformed trusted header values", () => {
    expect(
      getTrustedReadinessClientIp(
        request({ "x-vercel-forwarded-for": "not-an-ip" }),
        { vercel: true, production: true },
      ),
    ).toBeNull();
  });
});
