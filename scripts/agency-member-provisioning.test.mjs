import { describe, expect, it, vi } from "vitest";

import {
  AgencyMemberProvisioningSafetyError,
  applyAgencyMemberProvisioning,
  formatAgencyMemberProvisioningFailure,
  parseAgencyMemberProvisioningArgs,
  prepareAgencyMemberProvisioning,
  runAgencyMemberProvisioningCli,
} from "./agency-member-provisioning.mjs";

const organizationId = "11111111-1111-4111-8111-111111111111";
const actingOperatorId = "user_private_beta_owner";
const targetOperatorId = "user_private_beta_reviewer";
const alternateTargetOperatorId = "user_private_beta_reviewer_two";
const fixedDate = new Date("2026-09-03T10:00:00.000Z");

function argumentsFor(extra = []) {
  return [
    "--organization-id",
    organizationId,
    "--acting-operator-id",
    actingOperatorId,
    "--target-operator-id",
    targetOperatorId,
    "--role",
    "admin",
    ...extra,
  ];
}

function fakeDatabase({
  organizationType = "agency",
  organizationStatus = "active",
  actingRole = "owner",
  initialTargetRole = null,
  requestedRole = "admin",
  databaseRole = "maintainflow_operator",
  canSelectOrganizations = true,
  canUpdateOrganizations = true,
  canSelectMemberships = true,
  canInsertMemberships = true,
  canUpdateMemberships = true,
  canBypassZeroPolicyRls = true,
} = {}) {
  const organization = {
    id: organizationId,
    name: "Northstar Agency",
    customer_type: organizationType,
    status: organizationStatus,
    created_at: fixedDate,
    updated_at: fixedDate,
  };
  const actingMembership = actingRole
    ? {
        organization_id: organizationId,
        clerk_user_id: actingOperatorId,
        role: actingRole,
        created_at: fixedDate,
        updated_at: fixedDate,
      }
    : null;
  let targetMembership = initialTargetRole
    ? {
        organization_id: organizationId,
        clerk_user_id: targetOperatorId,
        role: initialTargetRole,
        created_at: fixedDate,
        updated_at: fixedDate,
      }
    : null;
  const statements = [];

  const transaction = async (strings, ...parameters) => {
    const statement = strings.join(" ").replace(/\s+/g, " ").trim();
    statements.push({ statement, parameters });
    if (statement.includes("agency-member:operator-capability")) {
      return [
        {
          role_name: databaseRole,
          can_select_organizations: canSelectOrganizations,
          can_update_organizations: canUpdateOrganizations,
          can_select_memberships: canSelectMemberships,
          can_insert_memberships: canInsertMemberships,
          can_update_memberships: canUpdateMemberships,
          can_bypass_zero_policy_rls: canBypassZeroPolicyRls,
        },
      ];
    }
    if (statement.includes("maintainflow:agency-member:advisory-lock")) {
      return [{ pg_advisory_xact_lock: null }];
    }
    if (statement.includes("maintainflow:agency-member:target-reread")) {
      return targetMembership
        ? [
            {
              organization_id: targetMembership.organization_id,
              clerk_user_id: targetMembership.clerk_user_id,
              role: targetMembership.role,
            },
          ]
        : [];
    }
    if (statement.includes("maintainflow:agency-member:insert")) {
      if (targetMembership) return [];
      targetMembership = {
        organization_id: organizationId,
        clerk_user_id: targetOperatorId,
        role: requestedRole,
        created_at: fixedDate,
        updated_at: fixedDate,
      };
      return [
        {
          organization_id: organizationId,
          clerk_user_id: targetOperatorId,
          role: requestedRole,
        },
      ];
    }
    if (statement.includes("maintainflow:agency-member:organization")) {
      return [organization];
    }
    if (statement.includes("maintainflow:agency-member:memberships")) {
      return [actingMembership, targetMembership]
        .filter(Boolean)
        .sort((left, right) =>
          left.clerk_user_id.localeCompare(right.clerk_user_id),
        );
    }
    throw new Error(`Unexpected fake query: ${statement}`);
  };
  const sql = () => {};
  sql.begin = vi.fn(async (options, callback) => callback(transaction));
  sql.end = vi.fn(async () => {});

  return {
    sql,
    statements,
    setTargetRole(role) {
      targetMembership = role
        ? {
            organization_id: organizationId,
            clerk_user_id: targetOperatorId,
            role,
            created_at: fixedDate,
            updated_at: fixedDate,
          }
        : null;
    },
  };
}

function provisioningOptions(overrides = {}) {
  const applying = Object.hasOwn(overrides, "confirmationToken");
  return {
    organizationId,
    actingOperatorId,
    targetOperatorId,
    role: "admin",
    ...(applying ? { accountAccessAcknowledged: true } : {}),
    ...overrides,
  };
}

describe("agency member provisioning operator safety", () => {
  it("parses dry-run and explicit apply arguments", () => {
    expect(parseAgencyMemberProvisioningArgs(argumentsFor())).toEqual({
      mode: "dry-run",
      organizationId,
      actingOperatorId,
      targetOperatorId,
      role: "admin",
      confirmationToken: null,
      accountAccessAcknowledged: false,
    });

    const token = `PROVISION-AGENCY-MEMBER:${"a".repeat(64)}`;
    expect(
      parseAgencyMemberProvisioningArgs(
        argumentsFor([
          "--apply",
          "--confirm",
          token,
          "--acknowledge-agency-account-access",
        ]),
      ),
    ).toMatchObject({
      mode: "apply",
      confirmationToken: token,
      accountAccessAcknowledged: true,
    });
  });

  it.each([
    [
      "wildcard organization",
      argumentsFor().map((value) =>
        value === organizationId ? "*" : value,
      ),
    ],
    [
      "non-Clerk actor",
      argumentsFor().map((value) =>
        value === actingOperatorId ? "operator owner" : value,
      ),
    ],
    [
      "wildcard target",
      argumentsFor().map((value) =>
        value === targetOperatorId ? "user_*" : value,
      ),
    ],
    [
      "self add",
      argumentsFor().map((value) =>
        value === targetOperatorId ? actingOperatorId : value,
      ),
    ],
    [
      "owner target role",
      argumentsFor().map((value) => (value === "admin" ? "owner" : value)),
    ],
    ["apply without confirmation", argumentsFor(["--apply"])],
    [
      "apply without account-access acknowledgement",
      argumentsFor([
        "--apply",
        "--confirm",
        `PROVISION-AGENCY-MEMBER:${"a".repeat(64)}`,
      ]),
    ],
    [
      "account-access acknowledgement without apply",
      argumentsFor(["--acknowledge-agency-account-access"]),
    ],
    [
      "confirmation without apply",
      argumentsFor([
        "--confirm",
        `PROVISION-AGENCY-MEMBER:${"a".repeat(64)}`,
      ]),
    ],
    [
      "duplicate target",
      argumentsFor(["--target-operator-id", alternateTargetOperatorId]),
    ],
    ["unknown argument", argumentsFor(["--unexpected", "sensitive-value"])],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseAgencyMemberProvisioningArgs(argv)).toThrow(
      AgencyMemberProvisioningSafetyError,
    );
  });

  it("does not echo an unknown positional value in validation failures", () => {
    const sensitiveValue = "must-not-appear-in-errors";
    expect(() =>
      parseAgencyMemberProvisioningArgs([
        ...argumentsFor(),
        "--unknown",
        sensitiveValue,
      ]),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(sensitiveValue),
      }),
    );
  });

  it("binds confirmation tokens to the exact target and role", async () => {
    const first = fakeDatabase();
    const firstPlan = await prepareAgencyMemberProvisioning(
      first.sql,
      provisioningOptions(),
    );
    const alternate = fakeDatabase();
    const alternatePlan = await prepareAgencyMemberProvisioning(
      alternate.sql,
      provisioningOptions({ targetOperatorId: alternateTargetOperatorId }),
    );
    const analyst = fakeDatabase({ requestedRole: "analyst" });
    const analystPlan = await prepareAgencyMemberProvisioning(
      analyst.sql,
      provisioningOptions({ role: "analyst" }),
    );

    expect(firstPlan.confirmationToken).toMatch(
      /^PROVISION-AGENCY-MEMBER:[a-f0-9]{64}$/,
    );
    expect(alternatePlan.confirmationToken).not.toBe(
      firstPlan.confirmationToken,
    );
    expect(analystPlan.confirmationToken).not.toBe(firstPlan.confirmationToken);
    expect(alternatePlan.targetOperatorFingerprint).not.toBe(
      firstPlan.targetOperatorFingerprint,
    );
  });

  it("runs a repeatable-read, read-only dry run without locks or writes", async () => {
    const database = fakeDatabase();
    const plan = await prepareAgencyMemberProvisioning(
      database.sql,
      provisioningOptions(),
    );

    expect(plan).toMatchObject({
      action: "create_membership",
      role: "admin",
    });
    expect(database.sql.begin).toHaveBeenCalledWith(
      "isolation level repeatable read read only",
      expect.any(Function),
    );
    const statements = database.statements.map(({ statement }) => statement);
    expect(statements).toHaveLength(3);
    expect(statements.join(" ")).not.toMatch(
      /agency-member:advisory-lock|for update|agency-member:insert|delete from/i,
    );
  });

  it.each([
    ["an advertiser organization", { organizationType: "advertiser" }],
    ["a suspended organization", { organizationStatus: "suspended" }],
    ["a missing actor membership", { actingRole: null }],
    ["a non-owner actor", { actingRole: "admin" }],
    ["a conflicting target role", { initialTargetRole: "analyst" }],
  ])("blocks %s", async (_label, fixture) => {
    const database = fakeDatabase(fixture);
    await expect(
      prepareAgencyMemberProvisioning(database.sql, provisioningOptions()),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
  });

  it("locks, re-reads, and inserts exactly one membership on confirmed apply", async () => {
    const database = fakeDatabase();
    const plan = await prepareAgencyMemberProvisioning(
      database.sql,
      provisioningOptions(),
    );
    database.statements.splice(0);

    const result = await applyAgencyMemberProvisioning(
      database.sql,
      provisioningOptions({ confirmationToken: plan.confirmationToken }),
    );
    expect(result).toMatchObject({
      action: "create_membership",
      created: true,
      idempotent: false,
      role: "admin",
    });
    expect(database.sql.begin).toHaveBeenLastCalledWith(
      "isolation level read committed",
      expect.any(Function),
    );

    const statements = database.statements.map(({ statement }) => statement);
    const capabilityIndex = statements.findIndex((statement) =>
      statement.includes("agency-member:operator-capability"),
    );
    const lockIndex = statements.findIndex((statement) =>
      statement.includes("agency-member:advisory-lock"),
    );
    const organizationIndex = statements.findIndex((statement) =>
      statement.includes("agency-member:organization:locked"),
    );
    const membershipsIndex = statements.findIndex((statement) =>
      statement.includes("agency-member:memberships:locked"),
    );
    const insertIndex = statements.findIndex((statement) =>
      statement.includes("agency-member:insert"),
    );
    const rereadIndex = statements.findIndex((statement) =>
      statement.includes("agency-member:target-reread"),
    );
    expect([
      capabilityIndex,
      lockIndex,
      organizationIndex,
      membershipsIndex,
      insertIndex,
      rereadIndex,
    ]).toEqual([0, 1, 2, 3, 4, 5]);
    expect(statements[membershipsIndex]).toContain("order by clerk_user_id");
    expect(statements[membershipsIndex]).toContain("for update");
    expect(statements[insertIndex]).toContain(
      "on conflict (organization_id, clerk_user_id) do nothing",
    );
    const mutations = statements.filter((statement) =>
      /\b(?:insert into|update public\.|delete from)\b/i.test(statement),
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toContain(
      "insert into public.maintainflow_organization_memberships",
    );
  });

  it("rejects a stale token before insert", async () => {
    const database = fakeDatabase();
    const plan = await prepareAgencyMemberProvisioning(
      database.sql,
      provisioningOptions(),
    );
    const staleToken = `${plan.confirmationToken.slice(0, -1)}${
      plan.confirmationToken.endsWith("a") ? "b" : "a"
    }`;
    database.statements.splice(0);

    await expect(
      applyAgencyMemberProvisioning(
        database.sql,
        provisioningOptions({ confirmationToken: staleToken }),
      ),
    ).rejects.toThrow(/current locked membership state/i);
    expect(
      database.statements.some(({ statement }) =>
        statement.includes("agency-member:insert"),
      ),
    ).toBe(false);
  });

  it("requires agency-wide account-access acknowledgement before apply", async () => {
    const database = fakeDatabase();
    const plan = await prepareAgencyMemberProvisioning(
      database.sql,
      provisioningOptions(),
    );
    database.statements.splice(0);

    await expect(
      applyAgencyMemberProvisioning(database.sql, {
        ...provisioningOptions(),
        confirmationToken: plan.confirmationToken,
        accountAccessAcknowledged: false,
      }),
    ).rejects.toThrow(/inherits current and future advertiser-account access/i);
    expect(database.statements).toHaveLength(0);
  });

  it("requires a new token after a target-state change and is idempotent with it", async () => {
    const database = fakeDatabase();
    const absentPlan = await prepareAgencyMemberProvisioning(
      database.sql,
      provisioningOptions(),
    );
    database.setTargetRole("admin");

    await expect(
      applyAgencyMemberProvisioning(
        database.sql,
        provisioningOptions({ confirmationToken: absentPlan.confirmationToken }),
      ),
    ).rejects.toThrow(/current locked membership state/i);

    const currentPlan = await prepareAgencyMemberProvisioning(
      database.sql,
      provisioningOptions(),
    );
    database.statements.splice(0);
    const result = await applyAgencyMemberProvisioning(
      database.sql,
      provisioningOptions({ confirmationToken: currentPlan.confirmationToken }),
    );
    expect(currentPlan.action).toBe("already_provisioned");
    expect(result).toMatchObject({ created: false, idempotent: true });
    expect(
      database.statements.some(({ statement }) =>
        statement.includes("agency-member:insert"),
      ),
    ).toBe(false);
  });

  it("keeps dry-run output pseudonymous and closes its database connection", async () => {
    const database = fakeDatabase();
    const connect = vi.fn(() => database.sql);
    const output = { log: vi.fn() };
    const databaseUrl = "postgres://operator:private-password@localhost/app";

    await expect(
      runAgencyMemberProvisioningCli({
        argv: argumentsFor(),
        environment: { DATABASE_URL: databaseUrl },
        connect,
        output,
      }),
    ).resolves.toBe(0);
    expect(connect).toHaveBeenCalledWith(
      databaseUrl,
      expect.objectContaining({
        max: 1,
        max_pipeline: 0,
        prepare: false,
      }),
    );
    expect(database.sql.end).toHaveBeenCalledWith({ timeout: 5 });
    const rendered = output.log.mock.calls.flat().join("\n");
    expect(rendered).not.toContain(organizationId);
    expect(rendered).not.toContain(actingOperatorId);
    expect(rendered).not.toContain(targetOperatorId);
    expect(rendered).not.toContain("private-password");
    expect(rendered).toContain("without database changes");
    expect(rendered).toContain("does not create a Clerk user");
    expect(rendered).toMatch(/Confirmation token: PROVISION-AGENCY-MEMBER:/);
  });

  it("closes the connection when authorization fails", async () => {
    const database = fakeDatabase({ actingRole: "analyst" });
    await expect(
      runAgencyMemberProvisioningCli({
        argv: argumentsFor(),
        environment: { DATABASE_URL: "postgres://localhost/app" },
        connect: () => database.sql,
        output: { log: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    expect(database.sql.end).toHaveBeenCalledWith({ timeout: 5 });
  });

  it.each([
    ["the restricted runtime role", { databaseRole: "maintainflow_app" }],
    [
      "a role without organization SELECT",
      { canSelectOrganizations: false },
    ],
    [
      "a role without organization UPDATE lock authority",
      { canUpdateOrganizations: false },
    ],
    ["a role without membership SELECT", { canSelectMemberships: false }],
    ["a role without membership INSERT", { canInsertMemberships: false }],
    [
      "a role without membership UPDATE lock authority",
      { canUpdateMemberships: false },
    ],
    ["a role blocked by zero-policy RLS", { canBypassZeroPolicyRls: false }],
  ])("refuses %s before reading customer state", async (_label, fixture) => {
    const database = fakeDatabase(fixture);
    await expect(
      prepareAgencyMemberProvisioning(database.sql, provisioningOptions()),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    expect(database.statements).toHaveLength(1);
    expect(database.statements[0].statement).toContain(
      "agency-member:operator-capability",
    );
  });

  it.each([
    "postgres://db.example.com/app",
    "postgres://db.example.com/app?sslmode=require",
    "postgres://localhost/app?search_path=public",
    "postgres://localhost/app?options=-csearch_path%3Dpublic",
  ])("rejects an unsafe database URL before connecting: %s", async (url) => {
    const connect = vi.fn();
    await expect(
      runAgencyMemberProvisioningCli({
        argv: argumentsFor(),
        environment: { DATABASE_URL: url },
        connect,
        output: { log: vi.fn() },
      }),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    expect(connect).not.toHaveBeenCalled();
  });

  it("redacts database credentials, identifiers, and the confirmation token", () => {
    const password = "encoded/private-password";
    const encodedPassword = encodeURIComponent(password);
    const databaseUrl = `postgres://db-user:${encodedPassword}@db.example.com/app?sslmode=verify-full`;
    const token = `PROVISION-AGENCY-MEMBER:${"d".repeat(64)}`;
    const failure = new Error(
      `failed ${databaseUrl} ${password} ${organizationId} ${actingOperatorId} ${targetOperatorId} ${token}`,
    );

    const formatted = formatAgencyMemberProvisioningFailure(
      failure,
      { DATABASE_URL: databaseUrl, INTERNAL_SECRET: "extra-private" },
      argumentsFor(["--apply", "--confirm", token]),
    );
    for (const sensitive of [
      databaseUrl,
      password,
      organizationId,
      actingOperatorId,
      targetOperatorId,
      token,
    ]) {
      expect(formatted).not.toContain(sensitive);
    }
    expect(formatted).toContain("[REDACTED]");
  });
});
