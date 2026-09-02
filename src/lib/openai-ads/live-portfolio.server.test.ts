import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getRuntimeDatabaseMock } = vi.hoisted(() => ({
  getRuntimeDatabaseMock: vi.fn(),
}));

vi.mock("../database/client.server", () => ({
  getRuntimeDatabase: getRuntimeDatabaseMock,
}));

import {
  listLivePortfolioAccounts,
  toLivePortfolioAccount,
} from "./live-portfolio.server";
import { summarizeLivePortfolioEvidence } from "./live-portfolio";

const now = new Date("2026-09-02T12:00:00.000Z");

function row(
  overrides: Partial<{
    account_id: string;
    account_name: string;
    payload_schema_version: number | null;
    detected_signal_count: number | null;
    synced_at: Date | null;
    fresh_until: Date | null;
    stale_until: Date | null;
  }> = {},
) {
  return {
    account_id: "adacct_live_one",
    account_name: "Harbour Home",
    payload_schema_version: 1,
    detected_signal_count: 3,
    synced_at: new Date("2026-09-02T11:55:00.000Z"),
    fresh_until: new Date("2026-09-02T12:05:00.000Z"),
    stale_until: new Date("2026-09-02T13:00:00.000Z"),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://localhost/maintainflow");
});

describe("live agency portfolio evidence", () => {
  it("queries only compact metadata inside the selected active agency scope", async () => {
    const calls: unknown[][] = [];
    const sql = vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return [
        row(),
        row({
          account_id: "adacct_missing",
          account_name: "Missing snapshot",
          payload_schema_version: null,
          detected_signal_count: null,
          synced_at: null,
          fresh_until: null,
          stale_until: null,
        }),
        row({
          account_id: "adacct_legacy",
          account_name: "Legacy snapshot",
          detected_signal_count: null,
        }),
      ];
    });
    getRuntimeDatabaseMock.mockReturnValue(sql);

    const result = await listLivePortfolioAccounts({
      operatorId: "user_agency_owner",
      organizationId: "00000000-0000-4000-8000-000000000001",
      now,
    });

    expect(result).toEqual([
      {
        accountId: "adacct_live_one",
        accountName: "Harbour Home",
        hasConfirmedSnapshot: true,
        detectedSignalCount: 3,
        evidenceState: "confirmed_fresh",
        evidenceAt: "2026-09-02T11:55:00.000Z",
      },
      expect.objectContaining({
        accountId: "adacct_missing",
        hasConfirmedSnapshot: false,
        detectedSignalCount: null,
        evidenceState: "not_confirmed",
      }),
      expect.objectContaining({
        accountId: "adacct_legacy",
        hasConfirmedSnapshot: false,
        detectedSignalCount: null,
        evidenceState: "refresh_required",
      }),
    ]);
    const statement = (calls[0]![0] as TemplateStringsArray)
      .join("?")
      .replace(/\s+/g, " ");
    expect(statement).toContain("membership.clerk_user_id = ?");
    expect(statement).toContain("organization.id = ?");
    expect(statement).toContain("organization.customer_type = 'agency'");
    expect(statement).toContain("organization.status = 'active'");
    expect(statement).toContain("account.status = 'active'");
    expect(statement).toContain("credential.status = 'active'");
    expect(statement).toContain("snapshot.credential_generation = concat(");
    expect(statement).toContain("snapshot.detected_signal_count");
    expect(statement).not.toContain("snapshot.snapshot_payload");
    expect(statement).not.toContain("ciphertext");
    expect(JSON.stringify(result)).not.toMatch(/currency|spend|credential/i);
  });

  it("keeps invalid metadata unknown while preserving a confirmed zero", () => {
    expect(
      toLivePortfolioAccount(
        row({ detected_signal_count: 0 }),
        now,
      ),
    ).toMatchObject({
      hasConfirmedSnapshot: true,
      detectedSignalCount: 0,
    });
    expect(
      toLivePortfolioAccount(
        row({ detected_signal_count: -1 }),
        now,
      ),
    ).toMatchObject({
      hasConfirmedSnapshot: false,
      detectedSignalCount: null,
      evidenceState: "invalid",
    });
    expect(
      toLivePortfolioAccount(
        row({ payload_schema_version: 2, detected_signal_count: 0 }),
        now,
      ),
    ).toMatchObject({
      hasConfirmedSnapshot: false,
      detectedSignalCount: null,
      evidenceState: "invalid",
    });
    expect(
      toLivePortfolioAccount(
        row({ payload_schema_version: null, detected_signal_count: 0 }),
        now,
      ),
    ).toMatchObject({
      hasConfirmedSnapshot: false,
      detectedSignalCount: null,
      evidenceState: "invalid",
    });
  });

  it("excludes expired and unknown snapshots from current portfolio totals", () => {
    expect(
      summarizeLivePortfolioEvidence([
        toLivePortfolioAccount(row({ detected_signal_count: 2 }), now),
        toLivePortfolioAccount(
          row({
            account_id: "adacct_stale",
            detected_signal_count: 3,
            fresh_until: new Date("2026-09-02T11:59:00.000Z"),
            stale_until: new Date("2026-09-02T12:30:00.000Z"),
          }),
          now,
        ),
        toLivePortfolioAccount(
          row({
            account_id: "adacct_expired",
            detected_signal_count: 99,
            fresh_until: new Date("2026-09-02T11:00:00.000Z"),
            stale_until: new Date("2026-09-02T11:30:00.000Z"),
          }),
          now,
        ),
        toLivePortfolioAccount(
          row({
            account_id: "adacct_missing",
            payload_schema_version: null,
            detected_signal_count: null,
            synced_at: null,
            fresh_until: null,
            stale_until: null,
          }),
          now,
        ),
      ]),
    ).toEqual({
      usableSnapshotCount: 2,
      unavailableSnapshotCount: 2,
      detectedSignalCount: 5,
    });
  });
});
