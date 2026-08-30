import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPLY_MIGRATIONS_FLAG,
  applyMigrationsWithConnection,
  BACKUP_RESTORE_FLAG,
  formatMigrationFailure,
  loadMigrations,
  MigrationDriftError,
  MigrationSafetyError,
  planMigrations,
  REQUIRED_MIGRATION_NAMES,
  sha256,
  validateMigrationEnvironment,
} from "./run-database-migrations.mjs";

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

describe("production database migration runner", () => {
  it("loads the required SQL files in filename order with exact SHA-256 checksums", async () => {
    const migrations = await loadMigrations();
    expect(migrations.map(({ name }) => name)).toEqual(
      REQUIRED_MIGRATION_NAMES,
    );
    expect(migrations).toHaveLength(12);

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
      [APPLY_MIGRATIONS_FLAG]: "true",
      [BACKUP_RESTORE_FLAG]: "true",
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
        DATABASE_URL:
          "postgres://db.example/maintainflow?sslmode=verify-full",
      }),
    ).toMatchObject({ hosted: true });
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
