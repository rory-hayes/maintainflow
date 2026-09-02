import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getRuntimeDatabaseMock } = vi.hoisted(() => ({
  getRuntimeDatabaseMock: vi.fn(),
}));

vi.mock("../database/client.server", () => ({
  getRuntimeDatabase: getRuntimeDatabaseMock,
}));

import {
  ApprovalTransitionError,
  claimApprovalRollback,
  claimDueMonitoringAccounts,
  claimDueMonitoringRecords,
  getReconciliationTransition,
  listDueMonitoringAccountIds,
  listDueMonitoringRecords,
  recordMonitoringOutcome,
  releaseMonitoringAccountAttempt,
  summarizeDueMonitoringBacklog,
} from "./approval-store.server";
import { MONITORING_ATTRIBUTION_MATURITY_MS } from "../openai-ads/monitoring";

function fakeDatabase(responses: unknown[][]) {
  const calls: unknown[][] = [];
  const sql = vi.fn(async (...args: unknown[]) => {
    calls.push(args);
    return responses.shift() ?? [];
  });
  Object.assign(sql, { json: (value: unknown) => value });
  getRuntimeDatabaseMock.mockReturnValue(sql);
  return { calls };
}

function monitoringCutoffValue(call: unknown[]) {
  const strings = call[0] as TemplateStringsArray;
  const interpolationIndex = strings.findIndex((part) =>
    part.includes("monitoring_ends_at <= "),
  );
  if (interpolationIndex < 0) {
    throw new Error("The monitoring maturity predicate is missing.");
  }
  return call[interpolationIndex + 1];
}

function normalizedQueryText(call: unknown[]) {
  return (call[0] as TemplateStringsArray)
    .join("$parameter")
    .replace(/\s+/g, " ")
    .trim();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://localhost/maintainflow");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

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

describe("approval rollback claims", () => {
  it("returns legacy request payloads raw so the executor can record a failed pair", async () => {
    const malformedMutation = {
      method: "PATCH",
      path: "/ad_groups/adgrp_legacy",
    };
    const rollbackPayload = {
      method: "POST",
      path: "/ad_groups/adgrp_legacy",
      body: { name: "Previous name" },
    };
    const sql = vi.fn((first: unknown) => {
      if (
        Array.isArray(first) &&
        !Object.prototype.hasOwnProperty.call(first, "raw")
      ) {
        return first.join(", ");
      }
      return Promise.resolve([
        {
          id: "00000000-0000-4000-8000-000000000001",
          request_payload: malformedMutation,
          rollback_payload: rollbackPayload,
        },
      ]);
    });
    getRuntimeDatabaseMock.mockReturnValue(sql);

    await expect(
      claimApprovalRollback(
        "00000000-0000-4000-8000-000000000001",
        "adacct_expected",
        "user_owner",
        {
          organizationId: "00000000-0000-4000-8000-000000000002",
          organizationName: "Northstar Agency",
          organizationType: "agency",
          accountId: "adacct_expected",
          accountName: "Expected account",
          connectionMode: "vault",
          membershipRole: "owner",
          accountRole: "manager",
        },
      ),
    ).resolves.toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      mutationPayload: malformedMutation,
      rollbackPayload,
    });
  });
});

describe("approval monitoring maturity store guards", () => {
  it("releases an unstarted account lease without recording a provider failure", async () => {
    const { calls } = fakeDatabase([
      [{ advertiser_account_id: "00000000-0000-4000-8000-000000000001" }],
    ]);

    await expect(
      releaseMonitoringAccountAttempt({
        accountId: "adacct_expected",
        attemptId: "attempt-expected",
        now: new Date("2026-08-30T12:00:00.000Z"),
      }),
    ).resolves.toBe(true);

    const statement = normalizedQueryText(calls[0]);
    expect(statement).toContain("current_attempt_id = null");
    expect(statement).toContain("attempt_lease_until = null");
    expect(statement).not.toContain("consecutive_failures =");
    expect(statement).not.toContain("backoff_until =");
    expect(statement).toContain("schedule.current_attempt_id = $parameter");
  });

  it("uses the shared 48-hour cutoff for listing, claiming, and outcome persistence", async () => {
    const endsAt = new Date("2026-08-27T00:00:00.000Z");
    const maturityAt = new Date(
      endsAt.getTime() + MONITORING_ATTRIBUTION_MATURITY_MS,
    );
    const { calls } = fakeDatabase([[], [], [], [], []]);

    await expect(
      listDueMonitoringRecords("adacct_expected", maturityAt, 1),
    ).resolves.toEqual([]);
    await expect(
      listDueMonitoringAccountIds(maturityAt, 1),
    ).resolves.toEqual([]);
    await expect(
      claimDueMonitoringRecords({
        accountId: "adacct_expected",
        claimId: "claim-expected",
        now: maturityAt,
        limit: 1,
      }),
    ).resolves.toEqual([]);
    await expect(
      recordMonitoringOutcome({
        id: "approval-expected",
        accountId: "adacct_expected",
        outcome: "within_safeguard",
        observation: {
          rangeStart: 1_788_048_000,
          rangeEnd: 1_788_652_800,
          spend: 2_100,
          clickAttributedConversions: 105,
          cpa: 20,
          conversionChangePercent: 5,
          baselineClickAttributedConversions: 100,
          thresholdPercent: 15,
          evidenceState: "complete",
        },
        claimId: "claim-expected",
        evaluatedAt: maturityAt,
      }),
    ).resolves.toBe(false);

    await expect(summarizeDueMonitoringBacklog(maturityAt)).resolves.toEqual({
      dueAccounts: 0,
      dueWindows: 0,
      dueAccountsCapped: false,
      dueWindowsCapped: false,
    });

    expect(calls).toHaveLength(5);
    for (const call of calls) {
      expect(monitoringCutoffValue(call)).toEqual(endsAt);
    }
    expect(normalizedQueryText(calls[2])).toContain(
      "with locked_account as materialized",
    );
    expect(normalizedQueryText(calls[2])).toContain("for share");
    expect(normalizedQueryText(calls[3])).toContain(
      "with locked_account as materialized",
    );
    expect(normalizedQueryText(calls[3])).toContain("for share");
    expect(normalizedQueryText(calls[4])).not.toContain("for update");
  });

  it("returns only bounded aggregate monitoring backlog evidence", async () => {
    fakeDatabase([
      [
        {
          due_accounts: 10_001,
          due_windows: 10_001,
          due_accounts_capped: true,
          due_windows_capped: true,
        },
      ],
    ]);

    await expect(
      summarizeDueMonitoringBacklog(new Date("2026-08-30T12:00:00.000Z")),
    ).resolves.toEqual({
      dueAccounts: 10_000,
      dueWindows: 10_000,
      dueAccountsCapped: true,
      dueWindowsCapped: true,
    });
  });

  it("fences a stale account candidate against a current lease or backoff", async () => {
    const now = new Date("2026-08-27T00:00:00.000Z");
    const { calls } = fakeDatabase([[]]);

    await expect(
      claimDueMonitoringAccounts({
        attemptId: "00000000-0000-4000-8000-000000000001",
        now,
        limit: 6,
      }),
    ).resolves.toEqual([]);

    expect(calls).toHaveLength(1);
    const query = normalizedQueryText(calls[0]!);
    expect(query).toContain(
      "where advertiser_account.status = 'active' order by",
    );
    expect(query).toContain("for update of advertiser_account skip locked");
    expect(query).toContain(
      "on conflict (advertiser_account_id) do update set",
    );
    expect(query).toContain(
      "maintainflow_monitoring_account_schedule.attempt_lease_until <= $parameter",
    );
    expect(query).toContain(
      "maintainflow_monitoring_account_schedule.backoff_until <= $parameter",
    );
  });
});
