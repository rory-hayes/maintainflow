import { describe, expect, it, vi } from "vitest";

import { resolveBuildTimeRevision } from "./build-revision";

describe("build-time revision provenance", () => {
  it("uses matching explicit build provenance without consulting Git", () => {
    const git = vi.fn();

    expect(
      resolveBuildTimeRevision(
        {
          MAINTAINFLOW_BUILD_SHA: "A".repeat(40),
          VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
        },
        git,
      ),
    ).toBe("a".repeat(40));
    expect(git).not.toHaveBeenCalled();
  });

  it("rejects conflicting explicit provenance instead of trusting source order", () => {
    expect(() =>
      resolveBuildTimeRevision(
        {
          MAINTAINFLOW_BUILD_SHA: "a".repeat(40),
          VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
          GITHUB_SHA: "c".repeat(40),
        },
        vi.fn(),
      ),
    ).toThrow(/Conflicting build revision provenance/);
  });

  it("uses HEAD only when the local checkout is clean", () => {
    const cleanGit = vi
      .fn()
      .mockReturnValueOnce("")
      .mockReturnValueOnce(`${"c".repeat(40)}\n`);

    expect(resolveBuildTimeRevision({}, cleanGit)).toBe("c".repeat(40));
    expect(cleanGit).toHaveBeenNthCalledWith(1, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    expect(cleanGit).toHaveBeenNthCalledWith(2, ["rev-parse", "HEAD"]);
  });

  it("refuses to label a dirty or unavailable checkout as clean HEAD", () => {
    const dirtyGit = vi.fn().mockReturnValue(" M src/app.ts\n");
    expect(resolveBuildTimeRevision({}, dirtyGit)).toBeNull();
    expect(dirtyGit).toHaveBeenCalledTimes(1);

    const unavailableGit = vi.fn(() => {
      throw new Error("git unavailable");
    });
    expect(resolveBuildTimeRevision({}, unavailableGit)).toBeNull();
  });

  it("rejects malformed explicit provenance instead of falling back", () => {
    for (const revision of ["latest", "a".repeat(7), "b".repeat(41)]) {
      expect(() =>
        resolveBuildTimeRevision({ GITHUB_SHA: revision }, vi.fn()),
      ).toThrow(/full 40- or 64-character hexadecimal Git SHA/);
    }
  });

  it("accepts a full SHA-256 Git object id", () => {
    expect(
      resolveBuildTimeRevision({ GITHUB_SHA: "D".repeat(64) }, vi.fn()),
    ).toBe("d".repeat(64));
  });
});
