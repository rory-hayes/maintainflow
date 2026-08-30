import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getBootstrapOperatorIds,
  getWorkspaceAdmissionMode,
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

  it("requires a deliberate open mode for public workspace creation", () => {
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "open");

    expect(isWorkspaceAdmissionAllowed("user_any_customer")).toBe(true);
  });

  it("does not silently reuse the removed legacy allowlist", () => {
    vi.stubEnv("MAINTAINFLOW_ALLOWED_OPERATOR_IDS", "user_legacy");

    expect(getBootstrapOperatorIds()).not.toContain("user_legacy");
    expect(isWorkspaceAdmissionAllowed("user_legacy")).toBe(false);
  });
});
