import { X509Certificate } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  APPLICATION_TABLES,
  capturePreBackupEvidence,
  collectDatabaseEvidence,
  compareRestoredEvidence,
  databaseTargetIdentity,
  formatRestoreVerificationFailure,
  inspectDatabase,
  readPreBackupManifest,
  RESTORE_DATABASE_URL_KEY,
  RESTORE_DATABASE_CA_CERT_KEY,
  RESTORE_EVIDENCE_PATH_KEY,
  RESTORE_IDENTITY_KEY,
  RESTORE_TARGET_REFERENCE_KEY,
  RestoreVerificationError,
  SOURCE_DATABASE_URL_KEY,
  SOURCE_DATABASE_CA_CERT_KEY,
  SOURCE_IDENTITY_KEY,
  SOURCE_TARGET_REFERENCE_KEY,
  PRE_BACKUP_EVIDENCE_PATH_KEY,
  PRODUCTION_IDENTITY_KEY,
  validateCaptureEnvironment,
  validateVerifyEnvironment,
  verifyRestoredBackup,
  writeEvidenceManifest,
} from "./database-restore-verification.mjs";

const buildSha = "a".repeat(40);
const testCaCertificate = rootCertificates.find((pem) => {
  const certificate = new X509Certificate(pem);
  const now = Date.now();
  return (
    certificate.ca &&
    Date.parse(certificate.validFrom) <= now &&
    Date.parse(certificate.validTo) > now &&
    certificate.checkIssued(certificate) &&
    certificate.verify(certificate.publicKey)
  );
});

if (!testCaCertificate) throw new Error("No valid test root CA is available.");

const recoveryRunId = "7d14d008-c539-4d43-9870-585f142459f8";
const sourceUrl =
  "postgres://reader:source-secret@prod.db.example/maintainflow?sslmode=verify-full";
const restoreUrl =
  "postgres://reader:restore-secret@restore.db.example/maintainflow_restore?sslmode=verify-full";
const sourceTargetReference = "prod-instance-001";
const restoreTargetReference = "restore-instance-001";
const sourceIdentity = databaseTargetIdentity(
  sourceUrl,
  sourceTargetReference,
).identitySha256;
const sourceEndpointIdentity = databaseTargetIdentity(
  sourceUrl,
  sourceTargetReference,
).endpointIdentitySha256;
const sourceReferenceSha256 = databaseTargetIdentity(
  sourceUrl,
  sourceTargetReference,
).referenceSha256;
const restoreIdentity = databaseTargetIdentity(
  restoreUrl,
  restoreTargetReference,
).identitySha256;
const restoreEndpointIdentity = databaseTargetIdentity(
  restoreUrl,
  restoreTargetReference,
).endpointIdentitySha256;
const restoreReferenceSha256 = databaseTargetIdentity(
  restoreUrl,
  restoreTargetReference,
).referenceSha256;
const tempDirectories = [];

function migrationsFixture() {
  return [
    {
      name: "001_fixture.sql",
      checksumSha256: "1".repeat(64),
    },
  ];
}

function invariantFixture(value = "0") {
  return {
    writable_table_privileges: value,
    invalid_owner_organizations: "0",
    missing_owner_access: "0",
    orphan_approval_actor_access: "0",
    orphan_approval_rollback_access: "0",
    orphan_approval_reconciliation_access: "0",
    orphan_dismissal_actor_access: "0",
    orphan_dismissal_restore_access: "0",
    orphan_conversion_credential_access: "0",
    orphan_readiness_audit_access: "0",
  };
}

function fakeTransaction(databaseName = "maintainflow") {
  const events = [];
  const transaction = () => {};
  transaction.unsafe = vi.fn(async (statement) => {
    events.push(statement.replace(/\s+/g, " ").trim());
    if (statement.includes("maintainflow:restore:metadata")) {
      return [
        {
          database_name: databaseName,
          server_version_num: "170004",
          transaction_read_only: "on",
          search_path: "pg_catalog, public",
          statement_timeout: "30s",
          lock_timeout: "5s",
          idle_in_transaction_session_timeout: "45s",
        },
      ];
    }
    if (statement.includes("maintainflow:restore:migration-ledger")) {
      return [
        {
          migration_name: "001_fixture.sql",
          checksum_sha256: "1".repeat(64),
        },
      ];
    }
    if (statement.includes("maintainflow:restore:schema-tables")) {
      return APPLICATION_TABLES.map((table_name) => ({
        table_name,
        relation_kind: "r",
      }));
    }
    if (statement.includes("maintainflow:restore:schema-columns")) {
      return APPLICATION_TABLES.map((table_name) => ({
        table_name,
        ordinal_position: 1,
        column_name: "id",
        data_type: "uuid",
        not_null: true,
        default_expression: "",
        identity_kind: "",
        generated_kind: "",
      }));
    }
    if (statement.includes("maintainflow:restore:schema-constraints")) {
      return [
        {
          table_name: "ads_approval_records",
          constraint_name: "ads_approval_records_pkey",
          constraint_type: "p",
          deferrable: false,
          initially_deferred: false,
          validated: true,
          definition: "PRIMARY KEY (id)",
        },
      ];
    }
    if (statement.includes("maintainflow:restore:schema-indexes")) {
      return [
        {
          table_name: "ads_approval_records",
          index_name: "ads_approval_records_pkey",
          is_unique: true,
          is_primary: true,
          is_valid: true,
          is_ready: true,
          definition:
            "CREATE UNIQUE INDEX ads_approval_records_pkey ON public.ads_approval_records USING btree (id)",
        },
      ];
    }
    if (statement.includes("maintainflow:restore:critical-count:")) {
      return [{ row_count: "2" }];
    }
    if (statement.includes("maintainflow:restore:isolation-invariants")) {
      return [invariantFixture()];
    }
    return [];
  });
  return { transaction, events };
}

function fakeConnector() {
  const connections = [];
  const connect = vi.fn((url, options) => {
    const databaseName = decodeURIComponent(new URL(url).pathname.slice(1));
    const { transaction, events } = fakeTransaction(databaseName);
    const sql = () => {};
    sql.begin = vi.fn(async (transactionOptions, callback) =>
      callback(transaction),
    );
    sql.end = vi.fn(async () => {});
    connections.push({ url, options, sql, events });
    return sql;
  });
  return { connect, connections };
}

function baseCaptureEnvironment(evidencePath) {
  return {
    [SOURCE_DATABASE_CA_CERT_KEY]: testCaCertificate,
    [SOURCE_DATABASE_URL_KEY]: sourceUrl,
    [SOURCE_TARGET_REFERENCE_KEY]: sourceTargetReference,
    [SOURCE_IDENTITY_KEY]: sourceIdentity,
    [PRODUCTION_IDENTITY_KEY]: sourceIdentity,
    [PRE_BACKUP_EVIDENCE_PATH_KEY]: evidencePath,
    MAINTAINFLOW_BUILD_SHA: buildSha,
    MAINTAINFLOW_RECOVERY_RUN_ID: recoveryRunId,
    MAINTAINFLOW_RECOVERY_OPERATOR_REFERENCE: "release-operator-17",
    MAINTAINFLOW_BACKUP_REFERENCE: "backup-request-2026-09-02",
  };
}

function baseVerifyEnvironment(preBackupPath, restoreEvidencePath) {
  return {
    [RESTORE_DATABASE_CA_CERT_KEY]: testCaCertificate,
    [RESTORE_DATABASE_URL_KEY]: restoreUrl,
    [RESTORE_TARGET_REFERENCE_KEY]: restoreTargetReference,
    [RESTORE_IDENTITY_KEY]: restoreIdentity,
    [PRODUCTION_IDENTITY_KEY]: sourceIdentity,
    [PRE_BACKUP_EVIDENCE_PATH_KEY]: preBackupPath,
    [RESTORE_EVIDENCE_PATH_KEY]: restoreEvidencePath,
    MAINTAINFLOW_BUILD_SHA: buildSha,
    MAINTAINFLOW_RECOVERY_RUN_ID: recoveryRunId,
    MAINTAINFLOW_RECOVERY_OPERATOR_REFERENCE: "release-operator-17",
    MAINTAINFLOW_BACKUP_REFERENCE: "backup-request-2026-09-02",
    MAINTAINFLOW_BACKUP_PROVIDER: "hosted_postgres",
    MAINTAINFLOW_BACKUP_TYPE: "physical_snapshot",
    MAINTAINFLOW_BACKUP_CREATED_AT: "2026-09-02T10:02:00.000Z",
    MAINTAINFLOW_BACKUP_RECOVERY_POINT_AT: "2026-09-02T10:01:00.000Z",
    MAINTAINFLOW_RESTORE_REFERENCE: "restore-job-2026-09-02",
    MAINTAINFLOW_RESTORE_COMPLETED_AT: "2026-09-02T10:05:00.000Z",
    MAINTAINFLOW_RESTORE_DURATION_SECONDS: "180",
    MAINTAINFLOW_ROLLBACK_DECISION_AT: "2026-09-02T10:06:00.000Z",
  };
}

async function createTempDirectory() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "maintainflow-restore-test-"),
  );
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("database backup and restore verification", () => {
  it("derives a credential-free exact target identity and requires hosted verify-full TLS", () => {
    const credentialVariant = databaseTargetIdentity(
      "postgres://different-user:different-password@prod.db.example:5432/maintainflow?sslmode=verify-full",
      sourceTargetReference,
    );
    const referenceVariant = databaseTargetIdentity(
      sourceUrl,
      "different-instance-002",
    );
    expect(credentialVariant.identitySha256).toBe(sourceIdentity);
    expect(credentialVariant.endpointIdentitySha256).toBe(
      sourceEndpointIdentity,
    );
    expect(credentialVariant.referenceSha256).toBe(sourceReferenceSha256);
    expect(
      databaseTargetIdentity(
        "postgres://reader:secret@prod.db.example./maintainflow?sslmode=verify-full",
        sourceTargetReference,
      ).endpointIdentitySha256,
    ).toBe(sourceEndpointIdentity);
    expect(referenceVariant.identitySha256).not.toBe(sourceIdentity);
    expect(referenceVariant.endpointIdentitySha256).toBe(
      sourceEndpointIdentity,
    );
    expect(referenceVariant.referenceSha256).not.toBe(
      sourceReferenceSha256,
    );

    for (const url of [
      "postgres://localhost/maintainflow?sslmode=verify-full",
      "postgres://localhost./maintainflow?sslmode=verify-full",
      "postgres://prod.db.example/maintainflow",
      "postgres://prod.db.example/maintainflow?sslmode=require",
      "https://prod.db.example/maintainflow?sslmode=verify-full",
    ]) {
      expect(() =>
        databaseTargetIdentity(url, sourceTargetReference),
      ).toThrow(
        RestoreVerificationError,
      );
    }
  });

  it("requires the explicit source identity to equal both its URL and production", () => {
    expect(
      validateCaptureEnvironment(baseCaptureEnvironment("/secure/pre.json")),
    ).toMatchObject({
      sourceIdentity,
      productionIdentity: sourceIdentity,
      buildSha,
    });

    expect(() =>
      validateCaptureEnvironment({
        ...baseCaptureEnvironment("/secure/pre.json"),
        [SOURCE_IDENTITY_KEY]: "b".repeat(64),
      }),
    ).toThrow(/does not identify/);
    expect(() =>
      validateCaptureEnvironment({
        ...baseCaptureEnvironment("/secure/pre.json"),
        [PRODUCTION_IDENTITY_KEY]: "c".repeat(64),
      }),
    ).toThrow(/exactly match/);
  });

  it("uses a repeatable-read READ ONLY transaction with fixed session controls", async () => {
    const { connect, connections } = fakeConnector();
    await expect(
      inspectDatabase(sourceUrl, "maintainflow", {
        connect,
        environment: { MAINTAINFLOW_DATABASE_CA_CERT: testCaCertificate },
        migrations: migrationsFixture(),
      }),
    ).resolves.toMatchObject({
      target: { transactionReadOnly: true },
      migrationLedger: {
        mode: "full",
        appliedEntryCount: 1,
        localEntryCount: 1,
      },
      schema: { tableCount: APPLICATION_TABLES.length },
    });

    expect(connections[0].sql.begin).toHaveBeenCalledWith(
      "isolation level repeatable read read only",
      expect.any(Function),
    );
    expect(connections[0].events.slice(0, 4)).toEqual([
      "set local search_path = pg_catalog, public",
      "set local statement_timeout = '30s'",
      "set local lock_timeout = '5s'",
      "set local idle_in_transaction_session_timeout = '45s'",
    ]);
    expect(connections[0].options).toMatchObject({ max: 1, prepare: false });
    expect(connections[0].sql.end).toHaveBeenCalled();
  });

  it("captures a checksum-valid applied prefix while full verification requires every local migration", async () => {
    const { transaction } = fakeTransaction();
    const migrations = [
      ...migrationsFixture(),
      {
        name: "002_future.sql",
        checksumSha256: "2".repeat(64),
      },
    ];
    await expect(
      collectDatabaseEvidence(transaction, {
        expectedDatabaseName: "maintainflow",
        migrations,
        ledgerMode: "prefix",
      }),
    ).resolves.toMatchObject({
      migrationLedger: {
        mode: "prefix",
        appliedEntryCount: 1,
        localEntryCount: 2,
        localManifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const full = fakeTransaction();
    await expect(
      collectDatabaseEvidence(full.transaction, {
        expectedDatabaseName: "maintainflow",
        migrations,
        ledgerMode: "full",
      }),
    ).rejects.toThrow(/full checkout/);
  });

  it("rejects schema, ledger, bounded-count, and isolation failures", async () => {
    const migrations = migrationsFixture();
    const metadataFailure = fakeTransaction();
    const metadataImplementation =
      metadataFailure.transaction.unsafe.getMockImplementation();
    metadataFailure.transaction.unsafe.mockImplementation(async (statement) => {
      if (statement.includes("maintainflow:restore:metadata")) {
        return [
          {
            database_name: "maintainflow",
            server_version_num: "170004",
            transaction_read_only: "off",
            search_path: "pg_catalog, public",
            statement_timeout: "30s",
            lock_timeout: "5s",
            idle_in_transaction_session_timeout: "45s",
          },
        ];
      }
      return metadataImplementation(statement);
    });
    await expect(
      collectDatabaseEvidence(metadataFailure.transaction, {
        expectedDatabaseName: "maintainflow",
        migrations,
      }),
    ).rejects.toThrow(/read-only session contract/);

    const failing = fakeTransaction();
    failing.transaction.unsafe.mockImplementation(async (statement) => {
      if (statement.includes("maintainflow:restore:metadata")) {
        return [
          {
            database_name: "maintainflow",
            server_version_num: "170004",
            transaction_read_only: "on",
            search_path: "pg_catalog, public",
            statement_timeout: "30s",
            lock_timeout: "5s",
            idle_in_transaction_session_timeout: "45s",
          },
        ];
      }
      if (statement.includes("maintainflow:restore:migration-ledger")) {
        return [];
      }
      return [];
    });
    await expect(
      collectDatabaseEvidence(failing.transaction, {
        expectedDatabaseName: "maintainflow",
        migrations,
      }),
    ).rejects.toThrow(/migration ledger/);

    const invariants = fakeTransaction();
    const original = invariants.transaction.unsafe.getMockImplementation();
    invariants.transaction.unsafe.mockImplementation(async (statement) => {
      if (statement.includes("maintainflow:restore:isolation-invariants")) {
        return [invariantFixture("1")];
      }
      return original(statement);
    });
    await expect(
      collectDatabaseEvidence(invariants.transaction, {
        expectedDatabaseName: "maintainflow",
        migrations,
      }),
    ).rejects.toThrow(/invariants failed/);
  });

  it("writes exclusive regular manifests with mode 0600 and verifies their checksum", async () => {
    const directory = await createTempDirectory();
    const evidencePath = path.join(directory, "pre-backup.json");
    const manifest = {
      schemaVersion: 1,
      kind: "fixture",
      value: "safe",
    };
    await writeEvidenceManifest(evidencePath, manifest);
    expect((await lstat(evidencePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(evidencePath, "utf8"))).toEqual(
      manifest,
    );
    await expect(writeEvidenceManifest(evidencePath, manifest)).rejects.toThrow();
  });

  it("captures and verifies a restored backup without writing URLs, credentials, or raw references", async () => {
    const directory = await createTempDirectory();
    const preBackupPath = path.join(directory, "pre-backup.json");
    const restoreEvidencePath = path.join(directory, "restore.json");
    const { connect, connections } = fakeConnector();

    const preBackup = await capturePreBackupEvidence({
      env: baseCaptureEnvironment(preBackupPath),
      connect,
      migrations: migrationsFixture(),
      now: new Date("2026-09-02T10:00:00.000Z"),
    });
    const verified = await verifyRestoredBackup({
      env: baseVerifyEnvironment(preBackupPath, restoreEvidencePath),
      connect,
      migrations: migrationsFixture(),
      now: new Date("2026-09-02T10:07:00.000Z"),
    });

    expect(verified).toMatchObject({
      kind: "maintainflow.database.restore_verification",
      result: "passed",
      buildSha,
      sourceTargetIdentitySha256: sourceIdentity,
      sourceTargetEndpointIdentitySha256: sourceEndpointIdentity,
      sourceTargetReferenceSha256: sourceReferenceSha256,
      restoreTargetIdentitySha256: restoreIdentity,
      restoreTargetEndpointIdentitySha256: restoreEndpointIdentity,
      restoreTargetReferenceSha256: restoreReferenceSha256,
      preBackupCapturedAt: "2026-09-02T10:00:00.000Z",
      preBackupManifestSha256: preBackup.manifestSha256,
      before: { migrationLedger: { mode: "prefix" } },
      after: { migrationLedger: { mode: "full" } },
    });
    expect(connections).toHaveLength(2);
    const serialized = await readFile(restoreEvidencePath, "utf8");
    for (const forbidden of [
      sourceUrl,
      restoreUrl,
      "source-secret",
      "restore-secret",
      "backup-request-2026-09-02",
      "restore-job-2026-09-02",
      "release-operator-17",
      sourceTargetReference,
      restoreTargetReference,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect((await lstat(preBackupPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(restoreEvidencePath)).mode & 0o777).toBe(0o600);
    await expect(readPreBackupManifest(preBackupPath)).resolves.toEqual(
      preBackup,
    );

    await expect(
      verifyRestoredBackup({
        env: baseVerifyEnvironment(
          preBackupPath,
          path.join(directory, "stale-restore.json"),
        ),
        connect,
        migrations: migrationsFixture(),
        now: new Date("2026-09-03T10:00:00.001Z"),
      }),
    ).rejects.toThrow(/Pre-backup capture evidence.*24 hours old/);
    expect(connections).toHaveLength(2);
  });

  it("rejects restore identity reuse and mismatched restored evidence", () => {
    const preBackupManifest = {
      sourceTargetIdentitySha256: sourceIdentity,
      sourceTargetEndpointIdentitySha256: sourceEndpointIdentity,
      sourceTargetReferenceSha256: sourceReferenceSha256,
      buildSha,
      recoveryRunId,
      operatorReferenceSha256: sourceIdentity,
      plannedBackupReferenceSha256: "d".repeat(64),
      generatedAt: "2026-09-02T10:00:00.000Z",
    };
    const env = {
      ...baseVerifyEnvironment("/secure/pre.json", "/secure/restore.json"),
      [RESTORE_DATABASE_URL_KEY]: sourceUrl,
      [RESTORE_TARGET_REFERENCE_KEY]: sourceTargetReference,
      [RESTORE_IDENTITY_KEY]: sourceIdentity,
    };
    expect(() => validateVerifyEnvironment(env, preBackupManifest)).toThrow(
      /must not be the source/,
    );

    const relabeledSource = databaseTargetIdentity(
      sourceUrl,
      restoreTargetReference,
    );
    expect(() =>
      validateVerifyEnvironment(
        {
          ...env,
          [RESTORE_TARGET_REFERENCE_KEY]: restoreTargetReference,
          [RESTORE_IDENTITY_KEY]: relabeledSource.identitySha256,
        },
        preBackupManifest,
      ),
    ).toThrow(/must not be the source/);

    const before = {
      migrationLedger: {
        mode: "prefix",
        localManifestSha256: "a".repeat(64),
      },
      schema: { sha256: "b".repeat(64) },
      criticalCounts: { records: 1 },
      invariants: { orphan: 0 },
    };
    const after = {
      migrationLedger: {
        mode: "full",
        localManifestSha256: "a".repeat(64),
      },
      schema: { sha256: "different-by-design" },
      criticalCounts: { records: 1, new_table: 2 },
      invariants: { orphan: 0 },
    };
    expect(compareRestoredEvidence(before, after)).toBe(true);
    expect(() =>
      compareRestoredEvidence(before, {
        ...after,
        criticalCounts: { records: 0 },
      }),
    ).toThrow(/does not preserve/);
  });

  it("rejects loose evidence permissions and does not expose unexpected failures", async () => {
    const directory = await createTempDirectory();
    const evidencePath = path.join(directory, "loose.json");
    await writeFile(evidencePath, "{}\n", { mode: 0o600 });
    await chmod(evidencePath, 0o644);
    await expect(readPreBackupManifest(evidencePath)).rejects.toThrow(
      /mode-0600/,
    );

    const failure = formatRestoreVerificationFailure(
      new Error(`connection failed for ${sourceUrl}`),
    );
    expect(failure).not.toContain(sourceUrl);
    expect(failure).not.toContain("source-secret");
    expect(failure).toContain("No connection detail");
  });
});
