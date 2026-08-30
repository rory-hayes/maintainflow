import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveReleaseStage } from "./stage";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("release-stage resolution", () => {
  it("defaults to demo and accepts only declared stages", () => {
    expect(resolveReleaseStage(undefined)).toBe("demo");
    expect(resolveReleaseStage("private_read")).toBe("private_read");
    expect(resolveReleaseStage("live_write")).toBe("live_write");
    expect(resolveReleaseStage("production")).toBe("invalid");
  });

  it("reads the current server environment when no value is supplied", () => {
    vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "private_read");
    expect(resolveReleaseStage()).toBe("private_read");
  });
});
