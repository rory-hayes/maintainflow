import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CustomerLifecycleSafetyError,
  formatCustomerLifecycleFailure,
  parseCustomerLifecycleArgs,
  prepareProviderRevocationConfirmation,
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
