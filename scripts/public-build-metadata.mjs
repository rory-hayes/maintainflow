import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PUBLIC_BUILD_METADATA_PATH =
  ".next/maintainflow-public-build-metadata.json";

const PUBLIC_CLERK_CONFIG_KEYS = [
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_CLERK_SIGN_IN_URL",
  "NEXT_PUBLIC_CLERK_SIGN_UP_URL",
];

function normalizedPublicClerkConfig(env) {
  return Object.fromEntries(
    PUBLIC_CLERK_CONFIG_KEYS.map((key) => [
      key,
      typeof env[key] === "string" ? env[key] : "",
    ]),
  );
}

export function publicClerkConfigDigest(env) {
  return createHash("sha256")
    .update(JSON.stringify(normalizedPublicClerkConfig(env)), "utf8")
    .digest("hex");
}

export function createPublicBuildMetadata(env) {
  return {
    schemaVersion: 1,
    publicConfigKeys: [...PUBLIC_CLERK_CONFIG_KEYS],
    publicClerkConfigSha256: publicClerkConfigDigest(env),
  };
}

function isPublicBuildMetadata(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schemaVersion === 1 &&
    Array.isArray(value.publicConfigKeys) &&
    value.publicConfigKeys.length === PUBLIC_CLERK_CONFIG_KEYS.length &&
    value.publicConfigKeys.every(
      (key, index) => key === PUBLIC_CLERK_CONFIG_KEYS[index],
    ) &&
    typeof value.publicClerkConfigSha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.publicClerkConfigSha256)
  );
}

export function readPublicBuildMetadata(
  metadataPath = resolve(process.cwd(), PUBLIC_BUILD_METADATA_PATH),
) {
  const parsed = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!isPublicBuildMetadata(parsed)) {
    throw new Error("Public build metadata has an unsupported shape.");
  }
  return parsed;
}

export function writePublicBuildMetadata(
  env,
  metadataPath = resolve(process.cwd(), PUBLIC_BUILD_METADATA_PATH),
) {
  mkdirSync(dirname(metadataPath), { recursive: true });
  writeFileSync(
    metadataPath,
    `${JSON.stringify(createPublicBuildMetadata(env), null, 2)}\n`,
    { encoding: "utf8", mode: 0o644 },
  );
  return metadataPath;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const nextEnvModule = await import("@next/env");
  const { loadEnvConfig } = nextEnvModule.default ?? nextEnvModule;
  loadEnvConfig(process.cwd(), false);
  const metadataPath = writePublicBuildMetadata(process.env);
  console.log(`Wrote non-secret public build metadata to ${metadataPath}.`);
}
