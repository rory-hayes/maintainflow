import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonicalJson, sha256, withManifestChecksum } from "./database-restore-evidence-common.mjs";
import { renderOfficialSupabaseRlsHelperBaselineSql } from "./generate-empty-database-bootstrap.mjs";
import { EMPTY_LEGACY_PROJECT_REF, renderEmptyLegacyBootstrapSql } from "./generate-empty-legacy-bootstrap.mjs";
import { loadMigrations } from "./run-database-migrations.mjs";

// Native PostgreSQL17 integration proof. All clusters use private Unix sockets;
// no existing database, hosting credential, provider API or user tab is touched.
// Usage: PG_BIN=/path/to/postgresql17/bin node scripts/verify-empty-legacy-bootstrap.mjs [EVIDENCE_JSON]
const root = fileURLToPath(new URL("..", import.meta.url));
const evidencePath = path.resolve(process.argv[2] ?? path.join(tmpdir(), "maintainflow-empty-legacy-integration.json"));
const execute = promisify(execFile);
const scratch = await mkdtemp(path.join(tmpdir(), "mc-empty-legacy-proof-"));
await chmod(scratch, 0o700);
let pgBin = process.env.PG_BIN ?? "";
if (!pgBin) {
  try { await access("/opt/homebrew/opt/postgresql@17/bin/pg_ctl"); pgBin = "/opt/homebrew/opt/postgresql@17/bin"; } catch { /* Use PATH on other systems. */ }
}
const binary = (name) => pgBin ? path.join(pgBin, name) : name;
const clusters = [];
const checks = [];
let sequence = 0;
const environment = { ...process.env, LC_ALL: "C", LANG: "C" };
const evidence = { scope: "Disposable local PostgreSQL17 only; no hosted upgrade, provider integration or production restore claim.", startedAt: new Date().toISOString(), checks };
async function command(name, args) {
  return (await execute(binary(name), args, { env: environment, maxBuffer: 16 * 1024 * 1024, timeout: 60000 })).stdout;
}
async function sql(cluster, statement, role = "postgres") {
  const file = path.join(scratch, `statement-${++sequence}.sql`);
  await writeFile(file, statement, { mode: 0o600 });
  return command("psql", ["-h", cluster.socket, "-U", role, "-d", "postgres", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", file]);
}
async function cluster(label) {
  const directory = path.join(scratch, label);
  await execute("mkdir", ["-p", directory]);
  const item = { directory, socket: directory, data: path.join(directory, "data"), started: false };
  clusters.push(item);
  await command("initdb", ["-D", item.data, "-U", "supabase_admin", "--auth=trust", "--no-locale", "--encoding=UTF8"]);
  await command("pg_ctl", ["-D", item.data, "-l", path.join(directory, "postgres.log"), "-w", "-t", "30", "-o", `-h '' -k ${item.socket}`, "start"]);
  item.started = true;
  return item;
}
function record(name) { checks.push(name); }
try {
  const version = (await command("pg_dump", ["--version"])).trim();
  assert.match(version, /PostgreSQL\) 17\./);
  evidence.postgres = version;
  const migrations = await loadMigrations({ directory: path.join(root, "docs/database") });
  const manifest = JSON.parse(await readFile(path.join(root, "src/lib/database/migration-manifest.json"), "utf8"));
  assert.equal(manifest.length, 27);
  const query = (await readFile(path.join(root, "scripts/empty-legacy-catalog.sql"), "utf8")).trim().replace(/;\s*$/, "");
  const inspect = async (db) => JSON.parse(await sql(db, `begin read only; set local row_security=off; ${query}; rollback;`));
  const source = await cluster("source");
  await sql(source, "create role postgres login superuser; alter database postgres owner to postgres;", "supabase_admin");
  const prefix = migrations.slice(0, 18).map((migration) => `${migration.sql}\ninsert into public.maintainflow_schema_migrations(migration_name,checksum_sha256) values ('${migration.name}','${migration.checksumSha256}');`).join("\n");
  await sql(source, `begin;
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create role maintainflow_app login noinherit bypassrls connection limit 10;
alter role maintainflow_app set search_path=pg_catalog,public;
alter role maintainflow_app set statement_timeout='20s';
alter role maintainflow_app set lock_timeout='18s';
alter role maintainflow_app set idle_in_transaction_session_timeout='30s';
grant maintainflow_app to postgres with admin true,inherit false,set false granted by supabase_admin;
create schema auth;
create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
create table auth.identities(id uuid primary key);
create table auth.sessions(id uuid primary key);
create schema storage;
create table storage.buckets(id text primary key);
create table storage.objects(id uuid primary key);
${renderOfficialSupabaseRlsHelperBaselineSql()}
create table public.maintainflow_schema_migrations(migration_name text primary key check(migration_name ~ '^[0-9]{3}_[a-z0-9][a-z0-9_-]*[.]sql$'),checksum_sha256 text not null check(checksum_sha256 ~ '^[a-f0-9]{64}$'),applied_at timestamptz not null default now());
${prefix}
grant usage on schema public to maintainflow_app;
grant connect on database postgres to maintainflow_app;
grant select,insert,update,delete on all tables in schema public to maintainflow_app;
commit;`);
  const original = await inspect(source);
  assert.equal(original.migrationLedger.length, 18);
  assert.equal(original.applicationCatalog.relations.length, 16);
  assert.ok(Object.values(original.applicationRowCounts).every((count) => count === 0));
  assert.ok(Object.values(original.emptyCounts).every((count) => count === 0));
  record("Checksum-verified001–018 with the actual pinned Supabase RLS helper and an empty provider fixture");

  const rolesFile = path.join(scratch, "roles.sql");
  const dumpFile = path.join(scratch, "baseline.dump");
  await command("pg_dumpall", ["-h", source.socket, "-U", "supabase_admin", "--roles-only", "--no-role-passwords", "-f", rolesFile]);
  await command("pg_dump", ["-h", source.socket, "-U", "postgres", "-d", "postgres", "--create", "-Fc", "-f", dumpFile]);
  await chmod(rolesFile, 0o600); await chmod(dumpFile, 0o600);
  const target = await cluster("restored");
  const roleDump = await readFile(rolesFile, "utf8");
  assert.equal(roleDump.split("CREATE ROLE supabase_admin;").length, 2);
  await sql(target, roleDump.replace("CREATE ROLE supabase_admin;", "-- Preserve the existing bootstrap role identity."), "supabase_admin");
  await command("pg_restore", ["-h", target.socket, "-U", "supabase_admin", "-d", "template1", "--create", "--clean", "--if-exists", "--exit-on-error", dumpFile]);
  assert.deepEqual(await inspect(target), original);
  record("Actual dump/restore preserves the full catalog, database ACLs, roles, memberships and empty state");
  evidence.schemaDumpSha256 = sha256(await readFile(dumpFile));
  evidence.rolesDumpSha256 = sha256(roleDump);
  evidence.migrationManifestSha256 = sha256(canonicalJson(manifest));

  const now = new Date();
  const baseline = { kind: "maintainflow.empty_legacy_baseline", version: 1, projectRef: EMPTY_LEGACY_PROJECT_REF, capturedAt: now.toISOString(), catalog: original, localFixture: true };
  const recoveryEvidence = withManifestChecksum({ kind: "maintainflow.empty_legacy_local_recovery", version: 1, projectRef: EMPTY_LEGACY_PROJECT_REF, baselineSha256: sha256(canonicalJson(baseline)), migrationManifestSha256: evidence.migrationManifestSha256, completedAt: now.toISOString(), checks: { canonicalPrefixMatches: true, localSchemaRestoreMatches: true, localRoleAclRestoreMatches: true, emptyState: true }, localFixture: true });
  const options = { manifest, expectedBuildSha: "0".repeat(40), baseline, recoveryEvidence, catalogQuery: query, now };
  const upgrade = renderEmptyLegacyBootstrapSql(migrations, options);
  await sql(target, "alter role postgres nosuperuser createrole createdb replication bypassrls;", "supabase_admin");
  const actor = JSON.parse(await sql(target, "select jsonb_build_object('role',current_user,'superuser',rolsuper,'createRole',rolcreaterole,'bypassRls',rolbypassrls) from pg_roles where rolname=current_user;"));
  assert.deepEqual(actor, { role: "postgres", superuser: false, createRole: true, bypassRls: true });
  evidence.migrationActor = actor;
  const fixtures = [
    ["existing application data", "insert into public.maintainflow_organizations(id,name,customer_type,status) values('11111111-1111-4111-8111-111111111111','Local retained-state test','advertiser','active');"],
    ["Auth user data", "insert into auth.users(id) values('11111111-1111-4111-8111-111111111111');"],
    ["Auth identity data", "insert into auth.identities(id) values('11111111-1111-4111-8111-111111111111');"],
    ["Auth session data", "insert into auth.sessions(id) values('11111111-1111-4111-8111-111111111111');"],
    ["Storage bucket data", "insert into storage.buckets(id) values('local-retained-state');"],
    ["Storage object data", "insert into storage.objects(id) values('11111111-1111-4111-8111-111111111111');"],
    ["ledger checksum drift", "update public.maintainflow_schema_migrations set checksum_sha256=repeat('0',64) where migration_name='001_ads_approval_records.sql';"],
    ["column drift", "alter table public.maintainflow_organizations add column local_review_note text;"],
    ["unexpected table rule", "create rule local_review_rule as on insert to public.maintainflow_organizations do also nothing;"],
    ["unexpected table privilege", "grant select on public.maintainflow_organizations to anon;"],
    ["unexpected database privilege", "grant create on database postgres to maintainflow_app;"],
    ["legacy default privilege", "alter default privileges in schema public grant select on tables to maintainflow_app;"],
    ["incoming role access", "create role local_review_role nologin; grant maintainflow_app to local_review_role with inherit true,set true;"],
  ];
  for (const [name, mutation] of fixtures) {
    let refusal;
    try { await sql(target, `begin; ${mutation}\n${upgrade}`); } catch (error) { refusal = error; }
    assert.ok(refusal, `${name} must refuse the upgrade`);
    assert.match(refusal.stderr ?? "", /Empty-legacy bootstrap refused:/, `${name} must reach the intended guard`);
    assert.deepEqual(await inspect(target), original, `${name} must roll back every fixture and migration change`);
    record(`Refuses ${name}; exact baseline restored by rollback`);
  }
  assert.match(upgrade, /commit;\s*$/);
  const failBeforeCommit = upgrade.replace(/commit;\s*$/, () => "do $$ begin raise exception 'EXPECTED_LOCAL_POST_UPGRADE_ROLLBACK'; end $$;\ncommit;");
  let postUpgradeFailure;
  try { await sql(target, failBeforeCommit); } catch (error) { postUpgradeFailure = error; }
  assert.ok(postUpgradeFailure, "A post-retirement failure must prevent commit");
  assert.match(postUpgradeFailure.stderr ?? "", /EXPECTED_LOCAL_POST_UPGRADE_ROLLBACK/);
  assert.deepEqual(await inspect(target), original, "All suffix DDL, ledger changes and role retirement must roll back");
  record("Failure after suffix and role retirement restores the exact18-ledger baseline, legacy role flags and absent new role");
  await sql(target, upgrade);
  const installed = JSON.parse(await sql(target, "select jsonb_build_object('ledger',(select count(*) from public.maintainflow_schema_migrations),'tables',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'),'legacyLogin',(select rolcanlogin from pg_roles where rolname='maintainflow_app'),'legacyBypass',(select rolbypassrls from pg_roles where rolname='maintainflow_app'),'newLogin',(select rolcanlogin from pg_roles where rolname='maintaincode_app'),'siteRls',(select relrowsecurity from pg_class where oid='public.maintaincode_sites'::regclass));"));
  assert.deepEqual(installed, { ledger: 27, tables: 24, legacyLogin: false, legacyBypass: false, newLogin: false, siteRls: true });
  record("019–027 commits as the observed non-superuser migration actor and atomically retires the legacy role");

  // Reuse every actual runtime/verifier assertion. Only its hosted transport is
  // replaced with this owned Unix socket; all identity, RLS, CRUD, encryption,
  // notification, queue and rollback assertions remain unchanged.
  await sql(target, "alter role maintaincode_app login;");
  const originalVerifier = path.join(root, "scripts/verify-maintaincode-database.mjs");
  let adapted = await readFile(originalVerifier, "utf8");
  const connectionLine = "const sql = runtime.getRuntimeDatabase(config.DATABASE_URL);";
  assert.equal(adapted.split(connectionLine).length, 2);
  adapted = adapted.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(originalVerifier).href));
  adapted = `import postgres from 'postgres';\nlet privateFixtureSql;\n${adapted}`;
  adapted = adapted.replace(connectionLine, `const sql = privateFixtureSql = postgres({host:${JSON.stringify(target.socket)},username:'maintaincode_app',database:'postgres',max:1,prepare:false});`);
  adapted = adapted.replace("await runtime?.closeRuntimeDatabase();", "await runtime?.closeRuntimeDatabase(); await privateFixtureSql?.end({timeout:5});");
  const adaptedFile = path.join(scratch, "local-runtime-verifier.mjs");
  await writeFile(adaptedFile, adapted, { mode: 0o600 });
  await symlink(path.join(root, "node_modules"), path.join(scratch, "node_modules"));
  const configFile = path.join(scratch, "local-config.json");
  await writeFile(configFile, JSON.stringify({ DATABASE_URL: `postgres://maintaincode_app@db.${EMPTY_LEGACY_PROJECT_REF}.supabase.co/postgres?sslmode=verify-full`, NEXT_PUBLIC_SUPABASE_URL: `https://${EMPTY_LEGACY_PROJECT_REF}.supabase.co`, MAINTAINFLOW_DATABASE_CA_CERT: "LOCAL_TRANSPORT_ONLY", MAINTAINFLOW_CREDENTIAL_KEYRING: JSON.stringify({ fixture: randomBytes(32).toString("base64") }), MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID: "fixture" }), { mode: 0o600 });
  const result = await execute(process.execPath, [adaptedFile, configFile, EMPTY_LEGACY_PROJECT_REF, "--require-queue", "--require-notifications"], { env: environment, maxBuffer: 4 * 1024 * 1024, timeout: 60000 });
  const runtime = JSON.parse(result.stdout);
  assert.equal(runtime.ok, true);
  evidence.runtime = { ...runtime, project: "local_fixture", checks: runtime.checks.map((name) => name === "restricted runtime role and verified TLS connection" ? "restricted runtime role over a private local socket; hosted TLS not exercised" : name), scope: "Owned Unix socket transport; not hosted TLS or Supabase Auth proof" };
  record("Actual runtime verifier passes global registry reads, scoped site writes, tenant isolation, encryption, queue and rollback checks");
  evidence.ok = true;
} catch (error) {
  evidence.ok = false;
  evidence.error = { name: error.name, message: error.message?.slice(0, 2000), stderr: error.stderr?.slice(-3000) };
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  for (const item of clusters.reverse()) {
    if (item.started) {
      try { await command("pg_ctl", ["-D", item.data, "-m", "fast", "-w", "stop"]); }
      catch (error) { cleanupErrors.push(error.message); }
    }
  }
  evidence.completedAt = new Date().toISOString();
  evidence.cleanup = { stoppedClusters: clusters.length, failures: cleanupErrors.length, ownedFilesRemoved: cleanupErrors.length === 0 };
  if (cleanupErrors.length) { evidence.ok = false; process.exitCode = 1; }
  else await rm(scratch, { recursive: true, force: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ ok: evidence.ok, checks: checks.length, evidencePath, cleanup: evidence.cleanup, error: evidence.error }, null, 2));
}
