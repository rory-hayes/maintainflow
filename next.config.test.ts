import {
  getRedirectUrl,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.MAINTAINCODE_APP_ORIGIN = "https://ads.example.test";
});

import nextConfig from "./next.config";

describe("server dependency boundaries", () => {
  it("loads the install-time patched postgres driver outside the Next server bundle", () => {
    expect(nextConfig.serverExternalPackages).toContain("postgres");
  });
});

async function configuredResponse(url: string) {
  return unstable_getResponseFromNextConfig({ url, nextConfig });
}

describe("canonical production host", () => {
  it("redirects a www browser route and preserves its query", async () => {
    const response = await configuredResponse(
      "https://www.ads.example.test/app?tab=campaigns",
    );

    expect(response.status).toBe(308);
    expect(getRedirectUrl(response)).toBe(
      "https://ads.example.test/app?tab=campaigns",
    );
  });

  it("does not redirect the canonical apex host", async () => {
    const response = await configuredResponse(
      "https://ads.example.test/app?tab=campaigns",
    );

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect protected API requests across hosts", async () => {
    const response = await configuredResponse(
      "https://www.ads.example.test/api/ready",
    );

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("MaintainCode release surfaces", () => {
  it("allows cross-origin tracker loading while retaining general security headers", async () => {
    const response = await configuredResponse(
      "https://ads.example.test/mc-tracker.js",
    );
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("routes retired marketing material into the current application", async () => {
    const response = await configuredResponse(
      "https://ads.example.test/blog/old-product",
    );
    expect(response.status).toBe(307);
    expect(getRedirectUrl(response)).toBe("https://ads.example.test/app");
  });
});
