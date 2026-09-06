import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBootstrapOperatorIds,
  getWorkspaceAdmittedOperatorIds,
  getWorkspaceAdmissionMode,
  isPublicSignUpEnabled,
  isWorkspaceAdmissionAllowed,
} from "./config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("workspace admission configuration", () => {
  it("fails closed to private beta when the mode is absent or invalid", () => {
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "unexpected");

    expect(getWorkspaceAdmissionMode()).toBe("private_beta");
    expect(isWorkspaceAdmissionAllowed("user_customer")).toBe(false);
  });

  it("admits only explicitly listed beta and bootstrap operators", () => {
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "private_beta");
    vi.stubEnv(
      "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS",
      " user_customer, user_agency ",
    );
    vi.stubEnv("MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS", "user_pilot");

    expect(isWorkspaceAdmissionAllowed("user_customer")).toBe(true);
    expect(isWorkspaceAdmissionAllowed("user_agency")).toBe(true);
    expect(isWorkspaceAdmissionAllowed("user_pilot")).toBe(true);
    expect(isWorkspaceAdmissionAllowed("user_other")).toBe(false);
  });

  it("exports the normalized, sorted private-beta union for SQL filters", () => {
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "private_beta");
    vi.stubEnv(
      "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS",
      " user_zulu, user_alpha ",
    );
    vi.stubEnv(
      "MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS",
      " user_pilot, user_bravo ",
    );

    expect(getWorkspaceAdmittedOperatorIds()).toEqual([
      "user_alpha",
      "user_bravo",
      "user_pilot",
      "user_zulu",
    ]);
  });

  it.each([
    ["malformed beta ID", "user_alpha,user invalid", "user_pilot"],
    ["beta wildcard", "user_alpha,*", "user_pilot"],
    ["empty beta segment", "user_alpha,,user_bravo", "user_pilot"],
    ["duplicate beta ID", "user_alpha,user_alpha", "user_pilot"],
    ["malformed bootstrap ID", "user_alpha", "operator_pilot"],
    ["bootstrap wildcard", "user_alpha", "user_*"],
    ["empty bootstrap segment", "user_alpha", "user_pilot,"],
    ["duplicate bootstrap ID", "user_alpha", "user_pilot,user_pilot"],
    ["ID repeated across lists", "user_alpha", "user_alpha"],
    ["overlong beta ID", `user_${"a".repeat(251)}`, "user_pilot"],
  ])("fails the complete private-beta union closed for a %s", (_label, beta, bootstrap) => {
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "private_beta");
    vi.stubEnv("MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS", beta);
    vi.stubEnv("MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS", bootstrap);

    expect(getWorkspaceAdmittedOperatorIds()).toEqual([]);
    expect(isWorkspaceAdmissionAllowed("user_alpha")).toBe(false);
    expect(isWorkspaceAdmissionAllowed("user_pilot")).toBe(false);
  });

  it("requires a deliberate open mode for public workspace creation", () => {
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "open");
    vi.stubEnv("MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS", "user_alpha,,");
    vi.stubEnv("MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS", "*");

    expect(isWorkspaceAdmissionAllowed("user_any_customer")).toBe(true);
  });

  it("requires both open admission and an explicit flag for public sign-up", () => {
    vi.stubEnv("MAINTAINFLOW_PUBLIC_SIGN_UP_ENABLED", "true");
    expect(isPublicSignUpEnabled()).toBe(false);

    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "open");
    expect(isPublicSignUpEnabled()).toBe(true);
  });

  it("does not silently reuse the removed legacy allowlist", () => {
    vi.stubEnv("MAINTAINFLOW_ALLOWED_OPERATOR_IDS", "user_legacy");

    expect(getBootstrapOperatorIds()).not.toContain("user_legacy");
    expect(isWorkspaceAdmissionAllowed("user_legacy")).toBe(false);
  });
});
