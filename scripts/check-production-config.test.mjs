import { describe, expect, it } from "vitest";

import { validateProductionConfig } from "./check-production-config.mjs";

function keyring() {
  return JSON.stringify({ v1: Buffer.alloc(32, 7).toString("base64") });
}

function privateConfig(overrides = {}) {
  return {
    MAINTAINFLOW_RELEASE_STAGE: "private_read",
    MAINTAINFLOW_APP_ORIGIN: "https://maintainflow.io",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_maintainflow",
    CLERK_SECRET_KEY: "sk_live_maintainflow",
    DATABASE_URL:
      "postgres://maintainflow:secret@db.example/maintainflow?sslmode=verify-full",
    MAINTAINFLOW_CREDENTIAL_KEYRING: keyring(),
    MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID: "v1",
    CRON_SECRET: "c".repeat(32),
    READINESS_RATE_LIMIT_SECRET: "r".repeat(32),
    MAINTAINFLOW_ADMISSION_MODE: "private_beta",
    MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS: "user_pilot",
    OPENAI_ADS_DATA_MODE: "live",
    OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
    ...overrides,
  };
}

describe("production release-stage configuration", () => {
  it("allows a truthful demo without provider or customer secrets", () => {
    expect(
      validateProductionConfig({
        MAINTAINFLOW_RELEASE_STAGE: "demo",
        MAINTAINFLOW_APP_ORIGIN: "https://maintainflow.io",
        OPENAI_ADS_DATA_MODE: "demo",
        OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
      }),
    ).toEqual({ stage: "demo", issues: [] });
  });

  it("accepts a private read-only pilot without requiring a global Ads key", () => {
    expect(validateProductionConfig(privateConfig())).toEqual({
      stage: "private_read",
      issues: [],
    });
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

  it("fails closed on open admission, missing TLS, weak secrets, and malformed key material", () => {
    const result = validateProductionConfig(
      privateConfig({
        MAINTAINFLOW_ADMISSION_MODE: "open",
        DATABASE_URL: "postgres://db.example/maintainflow",
        CRON_SECRET: "short",
        READINESS_RATE_LIMIT_SECRET: "short",
        MAINTAINFLOW_CREDENTIAL_KEYRING: JSON.stringify({ v1: "not-a-key" }),
      }),
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sslmode"),
        expect.stringContaining("CRON_SECRET"),
        expect.stringContaining("READINESS_RATE_LIMIT_SECRET"),
        expect.stringContaining("32 bytes"),
        expect.stringContaining("private_beta"),
      ]),
    );
  });

  it("never includes configured secret values in validation issues", () => {
    const secret = "do-not-print-this-secret";
    const result = validateProductionConfig(
      privateConfig({
        DATABASE_URL: `postgres://user:${secret}@db.example/maintainflow`,
        CRON_SECRET: secret,
      }),
    );

    expect(JSON.stringify(result.issues)).not.toContain(secret);
  });
});
