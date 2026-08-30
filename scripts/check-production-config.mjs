import { fileURLToPath } from "node:url";

import {
  publicClerkConfigDigest,
  readPublicBuildMetadata,
} from "./public-build-metadata.mjs";

const RELEASE_STAGES = new Set(["demo", "private_read", "live_write"]);
const PRODUCTION_SECRET_KEYS = [
  "MAINTAINFLOW_READINESS_PROBE_SECRET",
  "CRON_SECRET",
  "READINESS_RATE_LIMIT_SECRET",
];

function present(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requireValue(issues, env, key) {
  if (!present(env[key])) issues.push(`${key} is required.`);
}

function requireSecret(issues, env, key, minimumLength = 32) {
  if (!present(env[key]) || env[key].length < minimumLength) {
    issues.push(`${key} must contain at least ${minimumLength} characters.`);
  }
}

function requireDistinctSecrets(issues, env, keys, minimumLength = 32) {
  const validValues = keys
    .map((key) => env[key])
    .filter((value) => present(value) && value.length >= minimumLength);

  if (new Set(validValues).size !== validValues.length) {
    issues.push(
      "MAINTAINFLOW_READINESS_PROBE_SECRET, CRON_SECRET, and READINESS_RATE_LIMIT_SECRET must use pairwise distinct values.",
    );
  }
}

function requireContactEmail(issues, env, key) {
  const value = env[key];
  if (
    !present(value) ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  ) {
    issues.push(`${key} must be a valid monitored email address.`);
  }
}

function validateDatabasePoolMax(issues, value) {
  if (!present(value)) return;
  if (!/^\d+$/.test(value)) {
    issues.push(
      "MAINTAINFLOW_DATABASE_POOL_MAX must be an integer from 1 through 10.",
    );
    return;
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 10) {
    issues.push(
      "MAINTAINFLOW_DATABASE_POOL_MAX must be an integer from 1 through 10.",
    );
  }
}

function validateOrigin(issues, value) {
  if (!present(value)) {
    issues.push("MAINTAINFLOW_APP_ORIGIN is required.");
    return;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      value.replace(/\/$/, "") !== parsed.origin
    ) {
      issues.push(
        "MAINTAINFLOW_APP_ORIGIN must be an exact public HTTPS origin without a path, query, or fragment.",
      );
    }
  } catch {
    issues.push("MAINTAINFLOW_APP_ORIGIN must be a valid HTTPS origin.");
  }
}

function validateDatabaseUrl(issues, value) {
  if (!present(value)) {
    issues.push("DATABASE_URL is required.");
    return;
  }
  try {
    const parsed = new URL(value);
    if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
      issues.push("DATABASE_URL must use the postgres or postgresql protocol.");
    }
    for (const [key] of parsed.searchParams) {
      const normalized = key.toLowerCase();
      if (normalized === "search_path" || normalized === "options") {
        issues.push(
          "DATABASE_URL must not override the runtime database search path.",
        );
        break;
      }
    }
    const sslModes = [...parsed.searchParams].filter(
      ([key]) => key.toLowerCase() === "sslmode",
    );
    if (
      sslModes.length !== 1 ||
      sslModes[0][0] !== "sslmode" ||
      sslModes[0][1] !== "verify-full"
    ) {
      issues.push(
        "DATABASE_URL must include exactly one sslmode=verify-full parameter.",
      );
    }
  } catch {
    issues.push("DATABASE_URL must be a valid PostgreSQL URL.");
  }
}

function validateCredentialKeyring(issues, env) {
  const serialized = env.MAINTAINFLOW_CREDENTIAL_KEYRING;
  const activeKeyId = env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID;
  if (!present(serialized)) {
    issues.push("MAINTAINFLOW_CREDENTIAL_KEYRING is required.");
    return;
  }
  if (!present(activeKeyId)) {
    issues.push("MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID is required.");
    return;
  }

  try {
    const keyring = JSON.parse(serialized);
    if (
      !keyring ||
      typeof keyring !== "object" ||
      Array.isArray(keyring) ||
      typeof keyring[activeKeyId] !== "string"
    ) {
      issues.push("The active credential key ID must exist in the keyring.");
      return;
    }
    for (const [keyId, encoded] of Object.entries(keyring)) {
      if (!present(keyId) || typeof encoded !== "string") {
        issues.push("Every credential keyring entry must have a key ID and base64 value.");
        return;
      }
      const bytes = Buffer.from(encoded, "base64");
      if (bytes.length !== 32 || bytes.toString("base64") !== encoded) {
        issues.push("Every credential keyring value must encode exactly 32 bytes.");
        return;
      }
    }
  } catch {
    issues.push("MAINTAINFLOW_CREDENTIAL_KEYRING must be valid JSON.");
  }
}

export function validateProductionConfig(env) {
  const issues = [];
  const stage = env.MAINTAINFLOW_RELEASE_STAGE ?? "demo";

  if (!RELEASE_STAGES.has(stage)) {
    issues.push(
      "MAINTAINFLOW_RELEASE_STAGE must be demo, private_read, or live_write.",
    );
  }
  validateOrigin(issues, env.MAINTAINFLOW_APP_ORIGIN);
  validateDatabasePoolMax(issues, env.MAINTAINFLOW_DATABASE_POOL_MAX);
  requireValue(issues, env, "MAINTAINFLOW_LEGAL_ENTITY_NAME");
  requireContactEmail(issues, env, "MAINTAINFLOW_PRIVACY_CONTACT_EMAIL");
  requireContactEmail(issues, env, "MAINTAINFLOW_SUPPORT_CONTACT_EMAIL");
  validateDatabaseUrl(issues, env.DATABASE_URL);
  requireSecret(issues, env, "READINESS_RATE_LIMIT_SECRET");
  requireSecret(issues, env, "MAINTAINFLOW_READINESS_PROBE_SECRET");
  requireSecret(issues, env, "CRON_SECRET");
  requireDistinctSecrets(issues, env, PRODUCTION_SECRET_KEYS);

  if (env.MAINTAINFLOW_ADMISSION_MODE === "open") {
    issues.push(
      "Production releases cannot use MAINTAINFLOW_ADMISSION_MODE=open before public-launch controls are implemented.",
    );
  }
  if (env.MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED === "true") {
    issues.push(
      "Production releases cannot enable MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED before public-launch controls are implemented.",
    );
  }

  if (stage === "demo") {
    if (env.OPENAI_ADS_DATA_MODE && env.OPENAI_ADS_DATA_MODE !== "demo") {
      issues.push("The demo release stage requires OPENAI_ADS_DATA_MODE=demo.");
    }
    if (env.OPENAI_ADS_LIVE_WRITES_ENABLED === "true") {
      issues.push("The demo release stage cannot enable live Ads writes.");
    }
    if (env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED === "true") {
      issues.push("The demo release stage cannot contact the Conversions API.");
    }
    return { stage, issues };
  }

  requireValue(issues, env, "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
  requireValue(issues, env, "CLERK_SECRET_KEY");
  validateCredentialKeyring(issues, env);

  if (env.MAINTAINFLOW_ADMISSION_MODE !== "private_beta") {
    issues.push(
      "Pre-payment releases require MAINTAINFLOW_ADMISSION_MODE=private_beta.",
    );
  }
  requireValue(issues, env, "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS");
  if (env.OPENAI_ADS_DATA_MODE !== "live") {
    issues.push(`${stage} requires OPENAI_ADS_DATA_MODE=live.`);
  }
  if (stage === "private_read" && env.OPENAI_ADS_LIVE_WRITES_ENABLED === "true") {
    issues.push("The private_read release stage must keep live Ads writes disabled.");
  }
  if (stage === "live_write" && env.OPENAI_ADS_LIVE_WRITES_ENABLED !== "true") {
    issues.push("The live_write release stage requires the live-write flag.");
  }

  return { stage, issues };
}

export function validateStartupProductionConfig(
  env,
  { metadataPath } = {},
) {
  const result = validateProductionConfig(env);
  const issues = [...result.issues];

  try {
    const metadata = readPublicBuildMetadata(metadataPath);
    if (
      metadata.publicClerkConfigSha256 !== publicClerkConfigDigest(env)
    ) {
      issues.push(
        "Runtime NEXT_PUBLIC Clerk configuration does not match the values compiled by npm run build.",
      );
    }
  } catch {
    issues.push(
      "Compiled NEXT_PUBLIC configuration metadata is missing or invalid; run npm run build before npm start.",
    );
  }

  return { ...result, issues };
}

export async function loadNextProductionEnvironment() {
  const nextEnvModule = await import("@next/env");
  const { loadEnvConfig } = nextEnvModule.default ?? nextEnvModule;
  loadEnvConfig(process.cwd(), false);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadNextProductionEnvironment();
  const result = process.argv.includes("--startup")
    ? validateStartupProductionConfig(process.env)
    : validateProductionConfig(process.env);
  if (result.issues.length > 0) {
    console.error(`Production configuration is not ready for ${result.stage}:`);
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`Production configuration is valid for ${result.stage}.`);
  }
}
