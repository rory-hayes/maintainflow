import { execFileSync } from "node:child_process";

const GIT_REVISION_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const EXPLICIT_REVISION_KEYS = [
  "MAINTAINFLOW_BUILD_SHA",
  "VERCEL_GIT_COMMIT_SHA",
  "GITHUB_SHA",
] as const;

type RevisionEnvironment = Record<string, string | undefined>;
type GitCommand = (arguments_: readonly string[]) => string;

function normalizeBuildRevision(value: string | undefined) {
  const normalized = value?.trim();
  if (!normalized) return null;
  if (!GIT_REVISION_PATTERN.test(normalized)) {
    throw new Error(
      "The configured build revision must be a full 40- or 64-character hexadecimal Git SHA.",
    );
  }
  return normalized.toLowerCase();
}

function runGit(arguments_: readonly string[]) {
  return execFileSync("git", [...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Explicit CI/platform provenance is authoritative. The local Git fallback is
 * accepted only for a clean checkout, because HEAD cannot identify an artifact
 * that also contains uncommitted or untracked source changes.
 */
export function resolveBuildTimeRevision(
  env: RevisionEnvironment = process.env,
  git: GitCommand = runGit,
) {
  const explicitRevisions = EXPLICIT_REVISION_KEYS.flatMap((key) => {
    if (!env[key]?.trim()) return [];
    return [{ key, revision: normalizeBuildRevision(env[key]) }];
  });
  const distinctExplicitRevisions = new Set(
    explicitRevisions.map(({ revision }) => revision),
  );
  if (distinctExplicitRevisions.size > 1) {
    throw new Error(
      `Conflicting build revision provenance was supplied through ${explicitRevisions.map(({ key }) => key).join(", ")}.`,
    );
  }
  if (explicitRevisions.length > 0) {
    return explicitRevisions[0].revision;
  }

  try {
    if (git(["status", "--porcelain", "--untracked-files=normal"]).trim()) {
      return null;
    }
    return normalizeBuildRevision(git(["rev-parse", "HEAD"]));
  } catch {
    return null;
  }
}
