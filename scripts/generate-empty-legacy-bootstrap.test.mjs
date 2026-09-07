import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalJson,
  sha256,
  withManifestChecksum,
} from "./database-restore-evidence-common.mjs";
import { loadCompiledManifest } from "./generate-empty-database-bootstrap.mjs";
import {
  EMPTY_LEGACY_MANIFEST_SHA256,
  EMPTY_LEGACY_PROJECT_REF,
  EMPTY_LEGACY_TABLES,
  renderEmptyLegacyBootstrapSql,
  validateEmptyLegacyEvidence,
  writeEmptyLegacyBootstrapSql,
} from "./generate-empty-legacy-bootstrap.mjs";
import { loadMigrations } from "./run-database-migrations.mjs";

const now = new Date("2026-09-07T17:00:00.000Z");
let migrations;
let manifest;
const directories = [];
beforeAll(async () => {
  [migrations, manifest] = await Promise.all([
    loadMigrations(),
    loadCompiledManifest(),
  ]);
});
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function options(overrides = {}) {
  const baseline = {
    kind: "maintainflow.empty_legacy_baseline",
    version: 1,
    projectRef: EMPTY_LEGACY_PROJECT_REF,
    capturedAt: "2026-09-07T16:00:00.000Z",
    catalog: { fixture: "unit-rendering-only" },
    ...overrides.baseline,
  };
  const recoveryEvidence = withManifestChecksum({
    kind: "maintainflow.empty_legacy_local_recovery",
    version: 1,
    projectRef: EMPTY_LEGACY_PROJECT_REF,
    baselineSha256: sha256(canonicalJson(baseline)),
    migrationManifestSha256: EMPTY_LEGACY_MANIFEST_SHA256,
    completedAt: "2026-09-07T16:30:00.000Z",
    checks: {
      canonicalPrefixMatches: true,
      localSchemaRestoreMatches: true,
      localRoleAclRestoreMatches: true,
      emptyState: true,
    },
    ...overrides.recovery,
  });
  return {
    manifest,
    expectedBuildSha: "a".repeat(40),
    baseline,
    recoveryEvidence,
    catalogQuery: "select '{}'::jsonb",
    now,
  };
}

describe("separate empty legacy support", () => {
  it("accepts only this approved target and fresh successful local recovery bound to the captured state", () => {
    expect(() =>
      validateEmptyLegacyEvidence(migrations, options()),
    ).not.toThrow();
    for (const baseline of [
      { projectRef: "mvzspyhwoqzcygekridy" },
      { capturedAt: "2026-09-05T16:00:00.000Z" },
      { capturedAt: "2026-09-07T18:00:00.000Z" },
      { kind: "maintainflow.database.restore_verification" },
      { catalog: null },
      { catalog: [] },
    ])
      expect(() =>
        validateEmptyLegacyEvidence(migrations, options({ baseline })),
      ).toThrow();
    for (const recovery of [
      { baselineSha256: "0".repeat(64) },
      { migrationManifestSha256: "0".repeat(64) },
      { projectRef: "another-project" },
      { completedAt: "2026-09-07T15:00:00.000Z" },
      { completedAt: "2026-09-07T18:00:00.000Z" },
      { checks: { emptyState: true } },
    ])
      expect(() =>
        validateEmptyLegacyEvidence(migrations, options({ recovery })),
      ).toThrow();
    const altered = options();
    altered.recoveryEvidence.checks.emptyState = false;
    expect(() => validateEmptyLegacyEvidence(migrations, altered)).toThrow(
      /checksum/,
    );
  });

  it("rejects changed SQL even if callers retain original checksums, and rejects updated manifests", () => {
    const modified = migrations.map((migration, index) =>
      index === 18
        ? { ...migration, sql: migration.sql + "\nselect 1;" }
        : migration,
    );
    expect(() => validateEmptyLegacyEvidence(modified, options())).toThrow(
      /exact reviewed/,
    );
    modified[18].checksumSha256 = sha256(modified[18].sql);
    const changedManifest = modified.map(({ name, checksumSha256 }) => ({
      name,
      checksumSha256,
    }));
    expect(() =>
      validateEmptyLegacyEvidence(modified, {
        ...options(),
        manifest: changedManifest,
      }),
    ).toThrow(/exact reviewed/);
    expect(() =>
      validateEmptyLegacyEvidence(migrations.slice(0, 18), {
        ...options(),
        manifest: manifest.slice(0, 18),
      }),
    ).toThrow(/exact reviewed/);
  });

  it("preserves all nine migration bodies byte for byte and inserts their exact ledger rows inside one transaction", () => {
    const sql = renderEmptyLegacyBootstrapSql(migrations, options());
    expect(sql).toContain("not a hosted-backup rehearsal");
    expect(sql).toContain(EMPTY_LEGACY_PROJECT_REF);
    expect(sql).toContain("begin;");
    expect(sql.trimEnd()).toMatch(/commit;$/);
    for (const migration of migrations.slice(18)) {
      const start = `-- begin immutable ${migration.name}\n`;
      const end = `\n-- end immutable ${migration.name}`;
      const body = sql.slice(
        sql.indexOf(start) + start.length,
        sql.indexOf(end),
      );
      expect(body).toBe(migration.sql);
      expect(sha256(body)).toBe(migration.checksumSha256);
    }
    expect(sql).not.toContain("-- begin immutable 018");
    expect(sql).not.toMatch(/(?:truncate|drop)\s+(?:table|schema|database)/i);
    expect(sql).not.toMatch(/\bpassword\s+['$]/i);
  });

  it("locks every retained-state boundary and validates its emptiness before the first migration", () => {
    const sql = renderEmptyLegacyBootstrapSql(migrations, options());
    const guard = sql.slice(0, sql.indexOf("-- begin immutable"));
    expect(guard).toContain("pg_advisory_xact_lock(-635039337, 1107438067)");
    expect(guard).toContain("set local row_security = off");
    const lock = guard.match(/lock table (.+) in access exclusive mode;/)[1];
    for (const table of [
      ...EMPTY_LEGACY_TABLES.map((table) => `public.${table}`),
      "auth.users",
      "auth.identities",
      "auth.sessions",
      "storage.buckets",
      "storage.objects",
    ]) {
      expect(lock.split(", ")).toContain(table);
      expect(guard).toContain(`if exists (select 1 from ${table})`);
    }
    expect(lock).toContain("public.maintainflow_schema_migrations");
    expect(guard).toContain(
      "captured catalog, privileges or environment changed",
    );
    expect(guard).toContain("legacy runtime session still connected");
    expect(guard).toContain("new runtime role already exists");
    expect(guard).toContain("official RLS helper differs");
    expect(guard).toContain("unexpected legacy role membership");
  });

  it("retires both table and explicit column privileges after migrations but before commit", () => {
    const sql = renderEmptyLegacyBootstrapSql(migrations, options());
    const retire = sql.indexOf(
      "alter role maintainflow_app nologin nobypassrls noinherit",
    );
    expect(retire).toBeGreaterThan(sql.indexOf("-- end immutable 027_"));
    expect(retire).toBeLessThan(sql.lastIndexOf("commit;"));
    expect(sql).toContain(
      "revoke all privileges (%I) on table %I.%I from maintainflow_app",
    );
    expect(sql).toContain("has_any_column_privilege('maintainflow_app'");
    expect(sql).toContain("not rolcanlogin and not rolbypassrls");
    expect(sql).toContain("into retained");
  });

  it("writes only a new private SQL file outside the checkout", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "maintainflow-empty-legacy-unit-"),
    );
    directories.push(directory);
    const output = path.join(directory, "upgrade.sql");
    const result = await writeEmptyLegacyBootstrapSql(
      output,
      migrations,
      options(),
    );
    expect(result.migrationCount).toBe(9);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    expect(sha256(await readFile(output, "utf8"))).toBe(result.artifactSha256);
    await expect(
      writeEmptyLegacyBootstrapSql(output, migrations, options()),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(
      writeEmptyLegacyBootstrapSql("relative.sql", migrations, options()),
    ).rejects.toThrow(/absolute/);
    await expect(
      writeEmptyLegacyBootstrapSql(
        path.resolve("scripts/unsafe.sql"),
        migrations,
        options(),
      ),
    ).rejects.toThrow(/outside/);
  });
});
