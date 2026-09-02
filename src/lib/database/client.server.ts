import "server-only";

import { X509Certificate } from "node:crypto";

import postgres, { type Sql } from "postgres";

const DEFAULT_POOL_MAX = 4;
const MAX_POOL_MAX = 10;
const STATEMENT_TIMEOUT_MS = 20_000;
const LOCK_TIMEOUT_MS = 18_000;
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;

let runtimeDatabase:
  | { client: Sql; connectionString: string }
  | undefined;

export class RuntimeDatabaseConfigurationError extends Error {
  constructor(message = "The runtime database configuration is not safe.") {
    super(message);
    this.name = "RuntimeDatabaseConfigurationError";
  }
}

function configuredPoolMax() {
  const value = process.env.MAINTAINFLOW_DATABASE_POOL_MAX;
  if (value === undefined || value === "") return DEFAULT_POOL_MAX;
  if (!/^\d+$/.test(value)) {
    throw new RuntimeDatabaseConfigurationError(
      "MAINTAINFLOW_DATABASE_POOL_MAX must be an integer from 1 through 10.",
    );
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > MAX_POOL_MAX) {
    throw new RuntimeDatabaseConfigurationError(
      "MAINTAINFLOW_DATABASE_POOL_MAX must be an integer from 1 through 10.",
    );
  }
  return parsed;
}

function validatedDatabaseUrl(connectionString: string) {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new RuntimeDatabaseConfigurationError(
      "DATABASE_URL must be a valid PostgreSQL URL.",
    );
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new RuntimeDatabaseConfigurationError(
      "DATABASE_URL must use the postgres or postgresql protocol.",
    );
  }

  for (const [key] of parsed.searchParams) {
    const normalized = key.toLowerCase();
    if (normalized === "search_path" || normalized === "options") {
      throw new RuntimeDatabaseConfigurationError(
        "DATABASE_URL must not override the runtime database search path.",
      );
    }
  }

  if (process.env.NODE_ENV === "production") {
    const sslEntries = [...parsed.searchParams].filter(
      ([key]) => key.toLowerCase() === "sslmode",
    );
    if (
      sslEntries.length !== 1 ||
      sslEntries[0][0] !== "sslmode" ||
      sslEntries[0][1] !== "verify-full"
    ) {
      throw new RuntimeDatabaseConfigurationError(
        "Production DATABASE_URL must include exactly one sslmode=verify-full parameter.",
      );
    }
  }

  return parsed;
}

function configuredProductionDatabaseSsl() {
  const configured = process.env.MAINTAINFLOW_DATABASE_CA_CERT;
  if (!configured) {
    throw new RuntimeDatabaseConfigurationError(
      "MAINTAINFLOW_DATABASE_CA_CERT must contain one currently valid self-signed CA certificate in production.",
    );
  }

  const certificateBlocks = configured.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    certificateBlocks?.length !== 1 ||
    certificateBlocks[0].trim() !== configured.trim()
  ) {
    throw new RuntimeDatabaseConfigurationError(
      "MAINTAINFLOW_DATABASE_CA_CERT must contain one currently valid self-signed CA certificate in production.",
    );
  }

  try {
    const certificate = new X509Certificate(certificateBlocks[0]);
    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (
      !certificate.ca ||
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo <= now ||
      !certificate.checkIssued(certificate) ||
      !certificate.verify(certificate.publicKey)
    ) {
      throw new Error("The configured certificate is not a valid root CA.");
    }
  } catch {
    throw new RuntimeDatabaseConfigurationError(
      "MAINTAINFLOW_DATABASE_CA_CERT must contain one currently valid self-signed CA certificate in production.",
    );
  }

  return {
    ca: certificateBlocks[0],
    rejectUnauthorized: true,
  };
}

function createRuntimeDatabaseClient(
  connectionString: string,
  applicationName: string,
): Sql {
  validatedDatabaseUrl(connectionString);
  const options: postgres.Options<Record<string, never>> = {
    connect_timeout: 10,
    idle_timeout: 20,
    max: configuredPoolMax(),
    // Supavisor transaction-mode releases before v2.10 can drop pipelined
    // replies. The pinned postgres.js patch makes zero a strict serial mode
    // while preserving safe transaction connection reservation.
    max_pipeline: 0,
    prepare: false,
    connection: {
      application_name: applicationName,
      idle_in_transaction_session_timeout: IDLE_IN_TRANSACTION_TIMEOUT_MS,
      lock_timeout: LOCK_TIMEOUT_MS,
      search_path: "public",
      statement_timeout: STATEMENT_TIMEOUT_MS,
    },
    ...(process.env.NODE_ENV === "production"
      ? {
          ssl: configuredProductionDatabaseSsl(),
        }
      : {}),
  };
  return postgres(connectionString, options);
}

export function getRuntimeDatabase(connectionString: string): Sql {
  if (runtimeDatabase) {
    if (runtimeDatabase.connectionString !== connectionString) {
      throw new RuntimeDatabaseConfigurationError(
        "DATABASE_URL changed after the runtime pool was initialized; restart the process.",
      );
    }
    return runtimeDatabase.client;
  }

  const client = createRuntimeDatabaseClient(
    connectionString,
    "maintainflow-ads",
  );
  runtimeDatabase = { client, connectionString };
  return client;
}

export function createReadinessDatabase(connectionString: string): Sql {
  return createRuntimeDatabaseClient(
    connectionString,
    "maintainflow-readiness",
  );
}

export async function closeRuntimeDatabase() {
  const current = runtimeDatabase;
  runtimeDatabase = undefined;
  if (current) await current.client.end({ timeout: 5 });
}
