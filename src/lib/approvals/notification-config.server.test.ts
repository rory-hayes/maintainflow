import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ApprovalNotificationConfigurationError,
  getApprovalEmailOrganizationIds,
  getApprovalEmailProviderConfiguration,
  isApprovalEmailEnabledForOrganization,
} from "./notification-config.server";

const organizationId = "00000000-0000-4000-8000-000000000101";

afterEach(() => vi.unstubAllEnvs());

describe("approval email configuration", () => {
  it("enables only an explicitly allowlisted organization", () => {
    vi.stubEnv("MAINTAINFLOW_APPROVAL_EMAIL_ENABLED", "true");
    vi.stubEnv(
      "MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS",
      `${organizationId},00000000-0000-4000-8000-000000000102`,
    );

    expect(isApprovalEmailEnabledForOrganization(organizationId)).toBe(true);
    expect(
      isApprovalEmailEnabledForOrganization(
        "00000000-0000-4000-8000-000000000103",
      ),
    ).toBe(false);
  });

  it("fails closed for malformed or duplicate allowlist values", () => {
    expect(() => getApprovalEmailOrganizationIds("*,not-a-uuid")).toThrow(
      ApprovalNotificationConfigurationError,
    );
    expect(() =>
      getApprovalEmailOrganizationIds(`${organizationId},${organizationId}`),
    ).toThrow(ApprovalNotificationConfigurationError);
  });

  it("requires a verified provider-shaped configuration and exact HTTPS origin", () => {
    vi.stubEnv("RESEND_API_KEY", `re_${"a".repeat(32)}`);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${"b".repeat(32)}`);
    vi.stubEnv("MAINTAINFLOW_APPROVAL_FROM_EMAIL", "approvals@maintainflow.io");
    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");

    expect(getApprovalEmailProviderConfiguration()).toEqual({
      apiKey: `re_${"a".repeat(32)}`,
      webhookSecret: `whsec_${"b".repeat(32)}`,
      from: "MaintainFlow <approvals@maintainflow.io>",
      appOrigin: "https://maintainflow.io",
    });

    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "http://maintainflow.io");
    expect(() => getApprovalEmailProviderConfiguration()).toThrow(
      ApprovalNotificationConfigurationError,
    );

    vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");
    vi.stubEnv("MAINTAINFLOW_APPROVAL_FROM_EMAIL", "a..b@example.com");
    expect(() => getApprovalEmailProviderConfiguration()).toThrow(
      ApprovalNotificationConfigurationError,
    );
  });
});
