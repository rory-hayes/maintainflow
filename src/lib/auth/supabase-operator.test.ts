import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ user: vi.fn(), clerkAuth: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("./supabase.server", () => ({ verifiedSupabaseUser: state.user }));
vi.mock("@clerk/nextjs/server", () => ({
  auth: state.clerkAuth,
  currentUser: vi.fn(),
}));
import {
  requireOperatorId,
  getOptionalAdmittedOperator,
  OperatorUnauthorizedError,
  OperatorAdmissionForbiddenError,
} from "./operator.server";
import { isClerkConfigured } from "./config";
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  vi.stubEnv("CLERK_SECRET_KEY", "legacy");
  vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "legacy");
  vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "open");
});
afterEach(() => vi.unstubAllEnvs());
it("uses a verified Supabase UUID without mixing in a configured legacy Clerk identity", async () => {
  state.user.mockResolvedValue({
    id: "07f46a73-455c-4c9c-b06e-34a54d54d6be",
    email: "member@example.test",
  });
  expect(await requireOperatorId()).toBe(
    "07f46a73-455c-4c9c-b06e-34a54d54d6be",
  );
  expect(state.clerkAuth).not.toHaveBeenCalled();
  expect(isClerkConfigured()).toBe(false);
});
it("rejects missing Supabase sessions", async () => {
  state.user.mockResolvedValue(null);
  await expect(requireOperatorId()).rejects.toBeInstanceOf(
    OperatorUnauthorizedError,
  );
  expect(await getOptionalAdmittedOperator()).toBeNull();
});
it("does not admit a Supabase customer while the open release gate is closed", async () => {
  vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "private_beta");
  state.user.mockResolvedValue({ id: "07f46a73-455c-4c9c-b06e-34a54d54d6be" });
  await expect(requireOperatorId()).rejects.toBeInstanceOf(
    OperatorAdmissionForbiddenError,
  );
});
