import "server-only";

import { getRuntimeDatabase } from "./client.server";
import { databaseMigrationManifest } from "./migration-manifest";

type MigrationLedgerRow = {
  migration_name: string;
  checksum_sha256: string;
};

type RuntimeRoleRow = {
  role_name: string;
  session_role_name: string;
  can_login: boolean;
  inherits_roles: boolean;
  is_superuser: boolean;
  can_create_database: boolean;
  can_create_role: boolean;
  can_replicate: boolean;
  bypasses_rls: boolean;
  connection_limit: number;
  member_of_count: number;
  incoming_member_count: number;
  unexpected_incoming_member_count: number;
  owned_public_relation_count: number;
  public_policy_count: number;
  executable_public_function_count: number;
  usable_public_sequence_count: number;
  can_connect_database: boolean;
  can_create_in_database: boolean;
  can_use_public_schema: boolean;
  can_create_in_public_schema: boolean;
};

type RuntimeTablePrivilegeRow = {
  table_name: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
  can_reference: boolean;
  can_trigger: boolean;
  can_maintain: boolean;
  can_select_any_column: boolean;
  can_insert_any_column: boolean;
  can_update_any_column: boolean;
  can_reference_any_column: boolean;
};

const runtimeTablePrivileges = new Map<
  string,
  Readonly<{ select: boolean; insert: boolean; update: boolean; delete: boolean }>
>([
  ["ads_approval_records", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_organizations", { select: true, insert: true, update: false, delete: false }],
  ["maintainflow_organization_memberships", { select: true, insert: true, update: false, delete: false }],
  ["maintainflow_advertiser_accounts", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_account_access", { select: true, insert: true, update: false, delete: false }],
  ["maintainflow_advertiser_credentials", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_creative_review_state", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_creative_review_events", { select: true, insert: true, update: false, delete: false }],
  ["maintainflow_rate_limit_buckets", { select: true, insert: true, update: true, delete: true }],
  ["maintainflow_recommendation_dismissals", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_conversion_credentials", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_readiness_audit_runs", { select: true, insert: true, update: false, delete: false }],
  ["maintainflow_live_workbench_snapshots", { select: true, insert: true, update: true, delete: true }],
  ["maintainflow_customer_lifecycle_records", { select: true, insert: false, update: false, delete: false }],
  ["maintainflow_monitoring_account_schedule", { select: true, insert: true, update: true, delete: false }],
  ["maintainflow_schema_migrations", { select: true, insert: false, update: false, delete: false }],
]);

export type DatabaseMigrationReadiness = {
  ready: boolean;
  appliedCount: number;
  expectedCount: number;
  currentMigration: string | null;
};

export async function verifyRuntimeDatabaseRole(): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return false;

  try {
    const sql = getRuntimeDatabase(connectionString);
    const [role] = await sql<RuntimeRoleRow[]>`
      select role.rolname as role_name,
        session_user as session_role_name,
        role.rolcanlogin as can_login,
        role.rolinherit as inherits_roles,
        role.rolsuper as is_superuser,
        role.rolcreatedb as can_create_database,
        role.rolcreaterole as can_create_role,
        role.rolreplication as can_replicate,
        role.rolbypassrls as bypasses_rls,
        role.rolconnlimit as connection_limit,
        (
          select count(*)::integer
          from pg_catalog.pg_auth_members membership
          where membership.member = role.oid
        ) as member_of_count,
        (
          select count(*)::integer
          from pg_catalog.pg_auth_members membership
          where membership.roleid = role.oid
        ) as incoming_member_count,
        (
          select count(*)::integer
          from pg_catalog.pg_auth_members membership
          join pg_catalog.pg_roles member_role
            on member_role.oid = membership.member
          where membership.roleid = role.oid
            and (
              member_role.rolname <> 'postgres'
              or not membership.admin_option
              or membership.inherit_option
              or membership.set_option
            )
        ) as unexpected_incoming_member_count,
        (
          select count(*)::integer
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace
            on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
            and relation.relowner = role.oid
        ) as owned_public_relation_count,
        (
          select count(*)::integer
          from pg_catalog.pg_policy policy
          join pg_catalog.pg_class relation on relation.oid = policy.polrelid
          join pg_catalog.pg_namespace namespace
            on namespace.oid = relation.relnamespace
          where namespace.nspname = 'public'
        ) as public_policy_count,
        (
          select count(*)::integer
          from pg_catalog.pg_proc procedure
          join pg_catalog.pg_namespace namespace
            on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and has_function_privilege(current_user, procedure.oid, 'EXECUTE')
        ) as executable_public_function_count,
        (
          select count(*)::integer
          from pg_catalog.pg_class sequence
          join pg_catalog.pg_namespace namespace
            on namespace.oid = sequence.relnamespace
          where namespace.nspname = 'public'
            and sequence.relkind = 'S'
            and (
              has_sequence_privilege(current_user, sequence.oid, 'USAGE')
              or has_sequence_privilege(current_user, sequence.oid, 'SELECT')
              or has_sequence_privilege(current_user, sequence.oid, 'UPDATE')
            )
        ) as usable_public_sequence_count,
        has_database_privilege(current_user, current_database(), 'CONNECT')
          as can_connect_database,
        has_database_privilege(current_user, current_database(), 'CREATE')
          as can_create_in_database,
        has_schema_privilege(current_user, 'public', 'USAGE')
          as can_use_public_schema,
        has_schema_privilege(current_user, 'public', 'CREATE')
          as can_create_in_public_schema
      from pg_catalog.pg_roles role
      where role.rolname = current_user
    `;
    if (
      role?.role_name !== "maintainflow_app" ||
      role.session_role_name !== "maintainflow_app" ||
      role.can_login !== true ||
      role.inherits_roles !== false ||
      role.is_superuser !== false ||
      role.can_create_database !== false ||
      role.can_create_role !== false ||
      role.can_replicate !== false ||
      role.bypasses_rls !== true ||
      role.connection_limit !== 10 ||
      role.member_of_count !== 0 ||
      role.incoming_member_count > 1 ||
      role.unexpected_incoming_member_count !== 0 ||
      role.owned_public_relation_count !== 0 ||
      role.public_policy_count !== 0 ||
      role.executable_public_function_count !== 0 ||
      role.usable_public_sequence_count !== 0 ||
      role.can_connect_database !== true ||
      role.can_create_in_database !== false ||
      role.can_use_public_schema !== true ||
      role.can_create_in_public_schema !== false
    ) {
      return false;
    }

    const privileges = await sql<RuntimeTablePrivilegeRow[]>`
      select relation.relname as table_name,
        has_table_privilege(current_user, relation.oid, 'SELECT') as can_select,
        has_table_privilege(current_user, relation.oid, 'INSERT') as can_insert,
        has_table_privilege(current_user, relation.oid, 'UPDATE') as can_update,
        has_table_privilege(current_user, relation.oid, 'DELETE') as can_delete,
        has_table_privilege(current_user, relation.oid, 'TRUNCATE') as can_truncate,
        has_table_privilege(current_user, relation.oid, 'REFERENCES') as can_reference,
        has_table_privilege(current_user, relation.oid, 'TRIGGER') as can_trigger,
        has_table_privilege(current_user, relation.oid, 'MAINTAIN') as can_maintain,
        has_any_column_privilege(current_user, relation.oid, 'SELECT')
          as can_select_any_column,
        has_any_column_privilege(current_user, relation.oid, 'INSERT')
          as can_insert_any_column,
        has_any_column_privilege(current_user, relation.oid, 'UPDATE')
          as can_update_any_column,
        has_any_column_privilege(current_user, relation.oid, 'REFERENCES')
          as can_reference_any_column
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
      order by relation.relname
    `;

    return (
      privileges.length === runtimeTablePrivileges.size &&
      privileges.every((actual) => {
        const expected = runtimeTablePrivileges.get(actual.table_name);
        return (
          expected !== undefined &&
          actual.can_select === expected.select &&
          actual.can_insert === expected.insert &&
          actual.can_update === expected.update &&
          actual.can_delete === expected.delete &&
          actual.can_truncate === false &&
          actual.can_reference === false &&
          actual.can_trigger === false &&
          actual.can_maintain === false &&
          actual.can_select_any_column === expected.select &&
          actual.can_insert_any_column === expected.insert &&
          actual.can_update_any_column === expected.update &&
          actual.can_reference_any_column === false
        );
      })
    );
  } catch {
    return false;
  }
}

export async function verifyDatabaseMigrationLedger(): Promise<DatabaseMigrationReadiness> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    return {
      ready: false,
      appliedCount: 0,
      expectedCount: databaseMigrationManifest.length,
      currentMigration: null,
    };
  }

  try {
    const sql = getRuntimeDatabase(connectionString);
    const [table] = await sql<{ exists: boolean }[]>`
      select to_regclass('public.maintainflow_schema_migrations') is not null as exists
    `;
    if (table?.exists !== true) {
      return {
        ready: false,
        appliedCount: 0,
        expectedCount: databaseMigrationManifest.length,
        currentMigration: null,
      };
    }

    const rows = await sql<MigrationLedgerRow[]>`
      select migration_name, checksum_sha256
      from public.maintainflow_schema_migrations
      order by migration_name
    `;
    const ready =
      rows.length === databaseMigrationManifest.length &&
      rows.every(
        (row, index) =>
          row.migration_name === databaseMigrationManifest[index].name &&
          row.checksum_sha256 ===
            databaseMigrationManifest[index].checksumSha256,
      );

    return {
      ready,
      appliedCount: rows.length,
      expectedCount: databaseMigrationManifest.length,
      currentMigration: rows.at(-1)?.migration_name ?? null,
    };
  } catch {
    return {
      ready: false,
      appliedCount: 0,
      expectedCount: databaseMigrationManifest.length,
      currentMigration: null,
    };
  }
}
