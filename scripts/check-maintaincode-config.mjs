import { fileURLToPath } from "node:url";
import { validateDatabaseCaCertificate } from "./database-tls.mjs";
import {
  publicSupabaseConfigDigest,
  readPublicBuildMetadata,
} from "./public-build-metadata.mjs";

const REQUIRED = [
  "DATABASE_URL",
  "MAINTAINFLOW_DATABASE_CA_CERT",
  "MAINTAINFLOW_CREDENTIAL_KEYRING",
  "MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID",
  "MAINTAINCODE_APP_ORIGIN",
];

export function validateMaintainCodeConfig(
  env,
  { checkCertificate = validateDatabaseCaCertificate } = {},
) {
  const issues = REQUIRED.filter((key) => !env[key]?.trim()).map(
    (key) => `${key} is required.`,
  );
  for (const key of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  ])
    if (!env[key]?.trim()) issues.push(`${key} is required.`);
  if (
    env.MAINTAINFLOW_ADMISSION_MODE !== "open" ||
    env.MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED !== "true"
  )
    issues.push(
      "Self-service deployment requires MAINTAINFLOW_ADMISSION_MODE=open and MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED=true.",
    );
  if (env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("url");
    } catch {
      issues.push(
        "NEXT_PUBLIC_SUPABASE_URL must be an exact HTTPS project origin.",
      );
    }
  }
  if (env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_secret_"))
    issues.push(
      "A Supabase secret key must never be configured as a public publishable key.",
    );
  if (env.MAINTAINCODE_APP_ORIGIN) {
    try {
      const url = new URL(env.MAINTAINCODE_APP_ORIGIN);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("origin");
    } catch {
      issues.push(
        "MAINTAINCODE_APP_ORIGIN must be one exact HTTPS origin without a path, credentials, query or fragment.",
      );
    }
  }
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (
        !["postgres:", "postgresql:"].includes(url.protocol) ||
        !/^maintaincode_app(?:\.[A-Za-z0-9_-]+)?$/.test(
          decodeURIComponent(url.username),
        )
      )
        issues.push(
          "DATABASE_URL must use the dedicated maintaincode_app runtime role, optionally qualified by the Supabase project reference.",
        );
      if (
        url.searchParams.getAll("sslmode").length !== 1 ||
        url.searchParams.get("sslmode") !== "verify-full"
      )
        issues.push(
          "Production PostgreSQL requires exactly one sslmode=verify-full parameter.",
        );
    } catch {
      issues.push("DATABASE_URL must be a valid PostgreSQL connection URL.");
    }
  }
  if (env.MAINTAINFLOW_DATABASE_CA_CERT) {
    try {
      checkCertificate(env.MAINTAINFLOW_DATABASE_CA_CERT);
    } catch {
      issues.push(
        "MAINTAINFLOW_DATABASE_CA_CERT must contain the valid database root CA certificate.",
      );
    }
  }
  if (env.MAINTAINFLOW_CREDENTIAL_KEYRING) {
    try {
      const keyring = JSON.parse(env.MAINTAINFLOW_CREDENTIAL_KEYRING);
      if (
        !keyring ||
        typeof keyring !== "object" ||
        Array.isArray(keyring) ||
        !Object.keys(keyring).length ||
        Object.entries(keyring).some(
          ([id, value]) =>
            !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
            typeof value !== "string" ||
            !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
            Buffer.from(value, "base64").length !== 32,
        ) ||
        !Object.hasOwn(keyring, env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID)
      )
        throw new Error("keyring");
    } catch {
      issues.push(
        "The credential keyring must contain valid 32-byte base64 keys and the active key ID.",
      );
    }
  }
  for (const key of [
    "MAINTAINFLOW_READINESS_PROBE_SECRET",
    "MAINTAINCODE_MAINTENANCE_SECRET",
  ])
    if (!env[key] || env[key].length < 32)
      issues.push(`${key} must contain at least 32 characters.`);
  if (
    env.MAINTAINFLOW_READINESS_PROBE_SECRET &&
    env.MAINTAINFLOW_READINESS_PROBE_SECRET ===
      env.MAINTAINCODE_MAINTENANCE_SECRET
  )
    issues.push("Readiness and maintenance secrets must be distinct.");
  if (env.MAINTAINCODE_LOCAL_TEST === "1")
    issues.push("Local test mode must be disabled for production.");
  if (
    env.OPENAI_ADS_LIVE_WRITES_ENABLED === "true" ||
    env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED === "true"
  )
    issues.push(
      "MaintainCode attribution does not enable advertiser mutations or conversion-event submission.",
    );
  return { issues };
}

export async function loadMaintainCodeEnvironment() {
  const nextEnvModule = await import("@next/env");
  const { loadEnvConfig } = nextEnvModule.default ?? nextEnvModule;
  loadEnvConfig(process.cwd(), false);
}

export function validateMaintainCodeStartup(
  env,
  metadataReader = readPublicBuildMetadata,
) {
  const result = validateMaintainCodeConfig(env);
  try {
    if (
      metadataReader().publicSupabaseConfigSha256 !==
      publicSupabaseConfigDigest(env)
    )
      result.issues.push(
        "Runtime NEXT_PUBLIC Supabase configuration does not match the compiled browser configuration. Rebuild before starting.",
      );
  } catch {
    result.issues.push(
      "The public build metadata is missing or invalid. Run a fresh production build.",
    );
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await loadMaintainCodeEnvironment();
  const result = process.argv.includes("--startup")
    ? validateMaintainCodeStartup(process.env)
    : validateMaintainCodeConfig(process.env);
  if (result.issues.length) {
    console.error("MaintainCode production configuration is incomplete:");
    result.issues.forEach((issue) => console.error(`- ${issue}`));
    process.exitCode = 1;
  } else
    console.log(
      "MaintainCode configuration is present. Verify the deployed revision, database, identity, providers and payments separately.",
    );
}
