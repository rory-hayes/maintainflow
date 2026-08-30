import { fileURLToPath } from "node:url";

const RELEASE_STAGES = new Set(["demo", "private_read", "live_write"]);
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

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
    if (!TLS_MODES.has(parsed.searchParams.get("sslmode") ?? "")) {
      issues.push(
        "DATABASE_URL must require verified transport with sslmode=require, verify-ca, or verify-full.",
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
  validateDatabaseUrl(issues, env.DATABASE_URL);
  validateCredentialKeyring(issues, env);
  requireSecret(issues, env, "CRON_SECRET");
  requireSecret(issues, env, "READINESS_RATE_LIMIT_SECRET");

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = validateProductionConfig(process.env);
  if (result.issues.length > 0) {
    console.error(`Production configuration is not ready for ${result.stage}:`);
    for (const issue of result.issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log(`Production configuration is valid for ${result.stage}.`);
  }
}
