import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  loadCompiledManifest,
  OFFICIAL_SUPABASE_RLS_AUTO_ENABLE_BODY,
  renderEmptyDatabaseBootstrapSql,
  renderOfficialSupabaseRlsAutoEnableFunctionSql,
  renderOfficialSupabaseRlsHelperBaselineSql,
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
    expect(sql).toContain("official_rls_helper_oid");
    expect(sql).toContain("procedure.proconfig = array['search_path=pg_catalog']::text[]");
    expect(sql).toContain("not procedure.proretset");
    expect(sql).toContain("procedure.prosrc = $maintainflow_supabase_rls_body$");
    expect(sql).toContain("event_trigger.evtname = 'ensure_rls'");
    expect(sql).toContain("event_trigger_owner.rolname = 'postgres'");
    expect(sql).toContain("event_trigger.evtfoid = official_rls_helper_oid");
    expect(sql).toContain("helper_trigger_count <> 1");
    expect(sql).toContain("pg_advisory_xact_lock(-635039337, 1107438067)");
    expect(sql).toContain("set local search_path = public, pg_catalog");
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

  it("pins the accepted Supabase helper to the official source and catalog fingerprint", () => {
    expect(OFFICIAL_SUPABASE_RLS_AUTO_ENABLE_BODY).toHaveLength(953);
    expect(
      createHash("md5")
        .update(OFFICIAL_SUPABASE_RLS_AUTO_ENABLE_BODY)
        .digest("hex"),
    ).toBe("99be20677b456ea8d3be47bdd44fb369");

    const functionSql = renderOfficialSupabaseRlsAutoEnableFunctionSql();
    const baselineSql = renderOfficialSupabaseRlsHelperBaselineSql();
    expect(functionSql).toContain("function public.rls_auto_enable()");
    expect(functionSql).toContain("returns event_trigger");
    expect(functionSql).toContain("security definer");
    expect(functionSql).toContain("set search_path = pg_catalog");
    expect(baselineSql).toContain(functionSql);
    expect(baselineSql).toContain("create event trigger ensure_rls");
    expect(baselineSql).toContain(
      "when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')",
    );
    expect(baselineSql).toContain(
      "execute function public.rls_auto_enable()",
    );
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
