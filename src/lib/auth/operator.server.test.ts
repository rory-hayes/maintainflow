import { beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  auth: vi.fn(),
  currentUser: vi.fn(),
  isClerkConfigured: vi.fn(),
  isWorkspaceAdmissionAllowed: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@clerk/nextjs/server", () => ({
  auth: testState.auth,
  currentUser: testState.currentUser,
}));
vi.mock("./config", () => ({
  isClerkConfigured: testState.isClerkConfigured,
  isWorkspaceAdmissionAllowed: testState.isWorkspaceAdmissionAllowed,
}));

import {
  getOptionalAdmittedOperator,
  getOptionalOperator,
  OperatorAdmissionForbiddenError,
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperator,
  requireOperatorId,
} from "./operator.server";

const clerkUser = {
  fullName: "Ada Lovelace",
  firstName: "Ada",
  primaryEmailAddress: { emailAddress: "ada@example.com" },
};

beforeEach(() => {
  vi.resetAllMocks();
  testState.isClerkConfigured.mockReturnValue(true);
  testState.isWorkspaceAdmissionAllowed.mockReturnValue(true);
  testState.auth.mockResolvedValue({
    isAuthenticated: true,
    userId: "user_admitted",
  });
  testState.currentUser.mockResolvedValue(clerkUser);
});

describe("operator admission", () => {
  it("keeps authentication unavailable distinct from an unauthenticated request", async () => {
    testState.isClerkConfigured.mockReturnValue(false);

    await expect(requireOperatorId()).rejects.toBeInstanceOf(
      OperatorAuthUnavailableError,
    );
    expect(testState.auth).not.toHaveBeenCalled();
  });

  it("reports an unauthenticated request as HTTP 401", async () => {
    testState.auth.mockResolvedValue({
      isAuthenticated: false,
      userId: null,
    });

    const error = await requireOperatorId().catch((caught) => caught);

    expect(error).toBeInstanceOf(OperatorUnauthorizedError);
    expect(error).not.toBeInstanceOf(OperatorAdmissionForbiddenError);
    expect(error.status).toBe(401);
    expect(testState.isWorkspaceAdmissionAllowed).not.toHaveBeenCalled();
  });

  it("reports an authenticated but unadmitted request as HTTP 403", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    const error = await requireOperatorId().catch((caught) => caught);

    expect(error).toBeInstanceOf(OperatorAdmissionForbiddenError);
    expect(error).toBeInstanceOf(OperatorUnauthorizedError);
    expect(error.status).toBe(403);
    expect(testState.isWorkspaceAdmissionAllowed).toHaveBeenCalledWith(
      "user_admitted",
    );
  });

  it("returns an admitted authenticated operator ID", async () => {
    await expect(requireOperatorId()).resolves.toBe("user_admitted");
  });

  it("keeps the existing optional operator lookup independent of admission", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    await expect(getOptionalOperator()).resolves.toEqual({
      id: "user_admitted",
      name: "Ada Lovelace",
      initials: "AL",
    });
    expect(testState.isWorkspaceAdmissionAllowed).not.toHaveBeenCalled();
  });

  it("returns null for an unadmitted optional operator without disclosing the boundary", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    await expect(getOptionalAdmittedOperator()).resolves.toBeNull();
    expect(testState.currentUser).not.toHaveBeenCalled();
  });

  it("returns null for an unauthenticated optional operator", async () => {
    testState.auth.mockResolvedValue({
      isAuthenticated: false,
      userId: null,
    });

    await expect(getOptionalAdmittedOperator()).resolves.toBeNull();
    expect(testState.currentUser).not.toHaveBeenCalled();
    expect(testState.isWorkspaceAdmissionAllowed).not.toHaveBeenCalled();
  });

  it("returns an admitted optional operator", async () => {
    await expect(getOptionalAdmittedOperator()).resolves.toEqual({
      id: "user_admitted",
      name: "Ada Lovelace",
      initials: "AL",
    });
  });

  it("enforces admission when the full operator is required", async () => {
    testState.isWorkspaceAdmissionAllowed.mockReturnValue(false);

    const error = await requireOperator().catch((caught) => caught);

    expect(error).toBeInstanceOf(OperatorAdmissionForbiddenError);
    expect(error.status).toBe(403);
  });

  it("returns the full admitted operator", async () => {
    await expect(requireOperator()).resolves.toEqual({
      id: "user_admitted",
      name: "Ada Lovelace",
      initials: "AL",
    });
  });
});
