import { describe, expect, it } from "vitest";

import { buildSecurityHeaders } from "./security-headers";

function asRecord(isProduction: boolean) {
  return Object.fromEntries(
    buildSecurityHeaders({ isProduction }).map(({ key, value }) => [
      key,
      value,
    ]),
  );
}

describe("application security headers", () => {
  it("keeps the enforced CSP compatible with static rendering and external auth", () => {
    const headers = asRecord(false);

    expect(headers["Content-Security-Policy"]).toBe(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe(
      "same-origin-allow-popups",
    );
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-site");
    expect(headers["X-Permitted-Cross-Domain-Policies"]).toBe("none");
  });

  it("enables HSTS only for production builds", () => {
    expect(asRecord(false)["Strict-Transport-Security"]).toBeUndefined();
    expect(asRecord(true)["Strict-Transport-Security"]).toBe(
      "max-age=31536000; includeSubDomains",
    );
  });

  it("emits every header key exactly once", () => {
    const headers = buildSecurityHeaders({ isProduction: true });
    const keys = headers.map(({ key }) => key.toLowerCase());

    expect(new Set(keys).size).toBe(keys.length);
  });
});
