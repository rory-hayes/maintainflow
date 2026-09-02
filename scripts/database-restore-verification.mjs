import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  canonicalJson,
  databaseTargetIdentity,
  EVIDENCE_SCHEMA_VERSION,
  FULL_GIT_SHA_PATTERN,
  RECOVERY_EVIDENCE_MAX_AGE_MS,
  readEvidenceManifest,
  RestoreVerificationError,
  SHA256_PATTERN,
  sha256,
  withManifestChecksum,
  writeEvidenceManifest,
} from "./database-restore-evidence-common.mjs";
import { loadMigrations } from "./run-database-migrations.mjs";
import { hostedDatabaseTlsOptions } from "./database-tls.mjs";

export {
  databaseTargetIdentity,
  EVIDENCE_SCHEMA_VERSION,
  RestoreVerificationError,
  sha256,
  writeEvidenceManifest,
};
export const SOURCE_DATABASE_URL_KEY =
  "MAINTAINFLOW_BACKUP_SOURCE_DATABASE_URL";
export const RESTORE_DATABASE_URL_KEY =
  "MAINTAINFLOW_RESTORE_DATABASE_URL";
export const SOURCE_DATABASE_CA_CERT_KEY =
  "MAINTAINFLOW_BACKUP_SOURCE_DATABASE_CA_CERT";
export const RESTORE_DATABASE_CA_CERT_KEY =
  "MAINTAINFLOW_RESTORE_DATABASE_CA_CERT";
export const SOURCE_TARGET_REFERENCE_KEY =
  "MAINTAINFLOW_BACKUP_SOURCE_TARGET_REFERENCE";
export const RESTORE_TARGET_REFERENCE_KEY =
  "MAINTAINFLOW_RESTORE_TARGET_REFERENCE";
export const SOURCE_IDENTITY_KEY =
  "MAINTAINFLOW_BACKUP_SOURCE_IDENTITY_SHA256";
export const RESTORE_IDENTITY_KEY =
  "MAINTAINFLOW_RESTORE_TARGET_IDENTITY_SHA256";
export const PRODUCTION_IDENTITY_KEY =
  "MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256";
export const PRE_BACKUP_EVIDENCE_PATH_KEY =
  "MAINTAINFLOW_PRE_BACKUP_EVIDENCE_PATH";
export const RESTORE_EVIDENCE_PATH_KEY =
  "MAINTAINFLOW_RESTORE_VERIFICATION_EVIDENCE_PATH";
export { RECOVERY_EVIDENCE_MAX_AGE_MS };

export const CAPTURE_BASELINE_TABLES = Object.freeze([
  "ads_approval_records",
  "maintainflow_account_access",
  "maintainflow_advertiser_accounts",
  "maintainflow_advertiser_credentials",
  "maintainflow_conversion_credentials",
  "maintainflow_creative_review_events",
  "maintainflow_creative_review_state",
  "maintainflow_customer_lifecycle_records",
  "maintainflow_live_workbench_snapshots",
  "maintainflow_monitoring_account_schedule",
  "maintainflow_organization_memberships",
  "maintainflow_organizations",
  "maintainflow_rate_limit_buckets",
  "maintainflow_readiness_audit_runs",
  "maintainflow_recommendation_dismissals",
  "maintainflow_schema_migrations",
]);

// Additive migrations may append new application tables here without changing
// the last production schema accepted by the pre-backup capture.
export const APPLICATION_TABLES = Object.freeze([
  ...CAPTURE_BASELINE_TABLES,
]);

// These are customer and audit records whose exact restored cardinality is a
// useful recovery signal. The rate-limit table is intentionally excluded: it
// is disposable operational state and may be cleared during incident response.
export const CRITICAL_COUNT_TABLES = Object.freeze(
  APPLICATION_TABLES.filter(
    (table) =>
      table !== "maintainflow_rate_limit_buckets" &&
      table !== "maintainflow_schema_migrations",
  ),
);

const MAX_CRITICAL_COUNT = 1_000_000_000_000;
const READ_ONLY_TRANSACTION_OPTIONS =
  "isolation level repeatable read read only";
const FIXED_SEARCH_PATH = "pg_catalog, public";
const FIXED_STATEMENT_TIMEOUT = "30s";
const FIXED_LOCK_TIMEOUT = "5s";
const FIXED_IDLE_TRANSACTION_TIMEOUT = "45s";
const SAFE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const SCHEMA_TABLES_SQL = `
  /* maintainflow:restore:schema-tables */
  select relation.relname as table_name, relation.relkind as relation_kind
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and (
      relation.relname = 'ads_approval_records'
      or relation.relname like 'maintainflow\\_%' escape '\\'
    )
  order by relation.relname
`;

const SCHEMA_COLUMNS_SQL = `
  /* maintainflow:restore:schema-columns */
  select relation.relname as table_name,
    attribute.attnum as ordinal_position,
    attribute.attname as column_name,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as data_type,
    attribute.attnotnull as not_null,
    coalesce(
      pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid),
      ''
    ) as default_expression,
    attribute.attidentity as identity_kind,
    attribute.attgenerated as generated_kind
  from pg_catalog.pg_attribute attribute
  join pg_catalog.pg_class relation on relation.oid = attribute.attrelid
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  left join pg_catalog.pg_attrdef default_value
    on default_value.adrelid = attribute.attrelid
    and default_value.adnum = attribute.attnum
  where namespace.nspname = 'public'
    and relation.relkind in ('r', 'p')
    and attribute.attnum > 0
    and not attribute.attisdropped
    and (
      relation.relname = 'ads_approval_records'
      or relation.relname like 'maintainflow\\_%' escape '\\'
    )
  order by relation.relname, attribute.attnum
`;

const SCHEMA_CONSTRAINTS_SQL = `
  /* maintainflow:restore:schema-constraints */
  select relation.relname as table_name,
    constraint_record.conname as constraint_name,
    constraint_record.contype as constraint_type,
    constraint_record.condeferrable as deferrable,
    constraint_record.condeferred as initially_deferred,
    constraint_record.convalidated as validated,
    pg_catalog.pg_get_constraintdef(constraint_record.oid, true)
      as definition
  from pg_catalog.pg_constraint constraint_record
  join pg_catalog.pg_class relation
    on relation.oid = constraint_record.conrelid
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and (
      relation.relname = 'ads_approval_records'
      or relation.relname like 'maintainflow\\_%' escape '\\'
    )
  order by relation.relname, constraint_record.conname
`;

const SCHEMA_INDEXES_SQL = `
  /* maintainflow:restore:schema-indexes */
  select relation.relname as table_name,
    index_relation.relname as index_name,
    index_record.indisunique as is_unique,
    index_record.indisprimary as is_primary,
    index_record.indisvalid as is_valid,
    index_record.indisready as is_ready,
    pg_catalog.pg_get_indexdef(index_record.indexrelid) as definition
  from pg_catalog.pg_index index_record
  join pg_catalog.pg_class relation
    on relation.oid = index_record.indrelid
  join pg_catalog.pg_class index_relation
    on index_relation.oid = index_record.indexrelid
  join pg_catalog.pg_namespace namespace
    on namespace.oid = relation.relnamespace
  where namespace.nspname = 'public'
    and (
      relation.relname = 'ads_approval_records'
      or relation.relname like 'maintainflow\\_%' escape '\\'
    )
  order by relation.relname, index_relation.relname
`;

const INVARIANTS_SQL = `
  /* maintainflow:restore:isolation-invariants */
  select
    (
      select count(*)
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and (
          relation.relname = 'ads_approval_records'
          or relation.relname like 'maintainflow\\_%' escape '\\'
        )
        and pg_catalog.has_table_privilege(
          current_user,
          relation.oid,
          'INSERT,UPDATE,DELETE,TRUNCATE'
        )
    )::text as writable_table_privileges,
    (
      select count(*)
      from public.maintainflow_advertiser_accounts account
      left join public.maintainflow_organizations organization
        on organization.id = account.owner_organization_id
      where account.owner_organization_id is not null
        and (
          organization.id is null
          or organization.customer_type <> 'advertiser'
        )
    )::text as invalid_owner_organizations,
    (
      select count(*)
      from public.maintainflow_advertiser_accounts account
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = account.id
        and account_access.organization_id = account.owner_organization_id
        and account_access.role = 'owner'
      where account.owner_organization_id is not null
        and account_access.organization_id is null
    )::text as missing_owner_access,
    (
      select count(*)
      from public.ads_approval_records approval
      left join public.maintainflow_advertiser_accounts account
        on account.external_account_id = approval.account_id
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = account.id
        and account_access.organization_id = approval.acting_organization_id
      where approval.acting_organization_id is not null
        and account_access.organization_id is null
    )::text as orphan_approval_actor_access,
    (
      select count(*)
      from public.ads_approval_records approval
      left join public.maintainflow_advertiser_accounts account
        on account.external_account_id = approval.account_id
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = account.id
        and account_access.organization_id = approval.rollback_organization_id
      where approval.rollback_organization_id is not null
        and account_access.organization_id is null
    )::text as orphan_approval_rollback_access,
    (
      select count(*)
      from public.ads_approval_records approval
      left join public.maintainflow_advertiser_accounts account
        on account.external_account_id = approval.account_id
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = account.id
        and account_access.organization_id = approval.reconciled_organization_id
      where approval.reconciled_organization_id is not null
        and account_access.organization_id is null
    )::text as orphan_approval_reconciliation_access,
    (
      select count(*)
      from public.maintainflow_recommendation_dismissals dismissal
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = dismissal.advertiser_account_id
        and account_access.organization_id = dismissal.acting_organization_id
      where account_access.organization_id is null
    )::text as orphan_dismissal_actor_access,
    (
      select count(*)
      from public.maintainflow_recommendation_dismissals dismissal
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = dismissal.advertiser_account_id
        and account_access.organization_id = dismissal.restored_organization_id
      where dismissal.restored_organization_id is not null
        and account_access.organization_id is null
    )::text as orphan_dismissal_restore_access,
    (
      select count(*)
      from public.maintainflow_conversion_credentials credential
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = credential.advertiser_account_id
        and account_access.organization_id = credential.acting_organization_id
      where account_access.organization_id is null
    )::text as orphan_conversion_credential_access,
    (
      select count(*)
      from public.maintainflow_readiness_audit_runs audit_run
      left join public.maintainflow_account_access account_access
        on account_access.advertiser_account_id = audit_run.advertiser_account_id
        and account_access.organization_id = audit_run.acting_organization_id
      where account_access.organization_id is null
    )::text as orphan_readiness_audit_access
`;

function requiredString(env, key) {
  const value = env[key]?.trim();
  if (!value) {
    throw new RestoreVerificationError(`${key} is required.`);
  }
  return value;
}

function requiredSha256(env, key) {
  const value = requiredString(env, key).toLowerCase();
  if (!SHA256_PATTERN.test(value)) {
    throw new RestoreVerificationError(
      `${key} must be an exact lowercase SHA-256 value.`,
    );
  }
  return value;
}

function requiredFullGitSha(env) {
  const value = requiredString(env, "MAINTAINFLOW_BUILD_SHA").toLowerCase();
  if (!FULL_GIT_SHA_PATTERN.test(value)) {
    throw new RestoreVerificationError(
      "MAINTAINFLOW_BUILD_SHA must be a full 40- or 64-character Git SHA.",
    );
  }
  return value;
}

function requiredUuid(env, key) {
  const value = requiredString(env, key).toLowerCase();
  if (!UUID_PATTERN.test(value)) {
    throw new RestoreVerificationError(`${key} must be a UUID.`);
  }
  return value;
}

function requiredSlug(env, key) {
  const value = requiredString(env, key).toLowerCase();
  if (!SAFE_SLUG_PATTERN.test(value)) {
    throw new RestoreVerificationError(
      `${key} must be a lowercase operational slug.`,
    );
  }
  return value;
}

function requiredReferenceHash(env, key) {
  const value = requiredString(env, key);
  if (value.length < 8 || value.length > 256 || /[\r\n]/.test(value)) {
    throw new RestoreVerificationError(
      `${key} must be an 8- to 256-character single-line reference.`,
    );
  }
  return sha256(value);
}

function requiredInstant(env, key) {
  const value = requiredString(env, key);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new RestoreVerificationError(
      `${key} must be an exact UTC ISO-8601 instant.`,
    );
  }
  return value;
}

function requiredAbsolutePath(env, key) {
  const value = requiredString(env, key);
  if (!path.isAbsolute(value)) {
    throw new RestoreVerificationError(`${key} must be an absolute path.`);
  }
  return path.normalize(value);
}

function requiredDurationSeconds(env) {
  const value = requiredString(env, "MAINTAINFLOW_RESTORE_DURATION_SECONDS");
  if (!/^(?:0|[1-9][0-9]{0,5})$/.test(value)) {
    throw new RestoreVerificationError(
      "MAINTAINFLOW_RESTORE_DURATION_SECONDS must be an integer from 0 through 86400.",
    );
  }
  const duration = Number(value);
  if (duration > 86_400) {
    throw new RestoreVerificationError(
      "MAINTAINFLOW_RESTORE_DURATION_SECONDS must be an integer from 0 through 86400.",
    );
  }
  return duration;
}

function validateExpectedIdentity(env, key, actualIdentity) {
  const expectedIdentity = requiredSha256(env, key);
  if (expectedIdentity !== actualIdentity) {
    throw new RestoreVerificationError(
      `${key} does not identify the configured database target.`,
    );
  }
  return expectedIdentity;
}

export function validateCaptureEnvironment(env) {
  const databaseUrl = requiredString(env, SOURCE_DATABASE_URL_KEY);
  const target = databaseTargetIdentity(
    databaseUrl,
    requiredString(env, SOURCE_TARGET_REFERENCE_KEY),
  );
  const sourceIdentity = validateExpectedIdentity(
    env,
    SOURCE_IDENTITY_KEY,
    target.identitySha256,
  );
  const productionIdentity = requiredSha256(env, PRODUCTION_IDENTITY_KEY);
  if (sourceIdentity !== productionIdentity) {
    throw new RestoreVerificationError(
      "The pre-backup source must exactly match the declared production database identity.",
    );
  }
  return {
    databaseUrl,
    expectedDatabaseName: target.databaseName,
    sourceIdentity,
    sourceEndpointIdentity: target.endpointIdentitySha256,
    sourceTargetReferenceSha256: target.referenceSha256,
    productionIdentity,
    buildSha: requiredFullGitSha(env),
    recoveryRunId: requiredUuid(env, "MAINTAINFLOW_RECOVERY_RUN_ID"),
    operatorReferenceSha256: requiredReferenceHash(
      env,
      "MAINTAINFLOW_RECOVERY_OPERATOR_REFERENCE",
    ),
    plannedBackupReferenceSha256: requiredReferenceHash(
      env,
      "MAINTAINFLOW_BACKUP_REFERENCE",
    ),
    evidencePath: requiredAbsolutePath(env, PRE_BACKUP_EVIDENCE_PATH_KEY),
  };
}

export function validateVerifyEnvironment(env, preBackupManifest) {
  const databaseUrl = requiredString(env, RESTORE_DATABASE_URL_KEY);
  const target = databaseTargetIdentity(
    databaseUrl,
    requiredString(env, RESTORE_TARGET_REFERENCE_KEY),
  );
  const restoreIdentity = validateExpectedIdentity(
    env,
    RESTORE_IDENTITY_KEY,
    target.identitySha256,
  );
  const productionIdentity = requiredSha256(env, PRODUCTION_IDENTITY_KEY);
  if (
    restoreIdentity === productionIdentity ||
    restoreIdentity === preBackupManifest.sourceTargetIdentitySha256 ||
    target.endpointIdentitySha256 ===
      preBackupManifest.sourceTargetEndpointIdentitySha256
  ) {
    throw new RestoreVerificationError(
      "The restore target must not be the source or declared production database.",
    );
  }

  const buildSha = requiredFullGitSha(env);
  const recoveryRunId = requiredUuid(env, "MAINTAINFLOW_RECOVERY_RUN_ID");
  const operatorReferenceSha256 = requiredReferenceHash(
    env,
    "MAINTAINFLOW_RECOVERY_OPERATOR_REFERENCE",
  );
  const backupReferenceSha256 = requiredReferenceHash(
    env,
    "MAINTAINFLOW_BACKUP_REFERENCE",
  );
  if (
    buildSha !== preBackupManifest.buildSha ||
    recoveryRunId !== preBackupManifest.recoveryRunId ||
    operatorReferenceSha256 !==
      preBackupManifest.operatorReferenceSha256 ||
    backupReferenceSha256 !==
      preBackupManifest.plannedBackupReferenceSha256 ||
    productionIdentity !== preBackupManifest.sourceTargetIdentitySha256
  ) {
    throw new RestoreVerificationError(
      "Restore metadata does not match the sealed pre-backup evidence.",
    );
  }

  const backupCreatedAt = requiredInstant(
    env,
    "MAINTAINFLOW_BACKUP_CREATED_AT",
  );
  const backupRecoveryPointAt = requiredInstant(
    env,
    "MAINTAINFLOW_BACKUP_RECOVERY_POINT_AT",
  );
  const restoreCompletedAt = requiredInstant(
    env,
    "MAINTAINFLOW_RESTORE_COMPLETED_AT",
  );
  const rollbackDecisionAt = requiredInstant(
    env,
    "MAINTAINFLOW_ROLLBACK_DECISION_AT",
  );
  const preCapturedAt = new Date(preBackupManifest.generatedAt).valueOf();
  const backupCreated = new Date(backupCreatedAt).valueOf();
  const recoveryPoint = new Date(backupRecoveryPointAt).valueOf();
  const restoreCompleted = new Date(restoreCompletedAt).valueOf();
  const rollbackDecision = new Date(rollbackDecisionAt).valueOf();
  if (
    recoveryPoint < preCapturedAt ||
    backupCreated < recoveryPoint ||
    restoreCompleted < backupCreated ||
    rollbackDecision < restoreCompleted
  ) {
    throw new RestoreVerificationError(
      "Backup, recovery-point, restore, and rollback-decision timestamps are out of order.",
    );
  }

  const preBackupEvidencePath = requiredAbsolutePath(
    env,
    PRE_BACKUP_EVIDENCE_PATH_KEY,
  );
  const restoreEvidencePath = requiredAbsolutePath(
    env,
    RESTORE_EVIDENCE_PATH_KEY,
  );
  if (preBackupEvidencePath === restoreEvidencePath) {
    throw new RestoreVerificationError(
      "Pre-backup and restore evidence paths must be different.",
    );
  }

  return {
    databaseUrl,
    expectedDatabaseName: target.databaseName,
    restoreIdentity,
    restoreEndpointIdentity: target.endpointIdentitySha256,
    restoreTargetReferenceSha256: target.referenceSha256,
    productionIdentity,
    buildSha,
    recoveryRunId,
    operatorReferenceSha256,
    preBackupEvidencePath,
    restoreEvidencePath,
    backup: {
      provider: requiredSlug(env, "MAINTAINFLOW_BACKUP_PROVIDER"),
      backupType: requiredSlug(env, "MAINTAINFLOW_BACKUP_TYPE"),
      referenceSha256: backupReferenceSha256,
      createdAt: backupCreatedAt,
      recoveryPointAt: backupRecoveryPointAt,
    },
    restore: {
      referenceSha256: requiredReferenceHash(
        env,
        "MAINTAINFLOW_RESTORE_REFERENCE",
      ),
      completedAt: restoreCompletedAt,
      durationSeconds: requiredDurationSeconds(env),
    },
    rollbackDecisionAt,
  };
}

function parseBoundedCount(value, label) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new RestoreVerificationError(
      `Database evidence returned an invalid ${label} aggregate.`,
    );
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count > MAX_CRITICAL_COUNT) {
    throw new RestoreVerificationError(
      `Database evidence exceeded the bounded ${label} aggregate limit.`,
    );
  }
  return count;
}

function normalizeRows(rows) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "bigint" ? value.toString() : value,
      ]),
    ),
  );
}

function validateTableNames(tableRows, ledgerMode) {
  const names = tableRows.map((row) => row.table_name);
  const allowed = new Set(APPLICATION_TABLES);
  const required =
    ledgerMode === "prefix" ? CAPTURE_BASELINE_TABLES : APPLICATION_TABLES;
  if (
    new Set(names).size !== names.length ||
    names.some((name) => !allowed.has(name)) ||
    required.some((name) => !names.includes(name)) ||
    (ledgerMode === "full" && names.length !== APPLICATION_TABLES.length)
  ) {
    throw new RestoreVerificationError(
      "The public MaintainFlow table set does not match the expected migration stage.",
    );
  }
  return names;
}

export function migrationEntries(migrations) {
  return migrations.map((migration) => ({
    migration_name: migration.name,
    checksum_sha256: migration.checksumSha256,
  }));
}

function validateMigrationLedger(ledgerRows, migrations, ledgerMode) {
  const localEntries = migrationEntries(migrations);
  const expectedApplied = localEntries.slice(0, ledgerRows.length);
  if (
    ledgerRows.length > localEntries.length ||
    ledgerRows.length === 0 ||
    canonicalJson(ledgerRows) !== canonicalJson(expectedApplied) ||
    (ledgerMode === "full" && ledgerRows.length !== localEntries.length)
  ) {
    throw new RestoreVerificationError(
      ledgerMode === "prefix"
        ? "The source migration ledger is not an exact checksum-valid local prefix."
        : "The restored migration ledger does not exactly match the full checkout.",
    );
  }
  return {
    mode: ledgerMode,
    appliedEntryCount: expectedApplied.length,
    localEntryCount: localEntries.length,
    appliedEntries: expectedApplied,
    appliedSha256: sha256(canonicalJson(expectedApplied)),
    localManifestSha256: sha256(canonicalJson(localEntries)),
  };
}

export async function collectDatabaseEvidence(
  transaction,
  { expectedDatabaseName, migrations, ledgerMode = "full" },
) {
  if (!new Set(["prefix", "full"]).has(ledgerMode)) {
    throw new RestoreVerificationError("Database ledger mode is invalid.");
  }
  await transaction.unsafe(`set local search_path = ${FIXED_SEARCH_PATH}`);
  await transaction.unsafe(
    `set local statement_timeout = '${FIXED_STATEMENT_TIMEOUT}'`,
  );
  await transaction.unsafe(`set local lock_timeout = '${FIXED_LOCK_TIMEOUT}'`);
  await transaction.unsafe(
    `set local idle_in_transaction_session_timeout = '${FIXED_IDLE_TRANSACTION_TIMEOUT}'`,
  );

  const [metadata] = await transaction.unsafe(`
    /* maintainflow:restore:metadata */
    select pg_catalog.current_database() as database_name,
      pg_catalog.current_setting('server_version_num') as server_version_num,
      pg_catalog.current_setting('transaction_read_only') as transaction_read_only,
      pg_catalog.current_setting('search_path') as search_path,
      pg_catalog.current_setting('statement_timeout') as statement_timeout,
      pg_catalog.current_setting('lock_timeout') as lock_timeout,
      pg_catalog.current_setting('idle_in_transaction_session_timeout')
        as idle_in_transaction_session_timeout
  `);
  if (
    metadata?.database_name !== expectedDatabaseName ||
    metadata?.transaction_read_only !== "on" ||
    metadata?.search_path !== FIXED_SEARCH_PATH ||
    metadata?.statement_timeout !== FIXED_STATEMENT_TIMEOUT ||
    metadata?.lock_timeout !== FIXED_LOCK_TIMEOUT ||
    metadata?.idle_in_transaction_session_timeout !==
      FIXED_IDLE_TRANSACTION_TIMEOUT ||
    !/^[0-9]{5,6}$/.test(metadata?.server_version_num ?? "")
  ) {
    throw new RestoreVerificationError(
      "The database did not confirm the exact target and read-only session contract.",
    );
  }

  const ledgerRows = normalizeRows(
    await transaction.unsafe(`
      /* maintainflow:restore:migration-ledger */
      select migration_name, checksum_sha256
      from public.maintainflow_schema_migrations
      order by migration_name
    `),
  );
  const migrationLedger = validateMigrationLedger(
    ledgerRows,
    migrations,
    ledgerMode,
  );

  const tableRows = normalizeRows(
    await transaction.unsafe(SCHEMA_TABLES_SQL),
  );
  const tableNames = validateTableNames(tableRows, ledgerMode);
  const columnRows = normalizeRows(
    await transaction.unsafe(SCHEMA_COLUMNS_SQL),
  );
  const constraintRows = normalizeRows(
    await transaction.unsafe(SCHEMA_CONSTRAINTS_SQL),
  );
  const indexRows = normalizeRows(
    await transaction.unsafe(SCHEMA_INDEXES_SQL),
  );
  if (
    columnRows.length === 0 ||
    constraintRows.length === 0 ||
    indexRows.length === 0
  ) {
    throw new RestoreVerificationError(
      "The database schema evidence is incomplete.",
    );
  }
  const schemaDescriptor = {
    tables: tableRows,
    columns: columnRows,
    constraints: constraintRows,
    indexes: indexRows,
  };

  const criticalCounts = {};
  for (const table of CRITICAL_COUNT_TABLES) {
    if (!tableNames.includes(table)) continue;
    const [row] = await transaction.unsafe(`
      /* maintainflow:restore:critical-count:${table} */
      select count(*)::text as row_count from public.${table}
    `);
    criticalCounts[table] = parseBoundedCount(row?.row_count, table);
  }

  const [invariantRow] = await transaction.unsafe(INVARIANTS_SQL);
  const invariants = Object.fromEntries(
    Object.entries(invariantRow ?? {}).map(([name, value]) => [
      name,
      parseBoundedCount(value, name),
    ]),
  );
  if (
    Object.keys(invariants).length === 0 ||
    Object.values(invariants).some((count) => count !== 0)
  ) {
    throw new RestoreVerificationError(
      "Database isolation, orphan, or read-only-role invariants failed.",
    );
  }

  return {
    target: {
      databaseNameSha256: sha256(metadata.database_name),
      serverVersionNum: metadata.server_version_num,
      transactionReadOnly: true,
      searchPathSha256: sha256(metadata.search_path),
      statementTimeout: metadata.statement_timeout,
      lockTimeout: metadata.lock_timeout,
      idleInTransactionTimeout:
        metadata.idle_in_transaction_session_timeout,
    },
    migrationLedger,
    schema: {
      tableCount: tableRows.length,
      columnCount: columnRows.length,
      constraintCount: constraintRows.length,
      indexCount: indexRows.length,
      sha256: sha256(canonicalJson(schemaDescriptor)),
    },
    criticalCounts,
    invariants,
  };
}

export async function inspectDatabase(
  databaseUrl,
  expectedDatabaseName,
  {
    connect = postgres,
    certificateKey = "MAINTAINFLOW_DATABASE_CA_CERT",
    environment = process.env,
    migrations = undefined,
    ledgerMode = "full",
  } = {},
) {
  const loadedMigrations = migrations ?? (await loadMigrations());
  const sql = connect(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
    prepare: false,
    ...hostedDatabaseTlsOptions({
      hosted: true,
      certificateKey,
      environment,
      createError: (message) => new RestoreVerificationError(message),
    }),
  });
  try {
    return await sql.begin(READ_ONLY_TRANSACTION_OPTIONS, (transaction) =>
      collectDatabaseEvidence(transaction, {
        expectedDatabaseName,
        migrations: loadedMigrations,
        ledgerMode,
      }),
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

function validatePreBackupManifest(manifest) {
  const generatedAt = new Date(manifest?.generatedAt ?? "");
  if (
    manifest.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    manifest.kind !== "maintainflow.database.pre_backup" ||
    !FULL_GIT_SHA_PATTERN.test(manifest.buildSha ?? "") ||
    !UUID_PATTERN.test(manifest.recoveryRunId ?? "") ||
    !SHA256_PATTERN.test(manifest.operatorReferenceSha256 ?? "") ||
    !SHA256_PATTERN.test(manifest.sourceTargetIdentitySha256 ?? "") ||
    !SHA256_PATTERN.test(
      manifest.sourceTargetEndpointIdentitySha256 ?? "",
    ) ||
    !SHA256_PATTERN.test(manifest.sourceTargetReferenceSha256 ?? "") ||
    !SHA256_PATTERN.test(manifest.plannedBackupReferenceSha256 ?? "") ||
    !Number.isFinite(generatedAt.valueOf()) ||
    generatedAt.toISOString() !== manifest.generatedAt ||
    typeof manifest.evidence !== "object" ||
    manifest.evidence === null
  ) {
    throw new RestoreVerificationError(
      "The pre-backup evidence manifest has an unsupported shape.",
    );
  }
  return manifest;
}

export async function readPreBackupManifest(filePath) {
  const parsed = await readEvidenceManifest(filePath, "pre-backup evidence");
  return validatePreBackupManifest(parsed);
}

export async function readRestoreVerificationManifest(filePath) {
  const manifest = await readEvidenceManifest(
    filePath,
    "restore-verification evidence",
  );
  const generatedAt = new Date(manifest?.generatedAt ?? "");
  if (
    manifest.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    manifest.kind !== "maintainflow.database.restore_verification" ||
    manifest.result !== "passed" ||
    !FULL_GIT_SHA_PATTERN.test(manifest.buildSha ?? "") ||
    !SHA256_PATTERN.test(manifest.sourceTargetIdentitySha256 ?? "") ||
    !SHA256_PATTERN.test(
      manifest.sourceTargetEndpointIdentitySha256 ?? "",
    ) ||
    !SHA256_PATTERN.test(manifest.sourceTargetReferenceSha256 ?? "") ||
    !SHA256_PATTERN.test(manifest.restoreTargetIdentitySha256 ?? "") ||
    !SHA256_PATTERN.test(
      manifest.restoreTargetEndpointIdentitySha256 ?? "",
    ) ||
    !SHA256_PATTERN.test(manifest.restoreTargetReferenceSha256 ?? "") ||
    manifest.sourceTargetIdentitySha256 ===
      manifest.restoreTargetIdentitySha256 ||
    manifest.sourceTargetEndpointIdentitySha256 ===
      manifest.restoreTargetEndpointIdentitySha256 ||
    !exactManifestInstant(manifest.preBackupCapturedAt) ||
    !Number.isFinite(generatedAt.valueOf()) ||
    generatedAt.toISOString() !== manifest.generatedAt ||
    manifest.before?.migrationLedger?.mode !== "prefix" ||
    manifest.after?.migrationLedger?.mode !== "full" ||
    typeof manifest.before?.schema !== "object" ||
    typeof manifest.after?.schema !== "object"
  ) {
    throw new RestoreVerificationError(
      "The restore-verification evidence manifest has an unsupported shape.",
    );
  }
  return manifest;
}

function exactManifestInstant(value) {
  const instant = new Date(value ?? "");
  return (
    Number.isFinite(instant.valueOf()) && instant.toISOString() === value
  );
}

function assertCurrentRecoveryInstant(value, now, label) {
  const instant = new Date(value ?? "");
  const age = now.valueOf() - instant.valueOf();
  if (
    !Number.isFinite(instant.valueOf()) ||
    instant.toISOString() !== value ||
    age < 0 ||
    age > RECOVERY_EVIDENCE_MAX_AGE_MS
  ) {
    throw new RestoreVerificationError(
      `${label} must be no more than 24 hours old and cannot be from the future.`,
    );
  }
}

export function compareRestoredEvidence(preBackupEvidence, restoredEvidence) {
  if (
    preBackupEvidence.migrationLedger?.mode !== "prefix" ||
    restoredEvidence.migrationLedger?.mode !== "full" ||
    preBackupEvidence.migrationLedger?.localManifestSha256 !==
      restoredEvidence.migrationLedger?.localManifestSha256
  ) {
    throw new RestoreVerificationError(
      "Before/after migration evidence does not describe the same full local migration manifest.",
    );
  }
  for (const [table, sourceCount] of Object.entries(
    preBackupEvidence.criticalCounts ?? {},
  )) {
    if (restoredEvidence.criticalCounts?.[table] !== sourceCount) {
      throw new RestoreVerificationError(
        "Restored critical aggregate evidence does not preserve the pre-backup source.",
      );
    }
  }
  if (
    Object.values(preBackupEvidence.invariants ?? {}).some(
      (count) => count !== 0,
    ) ||
    Object.values(restoredEvidence.invariants ?? {}).some(
      (count) => count !== 0,
    )
  ) {
    throw new RestoreVerificationError(
      "Restored database isolation or orphan invariants failed.",
    );
  }
  return true;
}

export async function capturePreBackupEvidence({
  env = process.env,
  connect = postgres,
  migrations = undefined,
  now = new Date(),
} = {}) {
  const config = validateCaptureEnvironment(env);
  const evidence = await inspectDatabase(
    config.databaseUrl,
    config.expectedDatabaseName,
    {
      connect,
      certificateKey: SOURCE_DATABASE_CA_CERT_KEY,
      environment: env,
      migrations,
      ledgerMode: "prefix",
    },
  );
  const manifest = withManifestChecksum({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "maintainflow.database.pre_backup",
    generatedAt: now.toISOString(),
    recoveryRunId: config.recoveryRunId,
    buildSha: config.buildSha,
    operatorReferenceSha256: config.operatorReferenceSha256,
    sourceTargetIdentitySha256: config.sourceIdentity,
    sourceTargetEndpointIdentitySha256: config.sourceEndpointIdentity,
    sourceTargetReferenceSha256: config.sourceTargetReferenceSha256,
    plannedBackupReferenceSha256:
      config.plannedBackupReferenceSha256,
    evidence,
  });
  await writeEvidenceManifest(config.evidencePath, manifest);
  return manifest;
}

export async function verifyRestoredBackup({
  env = process.env,
  connect = postgres,
  migrations = undefined,
  now = new Date(),
} = {}) {
  const preBackupEvidencePath = requiredAbsolutePath(
    env,
    PRE_BACKUP_EVIDENCE_PATH_KEY,
  );
  const preBackupManifest = await readPreBackupManifest(
    preBackupEvidencePath,
  );
  const config = validateVerifyEnvironment(env, preBackupManifest);
  const nowValue = now.valueOf();
  assertCurrentRecoveryInstant(
    preBackupManifest.generatedAt,
    now,
    "Pre-backup capture evidence",
  );
  assertCurrentRecoveryInstant(
    config.backup.recoveryPointAt,
    now,
    "Backup recovery-point evidence",
  );
  if (
    new Date(config.restore.completedAt).valueOf() > nowValue ||
    new Date(config.rollbackDecisionAt).valueOf() > nowValue
  ) {
    throw new RestoreVerificationError(
      "Restore metadata cannot contain future completion or decision evidence.",
    );
  }
  const restoredEvidence = await inspectDatabase(
    config.databaseUrl,
    config.expectedDatabaseName,
    {
      connect,
      certificateKey: RESTORE_DATABASE_CA_CERT_KEY,
      environment: env,
      migrations,
      ledgerMode: "full",
    },
  );
  compareRestoredEvidence(preBackupManifest.evidence, restoredEvidence);
  const manifest = withManifestChecksum({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: "maintainflow.database.restore_verification",
    generatedAt: now.toISOString(),
    recoveryRunId: config.recoveryRunId,
    buildSha: config.buildSha,
    operatorReferenceSha256: config.operatorReferenceSha256,
    preBackupCapturedAt: preBackupManifest.generatedAt,
    sourceTargetIdentitySha256:
      preBackupManifest.sourceTargetIdentitySha256,
    sourceTargetEndpointIdentitySha256:
      preBackupManifest.sourceTargetEndpointIdentitySha256,
    sourceTargetReferenceSha256:
      preBackupManifest.sourceTargetReferenceSha256,
    restoreTargetIdentitySha256: config.restoreIdentity,
    restoreTargetEndpointIdentitySha256: config.restoreEndpointIdentity,
    restoreTargetReferenceSha256: config.restoreTargetReferenceSha256,
    preBackupManifestSha256: preBackupManifest.manifestSha256,
    backup: config.backup,
    restore: config.restore,
    rollbackDecisionAt: config.rollbackDecisionAt,
    before: preBackupManifest.evidence,
    after: restoredEvidence,
    result: "passed",
  });
  await writeEvidenceManifest(config.restoreEvidencePath, manifest);
  return manifest;
}

export function formatRestoreVerificationFailure(error) {
  if (error instanceof RestoreVerificationError) {
    return `Database backup/restore verification failed: ${error.message}`;
  }
  return "Database backup/restore verification failed with a database or filesystem error. No connection detail or evidence path was printed.";
}

async function main() {
  const mode = process.argv[2];
  if (mode === "capture") {
    await capturePreBackupEvidence();
    console.log("Pre-backup database evidence captured in a mode-0600 manifest.");
    return;
  }
  if (mode === "verify") {
    await verifyRestoredBackup();
    console.log("Restored database evidence verified and sealed in a mode-0600 manifest.");
    return;
  }
  if (mode === "source-identity") {
    const target = databaseTargetIdentity(
      requiredString(process.env, SOURCE_DATABASE_URL_KEY),
      requiredString(process.env, SOURCE_TARGET_REFERENCE_KEY),
    );
    console.log(target.identitySha256);
    return;
  }
  if (mode === "restore-identity") {
    const target = databaseTargetIdentity(
      requiredString(process.env, RESTORE_DATABASE_URL_KEY),
      requiredString(process.env, RESTORE_TARGET_REFERENCE_KEY),
    );
    console.log(target.identitySha256);
    return;
  }
  throw new RestoreVerificationError(
    "Choose capture, verify, source-identity, or restore-identity.",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(formatRestoreVerificationFailure(error));
    process.exitCode = 1;
  }
}
