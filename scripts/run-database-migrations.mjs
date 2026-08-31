import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

export const APPLY_MIGRATIONS_FLAG =
  "MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS";
export const BACKUP_RESTORE_FLAG =
  "MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED";
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

export function validateMigrationEnvironment(env) {
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
    if (env[BACKUP_RESTORE_FLAG] !== "true") {
      throw new MigrationSafetyError(
        `Hosted database migration requires ${BACKUP_RESTORE_FLAG}=true after a backup and restore rehearsal has passed.`,
      );
    }
  }

  return { databaseUrl, hosted };
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
} = {}) {
  const { databaseUrl } = validateMigrationEnvironment(env);
  const migrations = await loadMigrations({ directory: migrationsDirectory });
  const sql = connect(databaseUrl, {
    connect_timeout: 10,
    idle_timeout: 5,
    max: 1,
    onnotice: () => {},
    prepare: false,
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
    const result = await runDatabaseMigrations();
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
