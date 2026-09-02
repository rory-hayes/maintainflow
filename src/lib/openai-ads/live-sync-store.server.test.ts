import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getRuntimeDatabaseMock } = vi.hoisted(() => ({
  getRuntimeDatabaseMock: vi.fn(),
}));

vi.mock("../database/client.server", () => ({
  getRuntimeDatabase: getRuntimeDatabaseMock,
}));

import {
  demoAccount,
  demoAds,
  demoCampaignPerformance,
  demoCampaigns,
} from "./demo-data";
import type { LiveWorkbenchData } from "./data.server";
import {
  claimLiveSyncRefresh,
  completeLiveSyncRefresh,
  failLiveSyncRefresh,
  pruneExpiredLiveSyncSnapshots,
  readLiveSyncState,
  renewLiveSyncClaim,
  verifyLiveSyncStore,
} from "./live-sync-store.server";
import { serializeLiveWorkbenchSnapshot } from "./live-sync-snapshot";

function snapshot(): LiveWorkbenchData {
  const syncedAt = "2026-08-30T12:00:00.000Z";
  return {
    account: demoAccount,
    campaigns: demoCampaigns,
    ads: demoAds,
    performance: demoCampaignPerformance,
    budgetGuardEvidence: [],
    recommendations: [],
    conversionMeasurement: {
      source: "live",
      status: "ready",
      checkedAt: syncedAt,
      activeConversionCampaigns: 1,
      healthyCampaigns: 1,
      eventSettingCount: 1,
      checks: [],
      message: "Measurement is ready.",
    },
    syncedAt,
  };
}

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

function statement(call: unknown[]) {
  return (call[0] as TemplateStringsArray).join("?").replace(/\s+/g, " ");
}

const scope = {
  accountId: demoAccount.id,
  credentialGeneration: "vault:v1:credential:7",
};
const now = new Date("2026-08-30T12:00:05.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DATABASE_URL = "postgres://localhost/maintainflow";
});

describe("live sync store", () => {
  it("verifies the table and cleanup index through the shared runtime client", async () => {
    fakeDatabase([[{ ready: true }]]);

    await expect(verifyLiveSyncStore()).resolves.toBe(true);
    expect(getRuntimeDatabaseMock).toHaveBeenCalledWith(
      "postgres://localhost/maintainflow",
    );
  });

  it("parses the versioned snapshot and exposes claim and failure metadata", async () => {
    const serialized = serializeLiveWorkbenchSnapshot(
      snapshot(),
      demoAccount.id,
    );
    const claimedAt = new Date("2026-08-30T12:00:01.000Z");
    const expiresAt = new Date("2026-08-30T12:01:31.000Z");
    const retryAfter = new Date("2026-08-30T12:02:00.000Z");
    fakeDatabase([
      [
        {
          payload_schema_version: 1,
          snapshot_payload: serialized.envelope,
          snapshot_bytes: serialized.bytes,
          synced_at: new Date(snapshot().syncedAt),
          fresh_until: new Date("2026-08-30T12:02:00.000Z"),
          stale_until: new Date("2026-08-30T12:15:00.000Z"),
          refresh_claim_id: "00000000-0000-4000-8000-000000000001",
          refresh_claimed_at: claimedAt,
          refresh_claim_expires_at: expiresAt,
          consecutive_failures: 2,
          last_failure_code: "provider_unavailable",
          last_failed_at: now,
          retry_after: retryAfter,
        },
      ],
    ]);

    await expect(readLiveSyncState(scope)).resolves.toMatchObject({
      snapshot: { account: { id: demoAccount.id } },
      payloadSchemaVersion: 1,
      snapshotBytes: serialized.bytes,
      claim: { claimedAt, expiresAt },
      consecutiveFailures: 2,
      lastFailureCode: "provider_unavailable",
      retryAfter,
    });
  });

  it("does not clear a valid snapshot that wins the invalid-payload recovery race", async () => {
    const serialized = serializeLiveWorkbenchSnapshot(
      snapshot(),
      demoAccount.id,
    );
    const invalidPayload = { ...serialized.envelope, schemaVersion: 0 };
    const invalidRow = {
      payload_schema_version: 1,
      snapshot_payload: invalidPayload,
      snapshot_bytes: Buffer.byteLength(JSON.stringify(invalidPayload), "utf8"),
      synced_at: new Date(snapshot().syncedAt),
      fresh_until: new Date("2026-08-30T12:02:00.000Z"),
      stale_until: new Date("2026-08-30T12:15:00.000Z"),
      refresh_claim_id: null,
      refresh_claimed_at: null,
      refresh_claim_expires_at: null,
      consecutive_failures: 0,
      last_failure_code: null,
      last_failed_at: null,
      retry_after: null,
    };
    const validRow = {
      ...invalidRow,
      snapshot_payload: serialized.envelope,
      snapshot_bytes: serialized.bytes,
    };
    const database = fakeDatabase([
      [invalidRow],
      [],
      [validRow],
    ]);

    await expect(readLiveSyncState(scope)).resolves.toMatchObject({
      snapshot: { account: { id: demoAccount.id } },
      payloadSchemaVersion: 1,
      snapshotBytes: serialized.bytes,
    });
    expect(statement(database.calls[1])).toContain(
      "state.snapshot_payload = ?",
    );
    expect(statement(database.calls[1])).toContain(
      "detected_signal_count = null",
    );
    expect(database.calls).toHaveLength(3);
  });

  it("claims atomically behind an active-account lock and applies lease and cooldown predicates", async () => {
    const { calls } = fakeDatabase([
      [{ refresh_claim_id: "ignored-return-value" }],
    ]);

    const result = await claimLiveSyncRefresh({
      ...scope,
      now,
      leaseMs: 90_000,
    });

    expect(result?.claimId).toMatch(/^[a-f0-9-]{36}$/);
    expect(result?.expiresAt).toEqual(
      new Date("2026-08-30T12:01:35.000Z"),
    );
    expect(statement(calls[0])).toContain("for share");
    expect(statement(calls[0])).toContain(
      "on conflict (advertiser_account_id, credential_generation) do update",
    );
    expect(statement(calls[0])).toContain("refresh_claim_expires_at");
    expect(statement(calls[0])).toContain("retry_after");
  });

  it("returns null when another worker owns the claim", async () => {
    fakeDatabase([[]]);

    await expect(
      claimLiveSyncRefresh({
        ...scope,
        now,
        leaseMs: 90_000,
      }),
    ).resolves.toBeNull();
  });

  it("renews and completes only an unexpired matching claim", async () => {
    const claimId = "00000000-0000-4000-8000-000000000001";
    const renewal = fakeDatabase([[{ refresh_claim_id: claimId }]]);
    await expect(
      renewLiveSyncClaim({
        ...scope,
        claimId,
        now,
        leaseMs: 90_000,
      }),
    ).resolves.toBe(true);
    expect(statement(renewal.calls[0])).toContain(
      "state.refresh_claim_expires_at >",
    );
    expect(statement(renewal.calls[0])).toContain("for share");

    const completion = fakeDatabase([[{ refresh_claim_id: claimId }]]);
    await expect(
      completeLiveSyncRefresh({
        ...scope,
        claimId,
        snapshot: snapshot(),
        now,
        freshForMs: 120_000,
        staleForMs: 900_000,
      }),
    ).resolves.toBe(true);
    expect(statement(completion.calls[0])).toContain(
      "state.refresh_claim_id =",
    );
    expect(statement(completion.calls[0])).toContain(
      "state.refresh_claim_expires_at >",
    );
    expect(statement(completion.calls[0])).toContain(
      "detected_signal_count = ?",
    );
    expect(statement(completion.calls[0])).toContain("for share");
  });

  it("records only bounded failure codes for an unexpired matching claim", async () => {
    const claimId = "00000000-0000-4000-8000-000000000001";
    const database = fakeDatabase([[{ refresh_claim_id: claimId }]]);
    await expect(
      failLiveSyncRefresh({
        ...scope,
        claimId,
        failureCode: "provider_unavailable",
        retryAfter: new Date("2026-08-30T12:00:35.000Z"),
        now,
      }),
    ).resolves.toBe(true);
    expect(statement(database.calls[0])).toContain(
      "state.refresh_claim_expires_at >",
    );
    expect(statement(database.calls[0])).toContain("for share");

    await expect(
      failLiveSyncRefresh({
        ...scope,
        claimId,
        failureCode: "Provider error: leaked response body",
        retryAfter: new Date("2026-08-30T12:00:35.000Z"),
        now,
      }),
    ).rejects.toThrow(/machine-readable code/);
  });

  it("does not complete or fail after claim ownership is lost", async () => {
    const claimId = "00000000-0000-4000-8000-000000000001";
    fakeDatabase([[]]);
    await expect(
      completeLiveSyncRefresh({
        ...scope,
        claimId,
        snapshot: snapshot(),
        now,
        freshForMs: 120_000,
        staleForMs: 900_000,
      }),
    ).resolves.toBe(false);

    fakeDatabase([[]]);
    await expect(
      failLiveSyncRefresh({
        ...scope,
        claimId,
        failureCode: "provider_unavailable",
        retryAfter: new Date("2026-08-30T12:00:35.000Z"),
        now,
      }),
    ).resolves.toBe(false);
  });

  it("prunes only unclaimed or expired-claim rows through a bounded skip-locked batch", async () => {
    const database = fakeDatabase([
      [
        { advertiser_account_id: "00000000-0000-4000-8000-000000000001" },
        { advertiser_account_id: "00000000-0000-4000-8000-000000000002" },
      ],
    ]);

    await expect(
      pruneExpiredLiveSyncSnapshots({
        now,
        retentionMs: 86_400_000,
        limit: 100,
      }),
    ).resolves.toBe(2);
    expect(statement(database.calls[0])).toContain("candidate.refresh_claim_id is null");
    expect(statement(database.calls[0])).toContain(
      "candidate.refresh_claim_expires_at <=",
    );
    expect(statement(database.calls[0])).toContain("for update skip locked");
    expect(statement(database.calls[0])).toContain(
      "coalesce(candidate.synced_at, candidate.created_at) <",
    );
    expect(statement(database.calls[0])).not.toContain("candidate.updated_at <");
  });
});
