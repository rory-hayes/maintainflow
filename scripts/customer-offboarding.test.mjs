import { X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyCustomerOffboarding,
  canonicalCustomerOffboardingJson,
  CustomerOffboardingSafetyError,
  customerOffboardingConfirmationToken,
  customerOffboardingStateFingerprint,
  formatCustomerOffboardingFailure,
  parseCustomerOffboardingArgs,
  prepareCustomerOffboarding,
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
    changeApprovalRequests: [],
    approvalNotificationDeliveries: [],
    approvals: [],
    creativeReviewState: [],
    creativeReviewEvents: [],
    recommendationDecisions: [],
    readinessAudits: [],
    liveWorkbenchSnapshots: [],
    changeIntegrityState: [],
    changeIntegrityEvents: [],
    monitoringAccountSchedules: [],
    lifecycleRecords: [],
    ...overrides,
  };
}

function fakeOffboardingDatabase(
  changeApprovalRequests,
  approvalNotificationDeliveries = [],
) {
  const fixture = snapshot({
    changeApprovalRequests,
    approvalNotificationDeliveries,
  });
  const statements = [];
  const transaction = (strings) => {
    const statement = strings.join(" ").replace(/\s+/g, " ").trim();
    statements.push(statement);
    if (statement === "set transaction read only") return Promise.resolve([]);
    if (
      statement.startsWith(
        "update maintainflow_approval_notification_deliveries delivery set",
      )
    ) {
      return Promise.resolve(
        fixture.approvalNotificationDeliveries
          .filter((delivery) =>
            new Set(["queued", "retry_scheduled", "sending"]).has(
              delivery.status,
            ),
          )
          .map(({ id }) => ({ id })),
      );
    }
    if (statement.startsWith("delete from maintainflow_advertiser_credentials")) {
      return Promise.resolve(
        fixture.advertiserCredentialMetadata.map(({ id }) => ({ id })),
      );
    }
    if (statement.startsWith("delete from maintainflow_conversion_credentials")) {
      return Promise.resolve(
        fixture.conversionCredentialMetadata.map(({ id }) => ({ id })),
      );
    }
    if (statement.startsWith("delete from maintainflow_account_access")) {
      return Promise.resolve(
        fixture.accountAccess.map(({ organization_id }) => ({
          organization_id,
        })),
      );
    }
    if (statement.startsWith("update maintainflow_advertiser_accounts set")) {
      return Promise.resolve([{ id: fixture.account.id }]);
    }
    if (statement.startsWith("insert into maintainflow_customer_lifecycle_records")) {
      return Promise.resolve([]);
    }
    if (statement.includes("from maintainflow_advertiser_accounts")) {
      return Promise.resolve([fixture.account]);
    }
    if (
      statement.includes("from maintainflow_organizations organization") &&
      statement.includes("join maintainflow_organization_memberships membership")
    ) {
      return Promise.resolve([
        {
          organization_id: organizationId,
          organization_status: "active",
          membership_role: "owner",
          account_role: "owner",
        },
      ]);
    }
    if (statement.includes("from maintainflow_account_access account_access")) {
      return Promise.resolve(fixture.accountAccess);
    }
    if (statement.includes("from maintainflow_advertiser_credentials")) {
      return Promise.resolve(fixture.advertiserCredentialMetadata);
    }
    if (statement.includes("from maintainflow_conversion_credentials")) {
      return Promise.resolve(fixture.conversionCredentialMetadata);
    }
    if (
      statement.includes(
        "from maintainflow_approval_notification_deliveries delivery",
      )
    ) {
      return Promise.resolve(fixture.approvalNotificationDeliveries);
    }
    if (statement.includes("from maintainflow_change_approval_requests")) {
      return Promise.resolve(fixture.changeApprovalRequests);
    }
    if (statement.includes("from ads_approval_records")) {
      return Promise.resolve(fixture.approvals);
    }
    if (statement.includes("from maintainflow_creative_review_state")) {
      return Promise.resolve(fixture.creativeReviewState);
    }
    if (statement.includes("from maintainflow_creative_review_events")) {
      return Promise.resolve(fixture.creativeReviewEvents);
    }
    if (statement.includes("from maintainflow_recommendation_dismissals")) {
      return Promise.resolve(fixture.recommendationDecisions);
    }
    if (statement.includes("from maintainflow_readiness_audit_runs")) {
      return Promise.resolve(fixture.readinessAudits);
    }
    if (statement.includes("from maintainflow_live_workbench_snapshots")) {
      return Promise.resolve(fixture.liveWorkbenchSnapshots);
    }
    if (statement.includes("from maintainflow_ads_config_integrity_state")) {
      return Promise.resolve(fixture.changeIntegrityState);
    }
    if (statement.includes("from maintainflow_ads_config_integrity_events")) {
      return Promise.resolve(fixture.changeIntegrityEvents);
    }
    if (statement.includes("from maintainflow_monitoring_account_schedule")) {
      return Promise.resolve(fixture.monitoringAccountSchedules);
    }
    if (statement.includes("from maintainflow_customer_lifecycle_records")) {
      return Promise.resolve(fixture.lifecycleRecords);
    }
    throw new Error(`Unexpected fake query: ${statement}`);
  };
  transaction.json = (value) => value;
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

    const changedIntegrityEvidence = snapshot({
      changeIntegrityEvents: [
        {
          id: "44444444-4444-4444-8444-444444444445",
          classification: "unexplained",
          review_status: "open",
        },
      ],
    });
    expect(
      customerOffboardingStateFingerprint(changedIntegrityEvidence),
    ).not.toBe(customerOffboardingStateFingerprint(first));

    const changedApprovalQueue = snapshot({
      changeApprovalRequests: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          advertiser_account_id: first.account.id,
          source: "live",
          status: "approved",
        },
      ],
    });
    expect(customerOffboardingStateFingerprint(changedApprovalQueue)).not.toBe(
      customerOffboardingStateFingerprint(first),
    );

    const changedNotificationQueue = snapshot({
      approvalNotificationDeliveries: [
        {
          id: "66666666-6666-4666-8666-666666666666",
          approval_request_id: "55555555-5555-4555-8555-555555555555",
          organization_id: organizationId,
          status: "queued",
        },
      ],
    });
    expect(customerOffboardingStateFingerprint(changedNotificationQueue)).not.toBe(
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

  it("exports linked live change approvals and blocks an awaiting decision", async () => {
    const database = fakeOffboardingDatabase([
      {
        id: "55555555-5555-4555-8555-555555555555",
        advertiser_account_id: snapshot().account.id,
        source: "live",
        status: "awaiting_approval",
      },
    ]);
    const prepared = await prepareCustomerOffboarding(database.sql, {
      accountId: "adacct_customer_exact",
      organizationId,
      operatorId: "user_customer_owner",
      generatedAt: new Date("2026-09-03T10:00:00.000Z"),
    });
    expect(prepared.inventory).toMatchObject({
      changeApprovalRequests: 1,
      unresolvedChangeApprovalRequests: 1,
    });
    expect(prepared.confirmationToken).toBeNull();
    expect(prepared.blockers).toContain(
      "1 live change approval request(s) still await a decision. Cancel, decide, or expire them before offboarding.",
    );
    expect(prepared.exportDocument.data.changeApprovalRequests).toHaveLength(1);
    const requestStatement = database.statements.find((statement) =>
      statement.includes("from maintainflow_change_approval_requests"),
    );
    expect(requestStatement).toContain("and source = 'live'");
    expect(requestStatement).toContain("order by id");
    expect(requestStatement).not.toContain("account_id_snapshot");
  });

  it("exports notification deliveries and blocks an active sending lease", async () => {
    const requestId = "55555555-5555-4555-8555-555555555555";
    const database = fakeOffboardingDatabase(
      [
        {
          id: requestId,
          advertiser_account_id: snapshot().account.id,
          organization_id: organizationId,
          source: "live",
          status: "approved",
        },
      ],
      [
        {
          id: "66666666-6666-4666-8666-666666666666",
          approval_request_id: requestId,
          organization_id: organizationId,
          status: "sending",
          claim_expires_at: new Date("2026-09-03T10:02:00.000Z"),
          created_at: new Date("2026-09-03T09:58:00.000Z"),
        },
      ],
    );
    const prepared = await prepareCustomerOffboarding(database.sql, {
      accountId: "adacct_customer_exact",
      organizationId,
      operatorId: "user_customer_owner",
      generatedAt: new Date("2026-09-03T10:00:00.000Z"),
    });

    expect(prepared.inventory.approvalNotificationDeliveries).toBe(1);
    expect(prepared.exportDocument.schemaVersion).toBe(
      "maintainflow.customer-offboarding.v3",
    );
    expect(
      prepared.exportDocument.data.approvalNotificationDeliveries,
    ).toHaveLength(1);
    expect(prepared.confirmationToken).toBeNull();
    expect(prepared.blockers).toContain(
      "1 approval notification delivery attempt(s) still hold an unexpired or invalid database lease. Let them finish before offboarding.",
    );
    const deliveryStatement = database.statements.find((statement) =>
      statement.includes(
        "from maintainflow_approval_notification_deliveries delivery",
      ),
    );
    expect(deliveryStatement).toContain(
      "request.id = delivery.approval_request_id",
    );
    expect(deliveryStatement).toContain(
      "request.organization_id = delivery.organization_id",
    );
    expect(deliveryStatement).toContain("and request.source = 'live'");
  });

  it("cancels pending and expired-lease deliveries while retaining delivery evidence", async () => {
    const requestId = "55555555-5555-4555-8555-555555555555";
    const request = {
      id: requestId,
      advertiser_account_id: snapshot().account.id,
      organization_id: organizationId,
      source: "live",
      status: "approved",
    };
    const approvalNotificationDeliveries = [
      ["66666666-6666-4666-8666-666666666661", "queued", null],
      ["66666666-6666-4666-8666-666666666662", "retry_scheduled", null],
      [
        "66666666-6666-4666-8666-666666666663",
        "sending",
        new Date("2026-09-03T09:59:00.000Z"),
      ],
      ["66666666-6666-4666-8666-666666666664", "provider_accepted", null],
      ["66666666-6666-4666-8666-666666666665", "delivered", null],
    ].map(([id, status, claimExpiresAt], index) => ({
      id,
      approval_request_id: requestId,
      organization_id: organizationId,
      status,
      claim_expires_at: claimExpiresAt,
      created_at: new Date(`2026-09-03T09:5${index}:00.000Z`),
    }));
    const database = fakeOffboardingDatabase(
      [request],
      approvalNotificationDeliveries,
    );
    const options = {
      accountId: "adacct_customer_exact",
      organizationId,
      operatorId: "user_customer_owner",
      generatedAt: new Date("2026-09-03T10:00:00.000Z"),
    };
    const prepared = await prepareCustomerOffboarding(database.sql, options);
    expect(prepared.blockers).toEqual([]);
    const writeValidatedExport = vi.fn(async () => {});

    const result = await applyCustomerOffboarding(database.sql, {
      ...options,
      confirmationToken: prepared.confirmationToken,
      writeValidatedExport,
    });

    expect(result.cancelled.approvalNotificationDeliveries).toBe(3);
    expect(result.inventory.approvalNotificationDeliveries).toBe(5);
    expect(writeValidatedExport).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.objectContaining({
          data: expect.objectContaining({
            approvalNotificationDeliveries: expect.arrayContaining([
              expect.objectContaining({ status: "provider_accepted" }),
              expect.objectContaining({ status: "delivered" }),
            ]),
          }),
        }),
      }),
    );
    const cancellationStatement = database.statements.find((statement) =>
      statement.startsWith(
        "update maintainflow_approval_notification_deliveries delivery set",
      ),
    );
    expect(cancellationStatement).toContain(
      "status = 'cancelled', cancellation_code = 'account_offboarded'",
    );
    expect(cancellationStatement).toContain(
      "delivery.status in ('queued', 'retry_scheduled')",
    );
    expect(cancellationStatement).toContain(
      "delivery.claim_expires_at <= statement_timestamp()",
    );
    expect(cancellationStatement).not.toContain("claim_id = null");
    expect(cancellationStatement).not.toContain("cancelled_at =");
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
