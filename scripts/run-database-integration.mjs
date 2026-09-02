import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import {
  loadCompiledManifest,
  renderEmptyDatabaseBootstrapSql,
} from "./generate-empty-database-bootstrap.mjs";
import { loadMigrations } from "./run-database-migrations.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

const adminDatabaseUrl =
  process.env.MAINTAINFLOW_TEST_ADMIN_DATABASE_URL ??
  "postgres://localhost/postgres";
const databaseName = `maintainflow_ads_test_${Date.now()}_${randomBytes(4).toString("hex")}`;
const quotedDatabaseName = `"${databaseName}"`;
const admin = postgres(adminDatabaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
  prepare: false,
});
const dataApiRoleNames = ["anon", "authenticated", "service_role"];
const createdDataApiRoleNames = [];

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

async function verifyMigrationLedger(databaseUrl) {
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
      `Verified ${rows.length} checksum ledger rows after concurrent migration runners.`,
    );
  } finally {
    await database.end({ timeout: 5 });
  }
}

async function verifyBootstrapRejectsPublicCompositeType(databaseUrl) {
  const setup = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  try {
    await setup`create type public.uuid as (value text)`;
  } finally {
    await setup.end({ timeout: 5 });
  }

  const migrations = await loadMigrations();
  const manifest = await loadCompiledManifest();
  const bootstrapSql = renderEmptyDatabaseBootstrapSql(migrations, {
    manifest,
    expectedBuildSha: "0".repeat(40),
  });
  const bootstrap = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
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
      "The empty hosted bootstrap accepted a public composite type.",
    );
  }

  const cleanup = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  });
  try {
    await cleanup`drop type public.uuid`;
  } finally {
    await cleanup.end({ timeout: 5 });
  }
  console.log("Verified that the empty bootstrap rejects a public composite type.");
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

let testExitCode = 1;
try {
  await ensureDataApiRoles();
  await admin.unsafe(`create database ${quotedDatabaseName}`);
  const testDatabaseUrl = new URL(adminDatabaseUrl);
  testDatabaseUrl.pathname = `/${databaseName}`;
  await seedLooseDataApiSchemaPrivileges(testDatabaseUrl.toString());
  await verifyBootstrapRejectsPublicCompositeType(testDatabaseUrl.toString());
  const migrationExitCodes = await Promise.all([
    runMigrations(testDatabaseUrl.toString()),
    runMigrations(testDatabaseUrl.toString()),
  ]);
  if (migrationExitCodes.some((code) => code !== 0)) {
    throw new Error(
      `Concurrent migration runner failed with exit code(s) ${migrationExitCodes.join(", ")}.`,
    );
  }
  await verifyMigrationLedger(testDatabaseUrl.toString());
  testExitCode = await runVitest(testDatabaseUrl.toString());
} finally {
  await admin`
    select pg_terminate_backend(pid)
    from pg_stat_activity
    where datname = ${databaseName}
      and pid <> pg_backend_pid()
  `;
  await admin.unsafe(`drop database if exists ${quotedDatabaseName}`);
  for (const roleName of createdDataApiRoleNames.reverse()) {
    await admin.unsafe(`drop role "${roleName}"`);
  }
  await admin.end({ timeout: 5 });
}

process.exitCode = testExitCode;
