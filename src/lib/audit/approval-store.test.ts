import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ApprovalTransitionError,
  getReconciliationTransition,
} from "./approval-store.server";

describe("approval reconciliation transitions", () => {
  it("resolves an uncertain apply only to a verified terminal state", () => {
    expect(
      getReconciliationTransition("reconciliation_required", "mark_applied"),
    ).toBe("applied");
    expect(
      getReconciliationTransition(
        "reconciliation_required",
        "mark_not_applied",
      ),
    ).toBe("failed");
  });

  it("resolves an uncertain rollback without sending another write", () => {
    expect(
      getReconciliationTransition(
        "rollback_reconciliation_required",
        "mark_rolled_back",
      ),
    ).toBe("rolled_back");
    expect(
      getReconciliationTransition(
        "rollback_reconciliation_required",
        "mark_still_applied",
      ),
    ).toBe("applied");
  });

  it("rejects incompatible outcomes", () => {
    expect(() =>
      getReconciliationTransition("applied", "mark_rolled_back"),
    ).toThrow(ApprovalTransitionError);
  });
});
