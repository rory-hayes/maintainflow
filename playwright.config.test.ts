import { describe, expect, it } from "vitest";

import { validateProductionConfig } from "./scripts/check-production-config.mjs";
import { demoEnvironment } from "./playwright.config";

describe("Playwright demo environment", () => {
  it("fully overrides local live and credential configuration", () => {
    const inheritedEnvironment = {
      MAINTAINFLOW_RELEASE_STAGE: "live_write",
      OPENAI_ADS_DATA_MODE: "live",
      OPENAI_ADS_API_KEY: "inherited-ads-key",
      OPENAI_ADS_LIVE_TEST_ENABLED: "true",
      OPENAI_ADS_LIVE_WRITES_ENABLED: "true",
      OPENAI_CONVERSIONS_ACCOUNT_ID: "inherited-account",
      OPENAI_CONVERSIONS_API_KEY: "inherited-conversions-key",
      OPENAI_CONVERSIONS_PIXEL_ID: "inherited-pixel",
      OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED: "true",
      MAINTAINFLOW_DATABASE_CA_CERT: "expired-or-malformed-certificate",
      MAINTAINFLOW_APPROVAL_EMAIL_ENABLED: "true",
      MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS:
        "00000000-0000-4000-8000-000000000000",
      MAINTAINFLOW_APPROVAL_FROM_EMAIL: "approval@maintainflow.io",
      RESEND_API_KEY: "re_inherited_secret_value",
      RESEND_WEBHOOK_SECRET: "whsec_inherited_secret_value",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_inherited",
      CLERK_SECRET_KEY: "sk_live_inherited",
      MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS: "user_inherited",
      MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS: "user_bootstrap",
      MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED: "true",
      MAINTAINFLOW_TRUST_PROXY_HEADERS: "true",
      READINESS_TRUST_X_FORWARDED_FOR: "true",
    };

    expect(
      validateProductionConfig({
        ...inheritedEnvironment,
        ...demoEnvironment,
      }),
    ).toEqual({ stage: "demo", issues: [] });

    for (const key of [
      "OPENAI_ADS_API_KEY",
      "OPENAI_CONVERSIONS_ACCOUNT_ID",
      "OPENAI_CONVERSIONS_API_KEY",
      "OPENAI_CONVERSIONS_PIXEL_ID",
      "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
      "CLERK_SECRET_KEY",
      "MAINTAINFLOW_CREDENTIAL_KEYRING",
      "MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID",
      "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS",
      "MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS",
      "MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS",
      "MAINTAINFLOW_APPROVAL_FROM_EMAIL",
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
    ] as const) {
      expect(demoEnvironment[key]).toBe("");
    }
  });
});
