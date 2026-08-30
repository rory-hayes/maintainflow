import { describe, expect, it, vi } from "vitest";

import { resolveBuildTimeRevision } from "./build-revision";

describe("build-time revision provenance", () => {
  it("prefers an explicit build revision without consulting Git", () => {
    const git = vi.fn();

    expect(
      resolveBuildTimeRevision(
        {
          MAINTAINFLOW_BUILD_SHA: "A".repeat(40),
          VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
        },
        git,
      ),
    ).toBe("a".repeat(40));
    expect(git).not.toHaveBeenCalled();
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
    expect(() =>
      resolveBuildTimeRevision({ GITHUB_SHA: "latest" }, vi.fn()),
    ).toThrow(/hexadecimal Git SHA/);
  });
});
