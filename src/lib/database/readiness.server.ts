import "server-only";

import { getRuntimeDatabase } from "./client.server";
import { databaseMigrationManifest } from "./migration-manifest";

type MigrationLedgerRow = {
  migration_name: string;
  checksum_sha256: string;
};

export type DatabaseMigrationReadiness = {
  ready: boolean;
  appliedCount: number;
  expectedCount: number;
  currentMigration: string | null;
};

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
