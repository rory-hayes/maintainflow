import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJson,
  sha256,
  verifyManifestChecksum,
} from "./database-restore-evidence-common.mjs";
import {
  loadCompiledManifest,
  OFFICIAL_SUPABASE_RLS_AUTO_ENABLE_BODY,
  validateCompiledManifest,
  validatePinnedCheckout,
} from "./generate-empty-database-bootstrap.mjs";
import {
  loadMigrations,
  MigrationSafetyError,
} from "./run-database-migrations.mjs";

// Deliberately a separate, one-target support path. Neither general hosted
// migration evidence nor the pristine-bootstrap contract is relaxed here.
export const EMPTY_LEGACY_PROJECT_REF = "dhbevbimoajwkuzcunwz";
export const EMPTY_LEGACY_MANIFEST_SHA256 =
  "834aa56981ec71c62dfe687b0a9badd745ea7d07c4e751501755ccb683c46abf";
export const EMPTY_LEGACY_PREFIX_SHA256 =
  "5438bd4a6360b649639c8d90da66ec8938ecbc54a741652bd8c54f50b13cb279";
export const EMPTY_LEGACY_TABLES = Object.freeze([
  "ads_approval_records",
  "maintainflow_account_access",
  "maintainflow_advertiser_accounts",
  "maintainflow_advertiser_credentials",
  "maintainflow_conversion_credentials",
  "maintainflow_creative_review_events",
  "maintainflow_creative_review_state",
  "maintainflow_customer_lifecycle_records",
  "maintainflow_live_workbench_snapshots",
  "maintainflow_monitoring_account_schedule",
  "maintainflow_organization_memberships",
  "maintainflow_organizations",
  "maintainflow_rate_limit_buckets",
  "maintainflow_readiness_audit_runs",
  "maintainflow_recommendation_dismissals",
]);
const providerTables = [
  "auth.users",
  "auth.identities",
  "auth.sessions",
  "storage.buckets",
  "storage.objects",
];
const ledger = "maintainflow_schema_migrations";
const root = fileURLToPath(new URL("..", import.meta.url));
const execFileAsync = promisify(execFile);
const fullShaPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maximumAgeMs = 24 * 60 * 60 * 1000;
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function refuse(message) {
  throw new MigrationSafetyError(message);
}
function fresh(value, now) {
  const instant = Date.parse(value);
  return (
    typeof value === "string" &&
    Number.isFinite(instant) &&
    new Date(instant).toISOString() === value &&
    instant <= now.valueOf() &&
    now.valueOf() - instant <= maximumAgeMs
  );
}

export function validateEmptyLegacyEvidence(migrations, options) {
  const {
    manifest,
    baseline,
    recoveryEvidence,
    expectedBuildSha,
    now = new Date(),
  } = options ?? {};
  validateCompiledManifest(migrations, manifest);
  if (
    manifest.length !== 27 ||
    sha256(canonicalJson(manifest)) !== EMPTY_LEGACY_MANIFEST_SHA256 ||
    sha256(canonicalJson(manifest.slice(0, 18))) !==
      EMPTY_LEGACY_PREFIX_SHA256 ||
    migrations.some(
      (migration) => sha256(migration.sql) !== migration.checksumSha256,
    )
  ) {
    refuse(
      "Empty-legacy support accepts only the exact reviewed 001–027 migration bytes.",
    );
  }
  if (!fullShaPattern.test(expectedBuildSha ?? ""))
    refuse("A full lowercase build SHA is required.");
  if (
    baseline?.kind !== "maintainflow.empty_legacy_baseline" ||
    baseline.version !== 1 ||
    baseline.projectRef !== EMPTY_LEGACY_PROJECT_REF ||
    !fresh(baseline.capturedAt, now) ||
    !baseline.catalog ||
    typeof baseline.catalog !== "object" ||
    Array.isArray(baseline.catalog)
  ) {
    refuse(
      "A fresh captured baseline for the exact approved empty-legacy project is required.",
    );
  }
  verifyManifestChecksum(recoveryEvidence, "empty-legacy local recovery");
  const requiredChecks = [
    "canonicalPrefixMatches",
    "localSchemaRestoreMatches",
    "localRoleAclRestoreMatches",
    "emptyState",
  ];
  if (
    recoveryEvidence.kind !== "maintainflow.empty_legacy_local_recovery" ||
    recoveryEvidence.version !== 1 ||
    recoveryEvidence.projectRef !== EMPTY_LEGACY_PROJECT_REF ||
    recoveryEvidence.baselineSha256 !== sha256(canonicalJson(baseline)) ||
    recoveryEvidence.migrationManifestSha256 !== EMPTY_LEGACY_MANIFEST_SHA256 ||
    !fresh(recoveryEvidence.completedAt, now) ||
    Date.parse(recoveryEvidence.completedAt) <
      Date.parse(baseline.capturedAt) ||
    requiredChecks.some((check) => recoveryEvidence.checks?.[check] !== true)
  ) {
    refuse(
      "Passing local recovery evidence must match the captured empty baseline and exact migration manifest.",
    );
  }
  return { baseline, recoveryEvidence, expectedBuildSha };
}

function ledgerGuard(manifest) {
  const expected = manifest.map((migration) => ({
    migration_name: migration.name,
    checksum_sha256: migration.checksumSha256,
  }));
  return `if (select coalesce(jsonb_agg(jsonb_build_object('migration_name', migration_name, 'checksum_sha256', checksum_sha256) order by migration_name), '[]'::jsonb) from public.${ledger}) is distinct from ${quote(JSON.stringify(expected))}::jsonb then
    raise exception 'Empty-legacy bootstrap refused: migration ledger differs.';
  end if;`;
}

function emptyGuard(tables) {
  return tables
    .map(
      (table) =>
        `if exists (select 1 from ${table}) then raise exception 'Empty-legacy bootstrap refused: retained state in ${table}.'; end if;`,
    )
    .join("\n  ");
}

function unsupportedObjectsGuard() {
  const catalogs = [
    ["pg_operator", "oprnamespace"],
    ["pg_opclass", "opcnamespace"],
    ["pg_opfamily", "opfnamespace"],
    ["pg_collation", "collnamespace"],
    ["pg_conversion", "connamespace"],
    ["pg_statistic_ext", "stxnamespace"],
    ["pg_ts_config", "cfgnamespace"],
    ["pg_ts_dict", "dictnamespace"],
    ["pg_ts_parser", "prsnamespace"],
    ["pg_ts_template", "tmplnamespace"],
  ];
  return `if ${catalogs.map(([catalog, namespace]) => `exists(select 1 from pg_catalog.${catalog} o join pg_catalog.pg_namespace n on n.oid=o.${namespace} where n.nspname='public')`).join("\n    or ")}
    or exists(select 1 from pg_catalog.pg_rewrite r join pg_catalog.pg_class c on c.oid=r.ev_class join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public') then
    raise exception 'Empty-legacy bootstrap refused: unsupported public objects or rewrite rules.';
  end if;
  if exists(select 1 from pg_catalog.pg_shdepend d join pg_catalog.pg_roles r on r.oid=d.refobjid
    where d.refclassid='pg_catalog.pg_authid'::regclass and r.rolname='maintainflow_app' and d.deptype='o') then
    raise exception 'Empty-legacy bootstrap refused: legacy runtime owns objects.';
  end if;
  if exists(select 1 from pg_catalog.pg_default_acl d cross join lateral pg_catalog.aclexplode(d.defaclacl) a
    join pg_catalog.pg_roles r on r.oid=a.grantee where r.rolname='maintainflow_app') then
    raise exception 'Empty-legacy bootstrap refused: future default privileges reach the legacy runtime.';
  end if;`;
}

function helperGuard(onlyHelper = true) {
  return `if ${onlyHelper ? "(select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace where n.nspname='public') <> 1 or " : ""}not exists (
      select 1 from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      join pg_catalog.pg_roles r on r.oid=p.proowner
      join pg_catalog.pg_language l on l.oid=p.prolang
      where n.nspname='public' and p.proname='rls_auto_enable' and p.pronargs=0
        and p.prorettype='pg_catalog.event_trigger'::regtype and r.rolname='postgres' and l.lanname='plpgsql'
        and not p.proretset and p.provolatile='v' and not p.proisstrict and p.prosecdef
        and not p.proleakproof and p.proparallel='u' and p.proconfig=array['search_path=pg_catalog']::text[]
        and p.prosrc=${quote(OFFICIAL_SUPABASE_RLS_AUTO_ENABLE_BODY)}
        and not exists (select 1 from pg_catalog.pg_depend d where d.classid='pg_catalog.pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
        and (select count(*) from pg_catalog.pg_event_trigger e where e.evtfoid=p.oid)=1
        and exists (select 1 from pg_catalog.pg_event_trigger e join pg_catalog.pg_roles er on er.oid=e.evtowner
          where e.evtfoid=p.oid and e.evtname='ensure_rls' and e.evtevent='ddl_command_end' and e.evtenabled='O'
            and er.rolname='postgres' and e.evttags=array['CREATE TABLE','CREATE TABLE AS','SELECT INTO']::text[])
    ) then raise exception 'Empty-legacy bootstrap refused: official RLS helper differs.'; end if;`;
}

function retirementSql() {
  return `-- Retire the obsolete bypass role atomically; do not alter any password.
alter role maintainflow_app nologin nobypassrls noinherit;
revoke all privileges on all tables in schema public from maintainflow_app;
revoke all privileges on all sequences in schema public from maintainflow_app;
revoke all privileges on all functions in schema public from maintainflow_app;
revoke all privileges on schema public from maintainflow_app;
do $empty_legacy_retire$
declare col record;
begin
  -- Table-level REVOKE does not remove previously explicit column ACLs.
  for col in select n.nspname,c.relname,a.attname from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid=a.attrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped
  loop execute format('revoke all privileges (%I) on table %I.%I from maintainflow_app',col.attname,col.nspname,col.relname); end loop;
  execute format('revoke all privileges on database %I from maintainflow_app',current_database());
end;
$empty_legacy_retire$;`;
}

export function renderEmptyLegacyBootstrapSql(migrations, options) {
  const { baseline, recoveryEvidence, expectedBuildSha } =
    validateEmptyLegacyEvidence(migrations, options);
  const query = options.catalogQuery?.trim().replace(/;\s*$/, "");
  if (!query || !/^(?:--[^\n]*\n\s*)*(?:select|with)\s/i.test(query))
    refuse("The bundled read-only catalog query is required.");
  const expectedTables = [...EMPTY_LEGACY_TABLES, ledger].sort();
  const guardedTables = [
    ...EMPTY_LEGACY_TABLES.map((table) => `public.${table}`),
    ...providerTables,
  ];
  const locks = [...guardedTables, `public.${ledger}`].sort();
  const sections = [
    "-- MaintainFlow one-time EMPTY LEGACY installation upgrade; not a hosted-backup rehearsal.",
    `-- APPROVED TARGET ONLY: ${EMPTY_LEGACY_PROJECT_REF}. Verify the SQL editor project at execution.`,
    `-- Exact source build: ${expectedBuildSha}`,
    `-- Captured baseline SHA-256: ${sha256(canonicalJson(baseline))}`,
    `-- Local recovery evidence SHA-256: ${recoveryEvidence.manifestSha256}`,
    "-- This artifact contains no password. Existing migrations and normal migration gates remain unchanged.",
    "begin;",
    "set local standard_conforming_strings = on;",
    "set local search_path = pg_catalog, public;",
    "set local row_security = off;",
    "set local lock_timeout = '5s';",
    "set local statement_timeout = '120s';",
    "select pg_advisory_xact_lock(-635039337, 1107438067);",
    `lock table ${locks.join(", ")} in access exclusive mode;`,
    `do $empty_legacy_guard$
begin
  if current_database() <> 'postgres' or current_user <> 'postgres' then
    raise exception 'Empty-legacy bootstrap refused: use the reviewed postgres migration identity/database.';
  end if;
  if clock_timestamp() < ${quote(baseline.capturedAt)}::timestamptz
    or clock_timestamp() < ${quote(recoveryEvidence.completedAt)}::timestamptz
    or clock_timestamp() - ${quote(baseline.capturedAt)}::timestamptz > interval '24 hours'
    or clock_timestamp() - ${quote(recoveryEvidence.completedAt)}::timestamptz > interval '24 hours' then
    raise exception 'Empty-legacy bootstrap refused: execution evidence is stale or future-dated.';
  end if;
  ${unsupportedObjectsGuard()}
  if (select coalesce(jsonb_agg(c.relname order by c.relname),'[]'::jsonb) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r') is distinct from ${quote(JSON.stringify(expectedTables))}::jsonb
    or exists(select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind not in ('r','i')) then
    raise exception 'Empty-legacy bootstrap refused: unexpected public relations.';
  end if;
  ${ledgerGuard(options.manifest.slice(0, 18))}
  ${emptyGuard(guardedTables)}
  ${helperGuard()}
  if exists(select 1 from pg_catalog.pg_roles where rolname='maintaincode_app') then
    raise exception 'Empty-legacy bootstrap refused: new runtime role already exists.';
  end if;
  if not exists(select 1 from pg_catalog.pg_roles where rolname='maintainflow_app' and rolcanlogin and rolbypassrls and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication) then
    raise exception 'Empty-legacy bootstrap refused: legacy runtime role differs.';
  end if;
  if exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member on member.oid=m.member
    where (r.rolname='maintainflow_app' or member.rolname='maintainflow_app')
      and not (r.rolname='maintainflow_app' and member.rolname='postgres' and m.admin_option and not m.inherit_option and not m.set_option)) then
    raise exception 'Empty-legacy bootstrap refused: unexpected legacy role membership.';
  end if;
  if exists(select 1 from pg_catalog.pg_stat_activity where usename='maintainflow_app' and pid<>pg_backend_pid()) then
    raise exception 'Empty-legacy bootstrap refused: legacy runtime session still connected.';
  end if;
  if (${query}) is distinct from ${quote(JSON.stringify(baseline.catalog))}::jsonb then
    raise exception 'Empty-legacy bootstrap refused: captured catalog, privileges or environment changed.';
  end if;
end;
$empty_legacy_guard$;`,
    "set local search_path = public, pg_catalog;",
  ];
  for (const migration of migrations.slice(18)) {
    // Preserve every byte of each reviewed migration between separate markers.
    sections.push(
      `-- begin immutable ${migration.name}\n${migration.sql}\n-- end immutable ${migration.name}`,
    );
    sections.push(
      `insert into public.${ledger} (migration_name,checksum_sha256) values (${quote(migration.name)},${quote(migration.checksumSha256)});`,
    );
  }
  sections.push(retirementSql());
  sections.push(`do $empty_legacy_final$
declare t record; retained boolean;
begin
  ${ledgerGuard(options.manifest)}
  ${emptyGuard(providerTables)}
  ${helperGuard(false)}
  if (select count(*) from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r')<>24 then
    raise exception 'Empty-legacy bootstrap refused: final table inventory differs.';
  end if;
  for t in select c.oid,c.relname from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'
  loop
    if t.relname<>'${ledger}' then
      execute format('select exists(select 1 from public.%I)',t.relname) into retained;
      if retained then raise exception 'Empty-legacy bootstrap refused: final application state is not empty.'; end if;
    end if;
    if has_table_privilege('maintainflow_app',t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      or has_any_column_privilege('maintainflow_app',t.oid,'SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'Empty-legacy bootstrap refused: obsolete runtime still has application access.';
    end if;
  end loop;
  if exists(select 1 from pg_catalog.pg_roles where rolname='maintainflow_app' and (rolcanlogin or rolbypassrls))
    or not exists(select 1 from pg_catalog.pg_roles where rolname='maintaincode_app' and not rolcanlogin and not rolbypassrls and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolinherit)
    or has_schema_privilege('maintainflow_app','public','USAGE,CREATE') then
    raise exception 'Empty-legacy bootstrap refused: final runtime role boundary differs.';
  end if;
  if exists(select 1 from pg_catalog.pg_auth_members m join pg_catalog.pg_roles r on r.oid=m.roleid join pg_catalog.pg_roles member on member.oid=m.member
    where (r.rolname in ('maintainflow_app','maintaincode_app') or member.rolname in ('maintainflow_app','maintaincode_app'))
      and not (r.rolname in ('maintainflow_app','maintaincode_app') and member.rolname='postgres' and m.admin_option and not m.inherit_option and not m.set_option))
    or exists(select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and has_function_privilege('maintainflow_app',p.oid,'EXECUTE')) then
    raise exception 'Empty-legacy bootstrap refused: final runtime membership or routine access differs.';
  end if;
end;
$empty_legacy_final$;`);
  sections.push("commit;", "");
  return sections.join("\n\n");
}

async function privateJson(file) {
  if (!path.isAbsolute(file)) refuse("Evidence paths must be absolute.");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (
      !stats.isFile() ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 4 * 1024 * 1024
    )
      refuse(
        "Evidence must be a private mode-0600 regular file no larger than 4MB.",
      );
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

export async function writeEmptyLegacyBootstrapSql(
  outputPath,
  migrations,
  options,
) {
  if (!path.isAbsolute(outputPath) || path.extname(outputPath) !== ".sql")
    refuse("Output must be a new absolute .sql path outside the checkout.");
  const parent = await realpath(path.dirname(outputPath));
  const project = await realpath(root);
  if (parent === project || parent.startsWith(`${project}${path.sep}`))
    refuse("Output must be outside the checkout.");
  const sql = renderEmptyLegacyBootstrapSql(migrations, options);
  const handle = await open(
    outputPath,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(sql, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return {
    outputPath,
    artifactSha256: sha256(sql),
    migrationCount: 9,
    projectRef: EMPTY_LEGACY_PROJECT_REF,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const flags = [
    "--baseline",
    "--recovery-evidence",
    "--output",
    "--expected-build-sha",
  ];
  if (
    args.length !== 8 ||
    flags.some((flag) => args.filter((arg) => arg === flag).length !== 1) ||
    args.some((arg, index) => index % 2 === 0 && !flags.includes(arg))
  ) {
    refuse(
      "Usage: node scripts/generate-empty-legacy-bootstrap.mjs --baseline /private/baseline.json --recovery-evidence /private/recovery.json --output /private/new.sql --expected-build-sha <full-sha>",
    );
  }
  const values = Object.fromEntries(
    flags.map((flag) => [flag, args[args.indexOf(flag) + 1]]),
  );
  const [head, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }),
    execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: root, encoding: "utf8" },
    ),
  ]);
  validatePinnedCheckout({
    expectedBuildSha: values["--expected-build-sha"],
    actualHead: head.stdout.trim(),
    status: status.stdout,
  });
  const [migrations, manifest, baseline, recoveryEvidence, catalogQuery] =
    await Promise.all([
      loadMigrations(),
      loadCompiledManifest(),
      privateJson(values["--baseline"]),
      privateJson(values["--recovery-evidence"]),
      readFile(new URL("./empty-legacy-catalog.sql", import.meta.url), "utf8"),
    ]);
  const result = await writeEmptyLegacyBootstrapSql(
    values["--output"],
    migrations,
    {
      manifest,
      baseline,
      recoveryEvidence,
      catalogQuery,
      expectedBuildSha: values["--expected-build-sha"],
    },
  );
  console.log(JSON.stringify(result));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // Do not echo JSON inputs, catalog text, connection configuration or SQL.
    console.error(
      "Empty-legacy SQL generation refused. Check the private baseline/recovery evidence, exact manifest, clean revision and new private output path.",
    );
    process.exitCode = 1;
  });
}
