import {
  getRedirectUrl,
  unstable_getResponseFromNextConfig,
} from "next/experimental/testing/server";
import { describe, expect, it } from "vitest";

import nextConfig from "./next.config";

async function configuredResponse(url: string) {
  return unstable_getResponseFromNextConfig({ url, nextConfig });
}

describe("canonical production host", () => {
  it("redirects a www browser route and preserves its query", async () => {
    const response = await configuredResponse(
      "https://www.maintainflow.io/app?tab=campaigns",
    );

    expect(response.status).toBe(308);
    expect(getRedirectUrl(response)).toBe(
      "https://maintainflow.io/app?tab=campaigns",
    );
  });

  it("does not redirect the canonical apex host", async () => {
    const response = await configuredResponse(
      "https://maintainflow.io/app?tab=campaigns",
    );

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect protected API requests across hosts", async () => {
    const response = await configuredResponse(
      "https://www.maintainflow.io/api/ready",
    );

    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });
});
