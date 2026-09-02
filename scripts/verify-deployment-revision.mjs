import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

export class DeploymentRevisionError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeploymentRevisionError";
  }
}

function runGit(arguments_) {
  return execFileSync("git", arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export function verifyDeployableRevision(
  revision,
  ancestorRef = "origin/main",
  git = runGit,
) {
  const normalized = revision?.trim().toLowerCase();
  if (!normalized || !FULL_GIT_OBJECT_ID_PATTERN.test(normalized)) {
    throw new DeploymentRevisionError(
      "The deployed revision must be a full 40- or 64-character hexadecimal Git object id.",
    );
  }
  if (typeof ancestorRef !== "string" || ancestorRef.trim().length === 0) {
    throw new DeploymentRevisionError("The trusted deployment branch is missing.");
  }

  let resolved;
  try {
    resolved = git(["rev-parse", "--verify", `${normalized}^{commit}`])
      .trim()
      .toLowerCase();
  } catch {
    throw new DeploymentRevisionError(
      "The deployed revision does not resolve to a commit in this repository.",
    );
  }
  if (resolved !== normalized) {
    throw new DeploymentRevisionError(
      "The deployed revision did not resolve to the exact supplied object id.",
    );
  }

  try {
    git(["merge-base", "--is-ancestor", resolved, ancestorRef.trim()]);
  } catch {
    throw new DeploymentRevisionError(
      "The deployed revision is not an ancestor of the trusted deployment branch.",
    );
  }
  return resolved;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      verifyDeployableRevision(process.argv[2], process.argv[3] ?? "origin/main"),
    );
  } catch (error) {
    console.error(
      error instanceof DeploymentRevisionError
        ? error.message
        : "The deployed revision could not be verified.",
    );
    process.exitCode = 1;
  }
}
