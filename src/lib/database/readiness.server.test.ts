import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ getRuntimeDatabase: vi.fn() }));

vi.mock("./client.server", () => ({
  getRuntimeDatabase: state.getRuntimeDatabase,
}));

import { databaseMigrationManifest } from "./migration-manifest";
import {
  verifyDatabaseMigrationLedger,
  verifyRuntimeDatabaseRole,
  verifyRuntimeDatabaseTransaction,
} from "./readiness.server";

const runtimeReadableTables = [
  "ads_approval_records",
  "maintainflow_change_approval_requests",
  "maintainflow_approval_notification_deliveries",
  "maintainflow_organizations",
  "maintainflow_organization_memberships",
  "maintainflow_advertiser_accounts",
  "maintainflow_account_access",
  "maintainflow_advertiser_credentials",
  "maintainflow_creative_review_state",
  "maintainflow_creative_review_events",
  "maintainflow_rate_limit_buckets",
  "maintainflow_recommendation_dismissals",
  "maintainflow_conversion_credentials",
  "maintainflow_readiness_audit_runs",
  "maintainflow_live_workbench_snapshots",
  "maintainflow_ads_config_integrity_state",
  "maintainflow_ads_config_integrity_events",
  "maintainflow_customer_lifecycle_records",
  "maintainflow_monitoring_account_schedule",
  "maintainflow_schema_migrations",
];
const runtimeInsertableTables = new Set(
  runtimeReadableTables.filter(
    (table) =>
      !new Set([
        "maintainflow_customer_lifecycle_records",
        "maintainflow_change_approval_requests",
        "maintainflow_approval_notification_deliveries",
        "maintainflow_schema_migrations",
      ]).has(table),
  ),
);
const runtimeColumnInsertableTables = new Set([
  "maintainflow_change_approval_requests",
  "maintainflow_approval_notification_deliveries",
]);
const runtimeUpdatableTables = new Set([
  "maintainflow_advertiser_accounts",
  "maintainflow_advertiser_credentials",
  "maintainflow_creative_review_state",
  "maintainflow_rate_limit_buckets",
  "maintainflow_recommendation_dismissals",
  "maintainflow_conversion_credentials",
  "maintainflow_live_workbench_snapshots",
  "maintainflow_monitoring_account_schedule",
]);
const runtimeColumnUpdatableTables = new Set([
  "ads_approval_records",
  "maintainflow_account_access",
  "maintainflow_approval_notification_deliveries",
  "maintainflow_change_approval_requests",
  "maintainflow_organization_memberships",
  "maintainflow_organizations",
  "maintainflow_ads_config_integrity_state",
  "maintainflow_ads_config_integrity_events",
]);
const lockOnlyUpdateColumns = new Map([
  ["maintainflow_account_access", ["organization_id"]],
  ["maintainflow_organization_memberships", ["organization_id"]],
  ["maintainflow_organizations", ["id"]],
]);
const approvalRequestInsertColumns = [
  "account_id_snapshot",
  "account_name_snapshot",
  "advertiser_account_id",
  "decision_context",
  "entity_id",
  "evidence_payload",
  "expires_at",
  "id",
  "organization_id",
  "recommendation_fingerprint",
  "recommendation_id",
  "recommendation_title",
  "request_note",
  "request_payload",
  "requested_at",
  "requester_membership_role",
  "requester_name_snapshot",
  "requester_operator_id",
  "rollback_payload",
  "safeguard",
  "source",
];
const approvalNotificationInsertColumns = [
  "approval_request_id",
  "approval_request_version",
  "event_type",
  "id",
  "organization_id",
  "recipient_membership_role_snapshot",
  "recipient_operator_id",
];
const approvalRecordUpdateColumns = [
  "applied_at",
  "apply_provider_attempted_at",
  "error_message",
  "monitoring_ends_at",
  "monitoring_evaluated_at",
  "monitoring_evaluation_claim_id",
  "monitoring_evaluation_claimed_at",
  "monitoring_observation",
  "monitoring_outcome",
  "monitoring_started_at",
  "reconciled_account_role",
  "reconciled_at",
  "reconciled_by",
  "reconciled_membership_role",
  "reconciled_organization_id",
  "reconciliation_note",
  "response_payload",
  "rollback_account_role",
  "rollback_error_message",
  "rollback_membership_role",
  "rollback_operator_id",
  "rollback_organization_id",
  "rollback_provider_attempt_id",
  "rollback_provider_attempted_at",
  "rollback_response_payload",
  "rolled_back_at",
  "status",
  "updated_at",
];
const approvalRequestUpdateColumns = [
  "ads_approval_record_id",
  "decided_at",
  "decision_membership_role",
  "decision_name_snapshot",
  "decision_note",
  "decision_operator_id",
  "retired_at",
  "status",
  "updated_at",
  "version",
];
const approvalNotificationUpdateColumns = [
  "cancellation_code",
  "claim_id",
  "last_failure_code",
  "provider_event_at",
  "provider_event_type",
  "provider_message_id",
  "status",
];
const integrityEventUpdateColumns = [
  "review_note",
  "review_status",
  "reviewed_by_name",
  "reviewed_by_operator_id",
  "reviewed_by_organization_id",
];
const integrityStateUpdateColumns = [
  "observed_at",
  "projection_version",
  "snapshot_fingerprint",
  "snapshot_payload",
  "snapshot_resource_count",
  "updated_at",
];
const runtimeDeletableTables = new Set([
  "maintainflow_rate_limit_buckets",
  "maintainflow_live_workbench_snapshots",
]);

function healthyRole(overrides = {}) {
  return {
    role_name: "maintainflow_app",
    session_role_name: "maintainflow_app",
    role_settings: [
      "search_path=pg_catalog, public",
      "statement_timeout=20s",
      "lock_timeout=18s",
      "idle_in_transaction_session_timeout=30s",
    ],
    effective_statement_timeout: "20s",
    effective_lock_timeout: "18s",
    effective_idle_in_transaction_timeout: "30s",
    can_login: true,
    inherits_roles: false,
    is_superuser: false,
    can_create_database: false,
    can_create_role: false,
    can_replicate: false,
    bypasses_rls: true,
    connection_limit: 10,
    member_of_count: 0,
    incoming_member_count: 1,
    unexpected_incoming_member_count: 0,
    owned_public_relation_count: 0,
    unexpected_public_policy_count: 0,
    runtime_lock_guard_count: 3,
    executable_public_function_count: 0,
    usable_public_sequence_count: 0,
    can_connect_database: true,
    can_create_in_database: false,
    can_use_public_schema: true,
    can_create_in_public_schema: false,
    ...overrides,
  };
}

function healthyPrivileges() {
  const tables = [...runtimeReadableTables, "maintaincode_workspaces", "maintaincode_credentials", "maintaincode_maintenance_queue", "maintaincode_sites"];
  return tables.map((table_name) => ({
    table_name,
    row_security_enabled: table_name !== "maintaincode_sites",
    can_select: runtimeReadableTables.includes(table_name),
    can_insert: runtimeInsertableTables.has(table_name),
    can_update: runtimeUpdatableTables.has(table_name),
    can_delete: runtimeDeletableTables.has(table_name),
    can_truncate: false,
    can_reference: false,
    can_trigger: false,
    can_maintain: false,
    can_select_any_column: runtimeReadableTables.includes(table_name),
    can_insert_any_column:
      runtimeInsertableTables.has(table_name) ||
      runtimeColumnInsertableTables.has(table_name),
    can_update_any_column:
      runtimeUpdatableTables.has(table_name) ||
      runtimeColumnUpdatableTables.has(table_name),
    can_reference_any_column: false,
    insert_columns: runtimeInsertableTables.has(table_name)
      ? ["all_columns_via_table_grant"]
      : runtimeColumnInsertableTables.has(table_name)
        ? table_name === "maintainflow_change_approval_requests"
          ? approvalRequestInsertColumns
          : approvalNotificationInsertColumns
        : [],
    update_columns: runtimeUpdatableTables.has(table_name)
      ? ["all_columns_via_table_grant"]
      : runtimeColumnUpdatableTables.has(table_name)
        ? table_name === "ads_approval_records"
          ? approvalRecordUpdateColumns
          : table_name === "maintainflow_change_approval_requests"
            ? approvalRequestUpdateColumns
            : table_name ===
                "maintainflow_approval_notification_deliveries"
              ? approvalNotificationUpdateColumns
              : table_name === "maintainflow_ads_config_integrity_state"
                ? integrityStateUpdateColumns
              : table_name === "maintainflow_ads_config_integrity_events"
                ? integrityEventUpdateColumns
              : lockOnlyUpdateColumns.get(table_name)
        : [],
  }));
}

function databaseWithRuntimeRole(
  role = healthyRole(),
  privileges = healthyPrivileges(),
) {
  return vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("from pg_catalog.pg_roles role")) {
      return Promise.resolve([role]);
    }
    if (query.includes("has_table_privilege")) {
      return Promise.resolve(privileges);
    }
    throw new Error("Unexpected runtime-role readiness query.");
  });
}

function databaseWithLedger(
  rows: Array<{ migration_name: string; checksum_sha256: string }>,
) {
  return vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("to_regclass")) return Promise.resolve([{ exists: true }]);
    if (query.includes("maintainflow_schema_migrations")) {
      return Promise.resolve(rows);
    }
    throw new Error("Unexpected readiness query.");
  });
}

function databaseWithTransaction(options: {
  roleName?: string;
  identityMarker?: string;
  identityPid?: number;
  confirmedMarker?: string;
  confirmedPid?: number;
  reject?: boolean;
} = {}) {
  const identityPid = options.identityPid ?? 101;
  let queryCount = 0;
  const transaction = vi.fn(() => {
    queryCount += 1;
    return Promise.resolve(
      queryCount === 1
        ? [
            {
              role_name: options.roleName ?? "maintainflow_app",
              backend_pid: identityPid,
              transaction_marker: options.identityMarker ?? "active",
            },
          ]
        : [
            {
              backend_pid: options.confirmedPid ?? identityPid,
              transaction_marker: options.confirmedMarker ?? "active",
            },
          ],
    );
  });
  const begin = vi.fn(async (callback: (sql: typeof transaction) => unknown) => {
    if (options.reject) throw new Error("transaction unavailable");
    return callback(transaction);
  });
  const database = Object.assign(vi.fn(), { begin }) as unknown as Sql;
  return { database, begin, transaction };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgres://localhost/maintainflow");
});

describe("database migration deployment readiness", () => {
  it("accepts only the exact immutable migration ledger", async () => {
    state.getRuntimeDatabase.mockReturnValue(
      databaseWithLedger(
        databaseMigrationManifest.map((migration) => ({
          migration_name: migration.name,
          checksum_sha256: migration.checksumSha256,
        })),
      ),
    );

    await expect(verifyDatabaseMigrationLedger()).resolves.toEqual({
      ready: true,
      appliedCount: databaseMigrationManifest.length,
      expectedCount: databaseMigrationManifest.length,
      currentMigration: databaseMigrationManifest.at(-1)?.name,
    });
  });

  it("rejects a stale, extra, or checksum-drifted ledger", async () => {
    const current = databaseMigrationManifest.map((migration) => ({
      migration_name: migration.name,
      checksum_sha256: migration.checksumSha256,
    }));
    const variants = [
      current.slice(0, -1),
      [...current, { migration_name: "013_unknown.sql", checksum_sha256: "f".repeat(64) }],
      current.map((row, index) =>
        index === 0 ? { ...row, checksum_sha256: "0".repeat(64) } : row,
      ),
    ];

    for (const rows of variants) {
      state.getRuntimeDatabase.mockReturnValue(databaseWithLedger(rows));
      await expect(verifyDatabaseMigrationLedger()).resolves.toMatchObject({
        ready: false,
        appliedCount: rows.length,
      });
    }
  });

  it("fails closed when the ledger table or database is unavailable", async () => {
    state.getRuntimeDatabase.mockReturnValueOnce(
      vi.fn(() => Promise.resolve([{ exists: false }])),
    );
    await expect(verifyDatabaseMigrationLedger()).resolves.toMatchObject({
      ready: false,
      appliedCount: 0,
    });

    state.getRuntimeDatabase.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    await expect(verifyDatabaseMigrationLedger()).resolves.toMatchObject({
      ready: false,
      appliedCount: 0,
    });
  });
});

describe("runtime database role deployment readiness", () => {
  it("accepts only the dedicated role and exact effective privilege matrix", async () => {
    state.getRuntimeDatabase.mockReturnValue(databaseWithRuntimeRole());

    await expect(verifyRuntimeDatabaseRole()).resolves.toBe(true);
  });

  it.each([
    ["wrong login", { role_name: "postgres" }],
    ["session role mismatch", { session_role_name: "postgres" }],
    ["superuser", { is_superuser: true }],
    ["role inheritance", { inherits_roles: true }],
    ["missing RLS bypass", { bypasses_rls: false }],
    ["role membership", { member_of_count: 1 }],
    ["unexpected incoming member", { unexpected_incoming_member_count: 1 }],
    ["owned table", { owned_public_relation_count: 1 }],
    ["unexpected policy", { unexpected_public_policy_count: 1 }],
    ["missing runtime lock guard", { runtime_lock_guard_count: 2 }],
    ["function execution", { executable_public_function_count: 1 }],
    ["schema creation", { can_create_in_public_schema: true }],
    ["missing role timeout", { role_settings: ["statement_timeout=20s"] }],
    ["ineffective statement timeout", { effective_statement_timeout: "0" }],
    ["ineffective lock timeout", { effective_lock_timeout: "0" }],
    [
      "ineffective idle transaction timeout",
      { effective_idle_in_transaction_timeout: "0" },
    ],
  ])("rejects %s", async (_label, override) => {
    state.getRuntimeDatabase.mockReturnValue(
      databaseWithRuntimeRole(healthyRole(override)),
    );

    await expect(verifyRuntimeDatabaseRole()).resolves.toBe(false);
  });

  it("rejects missing, extra, elevated, or RLS-disabled table privileges", async () => {
    const current = healthyPrivileges();
    const variants = [
      ...["maintaincode_workspaces", "maintaincode_credentials", "maintaincode_maintenance_queue", "maintaincode_sites"].flatMap((table) => [
        current.map((row) => row.table_name === table ? { ...row, can_select: true, can_select_any_column: true } : row),
        current.filter((row) => row.table_name !== table),
      ]),
      current.filter(
        (row) => row.table_name !== "maintainflow_change_approval_requests",
      ),
      current.filter(
        (row) =>
          row.table_name !==
          "maintainflow_approval_notification_deliveries",
      ),
      [
        ...current,
        {
          ...current[0],
          table_name: "unexpected_public_table",
        },
      ],
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? { ...row, can_insert: true }
          : row,
      ),
      current.map((row) =>
        row.table_name ===
        "maintainflow_approval_notification_deliveries"
          ? { ...row, can_insert: true }
          : row,
      ),
      current.map((row) =>
        row.table_name ===
        "maintainflow_approval_notification_deliveries"
          ? {
              ...row,
              insert_columns: approvalNotificationInsertColumns.map(
                (column) =>
                  column === "event_type" ? "channel" : column,
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? { ...row, can_insert_any_column: false }
          : row,
      ),
      current.map((row) =>
        row.table_name ===
        "maintainflow_approval_notification_deliveries"
          ? { ...row, can_update: true }
          : row,
      ),
      current.map((row) =>
        row.table_name ===
        "maintainflow_approval_notification_deliveries"
          ? {
              ...row,
              update_columns: approvalNotificationUpdateColumns.map(
                (column) =>
                  column === "claim_id" ? "claimed_at" : column,
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name ===
        "maintainflow_approval_notification_deliveries"
          ? { ...row, can_delete: true }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? {
              ...row,
              insert_columns: approvalRequestInsertColumns.map((column) =>
                column === "source" ? "status" : column,
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name ===
        "maintainflow_approval_notification_deliveries"
          ? { ...row, row_security_enabled: false }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? {
              ...row,
              update_columns: approvalRequestUpdateColumns.filter(
                (column) => column !== "retired_at",
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? { ...row, can_delete: true }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? { ...row, can_update: true }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? { ...row, can_update_any_column: false }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? {
              ...row,
              update_columns: approvalRequestUpdateColumns.map((column) =>
                column === "status" ? "request_payload" : column,
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "ads_approval_records"
          ? { ...row, can_update: true }
          : row,
      ),
      current.map((row) =>
        row.table_name === "ads_approval_records"
          ? {
              ...row,
              update_columns: approvalRecordUpdateColumns.map((column) =>
                column === "status" ? "request_payload" : column,
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_organizations"
          ? { ...row, update_columns: ["name"] }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_change_approval_requests"
          ? { ...row, row_security_enabled: false }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_ads_config_integrity_state"
          ? { ...row, can_update: true }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_ads_config_integrity_state"
          ? {
              ...row,
              update_columns: integrityStateUpdateColumns.filter(
                (column) => column !== "observed_at",
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_ads_config_integrity_state"
          ? {
              ...row,
              update_columns: [
                ...integrityStateUpdateColumns,
                "advertiser_account_id",
              ].sort(),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_ads_config_integrity_events"
          ? { ...row, can_update: true }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_ads_config_integrity_events"
          ? {
              ...row,
              update_columns: integrityEventUpdateColumns.filter(
                (column) => column !== "review_note",
              ),
            }
          : row,
      ),
      current.map((row) =>
        row.table_name === "maintainflow_ads_config_integrity_events"
          ? {
              ...row,
              update_columns: [
                ...integrityEventUpdateColumns,
                "current_configuration",
              ].sort(),
            }
          : row,
      ),
    ];

    for (const privileges of variants) {
      state.getRuntimeDatabase.mockReturnValue(
        databaseWithRuntimeRole(healthyRole(), privileges),
      );
      await expect(verifyRuntimeDatabaseRole()).resolves.toBe(false);
    }
  });

  it("fails closed without a configured or reachable database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await expect(verifyRuntimeDatabaseRole()).resolves.toBe(false);

    vi.stubEnv("DATABASE_URL", "postgres://localhost/maintainflow");
    state.getRuntimeDatabase.mockImplementationOnce(() => {
      throw new Error("offline");
    });
    await expect(verifyRuntimeDatabaseRole()).resolves.toBe(false);
  });
});

describe("runtime database transaction deployment readiness", () => {
  it("proves the injected driver retains one role, backend, and local marker", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const { database, begin, transaction } = databaseWithTransaction();
    const reportFailure = vi.fn();

    await expect(
      verifyRuntimeDatabaseTransaction(database, reportFailure),
    ).resolves.toBe(true);
    expect(begin).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(state.getRuntimeDatabase).not.toHaveBeenCalled();
    expect(reportFailure).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong role", { roleName: "postgres" }, "transaction_role_mismatch"],
    ["changed backend", { confirmedPid: 202 }, "transaction_backend_changed"],
    [
      "missing marker",
      { confirmedMarker: "" },
      "transaction_confirmation_marker_mismatch",
    ],
    ["driver failure", { reject: true }, "transaction_begin_failed"],
  ])("rejects %s", async (_label, options, expectedCode) => {
    const { database } = databaseWithTransaction(options);
    const reportFailure = vi.fn();

    await expect(
      verifyRuntimeDatabaseTransaction(database, reportFailure),
    ).resolves.toBe(false);
    expect(reportFailure).toHaveBeenCalledWith({ code: expectedCode });
  });

  it("fails closed without a configured or injected database", async () => {
    vi.stubEnv("DATABASE_URL", "");

    const reportFailure = vi.fn();
    await expect(
      verifyRuntimeDatabaseTransaction(undefined, reportFailure),
    ).resolves.toBe(false);
    expect(state.getRuntimeDatabase).not.toHaveBeenCalled();
    expect(reportFailure).toHaveBeenCalledWith({
      code: "database_unconfigured",
    });
  });
});
