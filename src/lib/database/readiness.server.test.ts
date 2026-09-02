import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ getRuntimeDatabase: vi.fn() }));

vi.mock("./client.server", () => ({
  getRuntimeDatabase: state.getRuntimeDatabase,
}));

import { databaseMigrationManifest } from "./migration-manifest";
import {
  verifyDatabaseMigrationLedger,
  verifyRuntimeDatabaseRole,
} from "./readiness.server";

const runtimeReadableTables = [
  "ads_approval_records",
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
  "maintainflow_customer_lifecycle_records",
  "maintainflow_monitoring_account_schedule",
  "maintainflow_schema_migrations",
];
const runtimeInsertableTables = new Set(
  runtimeReadableTables.filter(
    (table) =>
      !new Set([
        "maintainflow_customer_lifecycle_records",
        "maintainflow_schema_migrations",
      ]).has(table),
  ),
);
const runtimeUpdatableTables = new Set([
  "ads_approval_records",
  "maintainflow_advertiser_accounts",
  "maintainflow_advertiser_credentials",
  "maintainflow_creative_review_state",
  "maintainflow_rate_limit_buckets",
  "maintainflow_recommendation_dismissals",
  "maintainflow_conversion_credentials",
  "maintainflow_live_workbench_snapshots",
  "maintainflow_monitoring_account_schedule",
]);
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
    public_policy_count: 0,
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
  return runtimeReadableTables.map((table_name) => ({
    table_name,
    can_select: true,
    can_insert: runtimeInsertableTables.has(table_name),
    can_update: runtimeUpdatableTables.has(table_name),
    can_delete: runtimeDeletableTables.has(table_name),
    can_truncate: false,
    can_reference: false,
    can_trigger: false,
    can_maintain: false,
    can_select_any_column: true,
    can_insert_any_column: runtimeInsertableTables.has(table_name),
    can_update_any_column: runtimeUpdatableTables.has(table_name),
    can_reference_any_column: false,
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
    ["unexpected policy", { public_policy_count: 1 }],
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

  it("rejects missing, extra, or elevated table privileges", async () => {
    const current = healthyPrivileges();
    const variants = [
      current.slice(0, -1),
      [
        ...current,
        {
          ...current[0],
          table_name: "unexpected_public_table",
        },
      ],
      current.map((row, index) =>
        index === 0 ? { ...row, can_delete: true } : row,
      ),
      current.map((row, index) =>
        index === 1 ? { ...row, can_update_any_column: true } : row,
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
