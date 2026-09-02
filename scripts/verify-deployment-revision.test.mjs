import { describe, expect, it, vi } from "vitest";

import {
  DeploymentRevisionError,
  verifyDeployableRevision,
} from "./verify-deployment-revision.mjs";

describe("hosted deployment revision provenance", () => {
  it("requires the exact supplied commit to be on the trusted branch", () => {
    const revision = "A".repeat(40);
    const git = vi
      .fn()
      .mockReturnValueOnce(`${"a".repeat(40)}\n`)
      .mockReturnValueOnce("");

    expect(verifyDeployableRevision(revision, "origin/main", git)).toBe(
      "a".repeat(40),
    );
    expect(git).toHaveBeenNthCalledWith(1, [
      "rev-parse",
      "--verify",
      `${"a".repeat(40)}^{commit}`,
    ]);
    expect(git).toHaveBeenNthCalledWith(2, [
      "merge-base",
      "--is-ancestor",
      "a".repeat(40),
      "origin/main",
    ]);
  });

  it("rejects short, malformed, nonexistent, or non-ancestor revisions", () => {
    for (const value of ["a".repeat(7), "latest", "b".repeat(41)]) {
      expect(() => verifyDeployableRevision(value, "origin/main", vi.fn()))
        .toThrow(DeploymentRevisionError);
    }

    expect(() =>
      verifyDeployableRevision("a".repeat(40), "origin/main", vi.fn(() => {
        throw new Error("missing");
      })),
    ).toThrow(/does not resolve to a commit/);

    const nonAncestorGit = vi
      .fn()
      .mockReturnValueOnce(`${"a".repeat(40)}\n`)
      .mockImplementationOnce(() => {
        throw new Error("not ancestor");
      });
    expect(() =>
      verifyDeployableRevision(
        "a".repeat(40),
        "origin/main",
        nonAncestorGit,
      ),
    ).toThrow(/not an ancestor/);
  });

  it("rejects a resolver that returns a different full object id", () => {
    expect(() =>
      verifyDeployableRevision(
        "a".repeat(40),
        "origin/main",
        vi.fn(() => `${"b".repeat(40)}\n`),
      ),
    ).toThrow(/exact supplied object id/);
  });
});
