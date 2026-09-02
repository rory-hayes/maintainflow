import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  canonicalJson,
  databaseTargetIdentity,
  EVIDENCE_SCHEMA_VERSION,
  sha256 as hashEvidence,
  withManifestChecksum,
  writeEvidenceManifest,
} from "./database-restore-evidence-common.mjs";

import {
  APPLY_MIGRATIONS_FLAG,
  applyMigrationsWithConnection,
  BACKUP_RESTORE_FLAG,
  DATABASE_TARGET_REFERENCE_KEY,
  formatMigrationFailure,
  loadMigrations,
  MigrationDriftError,
  MigrationSafetyError,
  planMigrations,
  PRE_BACKUP_EVIDENCE_PATH_KEY,
  PRODUCTION_IDENTITY_KEY,
  REQUIRED_MIGRATION_NAMES,
  RESTORE_EVIDENCE_PATH_KEY,
  RESTORE_IDENTITY_KEY,
  sha256,
  validateMigrationEnvironment,
  validateHostedMigrationEvidence,
} from "./run-database-migrations.mjs";

const tempDirectories = [];

async function createTempDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "maintainflow-migration-evidence-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function migration(name, sql) {
  return { name, sql, checksumSha256: sha256(sql) };
}

function fakeConnection({ ledgerRows = [] } = {}) {
  const events = [];
  const transaction = async (strings, ...values) => {
    const statement = strings.join("$").replace(/\s+/g, " ").trim();
    events.push({ kind: "query", statement, values });
    if (statement.includes("select migration_name, checksum_sha256")) {
      return ledgerRows;
    }
    return [];
  };
  transaction.unsafe = async (statement) => {
    events.push({ kind: "unsafe", statement });
    return [];
  };

  const sql = () => {};
  sql.begin = async (callback) => {
    events.push({ kind: "begin" });
    const result = await callback(transaction);
    events.push({ kind: "commit" });
    return result;
  };

  return { sql, events };
}

const hostedDatabaseUrl =
  "postgres://migration:secret@db.example/maintainflow?sslmode=verify-full";
const productionTargetReference = "production-instance-001";
const productionIdentity = databaseTargetIdentity(
  hostedDatabaseUrl,
  productionTargetReference,
).identitySha256;
const productionEndpointIdentity = databaseTargetIdentity(
  hostedDatabaseUrl,
  productionTargetReference,
).endpointIdentitySha256;
const productionReferenceSha256 = databaseTargetIdentity(
  hostedDatabaseUrl,
  productionTargetReference,
).referenceSha256;
const restoreDatabaseUrl =
  "postgres://migration:secret@restore.example/maintainflow_restore?sslmode=verify-full";
const restoreTargetReference = "restore-instance-001";
const restoreIdentity = databaseTargetIdentity(
  restoreDatabaseUrl,
  restoreTargetReference,
).identitySha256;
const restoreEndpointIdentity = databaseTargetIdentity(
  restoreDatabaseUrl,
  restoreTargetReference,
).endpointIdentitySha256;
const restoreReferenceSha256 = databaseTargetIdentity(
  restoreDatabaseUrl,
  restoreTargetReference,
).referenceSha256;
const buildSha = "a".repeat(40);

function hostedEnvironment(evidencePath) {
  return {
    DATABASE_URL: hostedDatabaseUrl,
    [APPLY_MIGRATIONS_FLAG]: "true",
    [BACKUP_RESTORE_FLAG]: "true",
    [DATABASE_TARGET_REFERENCE_KEY]: productionTargetReference,
    [PRODUCTION_IDENTITY_KEY]: productionIdentity,
    [RESTORE_EVIDENCE_PATH_KEY]: evidencePath,
    MAINTAINFLOW_BUILD_SHA: buildSha,
  };
}

function evidenceLedger(migrations, appliedCount, mode) {
  const localEntries = migrations.map((entry) => ({
    migration_name: entry.name,
    checksum_sha256: entry.checksumSha256,
  }));
  const appliedEntries = localEntries.slice(0, appliedCount);
  return {
    mode,
    appliedEntryCount: appliedEntries.length,
    localEntryCount: localEntries.length,
    appliedEntries,
    appliedSha256: hashEvidence(canonicalJson(appliedEntries)),
    localManifestSha256: hashEvidence(canonicalJson(localEntries)),
  };
}

function databaseEvidence(migrations, appliedCount, mode, count = 3) {
  return {
    migrationLedger: evidenceLedger(migrations, appliedCount, mode),
    schema: {
      tableCount: 16,
      columnCount: 100,
      constraintCount: 40,
      indexCount: 30,
      sha256: "b".repeat(64),
    },
    criticalCounts: { ads_approval_records: count },
    invariants: { writable_table_privileges: 0 },
  };
}

describe("production database migration runner", () => {
  it("loads the required SQL files in filename order with exact SHA-256 checksums", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map(({ name }) => name)).toEqual(
      REQUIRED_MIGRATION_NAMES,
    );
    expect(migrations).toHaveLength(REQUIRED_MIGRATION_NAMES.length);

    for (const migration of migrations) {
      const file = fileURLToPath(
        new URL(`../docs/database/${migration.name}`, import.meta.url),
      );
      const contents = await readFile(file, "utf8");
      expect(migration.checksumSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(migration.checksumSha256).toBe(sha256(contents));
    }
  });

  it("refuses every mutation unless the opt-in flag is exactly true", () => {
    for (const value of [undefined, "", "false", "TRUE", "1", "yes"]) {
      expect(() =>
        validateMigrationEnvironment({
          DATABASE_URL: "postgres://localhost/maintainflow",
          [APPLY_MIGRATIONS_FLAG]: value,
        }),
      ).toThrow(MigrationSafetyError);
    }

    expect(
      validateMigrationEnvironment({
        DATABASE_URL: "postgres://localhost/maintainflow",
        [APPLY_MIGRATIONS_FLAG]: "true",
      }),
    ).toMatchObject({ hosted: false });
  });

  it("requires authenticated TLS and the backup/restore gate for hosted databases", () => {
    const base = {
      ...hostedEnvironment("/secure/restore-evidence.json"),
    };

    for (const databaseUrl of [
      "postgres://db.example/maintainflow",
      "postgres://db.example/maintainflow?sslmode=disable",
      "postgres://db.example/maintainflow?sslmode=require",
      "postgres://db.example/maintainflow?sslmode=verify-ca",
      "postgres://db.example/maintainflow?sslmode=verify-full&sslmode=verify-full",
      "postgres://db.example/maintainflow?sslmode=verify-full&sslmode=require",
    ]) {
      expect(() =>
        validateMigrationEnvironment({
          ...base,
          DATABASE_URL: databaseUrl,
        }),
      ).toThrow(/exactly one sslmode=verify-full/);
    }
    expect(() =>
      validateMigrationEnvironment({
        [APPLY_MIGRATIONS_FLAG]: "true",
        DATABASE_URL:
          "postgres://db.example/maintainflow?sslmode=verify-full",
      }),
    ).toThrow(BACKUP_RESTORE_FLAG);
    expect(
      validateMigrationEnvironment({
        ...base,
        DATABASE_URL: hostedDatabaseUrl,
      }),
    ).toMatchObject({ hosted: true });
  });

  it("binds production migration to fresh passing restore evidence for the exact target and full manifest", async () => {
    const directory = await createTempDirectory();
    const evidencePath = path.join(directory, "restore.json");
    const migrations = [
      migration("001_first.sql", "select 1"),
      migration("002_second.sql", "select 2"),
    ];
    const before = databaseEvidence(migrations, 1, "prefix");
    const after = databaseEvidence(migrations, 2, "full");
    after.schema.sha256 = "d".repeat(64);
    const manifest = withManifestChecksum({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind: "maintainflow.database.restore_verification",
      generatedAt: "2026-09-02T10:30:00.000Z",
      preBackupCapturedAt: "2026-09-02T10:00:00.000Z",
      buildSha,
      sourceTargetIdentitySha256: productionIdentity,
      sourceTargetEndpointIdentitySha256: productionEndpointIdentity,
      sourceTargetReferenceSha256: productionReferenceSha256,
      restoreTargetIdentitySha256: restoreIdentity,
      restoreTargetEndpointIdentitySha256: restoreEndpointIdentity,
      restoreTargetReferenceSha256: restoreReferenceSha256,
      preBackupManifestSha256: "c".repeat(64),
      backup: {
        provider: "hosted_postgres",
        backupType: "physical_snapshot",
        referenceSha256: "d".repeat(64),
        createdAt: "2026-09-02T10:05:00.000Z",
        recoveryPointAt: "2026-09-02T10:04:00.000Z",
      },
      restore: {
        referenceSha256: "e".repeat(64),
        completedAt: "2026-09-02T10:20:00.000Z",
        durationSeconds: 300,
      },
      rollbackDecisionAt: "2026-09-02T10:25:00.000Z",
      before,
      after,
      result: "passed",
    });
    await writeEvidenceManifest(evidencePath, manifest);
    const config = validateMigrationEnvironment(
      hostedEnvironment(evidencePath),
    );
    await expect(
      validateHostedMigrationEvidence(config, migrations, {
        now: new Date("2026-09-02T11:00:00.000Z"),
      }),
    ).resolves.toEqual(manifest);

    await expect(
      validateHostedMigrationEvidence(config, migrations, {
        now: new Date("2026-09-03T11:00:01.000Z"),
      }),
    ).rejects.toThrow(/24 hours old/);

    const staleRecoveryPath = path.join(directory, "stale-recovery.json");
    const manifestFields = Object.fromEntries(
      Object.entries(manifest).filter(([key]) => key !== "manifestSha256"),
    );
    const staleRecoveryManifest = withManifestChecksum({
      ...manifestFields,
      preBackupCapturedAt: "2026-08-31T10:00:00.000Z",
      backup: {
        ...manifest.backup,
        createdAt: "2026-08-31T10:05:00.000Z",
        recoveryPointAt: "2026-08-31T10:04:00.000Z",
      },
    });
    await writeEvidenceManifest(staleRecoveryPath, staleRecoveryManifest);
    await expect(
      validateHostedMigrationEvidence(
        validateMigrationEnvironment(hostedEnvironment(staleRecoveryPath)),
        migrations,
        { now: new Date("2026-09-02T11:00:00.000Z") },
      ),
    ).rejects.toThrow(/24 hours old/);
  });

  it("allows an exact-prefix pre-backup manifest to migrate only the declared isolated restore", async () => {
    const directory = await createTempDirectory();
    const evidencePath = path.join(directory, "pre.json");
    const migrations = [
      migration("001_first.sql", "select 1"),
      migration("002_second.sql", "select 2"),
    ];
    const manifest = withManifestChecksum({
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      kind: "maintainflow.database.pre_backup",
      generatedAt: "2026-09-02T10:00:00.000Z",
      buildSha,
      sourceTargetIdentitySha256: productionIdentity,
      sourceTargetEndpointIdentitySha256: productionEndpointIdentity,
      sourceTargetReferenceSha256: productionReferenceSha256,
      evidence: databaseEvidence(migrations, 1, "prefix"),
    });
    await writeEvidenceManifest(evidencePath, manifest);
    const environment = {
      DATABASE_URL: restoreDatabaseUrl,
      [APPLY_MIGRATIONS_FLAG]: "true",
      [DATABASE_TARGET_REFERENCE_KEY]: restoreTargetReference,
      [PRODUCTION_IDENTITY_KEY]: productionIdentity,
      [RESTORE_IDENTITY_KEY]: restoreIdentity,
      [PRE_BACKUP_EVIDENCE_PATH_KEY]: evidencePath,
      MAINTAINFLOW_BUILD_SHA: buildSha,
    };
    const config = validateMigrationEnvironment(environment, {
      purpose: "restore_rehearsal",
    });
    await expect(
      validateHostedMigrationEvidence(config, migrations, {
        now: new Date("2026-09-02T11:00:00.000Z"),
      }),
    ).resolves.toEqual(manifest);

    await expect(
      validateHostedMigrationEvidence(
        { ...config, targetIdentity: productionIdentity },
        migrations,
        { now: new Date("2026-09-02T11:00:00.000Z") },
      ),
    ).rejects.toThrow(/isolated non-production target/);

    const relabeledProductionTarget = databaseTargetIdentity(
      hostedDatabaseUrl,
      restoreTargetReference,
    );
    const relabeledConfig = validateMigrationEnvironment(
      {
        ...environment,
        DATABASE_URL: hostedDatabaseUrl,
        [RESTORE_IDENTITY_KEY]: relabeledProductionTarget.identitySha256,
      },
      { purpose: "restore_rehearsal" },
    );
    await expect(
      validateHostedMigrationEvidence(relabeledConfig, migrations, {
        now: new Date("2026-09-02T11:00:00.000Z"),
      }),
    ).rejects.toThrow(/isolated non-production target/);
  });

  it("plans only a contiguous pending suffix and rejects unknown or gapped ledger state", () => {
    const migrations = [
      migration("001_first.sql", "select 1"),
      migration("002_second.sql", "select 2"),
      migration("003_third.sql", "select 3"),
    ];

    expect(
      planMigrations(migrations, [
        {
          migration_name: migrations[0].name,
          checksum_sha256: migrations[0].checksumSha256,
        },
      ]).map(({ name }) => name),
    ).toEqual(["002_second.sql", "003_third.sql"]);

    expect(() =>
      planMigrations(migrations, [
        {
          migration_name: migrations[1].name,
          checksum_sha256: migrations[1].checksumSha256,
        },
      ]),
    ).toThrow(/gap/);
    expect(() =>
      planMigrations(migrations, [
        {
          migration_name: "004_absent.sql",
          checksum_sha256: "a".repeat(64),
        },
      ]),
    ).toThrow(/absent from this checkout/);
  });

  it("fails on checksum drift before executing any migration SQL", async () => {
    const migrations = [migration("001_first.sql", "select 1")];
    const { sql, events } = fakeConnection({
      ledgerRows: [
        {
          migration_name: migrations[0].name,
          checksum_sha256: "0".repeat(64),
        },
      ],
    });

    await expect(
      applyMigrationsWithConnection(sql, migrations),
    ).rejects.toBeInstanceOf(MigrationDriftError);
    expect(
      events.some(
        (event) => event.kind === "unsafe" && event.statement === "select 1",
      ),
    ).toBe(false);
  });

  it("takes a transaction advisory lock before ledger or migration mutations", async () => {
    const migrations = [
      migration("001_first.sql", "select 'first'"),
      migration("002_second.sql", "select 'second'"),
    ];
    const { sql, events } = fakeConnection();

    await expect(
      applyMigrationsWithConnection(sql, migrations),
    ).resolves.toEqual({
      appliedNames: ["001_first.sql", "002_second.sql"],
      totalKnown: 2,
    });

    const lockIndex = events.findIndex(
      (event) =>
        event.kind === "query" &&
        event.statement.includes("pg_advisory_xact_lock"),
    );
    const ledgerIndex = events.findIndex(
      (event) =>
        event.kind === "unsafe" &&
        event.statement.includes("maintainflow_schema_migrations"),
    );
    const firstMigrationIndex = events.findIndex(
      (event) =>
        event.kind === "unsafe" && event.statement === "select 'first'",
    );
    expect(events[0]).toEqual({ kind: "begin" });
    expect(lockIndex).toBeGreaterThan(0);
    expect(ledgerIndex).toBeGreaterThan(lockIndex);
    expect(firstMigrationIndex).toBeGreaterThan(ledgerIndex);
    expect(events.at(-1)).toEqual({ kind: "commit" });

    const executedSql = events
      .filter((event) => event.kind === "query" || event.kind === "unsafe")
      .map((event) => event.statement)
      .join("\n");
    expect(executedSql).not.toMatch(/\b(?:create|drop)\s+database\b/i);
  });

  it("redacts the configured URL and secret values from failures", () => {
    const databaseUrl =
      "postgres://migration_user:do%2Dnot%2Dprint@db.example/maintainflow?sslmode=verify-full";
    const formatted = formatMigrationFailure(
      new Error(`connection failed for ${databaseUrl}: do-not-print`),
      {
        DATABASE_URL: databaseUrl,
        DEPLOY_SECRET: "a-different-secret",
      },
    );

    expect(formatted).toContain("Database migration failed");
    expect(formatted).not.toContain(databaseUrl);
    expect(formatted).not.toContain("do-not-print");
  });
});
