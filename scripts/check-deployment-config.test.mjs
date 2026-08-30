import { describe, expect, it } from "vitest";

import {
  evaluateDeploymentConfig,
  hasNonDemoDeploymentIntent,
  shouldEnforceDeploymentConfig,
} from "./check-deployment-config.mjs";

describe("deployment configuration gate", () => {
  it("enforces production Vercel deployments and explicit non-Vercel releases", () => {
    expect(shouldEnforceDeploymentConfig({ VERCEL_ENV: "production" })).toBe(true);
    expect(
      shouldEnforceDeploymentConfig({
        VERCEL_ENV: "preview",
        MAINTAINFLOW_ENFORCE_PRODUCTION_CONFIG: "true",
      }),
    ).toBe(true);
  });

  it("keeps a strict demo preview independent of production secrets", () => {
    const strictDemoPreview = {
      VERCEL_ENV: "preview",
      MAINTAINFLOW_RELEASE_STAGE: "demo",
      OPENAI_ADS_DATA_MODE: "demo",
      OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
      OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED: "false",
      MAINTAINFLOW_ADMISSION_MODE: "private_beta",
      MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "false",
    };

    expect(hasNonDemoDeploymentIntent(strictDemoPreview)).toBe(false);
    expect(evaluateDeploymentConfig(strictDemoPreview)).toEqual({
      enforced: false,
      stage: "demo",
      issues: [],
    });
  });

  it.each([
    ["a private release stage", { MAINTAINFLOW_RELEASE_STAGE: "private_read" }],
    ["live provider data", { OPENAI_ADS_DATA_MODE: "live" }],
    ["live writes", { OPENAI_ADS_LIVE_WRITES_ENABLED: "true" }],
    [
      "Conversions API contact",
      { OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED: "true" },
    ],
    ["open admission", { MAINTAINFLOW_ADMISSION_MODE: "open" }],
    [
      "public sign-up",
      { MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "true" },
    ],
  ])("enforces a preview that declares %s", (_label, intent) => {
    const result = evaluateDeploymentConfig({
      VERCEL_ENV: "preview",
      MAINTAINFLOW_RELEASE_STAGE: "demo",
      OPENAI_ADS_DATA_MODE: "demo",
      ...intent,
    });

    expect(result.enforced).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("fails a production deployment before build when required config is absent", () => {
    const result = evaluateDeploymentConfig({ VERCEL_ENV: "production" });

    expect(result.enforced).toBe(true);
    expect(result.issues).toContain("MAINTAINFLOW_APP_ORIGIN is required.");
  });
});
