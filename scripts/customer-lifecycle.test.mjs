import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyRetentionPurge,
  CustomerLifecycleSafetyError,
  formatCustomerLifecycleFailure,
  parseCustomerLifecycleArgs,
  prepareProviderRevocationConfirmation,
  prepareRetentionPurge,
  runCustomerLifecycleCli,
  writePrivateLifecycleEvidence,
} from "./customer-lifecycle.mjs";

const lifecycleId = "11111111-1111-4111-8111-111111111111";
const advertiserAccountId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const externalAccountId = "adacct_customer_must_not_enter_evidence";
const operatorId = "user_customer_must_not_enter_evidence";
const evidenceReference = "case_external_revocation_20260902";
const temporaryDirectories = [];
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

function revocationArguments(extra = []) {
  return [
    "confirm-revocation",
    "--lifecycle-id",
    lifecycleId,
    "--provider-revoked-at",
    "2026-09-02T10:00:00.000Z",
    "--evidence-ref",
    evidenceReference,
    "--retain-until",
    "2026-10-02T10:00:00.000Z",
    "--evidence-file",
    "/tmp/revocation-evidence.json",
    ...extra,
  ];
}

function fakeReadOnlyDatabase() {
  const lifecycle = {
    id: lifecycleId,
    advertiser_account_id: advertiserAccountId,
    external_account_id: externalAccountId,
    acting_organization_id: organizationId,
    operator_id: operatorId,
    action: "offboarded",
    state_fingerprint: "a".repeat(64),
    export_sha256: "b".repeat(64),
    inventory_counts: {},
    provider_revocation_required: true,
    completed_at: new Date("2026-09-02T09:00:00.000Z"),
    provider_revoked_at: null,
    provider_revocation_confirmed_at: null,
    provider_revocation_evidence_ref: null,
    provider_revocation_confirmation_sha256: null,
    retain_until: new Date(8.64e15),
    purge_completed_at: null,
    purge_evidence_sha256: null,
  };
  const account = {
    id: advertiserAccountId,
    external_account_id: externalAccountId,
    status: "disconnected",
  };
  const transaction = async (strings) => {
    const statement = strings.join(" ").replace(/\s+/g, " ");
    if (statement.includes("set transaction read only")) return [];
    if (statement.includes("from maintainflow_customer_lifecycle_records")) {
      return [lifecycle];
    }
    if (statement.includes("from maintainflow_advertiser_accounts")) {
      return [account];
    }
    throw new Error(`Unexpected fake query: ${statement}`);
  };
  const sql = () => {};
  sql.begin = (callback) => callback(transaction);
  return sql;
}

function fakeRetentionDatabase({
  changeApprovalRequests = 1,
  approvalNotificationDeliveries = 0,
  unresolvedChangeApprovalRequests = 0,
} = {}) {
  const lifecycle = {
    id: lifecycleId,
    advertiser_account_id: advertiserAccountId,
    external_account_id: externalAccountId,
    acting_organization_id: organizationId,
    operator_id: operatorId,
    action: "offboarded",
    state_fingerprint: "a".repeat(64),
    export_sha256: "b".repeat(64),
    inventory_counts: {},
    provider_revocation_required: false,
    completed_at: new Date("2026-08-01T09:00:00.000Z"),
    provider_revoked_at: new Date("2026-08-01T10:00:00.000Z"),
    provider_revocation_confirmed_at: new Date("2026-08-01T10:05:00.000Z"),
    provider_revocation_evidence_ref: evidenceReference,
    provider_revocation_confirmation_sha256: "c".repeat(64),
    retain_until: new Date("2026-09-01T10:00:00.000Z"),
    purge_completed_at: null,
    purge_evidence_sha256: null,
  };
  const account = {
    id: advertiserAccountId,
    external_account_id: externalAccountId,
    status: "disconnected",
  };
  const counts = {
    access_grants: 0,
    advertiser_credentials: 0,
    conversion_credentials: 0,
    change_approval_requests: changeApprovalRequests,
    approval_notification_deliveries: approvalNotificationDeliveries,
    approvals: 0,
    creative_review_state: 0,
    creative_review_events: 0,
    recommendation_decisions: 0,
    readiness_audits: 0,
    live_workbench_snapshots: 0,
    change_integrity_state: 0,
    change_integrity_events: 0,
    monitoring_account_schedules: 0,
    unresolved_change_approval_requests: unresolvedChangeApprovalRequests,
    unresolved_approvals: 0,
  };
  const statements = [];
  const transaction = (strings) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    const statement = strings.join(" ").replace(/\s+/g, " ").trim();
    statements.push(statement);
    if (statement.startsWith("set ")) return Promise.resolve([]);
    if (statement.startsWith("update maintainflow_customer_lifecycle_records")) {
      return Promise.resolve([{ id: lifecycleId }]);
    }
    if (statement.startsWith("delete from maintainflow_advertiser_accounts")) {
      return Promise.resolve([{ id: advertiserAccountId }]);
    }
    if (
      statement.startsWith(
        "delete from maintainflow_approval_notification_deliveries delivery",
      )
    ) {
      return Promise.resolve(
        Array.from({ length: approvalNotificationDeliveries }, (_, index) => ({
          id: `notification-${index}`,
        })),
      );
    }
    if (statement.startsWith("delete from maintainflow_change_approval_requests")) {
      return Promise.resolve(
        Array.from({ length: changeApprovalRequests }, (_, index) => ({
          id: `request-${index}`,
        })),
      );
    }
    if (
      statement.startsWith("select id from maintainflow_change_approval_requests")
    ) {
      return Promise.resolve(
        Array.from({ length: changeApprovalRequests }, (_, index) => ({
          id: `request-${index}`,
        })),
      );
    }
    if (statement.startsWith("delete from ")) return Promise.resolve([]);
    if (statement.includes("from maintainflow_customer_lifecycle_records")) {
      return Promise.resolve([lifecycle]);
    }
    if (statement.includes("from maintainflow_advertiser_accounts")) {
      return Promise.resolve([account]);
    }
    if (statement.startsWith("select (select count(*)::int")) {
      return Promise.resolve([counts]);
    }
    throw new Error(`Unexpected fake query: ${statement}`);
  };
  const sql = () => {};
  sql.begin = (callback) => callback(transaction);
  return { sql, statements };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("customer lifecycle operator safety", () => {
  it("parses explicit revocation and purge workflows with apply tokens", () => {
    expect(parseCustomerLifecycleArgs(revocationArguments())).toMatchObject({
      operation: "confirm-revocation",
      mode: "dry-run",
      lifecycleId,
      providerRevokedAt: new Date("2026-09-02T10:00:00.000Z"),
      retainUntil: new Date("2026-10-02T10:00:00.000Z"),
      evidenceReference,
      confirmationToken: null,
    });
    expect(
      parseCustomerLifecycleArgs([
        "purge-retention",
        "--lifecycle-id",
        lifecycleId,
        "--evidence-file",
        "/tmp/purge-evidence.json",
        "--apply",
        "--confirm",
        `PURGE-RETAINED-DATA:${"a".repeat(64)}`,
      ]),
    ).toMatchObject({
      operation: "purge-retention",
      mode: "apply",
      lifecycleId,
    });
  });

  it("rejects ambiguous targets, noncanonical times, and confirmation without apply", () => {
    expect(() =>
      parseCustomerLifecycleArgs(
        revocationArguments([
          "--lifecycle-id",
          "44444444-4444-4444-8444-444444444444",
        ]),
      ),
    ).toThrow(/exactly once/i);
    expect(() =>
      parseCustomerLifecycleArgs(
        revocationArguments().map((value) =>
          value === "2026-09-02T10:00:00.000Z"
            ? "2026-09-02T10:00:00Z"
            : value,
        ),
      ),
    ).toThrow(/exact UTC ISO-8601/i);
    expect(() =>
      parseCustomerLifecycleArgs([
        "purge-retention",
        "--lifecycle-id",
        lifecycleId,
        "--evidence-file",
        "/tmp/purge-evidence.json",
        "--confirm",
        "not-authorized",
      ]),
    ).toThrow(/only together with --apply/i);
    expect(() =>
      parseCustomerLifecycleArgs([
        "purge-retention",
        "--lifecycle-id",
        "*",
        "--evidence-file",
        "/tmp/purge-evidence.json",
      ]),
    ).toThrow(CustomerLifecycleSafetyError);
  });

  it("builds revocation evidence without lifecycle, customer, operator, or raw reference identifiers", async () => {
    const parsed = parseCustomerLifecycleArgs(revocationArguments());
    const plan = await prepareProviderRevocationConfirmation(
      fakeReadOnlyDatabase(),
      {
        ...parsed,
        confirmedAt: new Date("2026-09-02T10:05:00.000Z"),
      },
    );
    expect(plan.blockers).toEqual([]);
    expect(plan.confirmationToken).toMatch(
      /^RECORD-EXTERNAL-REVOCATION:[a-f0-9]{64}$/,
    );
    expect(plan.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const sensitive of [
      lifecycleId,
      advertiserAccountId,
      organizationId,
      externalAccountId,
      operatorId,
      evidenceReference,
    ]) {
      expect(plan.serializedEvidence).not.toContain(sensitive);
    }
    expect(plan.serializedEvidence).toContain(
      '"providerAction": "completed_externally_no_provider_api_call"',
    );
    expect(plan.serializedEvidence).not.toMatch(
      /"(?:api[_-]?key|credential|ciphertext|password|secret|token)"\s*:/i,
    );
  });

  it("inventories account-linked live approvals and their notification deliveries", async () => {
    const retained = fakeRetentionDatabase({
      changeApprovalRequests: 3,
      approvalNotificationDeliveries: 7,
    });
    const plan = await prepareRetentionPurge(retained.sql, {
      lifecycleId,
      now: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.inventory.changeApprovalRequests).toBe(3);
    expect(plan.inventory.approvalNotificationDeliveries).toBe(7);
    expect(plan.serializedEvidence).toContain('"changeApprovalRequests": 3');
    expect(plan.serializedEvidence).toContain(
      '"approvalNotificationDeliveries": 7',
    );
    const inventoryStatement = retained.statements.find((statement) =>
      statement.startsWith("select (select count(*)::int"),
    );
    expect(inventoryStatement).toContain(
      "from maintainflow_change_approval_requests",
    );
    expect(inventoryStatement).toContain(
      "from maintainflow_approval_notification_deliveries delivery",
    );
    expect(inventoryStatement).toContain(
      "from maintainflow_ads_config_integrity_state",
    );
    expect(inventoryStatement).toContain(
      "from maintainflow_ads_config_integrity_events",
    );
    expect(inventoryStatement).toContain(
      "request.id = delivery.approval_request_id",
    );
    expect(inventoryStatement).toContain(
      "request.organization_id = delivery.organization_id",
    );
    expect(inventoryStatement).toContain("and source = 'live'");

    const unresolved = fakeRetentionDatabase({
      unresolvedChangeApprovalRequests: 1,
    });
    const blocked = await prepareRetentionPurge(unresolved.sql, {
      lifecycleId,
      now: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(blocked.confirmationToken).toBeNull();
    expect(blocked.blockers).toContain(
      "A live change approval request still awaits a decision and must be cancelled, decided, or expired before purging.",
    );
  });

  it("deletes notification deliveries before their live approval requests", async () => {
    const database = fakeRetentionDatabase({
      changeApprovalRequests: 2,
      approvalNotificationDeliveries: 5,
    });
    const now = new Date("2026-09-03T10:00:00.000Z");
    const plan = await prepareRetentionPurge(database.sql, { lifecycleId, now });
    const writeValidatedEvidence = vi.fn(async () => {});
    const result = await applyRetentionPurge(database.sql, {
      lifecycleId,
      now,
      confirmationToken: plan.confirmationToken,
      writeValidatedEvidence,
    });
    expect(result.deleted.changeApprovalRequests).toBe(2);
    expect(result.deleted.approvalNotificationDeliveries).toBe(5);
    expect(writeValidatedEvidence).toHaveBeenCalledOnce();
    const notificationDeleteIndex = database.statements.findIndex((statement) =>
      statement.startsWith(
        "delete from maintainflow_approval_notification_deliveries delivery",
      ),
    );
    const requestLockIndex = database.statements.findIndex((statement) =>
      statement.startsWith("select id from maintainflow_change_approval_requests"),
    );
    const requestDeleteIndex = database.statements.findIndex((statement) =>
      statement.startsWith("delete from maintainflow_change_approval_requests"),
    );
    const approvalDeleteIndex = database.statements.findIndex((statement) =>
      statement.startsWith("delete from ads_approval_records"),
    );
    const integrityEventDeleteIndex = database.statements.findIndex(
      (statement) =>
        statement.startsWith(
          "delete from maintainflow_ads_config_integrity_events",
        ),
    );
    const integrityStateDeleteIndex = database.statements.findIndex(
      (statement) =>
        statement.startsWith(
          "delete from maintainflow_ads_config_integrity_state",
        ),
    );
    const accountDeleteIndex = database.statements.findIndex((statement) =>
      statement.startsWith("delete from maintainflow_advertiser_accounts"),
    );
    expect(requestLockIndex).toBeGreaterThan(-1);
    expect(requestLockIndex).toBeLessThan(notificationDeleteIndex);
    expect(database.statements[requestLockIndex]).toContain("order by id");
    expect(database.statements[requestLockIndex]).toContain("for update");
    expect(notificationDeleteIndex).toBeLessThan(requestDeleteIndex);
    expect(requestDeleteIndex).toBeLessThan(approvalDeleteIndex);
    expect(integrityEventDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(integrityStateDeleteIndex).toBeGreaterThan(
      integrityEventDeleteIndex,
    );
    expect(accountDeleteIndex).toBeGreaterThan(integrityStateDeleteIndex);
    expect(database.statements[notificationDeleteIndex]).toContain(
      "request.organization_id = delivery.organization_id",
    );
    expect(database.statements[notificationDeleteIndex]).toContain(
      "and request.source = 'live'",
    );
    expect(database.statements[requestDeleteIndex]).toContain(
      "and source = 'live'",
    );
  });

  it("writes mode-0600 evidence once and refuses to overwrite it", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "maintainflow-lifecycle-"),
    );
    temporaryDirectories.push(directory);
    const evidenceFile = path.join(directory, "evidence.json");
    await writePrivateLifecycleEvidence(evidenceFile, '{"safe":true}\n');
    expect(await readFile(evidenceFile, "utf8")).toBe('{"safe":true}\n');
    expect((await stat(evidenceFile)).mode & 0o777).toBe(0o600);
    await expect(
      writePrivateLifecycleEvidence(evidenceFile, '{"replacement":true}\n'),
    ).rejects.toThrow(/already exists/i);
    expect(await readFile(evidenceFile, "utf8")).toBe('{"safe":true}\n');
  });

  it("redacts database secrets and lifecycle command values from failures", () => {
    const databaseUrl =
      "postgres://lifecycle_user:do%2Dnot%2Dprint@db.example/maintainflow?sslmode=verify-full";
    const formatted = formatCustomerLifecycleFailure(
      new Error(
        `${databaseUrl} ${lifecycleId} ${evidenceReference} another-secret`,
      ),
      { DATABASE_URL: databaseUrl, LIFECYCLE_OPERATOR_TOKEN: "another-secret" },
      revocationArguments(),
    );
    expect(formatted).not.toContain(databaseUrl);
    expect(formatted).not.toContain("do-not-print");
    expect(formatted).not.toContain(lifecycleId);
    expect(formatted).not.toContain(evidenceReference);
    expect(formatted).not.toContain("another-secret");
    expect(formatted).toContain("[REDACTED]");
  });

  it("requires the hosted operator CA before opening a lifecycle connection", async () => {
    const connect = vi.fn();
    await expect(
      runCustomerLifecycleCli({
        argv: revocationArguments(),
        environment: {
          DATABASE_URL:
            "postgres://operator:secret@db.example/maintainflow?sslmode=verify-full",
        },
        connect,
      }),
    ).rejects.toThrow("MAINTAINFLOW_DATABASE_CA_CERT");
    expect(connect).not.toHaveBeenCalled();
  });

  it("passes the pinned CA to the lifecycle connector", async () => {
    const sentinel = new Error("connector sentinel");
    const connect = vi.fn(() => {
      throw sentinel;
    });
    await expect(
      runCustomerLifecycleCli({
        argv: revocationArguments(),
        environment: {
          DATABASE_URL:
            "postgres://operator:secret@db.example/maintainflow?sslmode=verify-full",
          MAINTAINFLOW_DATABASE_CA_CERT: testCaCertificate,
        },
        connect,
      }),
    ).rejects.toBe(sentinel);
    expect(connect).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        max: 1,
        prepare: false,
        ssl: { ca: testCaCertificate, rejectUnauthorized: true },
      }),
    );
  });
});
