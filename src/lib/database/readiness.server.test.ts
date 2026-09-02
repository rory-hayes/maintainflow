import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ getRuntimeDatabase: vi.fn() }));

vi.mock("./client.server", () => ({
  getRuntimeDatabase: state.getRuntimeDatabase,
}));

import { databaseMigrationManifest } from "./migration-manifest";
import { verifyDatabaseMigrationLedger } from "./readiness.server";

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
      currentMigration: "016_live_portfolio_summaries.sql",
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
