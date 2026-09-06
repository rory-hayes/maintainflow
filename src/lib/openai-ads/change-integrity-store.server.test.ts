import { beforeEach, describe, expect, it, vi } from "vitest";

import type postgres from "postgres";
import type { Sql } from "postgres";

vi.mock("server-only", () => ({}));

const { getRuntimeDatabaseMock } = vi.hoisted(() => ({
  getRuntimeDatabaseMock: vi.fn(),
}));

vi.mock("../database/client.server", () => ({
  getRuntimeDatabase: getRuntimeDatabaseMock,
}));

import {
  buildChangeIntegritySnapshot,
  changeIntegrityFingerprint,
  compareChangeIntegritySnapshots,
  type ChangeIntegrityCandidate,
} from "./change-integrity";
import {
  acknowledgeChangeIntegrityEvent,
  changeIntegrityOperationEvidenceFromApprovalRows,
  ChangeIntegritySnapshotOrderError,
  ChangeIntegrityAuthorizationError,
  listChangeIntegrityEvents,
  recordChangeIntegritySnapshot,
  verifyChangeIntegrityStore,
} from "./change-integrity-store.server";
import type { AdAccount, Campaign } from "./schema";

const account: AdAccount = {
  id: "adacct_integrity_store",
  name: "Northstar Home",
  url: "https://northstar.example",
  preview_url: null,
  status: "active",
  timezone: "Europe/Dublin",
  currency_code: "EUR",
  review: { status: "approved" },
};

const campaign: Campaign = {
  id: "cmpn_integrity_store",
  created_at: 1_700_000_000,
  updated_at: 1_700_000_100,
  name: "Storage",
  description: null,
  status: "active",
  mode: null,
  product_feed_id: null,
  start_time: 1_700_000_000,
  end_time: null,
  budget: { daily_spend_limit_micros: 20_000_000 },
  bidding_type: "clicks",
  conversion_event_setting_ids: [],
};

function snapshot(
  observedAt: string,
  dailyBudget = 20_000_000,
  observationStartedAt = observedAt,
) {
  return buildChangeIntegritySnapshot({
    account: structuredClone(account),
    campaigns: [
      {
        ...structuredClone(campaign),
        budget: { daily_spend_limit_micros: dailyBudget },
      },
    ],
    adGroups: [],
    ads: [],
    observationStartedAt,
    observedAt,
  });
}

function storedState(value: ReturnType<typeof snapshot>) {
  return {
    projection_version: value.projectionVersion,
    snapshot_fingerprint: changeIntegrityFingerprint({
      projectionVersion: value.projectionVersion,
      accountId: value.accountId,
      observationStartedAt: value.observationStartedAt,
      observedAt: value.observedAt,
      resources: value.resources,
    }),
    snapshot_payload: value,
    snapshot_resource_count: value.resources.length,
    observed_at: new Date(value.observedAt),
  };
}

function eventRow(candidate: ChangeIntegrityCandidate, reviewStatus = "open") {
  return {
    id: "00000000-0000-4000-8000-000000000999",
    external_account_id: candidate.accountId,
    event_fingerprint: candidate.eventFingerprint,
    projection_version: 1,
    resource_type: candidate.resourceType,
    resource_id: candidate.resourceId,
    parent_resource_id: candidate.parentResourceId,
    resource_label: candidate.resourceLabel,
    provider_updated_at: candidate.providerUpdatedAt,
    change_type: candidate.changeType,
    classification: candidate.classification,
    previous_fingerprint: candidate.previousFingerprint,
    current_fingerprint: candidate.currentFingerprint,
    previous_configuration: candidate.previousConfiguration,
    current_configuration: candidate.currentConfiguration,
    changed_field_paths: candidate.changedFieldPaths,
    explained_field_paths: candidate.explainedFieldPaths,
    indeterminate_field_paths: candidate.indeterminateFieldPaths,
    unexplained_field_paths: candidate.unexplainedFieldPaths,
    matched_operations: candidate.matchedOperations,
    baseline_observation_started_at: new Date(
      candidate.baselineObservationStartedAt,
    ),
    baseline_observed_at: new Date(candidate.baselineObservedAt),
    detection_started_at: new Date(candidate.detectionStartedAt),
    detected_at: new Date(candidate.detectedAt),
    review_status: reviewStatus,
    reviewed_by_name: reviewStatus === "reviewed" ? "Rory Hayes" : null,
    review_note:
      reviewStatus === "reviewed"
        ? "Checked against the approved account configuration."
        : null,
    reviewed_at:
      reviewStatus === "reviewed"
        ? new Date("2026-09-04T09:11:00.000Z")
        : null,
  };
}

function fakeDatabase(responses: unknown[][]) {
  const calls: Array<{ statement: string; values: unknown[] }> = [];
  const databaseReference: { current?: Sql } = {};
  const begin = vi.fn(
    (callback: (transaction: postgres.TransactionSql) => unknown) =>
      callback(databaseReference.current as unknown as postgres.TransactionSql),
  );
  const query = vi.fn(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({
        statement: strings.join(" ").replace(/\s+/g, " ").trim(),
        values,
      });
      return Promise.resolve(responses.shift() ?? []);
    },
  );
  const database = Object.assign(query, {
    begin,
    json: (value: unknown) => value,
    unsafe: (value: string) => value,
  }) as unknown as Sql;
  databaseReference.current = database;
  return { database, calls, begin };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://localhost/maintainflow");
});

describe("change-integrity approval evidence", () => {
  it("uses only confirmed outcomes or provider-attempt-backed ambiguity", () => {
    const rows = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        entity_id: campaign.id,
        status: "rolled_back",
        request_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { budget: { daily_spend_limit_micros: 15_000_000 } },
        },
        rollback_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}/pause`,
          body: null,
        },
        applied_at: new Date("2026-09-04T09:02:00.000Z"),
        rolled_back_at: new Date("2026-09-04T09:04:00.000Z"),
        apply_provider_attempted_at: new Date("2026-09-04T09:01:00.000Z"),
        rollback_provider_attempted_at: new Date("2026-09-04T09:03:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000002",
        entity_id: campaign.id,
        status: "reconciliation_required",
        request_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "paused" },
        },
        rollback_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "active" },
        },
        applied_at: null,
        rolled_back_at: null,
        apply_provider_attempted_at: new Date("2026-09-04T09:05:00.000Z"),
        rollback_provider_attempted_at: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000004",
        entity_id: campaign.id,
        status: "applied",
        request_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "paused" },
        },
        rollback_payload: null,
        applied_at: new Date("2026-09-04T09:11:00.000Z"),
        rolled_back_at: null,
        apply_provider_attempted_at: new Date("2026-09-04T09:07:00.000Z"),
        rollback_provider_attempted_at: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000005",
        entity_id: campaign.id,
        status: "rolled_back",
        request_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "paused" },
        },
        rollback_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "active" },
        },
        applied_at: new Date("2026-09-04T08:59:00.000Z"),
        rolled_back_at: new Date("2026-09-04T09:12:00.000Z"),
        apply_provider_attempted_at: new Date("2026-09-04T08:58:00.000Z"),
        rollback_provider_attempted_at: new Date("2026-09-04T09:08:00.000Z"),
      },
      {
        id: "00000000-0000-4000-8000-000000000003",
        entity_id: campaign.id,
        status: "failed",
        request_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "paused" },
        },
        rollback_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "active" },
        },
        applied_at: null,
        rolled_back_at: null,
        apply_provider_attempted_at: new Date("2026-09-04T09:06:00.000Z"),
        rollback_provider_attempted_at: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000006",
        entity_id: campaign.id,
        status: "applied",
        request_payload: {
          method: "POST",
          path: `/campaigns/${campaign.id}`,
          body: { status: "paused" },
        },
        rollback_payload: null,
        applied_at: new Date("2026-09-04T09:09:30.000Z"),
        rolled_back_at: null,
        apply_provider_attempted_at: new Date("2026-09-04T09:09:15.000Z"),
        rollback_provider_attempted_at: null,
      },
    ];

    expect(
      changeIntegrityOperationEvidenceFromApprovalRows({
        rows,
        evidenceWindowStartedAt: "2026-09-04T09:00:00.000Z",
        observationStartedAt: "2026-09-04T09:09:00.000Z",
        detectedAt: "2026-09-04T09:10:00.000Z",
      }),
    ).toEqual([
      expect.objectContaining({
        approvalId: rows[0]!.id,
        mode: "apply",
        certainty: "confirmed",
        uncertaintyReason: null,
      }),
      expect.objectContaining({
        approvalId: rows[0]!.id,
        mode: "rollback",
        certainty: "confirmed",
        uncertaintyReason: null,
        expectedState: { status: "paused" },
      }),
      expect.objectContaining({
        approvalId: rows[1]!.id,
        mode: "apply",
        certainty: "indeterminate",
        uncertaintyReason: "provider_outcome",
      }),
      expect.objectContaining({
        approvalId: rows[2]!.id,
        mode: "apply",
        certainty: "indeterminate",
        uncertaintyReason: "snapshot_timing",
        occurredAt: "2026-09-04T09:07:00.000Z",
      }),
      expect.objectContaining({
        approvalId: rows[3]!.id,
        mode: "rollback",
        certainty: "indeterminate",
        uncertaintyReason: "snapshot_timing",
        occurredAt: "2026-09-04T09:08:00.000Z",
      }),
      expect.objectContaining({
        approvalId: rows[5]!.id,
        mode: "apply",
        certainty: "indeterminate",
        uncertaintyReason: "snapshot_timing",
        occurredAt: "2026-09-04T09:09:30.000Z",
      }),
    ]);
  });

  it("does not let malformed or noncanonical mutations explain a change", () => {
    expect(
      changeIntegrityOperationEvidenceFromApprovalRows({
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            entity_id: campaign.id,
            status: "applied",
            request_payload: {
              method: "POST",
              path: `/campaigns/${campaign.id}?unsafe=true`,
              body: { status: "paused" },
            },
            rollback_payload: null,
            applied_at: new Date("2026-09-04T09:02:00.000Z"),
            rolled_back_at: null,
            apply_provider_attempted_at: new Date(
              "2026-09-04T09:01:00.000Z",
            ),
            rollback_provider_attempted_at: null,
          },
        ],
        evidenceWindowStartedAt: "2026-09-04T09:00:00.000Z",
        observationStartedAt: "2026-09-04T09:09:00.000Z",
        detectedAt: "2026-09-04T09:10:00.000Z",
      }),
    ).toEqual([]);
  });
});

describe("durable change-integrity snapshots", () => {
  it("creates a first account baseline inside a supplied pooled transaction", async () => {
    const { database, calls, begin } = fakeDatabase([
      [{ id: "00000000-0000-4000-8000-000000000100" }],
      [],
      [],
    ]);

    await expect(
      recordChangeIntegritySnapshot(
        { snapshot: snapshot("2026-09-04T09:00:00.000Z") },
        database,
      ),
    ).resolves.toEqual({
      baselineCreated: true,
      baselineAdvanced: true,
      events: [],
    });
    expect(begin).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.statement).join(" ")).not.toContain(
      "credential_generation",
    );
    expect(calls[0]!.statement).toContain("for update");
  });

  it("uses an injected transaction without opening a nested transaction", async () => {
    const { database, calls, begin } = fakeDatabase([
      [{ id: "00000000-0000-4000-8000-000000000100" }],
      [],
      [],
    ]);
    delete (database as unknown as { begin?: unknown }).begin;

    await expect(
      recordChangeIntegritySnapshot(
        { snapshot: snapshot("2026-09-04T09:00:00.000Z") },
        database as unknown as postgres.TransactionSql,
      ),
    ).resolves.toMatchObject({ baselineCreated: true });
    expect(begin).not.toHaveBeenCalled();
    expect(calls[0]!.statement).toContain("for update");
  });

  it("persists a material event before advancing the baseline", async () => {
    const previous = snapshot(
      "2026-09-04T09:00:00.000Z",
      20_000_000,
      "2026-09-04T08:59:30.000Z",
    );
    const current = snapshot(
      "2026-09-04T09:10:00.000Z",
      15_000_000,
      "2026-09-04T09:09:30.000Z",
    );
    const [candidate] = compareChangeIntegritySnapshots({ previous, current });
    const { database, calls } = fakeDatabase([
      [{ id: "00000000-0000-4000-8000-000000000100" }],
      [storedState(previous)],
      [],
      [eventRow(candidate!)],
      [],
    ]);

    const result = await recordChangeIntegritySnapshot(
      { snapshot: current },
      database,
    );

    expect(result).toMatchObject({
      baselineCreated: false,
      baselineAdvanced: true,
      events: [
        {
          resourceId: campaign.id,
          classification: "unexplained",
          reviewStatus: "open",
        },
      ],
    });
    const statements = calls.map((call) => call.statement);
    expect(statements.join(" ")).toContain("approval.applied_at >=");
    expect(statements.join(" ")).toContain("approval.rolled_back_at >=");
    const operationEvidenceQuery = calls.find((call) =>
      call.statement.includes("from public.ads_approval_records approval"),
    );
    expect(operationEvidenceQuery?.values).toContainEqual(
      new Date("2026-09-04T08:59:30.000Z"),
    );
    expect(operationEvidenceQuery?.values).toContainEqual(
      new Date("2026-09-04T09:10:00.000Z"),
    );
    expect(
      statements.findIndex((statement) =>
        statement.includes("insert into public.maintainflow_ads_config_integrity_events"),
      ),
    ).toBeLessThan(
      statements.findIndex((statement) =>
        statement.includes("update public.maintainflow_ads_config_integrity_state"),
      ),
    );
  });

  it("rejects an out-of-order or same-time conflicting snapshot", async () => {
    const durable = snapshot("2026-09-04T09:10:00.000Z");
    for (const current of [
      snapshot("2026-09-04T09:09:00.000Z"),
      snapshot("2026-09-04T09:10:00.000Z", 15_000_000),
    ]) {
      const { database } = fakeDatabase([
        [{ id: "00000000-0000-4000-8000-000000000100" }],
        [storedState(durable)],
      ]);
      await expect(
        recordChangeIntegritySnapshot({ snapshot: current }, database),
      ).rejects.toBeInstanceOf(ChangeIntegritySnapshotOrderError);
    }
  });
});

describe("change-integrity event reads and review", () => {
  it("returns full-account durable totals separately from a bounded page", async () => {
    const previous = snapshot("2026-09-04T09:00:00.000Z");
    const current = snapshot("2026-09-04T09:10:00.000Z", 15_000_000);
    const [candidate] = compareChangeIntegritySnapshots({ previous, current });
    const row = eventRow(candidate!);
    const { database } = fakeDatabase([
      [{ observed_at: new Date(current.observedAt) }],
      [
        {
          retained_event_count: 12,
          open_unexplained_count: 4,
          open_indeterminate_count: 2,
          consistent_count: 5,
          reviewed_count: 1,
        },
      ],
      [row, { ...row, id: "00000000-0000-4000-8000-000000000998" }],
    ]);

    await expect(
      listChangeIntegrityEvents(
        { accountId: account.id, limit: 1 },
        database,
      ),
    ).resolves.toMatchObject({
      events: [{ id: row.id }],
      hasMore: true,
      summary: {
        baselineReady: true,
        lastCheckedAt: current.observedAt,
        retainedEventCount: 12,
        openUnexplainedCount: 4,
        openIndeterminateCount: 2,
        consistentCount: 5,
        reviewedCount: 1,
      },
    });
  });

  it("orders open events first and applies a stable keyset cursor", async () => {
    const previous = snapshot("2026-09-04T09:00:00.000Z");
    const current = snapshot("2026-09-04T09:10:00.000Z", 15_000_000);
    const [candidate] = compareChangeIntegritySnapshots({ previous, current });
    const row = eventRow(candidate!);
    const { database, calls } = fakeDatabase([
      [{ observed_at: new Date(current.observedAt) }],
      [{ retained_event_count: 1 }],
      [row],
    ]);

    await listChangeIntegrityEvents(
      {
        accountId: account.id,
        cursor: {
          reviewStatus: "open",
          detectedAt: "2026-09-04T09:09:00.000Z",
          id: "00000000-0000-4000-8000-000000000998",
        },
      },
      database,
    );

    const statement = calls.at(-1)!.statement;
    expect(statement).toContain("(event.review_status = 'open') desc");
    expect(statement).toContain("(event.detected_at, event.id) <");
    expect(calls.at(-1)!.values).toEqual(
      expect.arrayContaining([
        true,
        new Date("2026-09-04T09:09:00.000Z"),
        "00000000-0000-4000-8000-000000000998",
      ]),
    );
  });

  it("locks the account and current write authority before updating the event", async () => {
    const previous = snapshot("2026-09-04T09:00:00.000Z", 10_000_000);
    const current = snapshot("2026-09-04T09:10:00.000Z", 15_000_000);
    const [candidate] = compareChangeIntegritySnapshots({ previous, current });
    const advertiserAccountId = "00000000-0000-4000-8000-000000000300";
    const organizationId = "00000000-0000-4000-8000-000000000200";
    const { database, calls, begin } = fakeDatabase([
      [{ id: advertiserAccountId }],
      [
        {
          advertiser_account_id: advertiserAccountId,
          organization_id: organizationId,
          organization_name: "Northstar",
          organization_type: "advertiser",
          account_id: account.id,
          account_name: account.name,
          connection_mode: "vault",
          membership_role: "owner",
          account_role: "owner",
        },
      ],
      [eventRow(candidate!, "reviewed")],
    ]);

    await expect(
      acknowledgeChangeIntegrityEvent(
        {
          accountId: account.id,
          eventId: "00000000-0000-4000-8000-000000000999",
          operatorId: "user_owner",
          reviewerName: "Rory Hayes",
          access: {
            organizationId,
            organizationName: "Northstar",
            organizationType: "advertiser",
            accountId: account.id,
            accountName: account.name,
            connectionMode: "vault",
            membershipRole: "owner",
            accountRole: "owner",
          },
          note: "I reviewed the durable evidence carefully.",
        },
        database,
      ),
    ).resolves.toMatchObject({ reviewStatus: "reviewed" });

    expect(begin).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(3);
    expect(calls[0]!.statement).toContain(
      "from maintainflow_advertiser_accounts",
    );
    expect(calls[0]!.statement).toContain("for update");
    expect(calls[1]!.statement).toContain(
      "for update of organization, membership, account_access",
    );
    expect(calls[2]!.statement).toContain(
      "update public.maintainflow_ads_config_integrity_events",
    );
  });

  it("requires caller write authority before attempting review", async () => {
    const { database, calls } = fakeDatabase([]);
    await expect(
      acknowledgeChangeIntegrityEvent(
        {
          accountId: account.id,
          eventId: "00000000-0000-4000-8000-000000000999",
          operatorId: "user_viewer",
          reviewerName: "Viewer",
          access: {
            organizationId: "00000000-0000-4000-8000-000000000200",
            organizationName: "Northstar",
            organizationType: "advertiser",
            accountId: account.id,
            accountName: account.name,
            connectionMode: "vault",
            membershipRole: "analyst",
            accountRole: "viewer",
          },
          note: "I reviewed the durable evidence carefully.",
        },
        database,
      ),
    ).rejects.toThrow(/manager or owner/i);
    expect(calls).toEqual([]);
  });

  it("maps a database-time access revocation to a safe authorization error", async () => {
    const query = vi.fn().mockRejectedValue({
      message:
        "Current advertiser write authority is required to review an integrity event",
    });
    const database = Object.assign(query, {
      json: (value: unknown) => value,
      unsafe: (value: string) => value,
    }) as unknown as postgres.TransactionSql;

    await expect(
      acknowledgeChangeIntegrityEvent(
        {
          accountId: account.id,
          eventId: "00000000-0000-4000-8000-000000000999",
          operatorId: "user_owner",
          reviewerName: "Rory Hayes",
          access: {
            organizationId: "00000000-0000-4000-8000-000000000200",
            organizationName: "Northstar",
            organizationType: "advertiser",
            accountId: account.id,
            accountName: account.name,
            connectionMode: "vault",
            membershipRole: "owner",
            accountRole: "owner",
          },
          note: "I reviewed the durable evidence carefully.",
        },
        database,
      ),
    ).rejects.toBeInstanceOf(ChangeIntegrityAuthorizationError);
  });
});

describe("change-integrity store readiness", () => {
  it("checks both durable relations, indexes, and the immutable-event guard", async () => {
    const { database, calls } = fakeDatabase([[{ ready: true }]]);
    await expect(verifyChangeIntegrityStore(database)).resolves.toBe(true);
    expect(calls[0]!.statement).toContain(
      "maintainflow_ads_config_integrity_events_open_idx",
    );
    expect(calls[0]!.statement).toContain(
      "maintainflow_enforce_ads_config_integrity_event",
    );
    expect(calls[0]!.statement).toContain("pg_catalog.pg_trigger");
    expect(calls[0]!.statement).toContain(
      "maintainflow_ads_config_integrity_event_guard",
    );
    expect(calls[0]!.statement).toContain("integrity_trigger.tgenabled");
  });
});
