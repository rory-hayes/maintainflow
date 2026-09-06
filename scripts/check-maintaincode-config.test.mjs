import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  validateMaintainCodeConfig,
  validateMaintainCodeStartup,
} from "./check-maintaincode-config.mjs";
import { createPublicBuildMetadata } from "./public-build-metadata.mjs";

const ca = rootCertificates.find((pem) => {
  const c = new X509Certificate(pem);
  return (
    c.ca &&
    Date.parse(c.validFrom) < Date.now() &&
    Date.parse(c.validTo) > Date.now() &&
    c.checkIssued(c) &&
    c.verify(c.publicKey)
  );
});
function config(overrides = {}) {
  return {
    DATABASE_URL:
      "postgres://maintaincode_app.project:secret@db.example/postgres?sslmode=verify-full",
    NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
    MAINTAINFLOW_ADMISSION_MODE: "open",
    MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "true",
    MAINTAINFLOW_DATABASE_CA_CERT: ca,
    MAINTAINFLOW_CREDENTIAL_KEYRING: JSON.stringify({
      v1: Buffer.alloc(32, 7).toString("base64"),
    }),
    MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID: "v1",
    MAINTAINCODE_APP_ORIGIN: "https://maintainflow.io",
    MAINTAINFLOW_READINESS_PROBE_SECRET: "p".repeat(32),
    MAINTAINCODE_MAINTENANCE_SECRET: "m".repeat(32),
    ...overrides,
  };
}
describe("MaintainCode deployment configuration", () => {
  it("accepts the user-owned maintainflow.io target without provider or Stripe keys", () => {
    expect(validateMaintainCodeConfig(config()).issues).toEqual([]);
  });
  it.each(["postgres", "maintainflow_app", "maintaincode_app.evil.extra"])(
    "rejects runtime role %s",
    (role) => {
      expect(
        validateMaintainCodeConfig(
          config({
            DATABASE_URL: `postgres://${role}:secret@db.example/postgres?sslmode=verify-full`,
          }),
        ).issues,
      ).toContainEqual(expect.stringContaining("dedicated maintaincode_app"));
    },
  );
  it.each([
    "http://maintainflow.io",
    "https://maintainflow.io/app",
    "https://user:secret@maintainflow.io",
    "https://maintainflow.io?x=1",
  ])("rejects non-origin configuration %s", (origin) => {
    expect(
      validateMaintainCodeConfig(config({ MAINTAINCODE_APP_ORIGIN: origin }))
        .issues,
    ).toContainEqual(expect.stringContaining("exact HTTPS origin"));
  });
  it("rejects weak transport and reused job secrets", () => {
    const result = validateMaintainCodeConfig(
      config({
        DATABASE_URL:
          "postgres://maintaincode_app:secret@db.example/postgres?sslmode=require",
        MAINTAINCODE_MAINTENANCE_SECRET: "p".repeat(32),
      }),
    );
    expect(result.issues).toHaveLength(2);
  });
  it("rejects invalid encryption material without exposing it", () => {
    const result = validateMaintainCodeConfig(
      config({ MAINTAINFLOW_CREDENTIAL_KEYRING: '{"v1":"do-not-print-this"}' }),
    );
    expect(result.issues.join(" ")).not.toContain("do-not-print-this");
    expect(result.issues).toContainEqual(
      expect.stringContaining("32-byte base64"),
    );
  });
  it("rejects test impersonation and legacy external writes in production", () => {
    expect(
      validateMaintainCodeConfig(
        config({
          MAINTAINCODE_LOCAL_TEST: "1",
          OPENAI_ADS_LIVE_WRITES_ENABLED: "true",
        }),
      ).issues,
    ).toHaveLength(2);
  });
  it("compares actual startup identity configuration with the browser build", () => {
    const env = config();
    expect(
      validateMaintainCodeStartup(env, () => createPublicBuildMetadata(env))
        .issues,
    ).toEqual([]);
    expect(
      validateMaintainCodeStartup(env, () => createPublicBuildMetadata({}))
        .issues,
    ).toContainEqual(expect.stringContaining("does not match"));
  });
});
