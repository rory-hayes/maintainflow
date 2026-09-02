import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  loadMigrations,
  MigrationSafetyError,
} from "./run-database-migrations.mjs";

const OUTPUT_FLAG = "--output";
const EXPECTED_BUILD_SHA_FLAG = "--expected-build-sha";
const FULL_GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const compiledManifestPath = fileURLToPath(
  new URL("../src/lib/database/migration-manifest.json", import.meta.url),
);
const execFileAsync = promisify(execFile);

function ledgerDdl() {
  return `create table public.maintainflow_schema_migrations (
  migration_name text primary key
    check (migration_name ~ '^[0-9]{3}_[a-z0-9][a-z0-9_-]*[.]sql$'),
  checksum_sha256 text not null
    check (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
)`;
}

function pristinePublicSchemaGuard() {
  return `do $maintainflow_empty_bootstrap$
declare
  unexpected_object_count integer;
begin
  select count(*)::integer
    into unexpected_object_count
  from (
    select c.oid
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
    union all
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    union all
    select t.oid
    from pg_catalog.pg_type t
    join pg_catalog.pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public'
    union all
    select c.oid
    from pg_catalog.pg_collation c
    join pg_catalog.pg_namespace n on n.oid = c.collnamespace
    where n.nspname = 'public'
    union all
    select c.oid
    from pg_catalog.pg_conversion c
    join pg_catalog.pg_namespace n on n.oid = c.connamespace
    where n.nspname = 'public'
    union all
    select o.oid
    from pg_catalog.pg_operator o
    join pg_catalog.pg_namespace n on n.oid = o.oprnamespace
    where n.nspname = 'public'
    union all
    select o.oid
    from pg_catalog.pg_opclass o
    join pg_catalog.pg_namespace n on n.oid = o.opcnamespace
    where n.nspname = 'public'
    union all
    select o.oid
    from pg_catalog.pg_opfamily o
    join pg_catalog.pg_namespace n on n.oid = o.opfnamespace
    where n.nspname = 'public'
    union all
    select s.oid
    from pg_catalog.pg_statistic_ext s
    join pg_catalog.pg_namespace n on n.oid = s.stxnamespace
    where n.nspname = 'public'
    union all
    select c.oid
    from pg_catalog.pg_ts_config c
    join pg_catalog.pg_namespace n on n.oid = c.cfgnamespace
    where n.nspname = 'public'
    union all
    select d.oid
    from pg_catalog.pg_ts_dict d
    join pg_catalog.pg_namespace n on n.oid = d.dictnamespace
    where n.nspname = 'public'
    union all
    select p.oid
    from pg_catalog.pg_ts_parser p
    join pg_catalog.pg_namespace n on n.oid = p.prsnamespace
    where n.nspname = 'public'
    union all
    select t.oid
    from pg_catalog.pg_ts_template t
    join pg_catalog.pg_namespace n on n.oid = t.tmplnamespace
    where n.nspname = 'public'
  ) unexpected;

  if unexpected_object_count <> 0 then
    raise exception using
      errcode = '55000',
      message = 'MaintainFlow empty bootstrap refused: public schema is not pristine.';
  end if;
end
$maintainflow_empty_bootstrap$`;
}

export function validateCompiledManifest(migrations, manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0) {
    throw new MigrationSafetyError(
      "The compiled database migration manifest is missing or empty.",
    );
  }
  if (migrations.length !== manifest.length) {
    throw new MigrationSafetyError(
      "The migration directory does not match the compiled database manifest.",
    );
  }
  for (const [index, expected] of manifest.entries()) {
    if (
      typeof expected?.name !== "string" ||
      !SHA256_PATTERN.test(expected?.checksumSha256 ?? "") ||
      migrations[index]?.name !== expected.name ||
      migrations[index]?.checksumSha256 !== expected.checksumSha256
    ) {
      throw new MigrationSafetyError(
        "The migration directory does not match the compiled database manifest.",
      );
    }
  }
}

export function validatePinnedCheckout({ expectedBuildSha, actualHead, status }) {
  if (!FULL_GIT_SHA_PATTERN.test(expectedBuildSha ?? "")) {
    throw new MigrationSafetyError(
      `${EXPECTED_BUILD_SHA_FLAG} must be an exact lowercase 40- or 64-character Git SHA.`,
    );
  }
  if (actualHead !== expectedBuildSha) {
    throw new MigrationSafetyError(
      "The expected build SHA does not match the checked-out Git revision.",
    );
  }
  if (status.trim().length > 0) {
    throw new MigrationSafetyError(
      "The hosted bootstrap requires a clean Git checkout with no staged, unstaged, or untracked files.",
    );
  }
}

async function assertCleanPinnedCheckout(expectedBuildSha) {
  let actualHead;
  let status;
  try {
    ({ stdout: actualHead } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: projectRoot, encoding: "utf8" },
    ));
    ({ stdout: status } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: projectRoot, encoding: "utf8" },
    ));
  } catch {
    throw new MigrationSafetyError(
      "The hosted bootstrap could not verify the Git checkout.",
    );
  }
  validatePinnedCheckout({
    expectedBuildSha,
    actualHead: actualHead.trim(),
    status,
  });
}

export async function loadCompiledManifest(
  manifestPath = compiledManifestPath,
) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new MigrationSafetyError(
      "The compiled database migration manifest could not be loaded.",
    );
  }
  return parsed;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function renderEmptyDatabaseBootstrapSql(
  migrations,
  options,
) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new MigrationSafetyError(
      "At least one validated database migration is required.",
    );
  }
  const manifest = options?.manifest;
  const expectedBuildSha = options?.expectedBuildSha;
  validateCompiledManifest(migrations, manifest);
  if (!FULL_GIT_SHA_PATTERN.test(expectedBuildSha)) {
    throw new MigrationSafetyError(
      "A full lowercase build SHA is required for the bootstrap artifact.",
    );
  }

  const sections = [
    "-- MaintainFlow one-time hosted database bootstrap.",
    `-- Exact source build: ${expectedBuildSha}`,
    "-- This transaction refuses every non-pristine public schema.",
    "-- After first initialization, use the backup/restore-gated db:migrate workflow.",
    "begin;",
    "set local search_path = pg_catalog, public;",
    "select pg_advisory_xact_lock(-635039337, 1107438067);",
    `${pristinePublicSchemaGuard()};`,
    `${ledgerDdl()};`,
  ];

  for (const migration of migrations) {
    if (
      typeof migration?.name !== "string" ||
      typeof migration?.sql !== "string" ||
      typeof migration?.checksumSha256 !== "string"
    ) {
      throw new MigrationSafetyError("Database migration metadata is invalid.");
    }
    sections.push(
      `-- begin ${migration.name}`,
      migration.sql.trimEnd(),
      `insert into public.maintainflow_schema_migrations (migration_name, checksum_sha256) values (${sqlLiteral(migration.name)}, ${sqlLiteral(migration.checksumSha256)});`,
      `-- end ${migration.name}`,
    );
  }

  sections.push("commit;", "");
  return sections.join("\n\n");
}

export async function writeEmptyDatabaseBootstrapSql(
  outputPath,
  migrations,
  options,
) {
  if (!path.isAbsolute(outputPath) || path.extname(outputPath) !== ".sql") {
    throw new MigrationSafetyError(
      "Bootstrap output must be a new absolute path ending in .sql.",
    );
  }
  const sql = renderEmptyDatabaseBootstrapSql(migrations, options);
  const artifactSha256 = createHash("sha256").update(sql).digest("hex");
  const handle = await open(
    path.normalize(outputPath),
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(sql, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    outputPath: path.normalize(outputPath),
    migrationCount: migrations.length,
    artifactSha256,
  };
}

function parseArguments(argv) {
  if (
    argv.length !== 4 ||
    !argv.includes(OUTPUT_FLAG) ||
    !argv.includes(EXPECTED_BUILD_SHA_FLAG)
  ) {
    throw new MigrationSafetyError(
      "Usage: npm run db:bootstrap:empty:sql -- --output /absolute/new-file.sql --expected-build-sha <full-git-sha>",
    );
  }
  const outputIndex = argv.indexOf(OUTPUT_FLAG);
  const buildShaIndex = argv.indexOf(EXPECTED_BUILD_SHA_FLAG);
  const outputPath = argv[outputIndex + 1];
  const expectedBuildSha = argv[buildShaIndex + 1];
  if (!outputPath || !expectedBuildSha) {
    throw new MigrationSafetyError(
      "Both --output and --expected-build-sha require values.",
    );
  }
  return { outputPath, expectedBuildSha };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { outputPath, expectedBuildSha } = parseArguments(
      process.argv.slice(2),
    );
    await assertCleanPinnedCheckout(expectedBuildSha);
    const migrations = await loadMigrations();
    const manifest = await loadCompiledManifest();
    validateCompiledManifest(migrations, manifest);
    const result = await writeEmptyDatabaseBootstrapSql(outputPath, migrations, {
      manifest,
      expectedBuildSha,
    });
    console.log(
      `Wrote one-time empty-database bootstrap for ${result.migrationCount} migration(s) to ${result.outputPath} with SHA-256 ${result.artifactSha256}.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown bootstrap generation failure.";
    console.error(`Database bootstrap generation failed: ${message}`);
    process.exitCode = 1;
  }
}
