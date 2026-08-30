import { describe, expect, it } from "vitest";

import { buildAdsResourcePath, parseAdsResourcePath } from "./resource-path";

describe("OpenAI Ads resource paths", () => {
  it("round-trips provider IDs without letting delimiters alter the request URL", () => {
    const entityId = "group/season?phase=one#draft% ü";
    const path = buildAdsResourcePath("ad_groups", entityId, "pause");

    expect(path).toBe(
      "/ad_groups/group%2Fseason%3Fphase%3Done%23draft%25%20%C3%BC/pause",
    );
    expect(parseAdsResourcePath(path)).toEqual({
      resource: "ad_groups",
      entityId,
      encodedEntityId:
        "group%2Fseason%3Fphase%3Done%23draft%25%20%C3%BC",
      action: "pause",
    });
  });

  it.each([
    "/ad_groups/raw/id",
    "/ad_groups/id?account=other",
    "/ad_groups/id#fragment",
    "/ad_groups/id%2fchild",
    "//other.example/ad_groups/id",
    "/ad_groups/../campaigns/id",
    "/ad_groups/id/archive",
  ])("rejects a noncanonical or unsupported path: %s", (path) => {
    expect(() => parseAdsResourcePath(path)).toThrow();
  });

  it("rejects IDs that cannot form a stable relative resource path", () => {
    expect(() => buildAdsResourcePath("ads", "")).toThrow();
    expect(() => buildAdsResourcePath("ads", ".")).toThrow();
    expect(() => buildAdsResourcePath("ads", "..")).toThrow();
    expect(() => buildAdsResourcePath("ads", "x".repeat(513))).toThrow();
  });
});
