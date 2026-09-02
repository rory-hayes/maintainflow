import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadCompiledManifest,
  renderEmptyDatabaseBootstrapSql,
  validateCompiledManifest,
  validatePinnedCheckout,
  writeEmptyDatabaseBootstrapSql,
} from "./generate-empty-database-bootstrap.mjs";
import { loadMigrations } from "./run-database-migrations.mjs";

const migrations = [
  {
    name: "001_first.sql",
    sql: "create table first_table (id uuid primary key);\n",
    checksumSha256: "a".repeat(64),
  },
  {
    name: "002_second.sql",
    sql: "alter table first_table add column name text;\n",
    checksumSha256: "b".repeat(64),
  },
];
const testOptions = {
  manifest: migrations.map(({ name, checksumSha256 }) => ({
    name,
    checksumSha256,
  })),
  expectedBuildSha: "0".repeat(40),
};

describe("empty hosted database bootstrap SQL", () => {
  it("guards a pristine public schema before applying the exact migration ledger", () => {
    const sql = renderEmptyDatabaseBootstrapSql(migrations, testOptions);

    expect(sql).toContain("public schema is not pristine");
    expect(sql).toContain("from pg_catalog.pg_collation");
    expect(sql).toContain("from pg_catalog.pg_ts_template");
    expect(sql).toContain("pg_advisory_xact_lock(-635039337, 1107438067)");
    expect(sql).toContain("set local search_path = pg_catalog, public");
    expect(sql.indexOf("public schema is not pristine")).toBeLessThan(
      sql.indexOf("create table public.maintainflow_schema_migrations"),
    );
    expect(sql.indexOf("create table first_table")).toBeLessThan(
      sql.indexOf("'001_first.sql', '" + "a".repeat(64) + "'"),
    );
    expect(sql.indexOf("create table first_table")).toBeLessThan(
      sql.indexOf("alter table first_table"),
    );
    expect(sql.trimStart().startsWith("-- MaintainFlow one-time")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("writes a new mode-0600 SQL artifact and refuses overwrite", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maintainflow-bootstrap-"));
    const outputPath = path.join(directory, "bootstrap.sql");

    const result = await writeEmptyDatabaseBootstrapSql(
      outputPath,
      migrations,
      testOptions,
    );
    expect(result).toMatchObject({
      outputPath,
      migrationCount: 2,
      artifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await stat(outputPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(outputPath, "utf8")).toContain("002_second.sql");
    await expect(
      writeEmptyDatabaseBootstrapSql(outputPath, migrations, testOptions),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects empty metadata and non-absolute output paths", async () => {
    expect(() =>
      renderEmptyDatabaseBootstrapSql([], {
        manifest: [],
        expectedBuildSha: "0".repeat(40),
      }),
    ).toThrow(
      /At least one validated database migration/,
    );
    await expect(
      writeEmptyDatabaseBootstrapSql("bootstrap.sql", migrations),
    ).rejects.toThrow(/new absolute path/);
    expect(() => renderEmptyDatabaseBootstrapSql(migrations)).toThrow(
      /compiled database migration manifest is missing or empty/,
    );
  });

  it("binds the real migration directory to the compiled runtime manifest", async () => {
    const currentMigrations = await loadMigrations();
    const manifest = await loadCompiledManifest();

    expect(() => validateCompiledManifest(currentMigrations, manifest)).not.toThrow();
    expect(() =>
      validateCompiledManifest(currentMigrations, manifest.slice(0, -1)),
    ).toThrow(/does not match the compiled database manifest/);
    expect(() =>
      validateCompiledManifest(currentMigrations, [
        ...manifest.slice(0, -1),
        {
          ...manifest.at(-1),
          checksumSha256: "f".repeat(64),
        },
      ]),
    ).toThrow(/does not match the compiled database manifest/);
    expect(() =>
      validateCompiledManifest(
        [
          ...currentMigrations,
          {
            name: "019_unreviewed.sql",
            sql: "select 1;",
            checksumSha256: "f".repeat(64),
          },
        ],
        manifest,
      ),
    ).toThrow(/does not match the compiled database manifest/);
  });

  it("requires an exact clean pinned Git revision", () => {
    const sha = "a".repeat(40);
    expect(() =>
      validatePinnedCheckout({ expectedBuildSha: sha, actualHead: sha, status: "" }),
    ).not.toThrow();
    expect(() =>
      validatePinnedCheckout({
        expectedBuildSha: sha,
        actualHead: "b".repeat(40),
        status: "",
      }),
    ).toThrow(/does not match/);
    expect(() =>
      validatePinnedCheckout({
        expectedBuildSha: sha,
        actualHead: sha,
        status: " M docs/database/001_ads_approval_records.sql\n",
      }),
    ).toThrow(/clean Git checkout/);
  });
});
