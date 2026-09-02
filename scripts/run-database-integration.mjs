import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  loadCompiledManifest,
  renderEmptyDatabaseBootstrapSql,
} from "./generate-empty-database-bootstrap.mjs";
import { loadMigrations } from "./run-database-migrations.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

function isLoopbackHostname(hostname) {
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (unbracketedHostname === "localhost" || unbracketedHostname === "::1") {
    return true;
  }
  return (
    isIP(unbracketedHostname) === 4 &&
    unbracketedHostname.split(".")[0] === "127"
  );
}

function disposableAdminDatabaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "MAINTAINFLOW_TEST_ADMIN_DATABASE_URL must be a valid PostgreSQL URL for a disposable local /postgres admin database.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !isLoopbackHostname(parsed.hostname) ||
    parsed.pathname !== "/postgres" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error(
      "Refusing database integration outside a loopback disposable /postgres admin database; use a postgres:// URL on localhost, a full four-component 127.x.x.x address, or ::1 without query parameters or fragments.",
    );
  }
  return parsed.toString();
}

const adminDatabaseUrl = disposableAdminDatabaseUrl(
  process.env.MAINTAINFLOW_TEST_ADMIN_DATABASE_URL ??
    "postgres://localhost/postgres",
);
const databaseNamePrefix = `maintainflow_ads_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
const migrationDatabaseName = `${databaseNamePrefix}_migrations`;
const emptyBootstrapDatabaseName = `${databaseNamePrefix}_empty`;
const supabaseBootstrapDatabaseName = `${databaseNamePrefix}_supabase`;
const quotedMigrationDatabaseName = `"${migrationDatabaseName}"`;
const quotedEmptyBootstrapDatabaseName = `"${emptyBootstrapDatabaseName}"`;
const quotedSupabaseBootstrapDatabaseName = `"${supabaseBootstrapDatabaseName}"`;
const admin = postgres(adminDatabaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
  prepare: false,
});
const clusterFixtureLock = postgres(adminDatabaseUrl, {
  connect_timeout: 5,
  idle_timeout: 0,
  max: 1,
  prepare: false,
});
const dataApiRoleNames = ["anon", "authenticated", "service_role"];
const createdDataApiRoleNames = [];
let createdPostgresRole = false;
const alternateEventTriggerOwnerRoleName = `maintainflow_fixture_owner_${randomBytes(4).toString("hex")}`;
let createdAlternateEventTriggerOwnerRole = false;
let clusterFixtureLockAcquired = false;

// Independent fixture copied from the pinned official Supabase source rather
// than rendered by the implementation under test. Its pg_proc.prosrc is 953
// bytes with MD5 99be20677b456ea8d3be47bdd44fb369.
// https://github.com/supabase/supabase/blob/2bc6144aecfab2de97c5210d14aee85a34565535/apps/docs/content/guides/database/postgres/row-level-security.mdx
const officialSupabaseRlsFunctionFixtureSql = `create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $supabase_rls_fixture$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$supabase_rls_fixture$;`;
const officialSupabaseRlsBaselineFixtureSql = `${officialSupabaseRlsFunctionFixtureSql}

drop event trigger if exists ensure_rls;
create event trigger ensure_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable();`;

function withoutProviderCredentials(environment) {
  delete environment.OPENAI_ADS_API_KEY;
  delete environment.OPENAI_CONVERSIONS_API_KEY;
  delete environment.OPENAI_CONVERSIONS_PIXEL_ID;
  delete environment.OPENAI_CONVERSIONS_ACCOUNT_ID;
  return environment;
}

function runChild(command, args, environment, stoppedMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${stoppedMessage} ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

async function verifyDisposableAdminConnection() {
  const [capability] = await admin`
    select pg_catalog.current_database() as database_name,
      current_user as user_name,
      role.rolsuper
    from pg_catalog.pg_roles role
    where role.rolname = current_user
  `;
  if (capability?.database_name !== "postgres" || capability.rolsuper !== true) {
    throw new Error(
      `Database integration requires a superuser connection to the disposable loopback /postgres admin database; connected as ${capability?.user_name ?? "unknown"} to ${capability?.database_name ?? "unknown"}.`,
    );
  }
}

async function ensureDataApiRoles() {
  for (const roleName of dataApiRoleNames) {
    const [role] = await admin`
      select exists (
        select 1
        from pg_catalog.pg_roles
        where rolname = ${roleName}
      ) as exists
    `;
    if (!role?.exists) {
      await admin.unsafe(`create role "${roleName}" nologin`);
      createdDataApiRoleNames.push(roleName);
    }
  }
}

async function acquireClusterFixtureLock() {
  await clusterFixtureLock.unsafe(
    "select pg_catalog.pg_advisory_lock(-635039337, 1107438068)",
  );
  clusterFixtureLockAcquired = true;
}

async function ensurePostgresOwnerRole() {
  const [role] = await admin`
    select exists (
      select 1
      from pg_catalog.pg_roles
      where rolname = 'postgres'
    ) as exists
  `;
  if (!role?.exists) {
    // PostgreSQL only permits a superuser to own an event trigger. This role
    // exists solely inside the serialized disposable-cluster fixture.
    await admin.unsafe('create role "postgres" superuser nologin');
    createdPostgresRole = true;
  }
}

async function ensureAlternateEventTriggerOwnerRole() {
  await admin.unsafe(
    `create role "${alternateEventTriggerOwnerRoleName}" superuser nologin`,
  );
  createdAlternateEventTriggerOwnerRole = true;
}

function runMigrations(databaseUrl) {
  const migrationPath = fileURLToPath(
    new URL("./run-database-migrations.mjs", import.meta.url),
  );
  const migrationEnvironment = withoutProviderCredentials({
    ...process.env,
    DATABASE_URL: databaseUrl,
    MAINTAINFLOW_APPLY_DATABASE_MIGRATIONS: "true",
    MAINTAINFLOW_DATABASE_BACKUP_RESTORE_VERIFIED: "true",
  });
  return runChild(
    process.execPath,
    [migrationPath],
    migrationEnvironment,
    "Database migration process stopped with",
  );
}

async function verifyMigrationLedger(databaseUrl, verificationContext) {
  const migrations = await loadMigrations();
  const database = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  try {
    const rows = await database`
      select migration_name, checksum_sha256
      from public.maintainflow_schema_migrations
      order by migration_name
    `;
    const expected = migrations.map((migration) => ({
      migration_name: migration.name,
      checksum_sha256: migration.checksumSha256,
    }));
    if (JSON.stringify(rows) !== JSON.stringify(expected)) {
      throw new Error(
        "The disposable database migration ledger did not match the checkout.",
      );
    }
    console.log(
      `Verified ${rows.length} checksum ledger rows ${verificationContext}.`,
    );
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function loadBootstrapSql() {
  const migrations = await loadMigrations();
  const manifest = await loadCompiledManifest();
  return renderEmptyDatabaseBootstrapSql(migrations, {
    manifest,
    expectedBuildSha: "0".repeat(40),
  });
}

function disposableDatabaseUrl(databaseName) {
  const databaseUrl = new URL(adminDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}

function databaseClient(databaseUrl) {
  return postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
}

async function applyEmptyBootstrap(databaseUrl, bootstrapSql) {
  const database = databaseClient(databaseUrl);
  try {
    await database.unsafe(bootstrapSql);
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function installHostedPlatformEventTriggerFixture(databaseUrl) {
  const database = databaseClient(databaseUrl);
  try {
    await database.unsafe(`create schema if not exists extensions;
create function extensions.maintainflow_platform_trigger_fixture()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog
as $platform_trigger_fixture$
begin
  null;
end;
$platform_trigger_fixture$;
create event trigger maintainflow_platform_trigger_fixture
on ddl_command_end
when tag in ('CREATE EXTENSION')
execute function extensions.maintainflow_platform_trigger_fixture()`);
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function hostedPlatformEventTriggerFingerprint(databaseUrl) {
  const database = databaseClient(databaseUrl);
  try {
    const functions = await database`
      select namespace.nspname as function_schema,
        procedure.proname as function_name,
        pg_catalog.pg_get_function_identity_arguments(procedure.oid) as identity_arguments,
        owner_role.rolname as owner_name,
        language.lanname as language_name,
        procedure.prorettype = 'pg_catalog.event_trigger'::pg_catalog.regtype as returns_event_trigger,
        procedure.proretset,
        procedure.provolatile,
        procedure.proisstrict,
        procedure.prosecdef,
        procedure.proleakproof,
        procedure.proparallel,
        procedure.proconfig,
        procedure.prosrc,
        (
          select count(*)::integer
          from pg_catalog.pg_depend extension_dependency
          where extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
            and extension_dependency.objid = procedure.oid
            and extension_dependency.deptype = 'e'
        ) as extension_dependency_count
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid = procedure.pronamespace
      join pg_catalog.pg_roles owner_role
        on owner_role.oid = procedure.proowner
      join pg_catalog.pg_language language
        on language.oid = procedure.prolang
      where namespace.nspname = 'extensions'
        and procedure.proname = 'maintainflow_platform_trigger_fixture'
        and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
    `;
    const eventTriggers = await database`
      select event_trigger.evtname as trigger_name,
        event_trigger.evtevent,
        event_trigger.evtenabled,
        event_trigger.evttags,
        trigger_owner.rolname as owner_name,
        namespace.nspname as function_schema,
        procedure.proname as function_name,
        pg_catalog.pg_get_function_identity_arguments(procedure.oid) as function_identity_arguments,
        (
          select count(*)::integer
          from pg_catalog.pg_depend extension_dependency
          where extension_dependency.classid = 'pg_catalog.pg_event_trigger'::pg_catalog.regclass
            and extension_dependency.objid = event_trigger.oid
            and extension_dependency.deptype = 'e'
        ) as extension_dependency_count
      from pg_catalog.pg_event_trigger event_trigger
      join pg_catalog.pg_roles trigger_owner
        on trigger_owner.oid = event_trigger.evtowner
      join pg_catalog.pg_proc procedure
        on procedure.oid = event_trigger.evtfoid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = procedure.pronamespace
      where event_trigger.evtname = 'maintainflow_platform_trigger_fixture'
    `;
    if (functions.length !== 1 || eventTriggers.length !== 1) {
      throw new Error(
        `Expected exactly one hosted-platform fixture function and trigger, found ${functions.length} function(s) and ${eventTriggers.length} trigger(s).`,
      );
    }
    return {
      function: functions[0],
      event_trigger: eventTriggers[0],
    };
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function verifyHostedPlatformEventTriggerPreserved(
  databaseUrl,
  beforeFingerprint,
  bootstrapDescription,
) {
  const afterFingerprint =
    await hostedPlatformEventTriggerFingerprint(databaseUrl);
  if (JSON.stringify(afterFingerprint) !== JSON.stringify(beforeFingerprint)) {
    throw new Error(
      `The hosted-platform event trigger or function changed during ${bootstrapDescription}. Before: ${JSON.stringify(beforeFingerprint)}. After: ${JSON.stringify(afterFingerprint)}.`,
    );
  }
  console.log(
    `Verified the complete hosted-platform trigger/function fingerprint after ${bootstrapDescription}.`,
  );
}

async function expectEmptyBootstrapRefusal(
  databaseUrl,
  bootstrapSql,
  acceptedStateDescription,
) {
  const bootstrap = databaseClient(databaseUrl);
  let refused = false;
  try {
    await bootstrap.unsafe(bootstrapSql);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("public schema is not pristine")
    ) {
      refused = true;
    } else {
      throw error;
    }
  } finally {
    await bootstrap.end({ timeout: 5 });
  }
  if (!refused) {
    throw new Error(
      `The empty hosted bootstrap accepted ${acceptedStateDescription}.`,
    );
  }
}

async function clearSupabaseRlsHelperBaseline(databaseUrl) {
  const database = databaseClient(databaseUrl);
  try {
    await database.unsafe("drop event trigger if exists ensure_rls");
    await database.unsafe("drop event trigger if exists ensure_rls_extra");
    await database.unsafe(
      "drop function if exists public.rls_auto_enable()",
    );
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function verifySupabaseRlsHelperAbsent(databaseUrl, testStage) {
  const database = databaseClient(databaseUrl);
  try {
    const [state] = await database`
      select (
          select count(*)::integer
          from pg_catalog.pg_proc procedure
          join pg_catalog.pg_namespace namespace
            on namespace.oid = procedure.pronamespace
          where namespace.nspname = 'public'
            and procedure.proname = 'rls_auto_enable'
            and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
        ) as helper_count,
        (
          select count(*)::integer
          from pg_catalog.pg_event_trigger event_trigger
          where event_trigger.evtname = 'ensure_rls'
        ) as trigger_count
    `;
    if (state?.helper_count !== 0 || state.trigger_count !== 0) {
      throw new Error(
        `The ${testStage} database unexpectedly contains the Supabase RLS helper baseline: ${JSON.stringify(state)}.`,
      );
    }
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function installSupabaseRlsHelperFunction(databaseUrl, functionSql) {
  const database = databaseClient(databaseUrl);
  try {
    await database.unsafe(functionSql);
    await database.unsafe(
      "alter function public.rls_auto_enable() owner to postgres",
    );
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function installSupabaseRlsHelperBaseline(databaseUrl) {
  const database = databaseClient(databaseUrl);
  try {
    await database.unsafe(officialSupabaseRlsBaselineFixtureSql);
    await database.unsafe(
      "alter function public.rls_auto_enable() owner to postgres",
    );
    await database.unsafe("alter event trigger ensure_rls owner to postgres");
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function verifyBootstrapGuardVariants(databaseUrl, bootstrapSql) {
  const database = databaseClient(databaseUrl);
  try {
    await database`create type public.bootstrap_extra as (value text)`;
  } finally {
    await database.end({ timeout: 5 });
  }
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "a public composite type",
  );
  const compositeCleanup = databaseClient(databaseUrl);
  try {
    await compositeCleanup`drop type public.bootstrap_extra`;
  } finally {
    await compositeCleanup.end({ timeout: 5 });
  }

  await installSupabaseRlsHelperFunction(
    databaseUrl,
    officialSupabaseRlsFunctionFixtureSql,
  );
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "the official Supabase RLS helper without its event trigger",
  );
  await clearSupabaseRlsHelperBaseline(databaseUrl);

  const tamperedFunctionSql = officialSupabaseRlsFunctionFixtureSql.replace(
    "rls_auto_enable: enabled RLS on %",
    "rls_auto_enable: enabled tampered RLS on %",
  );
  await installSupabaseRlsHelperFunction(databaseUrl, tamperedFunctionSql);
  const tamperedTrigger = databaseClient(databaseUrl);
  try {
    await tamperedTrigger.unsafe(`create event trigger ensure_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable()`);
    await tamperedTrigger.unsafe(
      "alter event trigger ensure_rls owner to postgres",
    );
  } finally {
    await tamperedTrigger.end({ timeout: 5 });
  }
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "a tampered Supabase RLS helper",
  );
  await clearSupabaseRlsHelperBaseline(databaseUrl);

  const setReturningFunctionSql = officialSupabaseRlsFunctionFixtureSql.replace(
    "returns event_trigger",
    "returns setof event_trigger",
  );
  await installSupabaseRlsHelperFunction(databaseUrl, setReturningFunctionSql);
  const setReturningTrigger = databaseClient(databaseUrl);
  try {
    await setReturningTrigger.unsafe(`create event trigger ensure_rls
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable()`);
    await setReturningTrigger.unsafe(
      "alter event trigger ensure_rls owner to postgres",
    );
  } finally {
    await setReturningTrigger.end({ timeout: 5 });
  }
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "a set-returning Supabase RLS helper variant",
  );
  await clearSupabaseRlsHelperBaseline(databaseUrl);

  await installSupabaseRlsHelperBaseline(databaseUrl);
  const extraObject = databaseClient(databaseUrl);
  try {
    await extraObject`create type public.bootstrap_extra as (value text)`;
  } finally {
    await extraObject.end({ timeout: 5 });
  }
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "the official Supabase RLS helper baseline plus an extra public object",
  );
  const extraObjectCleanup = databaseClient(databaseUrl);
  try {
    await extraObjectCleanup`drop type public.bootstrap_extra`;
  } finally {
    await extraObjectCleanup.end({ timeout: 5 });
  }

  const extraEventTrigger = databaseClient(databaseUrl);
  try {
    await extraEventTrigger.unsafe(`create event trigger ensure_rls_extra
on ddl_command_end
when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
execute function public.rls_auto_enable()`);
  } finally {
    await extraEventTrigger.end({ timeout: 5 });
  }
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "the official Supabase RLS helper baseline plus an extra event trigger",
  );
  const extraEventTriggerCleanup = databaseClient(databaseUrl);
  try {
    await extraEventTriggerCleanup.unsafe(
      "drop event trigger ensure_rls_extra",
    );
  } finally {
    await extraEventTriggerCleanup.end({ timeout: 5 });
  }

  const wrongTriggerOwner = databaseClient(databaseUrl);
  try {
    await wrongTriggerOwner.unsafe(
      `alter event trigger ensure_rls owner to "${alternateEventTriggerOwnerRoleName}"`,
    );
  } finally {
    await wrongTriggerOwner.end({ timeout: 5 });
  }
  await expectEmptyBootstrapRefusal(
    databaseUrl,
    bootstrapSql,
    "the Supabase RLS helper baseline with a changed event-trigger owner",
  );
  const triggerOwnerCleanup = databaseClient(databaseUrl);
  try {
    await triggerOwnerCleanup.unsafe(
      "alter event trigger ensure_rls owner to postgres",
    );
  } finally {
    await triggerOwnerCleanup.end({ timeout: 5 });
  }

  console.log(
    "Verified bootstrap refusal for composite, helper-only, tampered-helper, set-returning-helper, extra-object, extra-trigger, and wrong-trigger-owner states.",
  );
}

async function verifySupabaseRlsHelperPreserved(databaseUrl) {
  const database = databaseClient(databaseUrl);
  try {
    const [helper] = await database`
      select owner_role.rolname as owner_name,
        language.lanname as language_name,
        procedure.prorettype = 'pg_catalog.event_trigger'::pg_catalog.regtype as returns_event_trigger,
        procedure.proretset,
        procedure.provolatile,
        procedure.proisstrict,
        procedure.prosecdef,
        procedure.proleakproof,
        procedure.proparallel,
        procedure.proconfig,
        pg_catalog.length(procedure.prosrc)::integer as source_length,
        pg_catalog.md5(procedure.prosrc) as source_md5,
        count(extension_dependency.objid)::integer as extension_dependency_count
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid = procedure.pronamespace
      join pg_catalog.pg_roles owner_role
        on owner_role.oid = procedure.proowner
      join pg_catalog.pg_language language
        on language.oid = procedure.prolang
      left join pg_catalog.pg_depend extension_dependency
        on extension_dependency.classid = 'pg_catalog.pg_proc'::pg_catalog.regclass
        and extension_dependency.objid = procedure.oid
        and extension_dependency.deptype = 'e'
      where namespace.nspname = 'public'
        and procedure.proname = 'rls_auto_enable'
        and pg_catalog.pg_get_function_identity_arguments(procedure.oid) = ''
      group by owner_role.rolname,
        language.lanname,
        procedure.prorettype,
        procedure.proretset,
        procedure.provolatile,
        procedure.proisstrict,
        procedure.prosecdef,
        procedure.proleakproof,
        procedure.proparallel,
        procedure.proconfig,
        procedure.prosrc
    `;
    const [eventTrigger] = await database`
      select event_trigger.evtevent,
        event_trigger.evtenabled,
        event_trigger.evttags,
        event_trigger_owner.rolname as owner_name,
        namespace.nspname as function_schema,
        procedure.proname as function_name,
        count(extension_dependency.objid)::integer as extension_dependency_count
      from pg_catalog.pg_event_trigger event_trigger
      join pg_catalog.pg_proc procedure
        on procedure.oid = event_trigger.evtfoid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = procedure.pronamespace
      join pg_catalog.pg_roles event_trigger_owner
        on event_trigger_owner.oid = event_trigger.evtowner
      left join pg_catalog.pg_depend extension_dependency
        on extension_dependency.classid = 'pg_catalog.pg_event_trigger'::pg_catalog.regclass
        and extension_dependency.objid = event_trigger.oid
        and extension_dependency.deptype = 'e'
      where event_trigger.evtname = 'ensure_rls'
      group by event_trigger.evtevent,
        event_trigger.evtenabled,
        event_trigger.evttags,
        event_trigger_owner.rolname,
        namespace.nspname,
        procedure.proname
    `;
    const expectedHelper = {
      owner_name: "postgres",
      language_name: "plpgsql",
      returns_event_trigger: true,
      proretset: false,
      provolatile: "v",
      proisstrict: false,
      prosecdef: true,
      proleakproof: false,
      proparallel: "u",
      proconfig: ["search_path=pg_catalog"],
      source_length: 953,
      source_md5: "99be20677b456ea8d3be47bdd44fb369",
      extension_dependency_count: 0,
    };
    const expectedEventTrigger = {
      evtevent: "ddl_command_end",
      evtenabled: "O",
      evttags: ["CREATE TABLE", "CREATE TABLE AS", "SELECT INTO"],
      owner_name: "postgres",
      function_schema: "public",
      function_name: "rls_auto_enable",
      extension_dependency_count: 0,
    };
    if (JSON.stringify(helper) !== JSON.stringify(expectedHelper)) {
      throw new Error(
        `The Supabase RLS helper changed during bootstrap: ${JSON.stringify(helper)}.`,
      );
    }
    if (JSON.stringify(eventTrigger) !== JSON.stringify(expectedEventTrigger)) {
      throw new Error(
        `The Supabase ensure_rls trigger changed during bootstrap: ${JSON.stringify(eventTrigger)}.`,
      );
    }
    await database`create table public.maintainflow_rls_trigger_probe (id integer)`;
    const [rlsProbe] = await database`
      select relation.relrowsecurity
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = 'maintainflow_rls_trigger_probe'
    `;
    if (rlsProbe?.relrowsecurity !== true) {
      throw new Error(
        "The preserved Supabase RLS helper did not enable RLS on a newly created public table.",
      );
    }
    await database`drop table public.maintainflow_rls_trigger_probe`;
  } finally {
    await database.end({ timeout: 5 });
  }
  console.log(
    "Verified that bootstrap preserves the exact, working Supabase RLS helper baseline.",
  );
}

async function seedLooseDataApiSchemaPrivileges(databaseUrl) {
  const database = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  try {
    await database.unsafe("grant usage, create on schema public to public");
    for (const roleName of dataApiRoleNames) {
      await database.unsafe(
        `grant usage, create on schema public to "${roleName}"`,
      );
    }
  } finally {
    await database.end({ timeout: 5 });
  }
}

function runVitest(databaseUrl) {
  const vitestPath = fileURLToPath(
    new URL("../node_modules/vitest/vitest.mjs", import.meta.url),
  );
  const testEnvironment = withoutProviderCredentials({
    ...process.env,
    DATABASE_URL: databaseUrl,
    MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID: "integration",
    MAINTAINFLOW_CREDENTIAL_KEYRING: JSON.stringify({
      integration: randomBytes(32).toString("base64"),
    }),
    READINESS_RATE_LIMIT_SECRET: randomBytes(32).toString("base64"),
  });

  return runChild(
    process.execPath,
    [vitestPath, "run", "--config", "vitest.integration.config.mjs"],
    testEnvironment,
    "Database integration tests stopped with",
  );
}

async function captureCleanupFailure(cleanupErrors, description, action) {
  try {
    await action();
  } catch (error) {
    cleanupErrors.push(
      new Error(`Failed to ${description}.`, {
        cause: error,
      }),
    );
  }
}

async function cleanupDatabaseIntegrationFixtures() {
  const cleanupErrors = [];
  await captureCleanupFailure(
    cleanupErrors,
    "terminate disposable database connections",
    async () => {
      await admin`
        select pg_catalog.pg_terminate_backend(pid)
        from pg_catalog.pg_stat_activity
        where datname in (
          ${migrationDatabaseName},
          ${emptyBootstrapDatabaseName},
          ${supabaseBootstrapDatabaseName}
        )
          and pid <> pg_catalog.pg_backend_pid()
      `;
    },
  );
  for (const [databaseName, quotedDatabaseName] of [
    [migrationDatabaseName, quotedMigrationDatabaseName],
    [emptyBootstrapDatabaseName, quotedEmptyBootstrapDatabaseName],
    [supabaseBootstrapDatabaseName, quotedSupabaseBootstrapDatabaseName],
  ]) {
    await captureCleanupFailure(
      cleanupErrors,
      `drop disposable database ${databaseName}`,
      async () => {
        await admin.unsafe(`drop database if exists ${quotedDatabaseName}`);
      },
    );
  }
  if (createdAlternateEventTriggerOwnerRole) {
    await captureCleanupFailure(
      cleanupErrors,
      `drop temporary role ${alternateEventTriggerOwnerRoleName}`,
      async () => {
        await admin.unsafe(
          `drop role if exists "${alternateEventTriggerOwnerRoleName}"`,
        );
      },
    );
  }
  for (const roleName of [...createdDataApiRoleNames].reverse()) {
    await captureCleanupFailure(
      cleanupErrors,
      `drop temporary role ${roleName}`,
      async () => {
        await admin.unsafe(`drop role if exists "${roleName}"`);
      },
    );
  }
  if (createdPostgresRole) {
    await captureCleanupFailure(
      cleanupErrors,
      "drop the temporary postgres owner role",
      async () => {
        await admin.unsafe('drop role if exists "postgres"');
      },
    );
  }
  if (clusterFixtureLockAcquired) {
    await captureCleanupFailure(
      cleanupErrors,
      "release the database integration fixture lock",
      async () => {
        const [unlock] = await clusterFixtureLock.unsafe(
          "select pg_catalog.pg_advisory_unlock(-635039337, 1107438068) as unlocked",
        );
        if (unlock?.unlocked !== true) {
          throw new Error("The fixture lock was not owned by its lock session.");
        }
      },
    );
  }
  await captureCleanupFailure(
    cleanupErrors,
    "close the fixture-lock connection",
    async () => {
      await clusterFixtureLock.end({ timeout: 5 });
    },
  );
  await captureCleanupFailure(
    cleanupErrors,
    "close the admin connection",
    async () => {
      await admin.end({ timeout: 5 });
    },
  );
  return cleanupErrors;
}

let testExitCode = 1;
let testError;
try {
  await verifyDisposableAdminConnection();
  await acquireClusterFixtureLock();
  await ensureDataApiRoles();
  await ensurePostgresOwnerRole();
  await ensureAlternateEventTriggerOwnerRole();
  const bootstrapSql = await loadBootstrapSql();

  await admin.unsafe(`create database ${quotedEmptyBootstrapDatabaseName}`);
  const emptyBootstrapDatabaseUrl = disposableDatabaseUrl(
    emptyBootstrapDatabaseName,
  );
  await installHostedPlatformEventTriggerFixture(
    emptyBootstrapDatabaseUrl,
  );
  const emptyPlatformFingerprint =
    await hostedPlatformEventTriggerFingerprint(emptyBootstrapDatabaseUrl);
  await applyEmptyBootstrap(emptyBootstrapDatabaseUrl, bootstrapSql);
  await verifyHostedPlatformEventTriggerPreserved(
    emptyBootstrapDatabaseUrl,
    emptyPlatformFingerprint,
    "the truly empty-public bootstrap",
  );
  await verifyMigrationLedger(
    emptyBootstrapDatabaseUrl,
    "after the truly empty-public bootstrap",
  );
  console.log(
    "Verified that the empty bootstrap accepts a truly empty public schema alongside a hosted-platform event trigger.",
  );

  await admin.unsafe(`create database ${quotedSupabaseBootstrapDatabaseName}`);
  const supabaseBootstrapDatabaseUrl = disposableDatabaseUrl(
    supabaseBootstrapDatabaseName,
  );
  await installHostedPlatformEventTriggerFixture(supabaseBootstrapDatabaseUrl);
  const supabasePlatformFingerprint =
    await hostedPlatformEventTriggerFingerprint(supabaseBootstrapDatabaseUrl);
  await verifyBootstrapGuardVariants(
    supabaseBootstrapDatabaseUrl,
    bootstrapSql,
  );
  await applyEmptyBootstrap(supabaseBootstrapDatabaseUrl, bootstrapSql);
  await verifySupabaseRlsHelperPreserved(supabaseBootstrapDatabaseUrl);
  await verifyHostedPlatformEventTriggerPreserved(
    supabaseBootstrapDatabaseUrl,
    supabasePlatformFingerprint,
    "the exact Supabase-helper bootstrap",
  );
  await verifyMigrationLedger(
    supabaseBootstrapDatabaseUrl,
    "after the exact Supabase-helper bootstrap",
  );

  await admin.unsafe(`create database ${quotedMigrationDatabaseName}`);
  const migrationDatabaseUrl = disposableDatabaseUrl(migrationDatabaseName);
  await seedLooseDataApiSchemaPrivileges(migrationDatabaseUrl);
  await verifySupabaseRlsHelperAbsent(
    migrationDatabaseUrl,
    "fresh pending-migration",
  );
  const migrationExitCodes = await Promise.all([
    runMigrations(migrationDatabaseUrl),
    runMigrations(migrationDatabaseUrl),
  ]);
  if (migrationExitCodes.some((code) => code !== 0)) {
    throw new Error(
      `Concurrent migration runner failed with exit code(s) ${migrationExitCodes.join(", ")}.`,
    );
  }
  await verifyMigrationLedger(
    migrationDatabaseUrl,
    "after two concurrent runners raced on the pending migration set",
  );
  await verifySupabaseRlsHelperAbsent(
    migrationDatabaseUrl,
    "migrated tenant/RLS integration",
  );
  const noOpMigrationExitCode = await runMigrations(migrationDatabaseUrl);
  if (noOpMigrationExitCode !== 0) {
    throw new Error(
      `Checksum-verifying no-op migration runner failed with exit code ${noOpMigrationExitCode}.`,
    );
  }
  await verifyMigrationLedger(
    migrationDatabaseUrl,
    "after the subsequent checksum-verifying no-op runner",
  );
  testExitCode = await runVitest(migrationDatabaseUrl);
} catch (error) {
  testError = error;
}

const cleanupErrors = await cleanupDatabaseIntegrationFixtures();
if (testError && cleanupErrors.length > 0) {
  throw new AggregateError(
    [testError, ...cleanupErrors],
    "Database integration failed and fixture cleanup was incomplete.",
  );
}
if (testError) {
  throw testError;
}
if (cleanupErrors.length > 0) {
  throw new AggregateError(
    cleanupErrors,
    "Database integration fixture cleanup was incomplete.",
  );
}

process.exitCode = testExitCode;
