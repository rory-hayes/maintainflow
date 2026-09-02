import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalCustomerOffboardingJson,
  CustomerOffboardingSafetyError,
  customerOffboardingConfirmationToken,
  customerOffboardingStateFingerprint,
  formatCustomerOffboardingFailure,
  parseCustomerOffboardingArgs,
  runCustomerOffboardingCli,
  writePrivateCustomerExport,
} from "./customer-offboarding.mjs";

const organizationId = "11111111-1111-4111-8111-111111111111";
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

function offboardingArguments(exportFile = "/tmp/customer-offboarding.json") {
  return [
    "--account-id",
    "adacct_customer_exact",
    "--organization-id",
    organizationId,
    "--operator-id",
    "user_customer_owner",
    "--export-file",
    exportFile,
  ];
}

function snapshot(overrides = {}) {
  return {
    account: {
      id: "22222222-2222-4222-8222-222222222222",
      external_account_id: "adacct_customer_exact",
      name: "Exact Customer",
      owner_organization_id: organizationId,
      connection_mode: "vault",
      status: "active",
      updated_at: new Date("2026-08-30T12:00:00.000Z"),
    },
    actingOrganizationId: organizationId,
    operatorId: "user_customer_owner",
    accountAccess: [{ organization_id: organizationId, role: "owner" }],
    actingAuthorization: {
      organization_id: organizationId,
      operator_id: "user_customer_owner",
      membership_role: "owner",
      account_role: "owner",
    },
    advertiserCredentialMetadata: [
      { id: "credential-metadata-only", credential_version: 1, status: "active" },
    ],
    conversionCredentialMetadata: [],
    approvals: [],
    creativeReviewState: [],
    creativeReviewEvents: [],
    recommendationDecisions: [],
    readinessAudits: [],
    liveWorkbenchSnapshots: [],
    monitoringAccountSchedules: [],
    lifecycleRecords: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("customer offboarding operator safety", () => {
  it("defaults to dry-run and requires exact, non-wildcard targets", () => {
    const parsed = parseCustomerOffboardingArgs(offboardingArguments());
    expect(parsed).toMatchObject({
      mode: "dry-run",
      accountId: "adacct_customer_exact",
      organizationId,
      operatorId: "user_customer_owner",
      confirmationToken: null,
    });

    for (const unsafeAccountId of ["*", "adacct_%", "two accounts", ""]) {
      expect(() =>
        parseCustomerOffboardingArgs([
          "--account-id",
          unsafeAccountId,
          "--organization-id",
          organizationId,
          "--operator-id",
          "user_customer_owner",
          "--export-file",
          "/tmp/customer-offboarding.json",
        ]),
      ).toThrow(CustomerOffboardingSafetyError);
    }
  });

  it("requires an explicit dry-run token for apply", () => {
    const base = [
      "--account-id",
      "adacct_customer_exact",
      "--organization-id",
      organizationId,
      "--operator-id",
      "user_customer_owner",
      "--export-file",
      "/tmp/customer-offboarding.json",
    ];
    expect(() => parseCustomerOffboardingArgs([...base, "--apply"])).toThrow(
      /--confirm/i,
    );
    expect(() =>
      parseCustomerOffboardingArgs([...base, "--confirm", "unbound-token"]),
    ).toThrow(/only together with --apply/i);
    expect(
      parseCustomerOffboardingArgs([
        ...base,
        "--apply",
        "--confirm",
        "OFFBOARD:adacct_customer_exact:fingerprint",
      ]).mode,
    ).toBe("apply");
  });

  it("binds confirmation to the full canonical account state", () => {
    const first = snapshot();
    const reordered = {
      ...snapshot(),
      account: Object.fromEntries(Object.entries(snapshot().account).reverse()),
    };
    expect(customerOffboardingStateFingerprint(first)).toBe(
      customerOffboardingStateFingerprint(reordered),
    );
    expect(customerOffboardingConfirmationToken(first)).toMatch(
      /^OFFBOARD:adacct_customer_exact:[a-f0-9]{64}$/,
    );

    const changedSchedule = snapshot({
      monitoringAccountSchedules: [
        {
          advertiser_account_id: first.account.id,
          current_attempt_id: "44444444-4444-4444-8444-444444444444",
          attempt_lease_until: new Date("2026-08-30T12:15:00.000Z"),
        },
      ],
    });
    expect(customerOffboardingStateFingerprint(changedSchedule)).not.toBe(
      customerOffboardingStateFingerprint(first),
    );

    const changed = snapshot({
      accountAccess: [
        { organization_id: organizationId, role: "owner" },
        {
          organization_id: "33333333-3333-4333-8333-333333333333",
          role: "viewer",
        },
      ],
    });
    expect(customerOffboardingStateFingerprint(changed)).not.toBe(
      customerOffboardingStateFingerprint(first),
    );
    expect(() => canonicalCustomerOffboardingJson({ ciphertext: Buffer.alloc(8) })).toThrow(
      /binary credential material/i,
    );
  });

  it("writes a private export once and refuses to overwrite evidence", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "maintainflow-offboard-"));
    temporaryDirectories.push(directory);
    const exportFile = path.join(directory, "customer.json");
    await writePrivateCustomerExport(exportFile, "{\"safe\":true}\n");
    expect(await readFile(exportFile, "utf8")).toBe("{\"safe\":true}\n");
    expect((await stat(exportFile)).mode & 0o777).toBe(0o600);
    await expect(
      writePrivateCustomerExport(exportFile, "{\"replacement\":true}\n"),
    ).rejects.toThrow(/already exists/i);
    expect(await readFile(exportFile, "utf8")).toBe("{\"safe\":true}\n");
  });

  it("redacts configured secrets and decoded database credentials from failures", () => {
    const databaseUrl =
      "postgres://offboard_user:do%2Dnot%2Dprint@db.example/maintainflow?sslmode=verify-full";
    const formatted = formatCustomerOffboardingFailure(
      new Error(
        `connection failed for ${databaseUrl}; password do-not-print; token another-secret`,
      ),
      {
        DATABASE_URL: databaseUrl,
        OFFBOARDING_OPERATOR_TOKEN: "another-secret",
      },
    );
    expect(formatted).not.toContain(databaseUrl);
    expect(formatted).not.toContain("do-not-print");
    expect(formatted).not.toContain("another-secret");
    expect(formatted).toContain("[REDACTED]");
  });

  it("requires the hosted operator CA before opening an offboarding connection", async () => {
    const connect = vi.fn();
    await expect(
      runCustomerOffboardingCli({
        argv: offboardingArguments(),
        environment: {
          DATABASE_URL:
            "postgres://operator:secret@db.example/maintainflow?sslmode=verify-full",
        },
        connect,
      }),
    ).rejects.toThrow("MAINTAINFLOW_DATABASE_CA_CERT");
    expect(connect).not.toHaveBeenCalled();
  });

  it("passes the pinned CA to the offboarding connector", async () => {
    const sentinel = new Error("connector sentinel");
    const connect = vi.fn(() => {
      throw sentinel;
    });
    await expect(
      runCustomerOffboardingCli({
        argv: offboardingArguments(),
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
