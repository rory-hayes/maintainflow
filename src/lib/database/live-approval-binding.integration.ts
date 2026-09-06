import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the database integration suite.");
}

const database = postgres(databaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 2,
  prepare: false,
});

const agencyOrganizationId = randomUUID();
const advertiserOrganizationId = randomUUID();
const agencyAccountId = randomUUID();
const advertiserAccountId = randomUUID();
const agencyExternalAccountId = `adacct_binding_agency_${randomUUID()}`;
const advertiserExternalAccountId = `adacct_binding_direct_${randomUUID()}`;
const requesterId = `user_binding_requester_${randomUUID()}`;
const executorId = `user_binding_executor_${randomUUID()}`;
const reviewerId = `user_binding_reviewer_${randomUUID()}`;
const directOperatorId = `user_binding_direct_${randomUUID()}`;
const fingerprint = "a".repeat(64);

const mutation = { operation: "update", budgetMicros: 2_500_000 };
const rollback = { operation: "update", budgetMicros: 2_000_000 };
const evidence = [{ label: "CPA", value: "EUR 19.40" }];
const safeguard = "Pause when click-attributed CPA rises by more than 15%.";

async function createApprovedAgencyRequest(
  options: {
    recommendationId: string;
    recommendationTitle?: string;
    entityId?: string;
    expiresAt?: Date;
    decisionContext?: postgres.JSONValue;
  },
  client: postgres.TransactionSql | typeof database = database,
) {
  const id = randomUUID();
  const now = new Date();
  await client`
    insert into maintainflow_change_approval_requests (
      id, organization_id, advertiser_account_id,
      account_id_snapshot, account_name_snapshot, source,
      recommendation_id, recommendation_title, entity_id,
      recommendation_fingerprint, decision_context, request_payload,
      rollback_payload, evidence_payload, safeguard,
      requester_operator_id, requester_name_snapshot,
      requester_membership_role, request_note, requested_at, expires_at
    ) values (
      ${id}, ${agencyOrganizationId}, ${agencyAccountId},
      ${agencyExternalAccountId}, 'Binding agency account', 'live',
      ${options.recommendationId},
      ${options.recommendationTitle ?? "Reduce wasted spend"},
      ${options.entityId ?? "campaign_binding"}, ${fingerprint},
      ${client.json(options.decisionContext ?? { schemaVersion: 2 })},
      ${client.json(mutation)},
      ${client.json(rollback)}, ${client.json(evidence)}, ${safeguard},
      ${requesterId}, 'Request Owner', 'analyst',
      'Please review the exact live change.', ${now},
      ${options.expiresAt ?? new Date(now.getTime() + 60 * 60 * 1_000)}
    )
  `;
  await client`
    update maintainflow_change_approval_requests set
      status = 'approved',
      decision_operator_id = ${reviewerId},
      decision_name_snapshot = 'Independent Reviewer',
      decision_membership_role = 'admin',
      decision_note = 'Reviewed against the supplied evidence.',
      decided_at = now(),
      version = version + 1,
      updated_at = now()
    where id = ${id}
  `;
  return id;
}

async function insertApproval(
  transaction: postgres.TransactionSql | typeof database,
  options: {
    id: string;
    organizationId: string;
    accountId: string;
    operatorId: string;
    membershipRole: "owner" | "admin";
    accountRole: "owner" | "manager";
    recommendationId: string;
    recommendationTitle?: string;
    entityId?: string;
    requestPayload?: unknown;
    monitoringPlan?: unknown;
    monitoringWindowDays?: number;
  },
) {
  await transaction`
    insert into ads_approval_records (
      id, account_id, operator_id, acting_organization_id,
      actor_membership_role, actor_account_role, recommendation_id,
      recommendation_title, entity_id, recommendation_approval_fingerprint,
      request_payload, rollback_payload, evidence_payload, safeguard,
      monitoring_plan, monitoring_window_days, apply_provider_attempt_id,
      status
    ) values (
      ${options.id}, ${options.accountId}, ${options.operatorId},
      ${options.organizationId}, ${options.membershipRole},
      ${options.accountRole}, ${options.recommendationId},
      ${options.recommendationTitle ?? "Reduce wasted spend"},
      ${options.entityId ?? "campaign_binding"}, ${fingerprint},
      ${transaction.json(
        (options.requestPayload ?? mutation) as postgres.JSONValue,
      )},
      ${transaction.json(rollback)}, ${transaction.json(evidence)},
      ${safeguard},
      ${options.monitoringPlan === undefined
        ? null
        : transaction.json(options.monitoringPlan as postgres.JSONValue)},
      ${options.monitoringWindowDays ?? null}, ${options.id}, 'pending'
    )
  `;
}

beforeAll(async () => {
  await database.begin(async (transaction) => {
    await transaction`
      insert into maintainflow_organizations (id, name, customer_type)
      values
        (${agencyOrganizationId}, 'Binding Test Agency', 'agency'),
        (${advertiserOrganizationId}, 'Binding Test Advertiser', 'advertiser')
    `;
    await transaction`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values
        (${agencyOrganizationId}, ${requesterId}, 'analyst'),
        (${agencyOrganizationId}, ${executorId}, 'owner'),
        (${agencyOrganizationId}, ${reviewerId}, 'admin'),
        (${advertiserOrganizationId}, ${directOperatorId}, 'owner')
    `;
    await transaction`
      insert into maintainflow_advertiser_accounts (
        id, external_account_id, name, owner_organization_id,
        connection_mode, status
      ) values
        (
          ${agencyAccountId}, ${agencyExternalAccountId},
          'Binding agency account', null, 'environment', 'active'
        ),
        (
          ${advertiserAccountId}, ${advertiserExternalAccountId},
          'Binding direct account', ${advertiserOrganizationId},
          'environment', 'active'
        )
    `;
    await transaction`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      ) values
        (${agencyOrganizationId}, ${agencyAccountId}, 'manager', ${executorId}),
        (
          ${advertiserOrganizationId}, ${advertiserAccountId},
          'owner', ${directOperatorId}
        )
    `;
  });
});

afterAll(async () => {
  await database`
    delete from maintainflow_change_approval_requests
    where organization_id in (
      ${agencyOrganizationId}, ${advertiserOrganizationId}
    )
  `;
  await database`
    delete from ads_approval_records
    where acting_organization_id in (
      ${agencyOrganizationId}, ${advertiserOrganizationId}
    )
  `;
  await database`
    delete from maintainflow_account_access
    where organization_id in (
      ${agencyOrganizationId}, ${advertiserOrganizationId}
    )
  `;
  await database`
    delete from maintainflow_organization_memberships
    where organization_id in (
      ${agencyOrganizationId}, ${advertiserOrganizationId}
    )
  `;
  await database`
    delete from maintainflow_advertiser_accounts
    where id in (${agencyAccountId}, ${advertiserAccountId})
  `;
  await database`
    delete from maintainflow_organizations
    where id in (${agencyOrganizationId}, ${advertiserOrganizationId})
  `;
  await database.end({ timeout: 5 });
});

describe("live agency approval database binding", () => {
  it("lets the restricted runtime lock auth rows but rejects material changes", async () => {
    const runtimeUrl = process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL;
    if (!runtimeUrl) return;

    const runtime = postgres(runtimeUrl, {
      connect_timeout: 5,
      idle_timeout: 5,
      max: 1,
      prepare: false,
    });
    try {
      await expect(
        runtime.begin(async (transaction) => {
          const rows = await transaction<{ organization_id: string }[]>`
            select organization.id as organization_id
            from maintainflow_organizations organization
            join maintainflow_organization_memberships membership
              on membership.organization_id = organization.id
            join maintainflow_account_access account_access
              on account_access.organization_id = organization.id
            where organization.id = ${agencyOrganizationId}
              and membership.clerk_user_id = ${executorId}
              and account_access.advertiser_account_id = ${agencyAccountId}
            for update of organization, membership, account_access
          `;
          return rows[0]?.organization_id;
        }),
      ).resolves.toBe(agencyOrganizationId);

      for (const mutationAttempt of [
        () => runtime`
          update maintainflow_organizations
          set id = ${randomUUID()}
          where id = ${agencyOrganizationId}
        `,
        () => runtime`
          update maintainflow_organization_memberships
          set organization_id = ${advertiserOrganizationId}
          where organization_id = ${agencyOrganizationId}
            and clerk_user_id = ${executorId}
        `,
        () => runtime`
          update maintainflow_account_access
          set organization_id = ${advertiserOrganizationId}
          where organization_id = ${agencyOrganizationId}
            and advertiser_account_id = ${agencyAccountId}
        `,
      ]) {
        await expect(mutationAttempt()).rejects.toThrow(
          /may lock authorization rows but cannot change them/,
        );
      }

      await expect(
        runtime`
          update maintainflow_organizations
          set name = name
          where id = ${agencyOrganizationId}
        `,
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await runtime.end({ timeout: 5 });
    }
  });

  it("accepts a direct-advertiser approval without an agency request", async () => {
    const id = randomUUID();
    await expect(
      insertApproval(database, {
        id,
        organizationId: advertiserOrganizationId,
        accountId: advertiserExternalAccountId,
        operatorId: directOperatorId,
        membershipRole: "owner",
        accountRole: "owner",
        recommendationId: `rec_direct_${randomUUID()}`,
      }),
    ).resolves.toBeUndefined();

    await expect(
      insertApproval(database, {
        id: randomUUID(),
        organizationId: advertiserOrganizationId,
        accountId: agencyExternalAccountId,
        operatorId: directOperatorId,
        membershipRole: "owner",
        accountRole: "owner",
        recommendationId: `rec_forged_direct_${randomUUID()}`,
      }),
    ).rejects.toThrow(/exact current account ownership and write access/);
  });

  it("rejects a new agency approval that reaches commit without a request", async () => {
    await expect(
      insertApproval(database, {
        id: randomUUID(),
        organizationId: agencyOrganizationId,
        accountId: agencyExternalAccountId,
        operatorId: executorId,
        membershipRole: "owner",
        accountRole: "manager",
        recommendationId: `rec_unbound_${randomUUID()}`,
      }),
    ).rejects.toThrow(/exactly one valid live approval request/);
  });

  it("commits only when the agency approval and request match exactly", async () => {
    const recommendationId = `rec_exact_${randomUUID()}`;
    const requestId = await createApprovedAgencyRequest({ recommendationId });
    const approvalId = randomUUID();

    await expect(
      database.begin(async (transaction) => {
        await insertApproval(transaction, {
          id: approvalId,
          organizationId: agencyOrganizationId,
          accountId: agencyExternalAccountId,
          operatorId: executorId,
          membershipRole: "owner",
          accountRole: "manager",
          recommendationId,
        });
        await transaction`
          update maintainflow_change_approval_requests set
            ads_approval_record_id = ${approvalId},
            version = version + 1,
            updated_at = now()
          where id = ${requestId}
        `;
      }),
    ).resolves.toBeUndefined();

    const [linked] = await database<
      { ads_approval_record_id: string | null }[]
    >`
      select ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${requestId}
    `;
    expect(linked?.ads_approval_record_id).toBe(approvalId);
  });

  it("rejects a mismatched payload before an agency packet can be consumed", async () => {
    const recommendationId = `rec_mismatch_${randomUUID()}`;
    const requestId = await createApprovedAgencyRequest({ recommendationId });
    const approvalId = randomUUID();

    await expect(
      database.begin(async (transaction) => {
        await insertApproval(transaction, {
          id: approvalId,
          organizationId: agencyOrganizationId,
          accountId: agencyExternalAccountId,
          operatorId: executorId,
          membershipRole: "owner",
          accountRole: "manager",
          recommendationId,
          requestPayload: { ...mutation, budgetMicros: 9_999_999 },
        });
        await transaction`
          update maintainflow_change_approval_requests set
            ads_approval_record_id = ${approvalId},
            version = version + 1,
            updated_at = now()
          where id = ${requestId}
        `;
      }),
    ).rejects.toThrow(/must match one active, unexpired, approved agency packet/);

    const [request] = await database<
      { ads_approval_record_id: string | null }[]
    >`
      select ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${requestId}
    `;
    expect(request?.ads_approval_record_id).toBeNull();
  });

  it("rejects a monitoring plan that was not present in the reviewed packet", async () => {
    const recommendationId = `rec_monitoring_mismatch_${randomUUID()}`;
    const requestId = await createApprovedAgencyRequest({ recommendationId });
    const approvalId = randomUUID();

    await expect(
      database.begin(async (transaction) => {
        await insertApproval(transaction, {
          id: approvalId,
          organizationId: agencyOrganizationId,
          accountId: agencyExternalAccountId,
          operatorId: executorId,
          membershipRole: "owner",
          accountRole: "manager",
          recommendationId,
          monitoringPlan: { windowDays: 7, rollbackRule: "manual" },
          monitoringWindowDays: 7,
        });
        await transaction`
          update maintainflow_change_approval_requests set
            ads_approval_record_id = ${approvalId},
            version = version + 1,
            updated_at = now()
          where id = ${requestId}
        `;
      }),
    ).rejects.toThrow(/must match one active, unexpired, approved agency packet/);
  });

  it("guards request creation, duplicate unconsumed packets, and approval evidence", async () => {
    const recommendationId = `rec_guard_${randomUUID()}`;
    const firstId = await createApprovedAgencyRequest({ recommendationId });

    await expect(
      createApprovedAgencyRequest({ recommendationId }),
    ).rejects.toMatchObject({ code: "23505" });

    const invalidRequestId = randomUUID();
    const now = new Date();
    await expect(
      database`
        insert into maintainflow_change_approval_requests (
          id, organization_id, advertiser_account_id,
          account_id_snapshot, account_name_snapshot, source,
          recommendation_id, recommendation_title, entity_id,
          recommendation_fingerprint, decision_context, request_payload,
          rollback_payload, evidence_payload, safeguard,
          requester_operator_id, requester_name_snapshot,
          requester_membership_role, requested_at, expires_at, version
        ) values (
          ${invalidRequestId}, ${agencyOrganizationId}, ${agencyAccountId},
          ${agencyExternalAccountId}, 'Binding agency account', 'live',
          ${`rec_invalid_${randomUUID()}`}, 'Invalid initial version',
          'campaign_binding', ${fingerprint},
          ${database.json({ schemaVersion: 1 })}, ${database.json(mutation)},
          ${database.json(rollback)}, ${database.json(evidence)}, ${safeguard},
          ${requesterId}, 'Request Owner', 'analyst', ${now},
          ${new Date(now.getTime() + 60 * 60 * 1_000)}, 2
        )
      `,
    ).rejects.toThrow(/must start awaiting approval/);

    const directApprovalId = randomUUID();
    await insertApproval(database, {
      id: directApprovalId,
      organizationId: advertiserOrganizationId,
      accountId: advertiserExternalAccountId,
      operatorId: directOperatorId,
      membershipRole: "owner",
      accountRole: "owner",
      recommendationId: `rec_immutable_${randomUUID()}`,
    });
    await expect(
      database`
        update ads_approval_records
        set request_payload = ${database.json({ operation: "delete" })}
        where id = ${directApprovalId}
      `,
    ).rejects.toThrow(/identity and evidence are immutable/);

    expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("rejects a combined approve-and-link transition from an awaiting packet", async () => {
    const requestId = randomUUID();
    const recommendationId = `rec_combined_transition_${randomUUID()}`;
    const requestedAt = new Date();
    await database`
      insert into maintainflow_change_approval_requests (
        id, organization_id, advertiser_account_id,
        account_id_snapshot, account_name_snapshot, source,
        recommendation_id, recommendation_title, entity_id,
        recommendation_fingerprint, decision_context, request_payload,
        rollback_payload, evidence_payload, safeguard,
        requester_operator_id, requester_name_snapshot,
        requester_membership_role, request_note, requested_at, expires_at
      ) values (
        ${requestId}, ${agencyOrganizationId}, ${agencyAccountId},
        ${agencyExternalAccountId}, 'Binding agency account', 'live',
        ${recommendationId}, 'Reduce wasted spend', 'campaign_binding',
        ${fingerprint}, ${database.json({ schemaVersion: 2 })},
        ${database.json(mutation)}, ${database.json(rollback)},
        ${database.json(evidence)}, ${safeguard}, ${requesterId},
        'Request Owner', 'analyst', 'Review before execution.',
        ${requestedAt}, ${new Date(requestedAt.getTime() + 60 * 60 * 1_000)}
      )
    `;
    const approvalId = randomUUID();

    await expect(
      database.begin(async (transaction) => {
        await insertApproval(transaction, {
          id: approvalId,
          organizationId: agencyOrganizationId,
          accountId: agencyExternalAccountId,
          operatorId: executorId,
          membershipRole: "owner",
          accountRole: "manager",
          recommendationId,
        });
        await transaction`
          update maintainflow_change_approval_requests set
            status = 'approved',
            decision_operator_id = ${reviewerId},
            decision_name_snapshot = 'Independent Reviewer',
            decision_membership_role = 'admin',
            decision_note = 'Approved against the supplied evidence.',
            decided_at = pg_catalog.statement_timestamp(),
            ads_approval_record_id = ${approvalId},
            version = version + 1,
            updated_at = pg_catalog.statement_timestamp()
          where id = ${requestId}
        `;
      }),
    ).rejects.toThrow(/cannot link an execution record/);

    const [request] = await database<
      { status: string; version: number; ads_approval_record_id: string | null }[]
    >`
      select status, version::integer as version, ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${requestId}
    `;
    expect(request).toEqual({
      status: "awaiting_approval",
      version: 1,
      ads_approval_record_id: null,
    });
    const [approval] = await database<{ count: number }[]>`
      select count(*)::integer as count
      from ads_approval_records
      where id = ${approvalId}
    `;
    expect(approval?.count).toBe(0);
  });

  it("permits only database-timed one-way retirement and never links a retired packet", async () => {
    const recommendationId = `rec_retirement_${randomUUID()}`;
    const requestId = await createApprovedAgencyRequest({ recommendationId });

    await expect(
      database`
        update maintainflow_change_approval_requests set
          retired_at = pg_catalog.statement_timestamp(),
          version = version + 1,
          updated_at = pg_catalog.statement_timestamp()
        where id = ${requestId}
      `,
    ).rejects.toThrow(
      /only after expiry, approver ineligibility, or decision-schema incompatibility/,
    );

    await database`
      update maintainflow_organization_memberships
      set role = 'analyst', updated_at = pg_catalog.statement_timestamp()
      where organization_id = ${agencyOrganizationId}
        and clerk_user_id = ${reviewerId}
    `;
    try {
      await expect(
        database`
          update maintainflow_change_approval_requests set
            retired_at = pg_catalog.statement_timestamp(),
            version = version + 1,
            updated_at = pg_catalog.statement_timestamp()
          where id = ${requestId}
          returning id
        `,
      ).resolves.toHaveLength(1);
    } finally {
      await database`
        update maintainflow_organization_memberships
        set role = 'admin', updated_at = pg_catalog.statement_timestamp()
        where organization_id = ${agencyOrganizationId}
          and clerk_user_id = ${reviewerId}
      `;
    }

    await expect(
      database`
        update maintainflow_change_approval_requests set
          retired_at = null,
          version = version + 1,
          updated_at = pg_catalog.statement_timestamp()
        where id = ${requestId}
      `,
    ).rejects.toThrow(/approved agency packet|one-way retirement/);

    const approvalId = randomUUID();
    await expect(
      database.begin(async (transaction) => {
        await insertApproval(transaction, {
          id: approvalId,
          organizationId: agencyOrganizationId,
          accountId: agencyExternalAccountId,
          operatorId: executorId,
          membershipRole: "owner",
          accountRole: "manager",
          recommendationId,
        });
        await transaction`
          update maintainflow_change_approval_requests set
            ads_approval_record_id = ${approvalId},
            version = version + 1,
            updated_at = pg_catalog.statement_timestamp()
          where id = ${requestId}
        `;
      }),
    ).rejects.toThrow(/approved agency packet|one-way retirement/);

    const [retired] = await database<
      {
        status: string;
        retired_at: Date | null;
        version: number;
        ads_approval_record_id: string | null;
      }[]
    >`
      select status, retired_at, version::integer as version,
        ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${requestId}
    `;
    expect(retired).toMatchObject({
      status: "approved",
      retired_at: expect.any(Date),
      version: 3,
      ads_approval_record_id: null,
    });
  });

  it("retires an incompatible legacy approval while its approver remains eligible", async () => {
    const recommendationId = `rec_legacy_retirement_${randomUUID()}`;
    const requestId = await database.begin(async (transaction) => {
      await transaction`set local session_replication_role = replica`;
      return createApprovedAgencyRequest(
        {
          recommendationId,
          decisionContext: { schemaVersion: 1 },
        },
        transaction,
      );
    });

    await expect(
      database`
        update maintainflow_change_approval_requests set
          retired_at = pg_catalog.statement_timestamp(),
          version = version + 1,
          updated_at = pg_catalog.statement_timestamp()
        where id = ${requestId}
        returning id
      `,
    ).resolves.toHaveLength(1);

    const [retired] = await database<
      { status: string; retired_at: Date | null; version: number }[]
    >`
      select status, retired_at, version::integer as version
      from maintainflow_change_approval_requests
      where id = ${requestId}
    `;
    expect(retired).toMatchObject({
      status: "approved",
      retired_at: expect.any(Date),
      version: 3,
    });
  });
});
