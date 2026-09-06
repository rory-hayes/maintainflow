import { randomUUID } from "node:crypto";

import postgres from "postgres";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
} from "vitest";

import {
  AgencyMemberProvisioningSafetyError,
  applyAgencyMemberProvisioning,
  prepareAgencyMemberProvisioning,
} from "../../../scripts/agency-member-provisioning.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for the agency member provisioning integration suite.",
  );
}

const runtimeDatabaseUrl = process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL;
if (!runtimeDatabaseUrl) {
  throw new Error(
    "MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL is required for the agency member provisioning integration suite.",
  );
}

const database = postgres(databaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 3,
  prepare: false,
});
const runtimeDatabase = postgres(runtimeDatabaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 4,
  prepare: false,
});

type MembershipRole = "owner" | "admin" | "analyst";
type OrganizationStatus = "active" | "suspended";
type OrganizationType = "advertiser" | "agency";

type ProvisioningFixture = Readonly<{
  organizationId: string;
  actingOperatorId: string;
  targetOperatorId: string;
  requestedRole: "admin" | "analyst";
}>;

const fixtureOrganizationIds = new Set<string>();

function clerkUserId(label: string) {
  return `user_provisioning_${label}_${randomUUID().replaceAll("-", "")}`;
}

async function createProvisioningFixture(
  overrides: Readonly<{
    actingRole?: MembershipRole;
    organizationStatus?: OrganizationStatus;
    organizationType?: OrganizationType;
    requestedRole?: "admin" | "analyst";
    targetRole?: MembershipRole;
  }> = {},
): Promise<ProvisioningFixture> {
  const organizationId = randomUUID();
  const actingOperatorId = clerkUserId("actor");
  const targetOperatorId = clerkUserId("target");
  const requestedRole = overrides.requestedRole ?? "analyst";
  fixtureOrganizationIds.add(organizationId);

  await database.begin(async (transaction) => {
    await transaction`
      insert into maintainflow_organizations (
        id, name, customer_type, status
      ) values (
        ${organizationId},
        ${`Provisioning fixture ${organizationId}`},
        ${overrides.organizationType ?? "agency"},
        ${overrides.organizationStatus ?? "active"}
      )
    `;
    await transaction`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values (
        ${organizationId},
        ${actingOperatorId},
        ${overrides.actingRole ?? "owner"}
      )
    `;
    if (overrides.targetRole) {
      await transaction`
        insert into maintainflow_organization_memberships (
          organization_id, clerk_user_id, role
        ) values (
          ${organizationId},
          ${targetOperatorId},
          ${overrides.targetRole}
        )
      `;
    }
  });

  return {
    organizationId,
    actingOperatorId,
    targetOperatorId,
    requestedRole,
  };
}

function provisioningOptions(fixture: ProvisioningFixture) {
  return {
    organizationId: fixture.organizationId,
    actingOperatorId: fixture.actingOperatorId,
    targetOperatorId: fixture.targetOperatorId,
    role: fixture.requestedRole,
  } as const;
}

async function membershipRows(fixture: ProvisioningFixture) {
  return database<
    {
      organization_id: string;
      clerk_user_id: string;
      role: MembershipRole;
    }[]
  >`
    select organization_id, clerk_user_id, role
    from maintainflow_organization_memberships
    where organization_id = ${fixture.organizationId}
      and clerk_user_id = ${fixture.targetOperatorId}
  `;
}

beforeAll(async () => {
  await database`select 1`;
  await runtimeDatabase`select 1`;
});

afterEach(async () => {
  const organizationIds = [...fixtureOrganizationIds];
  fixtureOrganizationIds.clear();
  if (organizationIds.length === 0) return;

  await database`
    delete from maintainflow_organization_memberships
    where organization_id = any(${organizationIds}::uuid[])
  `;
  await database`
    delete from maintainflow_organizations
    where id = any(${organizationIds}::uuid[])
  `;
});

afterAll(async () => {
  await Promise.all([
    database.end({ timeout: 5 }),
    runtimeDatabase.end({ timeout: 5 }),
  ]);
});

describe("private-beta agency member provisioning", () => {
  it("prepares and applies an exact member insert through a privileged operator connection", async () => {
    const fixture = await createProvisioningFixture();
    const options = provisioningOptions(fixture);

    const plan = await prepareAgencyMemberProvisioning(database, options);
    expect(plan).toMatchObject({
      action: "create_membership",
      role: "analyst",
      stateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      organizationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      targetOperatorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      confirmationToken: expect.any(String),
    });
    expect(JSON.stringify(plan)).not.toContain(fixture.actingOperatorId);
    expect(JSON.stringify(plan)).not.toContain(fixture.targetOperatorId);

    await expect(
      applyAgencyMemberProvisioning(database, {
        ...options,
        confirmationToken: `${plan.confirmationToken}-wrong`,
        accountAccessAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    await expect(membershipRows(fixture)).resolves.toEqual([]);

    const result = await applyAgencyMemberProvisioning(database, {
      ...options,
      confirmationToken: plan.confirmationToken,
      accountAccessAcknowledged: true,
    });
    expect(result).toMatchObject({
      action: "create_membership",
      role: "analyst",
      stateFingerprint: plan.stateFingerprint,
      created: true,
      idempotent: false,
    });
    await expect(membershipRows(fixture)).resolves.toEqual([
      {
        organization_id: fixture.organizationId,
        clerk_user_id: fixture.targetOperatorId,
        role: "analyst",
      },
    ]);
  });

  it("requires a current owner of an active agency", async () => {
    const unauthorizedFixtures = await Promise.all([
      createProvisioningFixture({ actingRole: "admin" }),
      createProvisioningFixture({ organizationStatus: "suspended" }),
      createProvisioningFixture({ organizationType: "advertiser" }),
    ]);

    for (const fixture of unauthorizedFixtures) {
      await expect(
        prepareAgencyMemberProvisioning(database, provisioningOptions(fixture)),
      ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
      await expect(membershipRows(fixture)).resolves.toEqual([]);
    }
  });

  it("invalidates a dry-run token when organization or target membership state changes", async () => {
    const organizationChanged = await createProvisioningFixture();
    const organizationOptions = provisioningOptions(organizationChanged);
    const organizationPlan = await prepareAgencyMemberProvisioning(
      database,
      organizationOptions,
    );
    await database`
      update maintainflow_organizations
      set name = 'Provisioning fixture renamed',
        updated_at = updated_at + interval '1 second'
      where id = ${organizationChanged.organizationId}
    `;
    await expect(
      applyAgencyMemberProvisioning(database, {
        ...organizationOptions,
        confirmationToken: organizationPlan.confirmationToken,
        accountAccessAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    await expect(membershipRows(organizationChanged)).resolves.toEqual([]);

    const targetChanged = await createProvisioningFixture();
    const targetOptions = provisioningOptions(targetChanged);
    const targetPlan = await prepareAgencyMemberProvisioning(
      database,
      targetOptions,
    );
    await database`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values (
        ${targetChanged.organizationId},
        ${targetChanged.targetOperatorId},
        ${targetChanged.requestedRole}
      )
    `;
    await expect(
      applyAgencyMemberProvisioning(database, {
        ...targetOptions,
        confirmationToken: targetPlan.confirmationToken,
        accountAccessAcknowledged: true,
      }),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    await expect(membershipRows(targetChanged)).resolves.toHaveLength(1);
  });

  it("is idempotent only after a fresh dry run for an existing matching role", async () => {
    const fixture = await createProvisioningFixture({ targetRole: "analyst" });
    const options = provisioningOptions(fixture);
    const plan = await prepareAgencyMemberProvisioning(database, options);
    expect(plan).toMatchObject({
      action: "already_provisioned",
      role: "analyst",
      confirmationToken: expect.any(String),
    });

    const result = await applyAgencyMemberProvisioning(database, {
      ...options,
      confirmationToken: plan.confirmationToken,
      accountAccessAcknowledged: true,
    });
    expect(result).toMatchObject({
      action: "already_provisioned",
      created: false,
      idempotent: true,
    });
    await expect(membershipRows(fixture)).resolves.toHaveLength(1);
  });

  it("rejects an existing conflicting role instead of changing it", async () => {
    const fixture = await createProvisioningFixture({ targetRole: "admin" });

    await expect(
      prepareAgencyMemberProvisioning(database, provisioningOptions(fixture)),
    ).rejects.toBeInstanceOf(AgencyMemberProvisioningSafetyError);
    await expect(membershipRows(fixture)).resolves.toEqual([
      {
        organization_id: fixture.organizationId,
        clerk_user_id: fixture.targetOperatorId,
        role: "admin",
      },
    ]);
  });

  it("serializes concurrent use of one absent-target dry-run token", async () => {
    const fixture = await createProvisioningFixture();
    const options = provisioningOptions(fixture);
    const plan = await prepareAgencyMemberProvisioning(database, options);

    const outcomes = await Promise.allSettled([
      applyAgencyMemberProvisioning(database, {
        ...options,
        confirmationToken: plan.confirmationToken,
        accountAccessAcknowledged: true,
      }),
      applyAgencyMemberProvisioning(database, {
        ...options,
        confirmationToken: plan.confirmationToken,
        accountAccessAcknowledged: true,
      }),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<
        Awaited<ReturnType<typeof applyAgencyMemberProvisioning>>
      > => outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value).toMatchObject({
      created: true,
      idempotent: false,
    });
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(
      AgencyMemberProvisioningSafetyError,
    );
    await expect(membershipRows(fixture)).resolves.toHaveLength(1);
  });

  it("keeps the runtime membership grant narrow and reserves locking apply for an operator connection", async () => {
    const fixture = await createProvisioningFixture();
    const options = provisioningOptions(fixture);

    const [privileges] = await runtimeDatabase<
      {
        role_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
        can_truncate: boolean;
      }[]
    >`
      select current_user as role_name,
        has_table_privilege(
          current_user,
          'public.maintainflow_organization_memberships',
          'SELECT'
        ) as can_select,
        has_table_privilege(
          current_user,
          'public.maintainflow_organization_memberships',
          'INSERT'
        ) as can_insert,
        has_table_privilege(
          current_user,
          'public.maintainflow_organization_memberships',
          'UPDATE'
        ) as can_update,
        has_table_privilege(
          current_user,
          'public.maintainflow_organization_memberships',
          'DELETE'
        ) as can_delete,
        has_table_privilege(
          current_user,
          'public.maintainflow_organization_memberships',
          'TRUNCATE'
        ) as can_truncate
    `;
    expect(privileges).toEqual({
      role_name: "maintainflow_app",
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
      can_truncate: false,
    });

    await expect(
      prepareAgencyMemberProvisioning(runtimeDatabase, options),
    ).rejects.toMatchObject({
      name: "AgencyMemberProvisioningSafetyError",
      message: expect.stringMatching(/maintainflow_app.*intentionally refused/i),
    });
    await expect(
      applyAgencyMemberProvisioning(runtimeDatabase, {
        ...options,
        confirmationToken: `PROVISION-AGENCY-MEMBER:${"a".repeat(64)}`,
        accountAccessAcknowledged: true,
      }),
    ).rejects.toMatchObject({
      name: "AgencyMemberProvisioningSafetyError",
      message: expect.stringMatching(/maintainflow_app.*intentionally refused/i),
    });
    await expect(membershipRows(fixture)).resolves.toEqual([]);

    let updateCode: unknown;
    try {
      await runtimeDatabase`
        update maintainflow_organization_memberships
        set role = role
        where false
      `;
    } catch (error) {
      updateCode = (error as { code?: unknown }).code;
    }
    expect(updateCode).toBe("42501");
  });
});
