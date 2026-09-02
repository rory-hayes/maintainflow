import { describe, expect, it } from "vitest";

import { resolveBuildRevision } from "./revision";

describe("deployment revision provenance", () => {
  it("accepts and normalizes a build-time compiled Git revision", () => {
    expect(resolveBuildRevision("A".repeat(40))).toBe("a".repeat(40));
    expect(resolveBuildRevision("B".repeat(64))).toBe("b".repeat(64));
  });

  it("fails closed for absent, placeholder, or malformed compiled provenance", () => {
    expect(resolveBuildRevision("latest")).toBeNull();
    expect(resolveBuildRevision("unknown")).toBeNull();
    expect(resolveBuildRevision("a".repeat(7))).toBeNull();
    expect(resolveBuildRevision("b".repeat(41))).toBeNull();
    expect(resolveBuildRevision(" ")).toBeNull();
    expect(resolveBuildRevision(undefined)).toBeNull();
  });
});
