import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  validateProductionConfig,
  validateStartupProductionConfig,
} from "./check-production-config.mjs";
import { createPublicBuildMetadata } from "./public-build-metadata.mjs";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function keyring() {
  return JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64") });
}

function privateConfig(overrides = {}) {
  return {
    MAINTAINFLOW_RELEASE_STAGE: "private_read",
    MAINTAINFLOW_APP_ORIGIN: "https://maintainflow.io",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_maintainflow",
    CLERK_SECRET_KEY: "sk_live_maintainflow",
    MAINTAINFLOW_LEGAL_ENTITY_NAME: "MaintainFlow Test Entity",
    MAINTAINFLOW_PRIVACY_CONTACT_EMAIL: "privacy@maintainflow.test",
    MAINTAINFLOW_SUPPORT_CONTACT_EMAIL: "support@maintainflow.test",
    DATABASE_URL:
      "postgres://maintainflow:secret@db.example/maintainflow?sslmode=verify-full",
    MAINTAINFLOW_CREDENTIAL_KEYRING: keyring(),
    MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID: "v1",
    MAINTAINFLOW_READINESS_PROBE_SECRET: "p".repeat(32),
    CRON_SECRET: "c".repeat(32),
    READINESS_RATE_LIMIT_SECRET: "r".repeat(32),
    MAINTAINFLOW_ADMISSION_MODE: "private_beta",
    MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS: "user_pilot",
    OPENAI_ADS_DATA_MODE: "live",
    OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
    ...overrides,
  };
}

function demoConfig(overrides = {}) {
  return {
    MAINTAINFLOW_RELEASE_STAGE: "demo",
    MAINTAINFLOW_APP_ORIGIN: "https://maintainflow.io",
    MAINTAINFLOW_LEGAL_ENTITY_NAME: "MaintainFlow Test Entity",
    MAINTAINFLOW_PRIVACY_CONTACT_EMAIL: "privacy@maintainflow.test",
    MAINTAINFLOW_SUPPORT_CONTACT_EMAIL: "support@maintainflow.test",
    DATABASE_URL:
      "postgres://maintainflow:secret@db.example/maintainflow?sslmode=verify-full",
    MAINTAINFLOW_READINESS_PROBE_SECRET: "p".repeat(32),
    CRON_SECRET: "c".repeat(32),
    READINESS_RATE_LIMIT_SECRET: "r".repeat(32),
    MAINTAINFLOW_ADMISSION_MODE: "private_beta",
    MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "false",
    OPENAI_ADS_DATA_MODE: "demo",
    OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
    OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED: "false",
    ...overrides,
  };
}

function writeBuildMetadata(env, value = createPublicBuildMetadata(env)) {
  const directory = mkdtempSync(join(tmpdir(), "maintainflow-config-test-"));
  temporaryDirectories.push(directory);
  const metadataPath = join(directory, "metadata.json");
  writeFileSync(metadataPath, JSON.stringify(value), "utf8");
  return metadataPath;
}

describe("production release-stage configuration", () => {
  it("keeps raw public Clerk values out of build metadata", () => {
    const env = {
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_metadata_test",
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/private-sign-in-path",
      NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/private-sign-up-path",
    };
    const serialized = JSON.stringify(createPublicBuildMetadata(env));

    for (const value of Object.values(env)) {
      expect(serialized).not.toContain(value);
    }
    expect(JSON.parse(serialized).publicClerkConfigSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("allows a truthful demo without provider or customer secrets", () => {
    expect(validateProductionConfig(demoConfig())).toEqual({
      stage: "demo",
      issues: [],
    });
  });

  it.each(["demo", "private_read", "live_write"])(
    "requires a 32+ character readiness probe secret for %s",
    (stage) => {
      const config =
        stage === "demo"
          ? demoConfig()
          : privateConfig({
              MAINTAINFLOW_RELEASE_STAGE: stage,
              OPENAI_ADS_LIVE_WRITES_ENABLED:
                stage === "live_write" ? "true" : "false",
            });

      for (const secret of [undefined, "p".repeat(31)]) {
        expect(
          validateProductionConfig({
            ...config,
            MAINTAINFLOW_READINESS_PROBE_SECRET: secret,
          }).issues,
        ).toContain(
          "MAINTAINFLOW_READINESS_PROBE_SECRET must contain at least 32 characters.",
        );
      }
    },
  );

  it.each([
    ["MAINTAINFLOW_READINESS_PROBE_SECRET", "CRON_SECRET"],
    ["MAINTAINFLOW_READINESS_PROBE_SECRET", "READINESS_RATE_LIMIT_SECRET"],
    ["CRON_SECRET", "READINESS_RATE_LIMIT_SECRET"],
  ])("rejects reuse between %s and %s without leaking it", (first, second) => {
    const reusedSecret = "shared-production-secret-".padEnd(40, "x");
    const result = validateProductionConfig(
      privateConfig({
        [first]: reusedSecret,
        [second]: reusedSecret,
      }),
    );

    expect(result.issues).toContain(
      "MAINTAINFLOW_READINESS_PROBE_SECRET, CRON_SECRET, and READINESS_RATE_LIMIT_SECRET must use pairwise distinct values.",
    );
    expect(JSON.stringify(result.issues)).not.toContain(reusedSecret);
  });

  it("requires a production demo to identify its operator and meter readiness scans", () => {
    const result = validateProductionConfig({
      MAINTAINFLOW_RELEASE_STAGE: "demo",
      MAINTAINFLOW_APP_ORIGIN: "https://maintainflow.io",
      OPENAI_ADS_DATA_MODE: "demo",
      OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
    });

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("MAINTAINFLOW_LEGAL_ENTITY_NAME"),
        expect.stringContaining("MAINTAINFLOW_PRIVACY_CONTACT_EMAIL"),
        expect.stringContaining("MAINTAINFLOW_SUPPORT_CONTACT_EMAIL"),
        expect.stringContaining("DATABASE_URL"),
        expect.stringContaining("MAINTAINFLOW_READINESS_PROBE_SECRET"),
        expect.stringContaining("CRON_SECRET"),
        expect.stringContaining("READINESS_RATE_LIMIT_SECRET"),
      ]),
    );
  });

  it.each([
    ["open admission", { MAINTAINFLOW_ADMISSION_MODE: "open" }],
    [
      "public sign-up",
      { MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "true" },
    ],
  ])("rejects %s in a production demo", (_label, override) => {
    expect(validateProductionConfig(demoConfig(override)).issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Production releases cannot"),
      ]),
    );
  });

  it("accepts a private read-only pilot without requiring a global Ads key", () => {
    expect(validateProductionConfig(privateConfig())).toEqual({
      stage: "private_read",
      issues: [],
    });
  });

  it.each([
    ["missing sslmode", "postgres://db.example/maintainflow"],
    ["sslmode=disable", "postgres://db.example/maintainflow?sslmode=disable"],
    ["sslmode=require", "postgres://db.example/maintainflow?sslmode=require"],
    ["sslmode=verify-ca", "postgres://db.example/maintainflow?sslmode=verify-ca"],
    [
      "duplicate verify-full parameters",
      "postgres://db.example/maintainflow?sslmode=verify-full&sslmode=verify-full",
    ],
    [
      "a duplicate downgrade",
      "postgres://db.example/maintainflow?sslmode=verify-full&sslmode=require",
    ],
    [
      "a mixed-case duplicate",
      "postgres://db.example/maintainflow?sslmode=verify-full&SSLMODE=verify-full",
    ],
    [
      "a mixed-case parameter name",
      "postgres://db.example/maintainflow?SSLMODE=verify-full",
    ],
  ])("rejects production DATABASE_URL with %s", (_label, databaseUrl) => {
    const result = validateProductionConfig(
      privateConfig({ DATABASE_URL: databaseUrl }),
    );

    expect(result.issues).toContain(
      "DATABASE_URL must include exactly one sslmode=verify-full parameter.",
    );
  });

  it.each([
    "search_path=other",
    "SEARCH_PATH=other",
    "options=-c%20search_path%3Dother",
    "OPTIONS=-c%20search_path%3Dother",
  ])("rejects a DATABASE_URL runtime search-path override: %s", (query) => {
    const result = validateProductionConfig(
      privateConfig({
        DATABASE_URL: `postgres://db.example/maintainflow?sslmode=verify-full&${query}`,
      }),
    );

    expect(result.issues).toContain(
      "DATABASE_URL must not override the runtime database search path.",
    );
  });

  it("requires an explicit live-write stage and flag", () => {
    expect(
      validateProductionConfig(
        privateConfig({
          MAINTAINFLOW_RELEASE_STAGE: "live_write",
          OPENAI_ADS_LIVE_WRITES_ENABLED: "true",
        }),
      ),
    ).toEqual({ stage: "live_write", issues: [] });
  });

  it("blocks a private release without identified legal and support contacts", () => {
    const result = validateProductionConfig(
      privateConfig({
        MAINTAINFLOW_LEGAL_ENTITY_NAME: "",
        MAINTAINFLOW_PRIVACY_CONTACT_EMAIL: "not-an-email",
        MAINTAINFLOW_SUPPORT_CONTACT_EMAIL: "",
      }),
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("MAINTAINFLOW_LEGAL_ENTITY_NAME"),
        expect.stringContaining("MAINTAINFLOW_PRIVACY_CONTACT_EMAIL"),
        expect.stringContaining("MAINTAINFLOW_SUPPORT_CONTACT_EMAIL"),
      ]),
    );
  });

  it("accepts startup only when runtime public Clerk config matches the build", () => {
    const env = privateConfig({
      NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/auth/sign-in",
      NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/auth/sign-up",
    });
    const metadataPath = writeBuildMetadata(env);

    expect(
      validateStartupProductionConfig(env, { metadataPath }).issues,
    ).toEqual([]);

    for (const runtimeOverride of [
      { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_other_tenant" },
      { NEXT_PUBLIC_CLERK_SIGN_IN_URL: "/different-sign-in" },
      { NEXT_PUBLIC_CLERK_SIGN_UP_URL: "/different-sign-up" },
    ]) {
      const result = validateStartupProductionConfig(
        { ...env, ...runtimeOverride },
        { metadataPath },
      );

      expect(result.issues).toContain(
        "Runtime NEXT_PUBLIC Clerk configuration does not match the values compiled by npm run build.",
      );
    }
  });

  it("fails startup when compiled public configuration metadata is missing or malformed", () => {
    const env = privateConfig();
    const missingDirectory = mkdtempSync(
      join(tmpdir(), "maintainflow-config-test-"),
    );
    temporaryDirectories.push(missingDirectory);
    const missingPath = join(missingDirectory, "missing.json");
    const malformedPath = writeBuildMetadata(env, { schemaVersion: 99 });

    for (const metadataPath of [missingPath, malformedPath]) {
      expect(
        validateStartupProductionConfig(env, { metadataPath }).issues,
      ).toContain(
        "Compiled NEXT_PUBLIC configuration metadata is missing or invalid; run npm run build before npm start.",
      );
    }
  });

  it.each(["0", "11", "1.5", "many"])(
    "rejects an unsafe per-instance database pool size: %s",
    (value) => {
      const result = validateProductionConfig(
        privateConfig({ MAINTAINFLOW_DATABASE_POOL_MAX: value }),
      );

      expect(result.issues).toContain(
        "MAINTAINFLOW_DATABASE_POOL_MAX must be an integer from 1 through 10.",
      );
    },
  );

  it("accepts a bounded explicit database pool size", () => {
    expect(
      validateProductionConfig(
        privateConfig({ MAINTAINFLOW_DATABASE_POOL_MAX: "4" }),
      ).issues,
    ).toEqual([]);
  });

  it("fails closed on open admission, missing authenticated TLS, weak secrets, and malformed key material", () => {
    const result = validateProductionConfig(
      privateConfig({
        MAINTAINFLOW_ADMISSION_MODE: "open",
        DATABASE_URL: "postgres://db.example/maintainflow",
        MAINTAINFLOW_READINESS_PROBE_SECRET: "short",
        CRON_SECRET: "short",
        READINESS_RATE_LIMIT_SECRET: "short",
        MAINTAINFLOW_CREDENTIAL_KEYRING: JSON.stringify({ v1: "not-a-key" }),
      }),
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sslmode"),
        expect.stringContaining("MAINTAINFLOW_READINESS_PROBE_SECRET"),
        expect.stringContaining("CRON_SECRET"),
        expect.stringContaining("READINESS_RATE_LIMIT_SECRET"),
        expect.stringContaining("32 bytes"),
        expect.stringContaining("private_beta"),
      ]),
    );
    expect(result.issues).not.toContain(
      "MAINTAINFLOW_READINESS_PROBE_SECRET, CRON_SECRET, and READINESS_RATE_LIMIT_SECRET must use pairwise distinct values.",
    );
  });

  it("never includes configured secret values in validation issues", () => {
    const secret = "do-not-print-this-secret";
    const result = validateProductionConfig(
      privateConfig({
        DATABASE_URL: `postgres://user:${secret}@db.example/maintainflow`,
        MAINTAINFLOW_READINESS_PROBE_SECRET: secret,
        CRON_SECRET: secret,
      }),
    );

    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });
});
