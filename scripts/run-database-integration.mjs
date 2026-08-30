import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

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
  await admin.unsafe(`create database ${quotedDatabaseName}`);
  const testDatabaseUrl = new URL(adminDatabaseUrl);
  testDatabaseUrl.pathname = `/${databaseName}`;
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
  await admin.end({ timeout: 5 });
}

process.exitCode = testExitCode;
