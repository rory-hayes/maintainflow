import { describe, expect, it } from "vitest";
import robots from "./robots";
import sitemap from "./sitemap";
describe("unpublished attribution metadata", () => {
  it("keeps the private preview out of search indexes", () => {
    expect(robots().rules).toEqual({ userAgent: "*", disallow: "/" });
    expect(robots().sitemap).toBeUndefined();
  });
  it("does not publish the original product domain", () =>
    expect(sitemap()).toEqual([]));
});
