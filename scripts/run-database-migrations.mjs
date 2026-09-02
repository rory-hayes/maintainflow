import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
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
  SHA256_PATTERN,
  sha256 as hashEvidence,
} from "./database-restore-evidence-common.mjs";
import { hostedDatabaseTlsOptions } from "./database-tls.mjs";

export const APPLY_MIGRATIONS_FLAG =
  "MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS";
export const BACKUP_RESTORE_FLAG =
  "MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED";
export const DATABASE_TARGET_REFERENCE_KEY =
  "MAINTAINFLOW_DATABASE_TARGET_REFERENCE";
export const PRODUCTION_IDENTITY_KEY =
  "MAINTAINFLOW_PRODUCTION_DATABASE_IDENTITY_SHA256";
export const RESTORE_EVIDENCE_PATH_KEY =
  "MAINTAINFLOW_DATABASE_RESTORE_EVIDENCE_PATH";
export const PRE_BACKUP_EVIDENCE_PATH_KEY =
  "MAINTAINFLOW_PRE_BACKUP_EVIDENCE_PATH";
export const RESTORE_IDENTITY_KEY =
  "MAINTAINFLOW_RESTORE_TARGET_IDENTITY_SHA256";
export const RESTORE_EVIDENCE_MAX_AGE_MS = RECOVERY_EVIDENCE_MAX_AGE_MS;
export const LEDGER_TABLE = "maintainflow_schema_migrations";

export const REQUIRED_MIGRATION_NAMES = Object.freeze([
  "001_ads_approval_records.sql",
  "002_customer_tenancy.sql",
  "003_advertiser_credentials.sql",
  "004_creative_review_history.sql",
  "005_durable_monitoring_windows.sql",
  "006_monitoring_outcomes.sql",
  "007_monitoring_evaluation_leases.sql",
  "008_readiness_rate_limits.sql",
  "009_recommendation_dismissals.sql",
  "010_conversion_credentials.sql",
  "011_readiness_audit_history.sql",
  "012_live_workbench_snapshots.sql",
  "013_customer_offboarding.sql",
  "014_approval_operation_recovery.sql",
  "015_monitoring_account_fairness.sql",
  "016_live_portfolio_summaries.sql",
  "017_customer_retention_purge.sql",
  "018_supabase_data_api_hardening.sql",
]);

const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../docs/database/", import.meta.url),
);
const MIGRATION_NAME_PATTERN = /^(\d{3})_[a-z0-9][a-z0-9_-]*\.sql$/;

// First 64 bits of SHA-256("maintainflow-ads:database-migrations:v1"), split
// into PostgreSQL's two-int advisory-lock namespace.
const ADVISORY_LOCK_CLASS_ID = -635_039_337;
const ADVISORY_LOCK_OBJECT_ID = 1_107_438_067;

const LEDGER_DDL = `
  create table if not exists public.${LEDGER_TABLE} (
    migration_name text primary key
      check (migration_name ~ '^[0-9]{3}_[a-z0-9][a-z0-9_-]*[.]sql$'),
    checksum_sha256 text not null
      check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
    applied_at timestamptz not null default now()
  )
`;

export class MigrationSafetyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MigrationSafetyError";
  }
}

export class MigrationDriftError extends Error {
  constructor(migrationName, expectedChecksum, recordedChecksum) {
    super(
      `Checksum drift detected for ${migrationName}: the file is ${expectedChecksum}, but the migration ledger records ${recordedChecksum}. Applied migration files are immutable.`,
    );
    this.name = "MigrationDriftError";
    this.migrationName = migrationName;
  }
}

function isLocalHostname(hostname) {
  return (
    hostname === "" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1"
  );
}

function requiredOperationalValue(env, key) {
  const value = env[key]?.trim();
  if (!value) {
    throw new MigrationSafetyError(`${key} is required.`);
  }
  return value;
}

function requiredEvidencePath(env, key) {
  const value = requiredOperationalValue(env, key);
  if (!path.isAbsolute(value)) {
    throw new MigrationSafetyError(`${key} must be an absolute path.`);
  }
  return path.normalize(value);
}

export function validateMigrationEnvironment(
  env,
  { purpose = "production" } = {},
) {
  if (!new Set(["production", "restore_rehearsal"]).has(purpose)) {
    throw new MigrationSafetyError("Database migration purpose is invalid.");
  }
  if (env[APPLY_MIGRATIONS_FLAG] !== "true") {
    throw new MigrationSafetyError(
      `Refusing to mutate the database. Set ${APPLY_MIGRATIONS_FLAG}=true for this invocation after completing the applicable recovery gate.`,
    );
  }

  const databaseUrl = env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new MigrationSafetyError("DATABASE_URL is required.");
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new MigrationSafetyError(
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }

  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new MigrationSafetyError(
      "DATABASE_URL must use the postgres or postgresql protocol.",
    );
  }

  const hosted = !isLocalHostname(parsed.hostname);
  if (hosted) {
    const sslModes = parsed.searchParams.getAll("sslmode");
    if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
      throw new MigrationSafetyError(
        "Hosted DATABASE_URL connections must include exactly one sslmode=verify-full parameter.",
      );
    }
    if (
      purpose === "production" &&
      env[BACKUP_RESTORE_FLAG] !== "true"
    ) {
      throw new MigrationSafetyError(
        `Hosted database migration requires ${BACKUP_RESTORE_FLAG}=true after a backup and restore rehearsal has passed.`,
      );
    }
    const targetReference = requiredOperationalValue(
      env,
      DATABASE_TARGET_REFERENCE_KEY,
    );
    const target = databaseTargetIdentity(databaseUrl, targetReference);
    const productionIdentity = requiredOperationalValue(
      env,
      PRODUCTION_IDENTITY_KEY,
    ).toLowerCase();
    const buildSha = requiredOperationalValue(
      env,
      "MAINTAINFLOW_BUILD_SHA",
    ).toLowerCase();
    if (!SHA256_PATTERN.test(productionIdentity)) {
      throw new MigrationSafetyError(
        `${PRODUCTION_IDENTITY_KEY} must be an exact lowercase SHA-256 value.`,
      );
    }
    if (!FULL_GIT_SHA_PATTERN.test(buildSha)) {
      throw new MigrationSafetyError(
        "MAINTAINFLOW_BUILD_SHA must be a full 40- or 64-character Git SHA.",
      );
    }
    const restoreIdentity =
      purpose === "restore_rehearsal"
        ? requiredOperationalValue(env, RESTORE_IDENTITY_KEY).toLowerCase()
        : undefined;
    if (restoreIdentity !== undefined && !SHA256_PATTERN.test(restoreIdentity)) {
      throw new MigrationSafetyError(
        `${RESTORE_IDENTITY_KEY} must be an exact lowercase SHA-256 value.`,
      );
    }
    return {
      databaseUrl,
      hosted,
      purpose,
      targetIdentity: target.identitySha256,
      targetEndpointIdentity: target.endpointIdentitySha256,
      targetReferenceSha256: target.referenceSha256,
      productionIdentity,
      buildSha,
      evidencePath: requiredEvidencePath(
        env,
        purpose === "production"
          ? RESTORE_EVIDENCE_PATH_KEY
          : PRE_BACKUP_EVIDENCE_PATH_KEY,
      ),
      restoreIdentity,
    };
  }

  return { databaseUrl, hosted, purpose };
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export async function loadMigrations({
  directory = DEFAULT_MIGRATIONS_DIRECTORY,
  requiredMigrationNames = REQUIRED_MIGRATION_NAMES,
} = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlNames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();

  if (sqlNames.length === 0) {
    throw new MigrationSafetyError("No database migration files were found.");
  }

  for (const [index, name] of sqlNames.entries()) {
    const match = MIGRATION_NAME_PATTERN.exec(name);
    if (!match) {
      throw new MigrationSafetyError(
        `Migration filename ${name} is invalid; use a three-digit numeric prefix and a lowercase descriptive name.`,
      );
    }
    const expectedNumber = index + 1;
    if (Number(match[1]) !== expectedNumber) {
      throw new MigrationSafetyError(
        `Migration sequence is not contiguous at ${name}; expected prefix ${String(expectedNumber).padStart(3, "0")}.`,
      );
    }
  }

  for (const [index, requiredName] of requiredMigrationNames.entries()) {
    if (sqlNames[index] !== requiredName) {
      throw new MigrationSafetyError(
        `Required migration ${requiredName} is missing or out of order.`,
      );
    }
  }

  return Promise.all(
    sqlNames.map(async (name) => {
      const sql = await readFile(path.join(directory, name), "utf8");
      return { name, sql, checksumSha256: sha256(sql) };
    }),
  );
}

export function planMigrations(migrations, ledgerRows) {
  const migrationsByName = new Map(
    migrations.map((migration) => [migration.name, migration]),
  );
  const appliedByName = new Map();

  for (const row of ledgerRows) {
    if (appliedByName.has(row.migration_name)) {
      throw new MigrationSafetyError(
        `Migration ledger contains duplicate entry ${row.migration_name}.`,
      );
    }
    const migration = migrationsByName.get(row.migration_name);
    if (!migration) {
      throw new MigrationSafetyError(
        `Migration ledger contains ${row.migration_name}, which is absent from this checkout. Refusing to run an older or incomplete migration set.`,
      );
    }
    if (migration.checksumSha256 !== row.checksum_sha256) {
      throw new MigrationDriftError(
        migration.name,
        migration.checksumSha256,
        row.checksum_sha256,
      );
    }
    appliedByName.set(row.migration_name, row);
  }

  let foundPending = false;
  const pending = [];
  for (const migration of migrations) {
    if (appliedByName.has(migration.name)) {
      if (foundPending) {
        throw new MigrationSafetyError(
          `Migration ledger has a gap before ${migration.name}; applied migrations must be a contiguous filename-ordered prefix.`,
        );
      }
      continue;
    }
    foundPending = true;
    pending.push(migration);
  }

  return pending;
}

function migrationEvidenceEntries(migrations) {
  return migrations.map((migration) => ({
    migration_name: migration.name,
    checksum_sha256: migration.checksumSha256,
  }));
}

function assertFreshEvidence(manifest, now) {
  assertFreshInstant(manifest?.generatedAt, now);
}

function assertFreshInstant(value, now) {
  const generatedAt = new Date(value ?? "");
  const age = now.valueOf() - generatedAt.valueOf();
  if (
    !Number.isFinite(generatedAt.valueOf()) ||
    generatedAt.toISOString() !== value ||
    age < 0 ||
    age > RESTORE_EVIDENCE_MAX_AGE_MS
  ) {
    throw new MigrationSafetyError(
      "Database recovery evidence must be no more than 24 hours old and cannot be from the future.",
    );
  }
}

function exactInstant(value) {
  const instant = new Date(value ?? "");
  return (
    Number.isFinite(instant.valueOf()) && instant.toISOString() === value
  );
}

function assertRestoreMetadata(manifest) {
  if (
    !exactInstant(manifest.preBackupCapturedAt) ||
    typeof manifest.backup?.provider !== "string" ||
    typeof manifest.backup?.backupType !== "string" ||
    !SHA256_PATTERN.test(manifest.backup?.referenceSha256 ?? "") ||
    !exactInstant(manifest.backup?.createdAt) ||
    !exactInstant(manifest.backup?.recoveryPointAt) ||
    !SHA256_PATTERN.test(manifest.restore?.referenceSha256 ?? "") ||
    !exactInstant(manifest.restore?.completedAt) ||
    !Number.isInteger(manifest.restore?.durationSeconds) ||
    manifest.restore.durationSeconds < 0 ||
    manifest.restore.durationSeconds > 86_400 ||
    !exactInstant(manifest.rollbackDecisionAt)
  ) {
    throw new MigrationSafetyError(
      "Restore-verification evidence is missing exact backup or restore metadata.",
    );
  }
  const preBackupCaptured = new Date(manifest.preBackupCapturedAt).valueOf();
  const recoveryPoint = new Date(manifest.backup.recoveryPointAt).valueOf();
  const backupCreated = new Date(manifest.backup.createdAt).valueOf();
  const restoreCompleted = new Date(manifest.restore.completedAt).valueOf();
  const rollbackDecision = new Date(manifest.rollbackDecisionAt).valueOf();
  const generated = new Date(manifest.generatedAt).valueOf();
  if (
    recoveryPoint < preBackupCaptured ||
    backupCreated < recoveryPoint ||
    restoreCompleted < backupCreated ||
    rollbackDecision < restoreCompleted ||
    generated < rollbackDecision
  ) {
    throw new MigrationSafetyError(
      "Restore-verification evidence timestamps are out of order.",
    );
  }
}

function assertMigrationLedgerEvidence(ledger, expectedEntries, mode) {
  const expectedApplied =
    mode === "full"
      ? expectedEntries
      : expectedEntries.slice(0, ledger?.appliedEntryCount);
  const expectedLocalHash = hashEvidence(canonicalJson(expectedEntries));
  if (
    ledger?.mode !== mode ||
    !Number.isInteger(ledger.appliedEntryCount) ||
    ledger.appliedEntryCount < 1 ||
    ledger.appliedEntryCount > expectedEntries.length ||
    ledger.localEntryCount !== expectedEntries.length ||
    canonicalJson(ledger.appliedEntries) !== canonicalJson(expectedApplied) ||
    ledger.appliedSha256 !== hashEvidence(canonicalJson(expectedApplied)) ||
    ledger.localManifestSha256 !== expectedLocalHash ||
    (mode === "full" && ledger.appliedEntryCount !== expectedEntries.length)
  ) {
    throw new MigrationSafetyError(
      `Database recovery evidence does not contain the exact ${mode} migration manifest required by this checkout.`,
    );
  }
}

function assertPreservationEvidence(before, after) {
  const validSchema = (schema) =>
    Number.isInteger(schema?.tableCount) &&
    schema.tableCount > 0 &&
    Number.isInteger(schema.columnCount) &&
    schema.columnCount > 0 &&
    Number.isInteger(schema.constraintCount) &&
    schema.constraintCount > 0 &&
    Number.isInteger(schema.indexCount) &&
    schema.indexCount > 0 &&
    SHA256_PATTERN.test(schema.sha256 ?? "");
  if (
    !validSchema(before?.schema) ||
    !validSchema(after?.schema) ||
    Object.keys(before.invariants ?? {}).length === 0 ||
    Object.keys(after.invariants ?? {}).length === 0 ||
    Object.keys(before.criticalCounts ?? {}).length === 0 ||
    Object.values(before.invariants ?? {}).some((count) => count !== 0) ||
    Object.values(after.invariants ?? {}).some((count) => count !== 0)
  ) {
    throw new MigrationSafetyError(
      "Database recovery evidence contains an invalid schema or isolation result.",
    );
  }
  for (const [table, sourceCount] of Object.entries(
    before.criticalCounts ?? {},
  )) {
    if (after.criticalCounts?.[table] !== sourceCount) {
      throw new MigrationSafetyError(
        "Database recovery evidence does not preserve critical aggregate counts.",
      );
    }
  }
}

export async function validateHostedMigrationEvidence(
  config,
  migrations,
  { now = new Date() } = {},
) {
  if (!config.hosted) return null;
  const manifest = await readEvidenceManifest(
    config.evidencePath,
    config.purpose === "production"
      ? "restore-verification evidence"
      : "pre-backup evidence",
  );
  const expectedEntries = migrationEvidenceEntries(migrations);
  assertFreshEvidence(manifest, now);
  if (
    manifest.schemaVersion !== EVIDENCE_SCHEMA_VERSION ||
    manifest.buildSha !== config.buildSha
  ) {
    throw new MigrationSafetyError(
      "Database recovery evidence does not match this build.",
    );
  }

  if (config.purpose === "restore_rehearsal") {
    if (
      manifest.kind !== "maintainflow.database.pre_backup" ||
      manifest.sourceTargetIdentitySha256 !== config.productionIdentity ||
      !SHA256_PATTERN.test(
        manifest.sourceTargetEndpointIdentitySha256 ?? "",
      ) ||
      !SHA256_PATTERN.test(manifest.sourceTargetReferenceSha256 ?? "") ||
      config.targetIdentity !== config.restoreIdentity ||
      config.targetIdentity === config.productionIdentity ||
      config.targetEndpointIdentity ===
        manifest.sourceTargetEndpointIdentitySha256
    ) {
      throw new MigrationSafetyError(
        "Restore-rehearsal migration identities do not prove an isolated non-production target.",
      );
    }
    assertMigrationLedgerEvidence(
      manifest.evidence?.migrationLedger,
      expectedEntries,
      "prefix",
    );
    assertPreservationEvidence(manifest.evidence, manifest.evidence);
    return manifest;
  }

  if (
    manifest.kind !== "maintainflow.database.restore_verification" ||
    manifest.result !== "passed" ||
    manifest.sourceTargetIdentitySha256 !== config.targetIdentity ||
    manifest.sourceTargetEndpointIdentitySha256 !==
      config.targetEndpointIdentity ||
    manifest.sourceTargetReferenceSha256 !== config.targetReferenceSha256 ||
    config.targetIdentity !== config.productionIdentity ||
    manifest.restoreTargetIdentitySha256 === config.targetIdentity ||
    manifest.restoreTargetEndpointIdentitySha256 ===
      config.targetEndpointIdentity ||
    !SHA256_PATTERN.test(manifest.restoreTargetReferenceSha256 ?? "") ||
    !SHA256_PATTERN.test(manifest.preBackupManifestSha256 ?? "")
  ) {
    throw new MigrationSafetyError(
      "Restore-verification evidence is not bound to the exact production migration target.",
    );
  }
  assertMigrationLedgerEvidence(
    manifest.before?.migrationLedger,
    expectedEntries,
    "prefix",
  );
  assertMigrationLedgerEvidence(
    manifest.after?.migrationLedger,
    expectedEntries,
    "full",
  );
  assertPreservationEvidence(manifest.before, manifest.after);
  assertRestoreMetadata(manifest);
  assertFreshInstant(manifest.preBackupCapturedAt, now);
  assertFreshInstant(manifest.backup.recoveryPointAt, now);
  return manifest;
}

export async function applyMigrationsWithConnection(sql, migrations) {
  return sql.begin(async (transaction) => {
    await transaction`set local search_path = public, pg_catalog`;
    await transaction`
      select pg_advisory_xact_lock(
        ${ADVISORY_LOCK_CLASS_ID},
        ${ADVISORY_LOCK_OBJECT_ID}
      )
    `;

    // This DDL and every pending migration share the advisory-locked
    // transaction, so checksum failures and SQL failures roll back together.
    await transaction.unsafe(LEDGER_DDL);
    const ledgerRows = await transaction`
      select migration_name, checksum_sha256
      from public.maintainflow_schema_migrations
      order by migration_name
    `;
    const pending = planMigrations(migrations, ledgerRows);

    for (const migration of pending) {
      await transaction.unsafe(migration.sql);
      await transaction`
        insert into public.maintainflow_schema_migrations (
          migration_name,
          checksum_sha256
        ) values (${migration.name}, ${migration.checksumSha256})
      `;
    }

    return {
      appliedNames: pending.map((migration) => migration.name),
      totalKnown: migrations.length,
    };
  });
}

export async function runDatabaseMigrations({
  env = process.env,
  connect = postgres,
  migrationsDirectory = DEFAULT_MIGRATIONS_DIRECTORY,
  purpose = "production",
  now = new Date(),
} = {}) {
  const migrationConfig = validateMigrationEnvironment(env, { purpose });
  const migrations = await loadMigrations({ directory: migrationsDirectory });
  await validateHostedMigrationEvidence(migrationConfig, migrations, { now });
  const sql = connect(migrationConfig.databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
    prepare: false,
    ...hostedDatabaseTlsOptions({
      hosted: migrationConfig.hosted,
      environment: env,
      createError: (message) => new MigrationSafetyError(message),
    }),
  });

  try {
    return await applyMigrationsWithConnection(sql, migrations);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export function formatMigrationFailure(error, env = process.env) {
  let message = error instanceof Error ? error.message : "Unknown failure.";
  const secretKeyPattern =
    /(?:DATABASE_URL|SECRET|TOKEN|PASSWORD|PRIVATE_KEY|API_KEY|CREDENTIAL_KEYRING)/i;

  for (const [key, value] of Object.entries(env)) {
    if (!secretKeyPattern.test(key) || typeof value !== "string" || !value) {
      continue;
    }
    message = message.split(value).join("[REDACTED]");
  }

  if (typeof env.DATABASE_URL === "string") {
    try {
      const parsed = new URL(env.DATABASE_URL);
      for (const encodedValue of [parsed.username, parsed.password]) {
        if (!encodedValue) continue;
        const values = new Set([encodedValue]);
        try {
          values.add(decodeURIComponent(encodedValue));
        } catch {
          // The URL parser already validated the connection string.
        }
        for (const value of values) {
          if (value) message = message.split(value).join("[REDACTED]");
        }
      }
    } catch {
      // The fixed validation error for malformed URLs contains no input value.
    }
  }

  return `Database migration failed: ${message}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const purpose =
      process.argv[2] === "--restore-rehearsal"
        ? "restore_rehearsal"
        : "production";
    if (process.argv.length > (purpose === "restore_rehearsal" ? 3 : 2)) {
      throw new MigrationSafetyError("Database migration arguments are invalid.");
    }
    const result = await runDatabaseMigrations({ purpose });
    if (result.appliedNames.length === 0) {
      console.log(
        `Database migrations are current (${result.totalKnown} checksums verified).`,
      );
    } else {
      console.log(
        `Applied ${result.appliedNames.length} database migration(s): ${result.appliedNames.join(", ")}.`,
      );
    }
  } catch (error) {
    console.error(formatMigrationFailure(error));
    process.exitCode = 1;
  }
}
