import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  ChangeApprovalRequestForbiddenError,
  ChangeApprovalRequestInvalidError,
  ChangeApprovalRequestTransitionError,
  createLiveChangeApprovalRequest,
  decideChangeApprovalRequest,
  linkLiveChangeApprovalExecution,
  resolveLiveChangeApprovalExecution,
} from "./change-request-store.server";
import { buildChangeApprovalDecisionContext } from "./change-request-schema";
import { recommendationApprovalFingerprint } from "../audit/recommendation-decision";
import { closeRuntimeDatabase } from "../database/client.server";
import {
  demoRecommendations,
  type Recommendation,
} from "../openai-ads/demo-data";
import type { AccountAccess, MembershipRole } from "../tenancy/schema";
import {
  AccountAccessForbiddenError,
  getOrganizationAccountAccess,
  requireOrganizationAccountAccess,
} from "../tenancy/store.server";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    "DATABASE_URL is required for the live change approval integration suite.",
  );
}

const database = postgres(databaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 4,
  prepare: false,
});

type LiveApprovalFixture = {
  organizationId: string;
  advertiserAccountId: string;
  accountId: string;
  requester: { id: string; name: string; initials: string };
  reviewer: { id: string; name: string; initials: string } | null;
  executor: { id: string; name: string; initials: string } | null;
};

const fixtureOrganizationIds = new Set<string>();

function operatorId(label: string) {
  return `user_live_approval_${label}_${randomUUID().replaceAll("-", "")}`;
}

function liveRecommendation(): Recommendation {
  const recommendation = demoRecommendations[0];
  if (!recommendation) throw new Error("Live approval fixture is missing.");
  return { ...recommendation, source: "live" };
}

async function createFixture(options: {
  requesterRole?: MembershipRole;
  includeReviewer?: boolean;
  includeExecutor?: boolean;
} = {}): Promise<LiveApprovalFixture> {
  const organizationId = randomUUID();
  const advertiserAccountId = randomUUID();
  const accountId = `adacct_live_approval_${randomUUID().replaceAll("-", "")}`;
  const requester = {
    id: operatorId("requester"),
    name: "Alex Requester",
    initials: "AR",
  };
  const reviewer = options.includeReviewer === false
    ? null
    : {
        id: operatorId("reviewer"),
        name: "Robin Reviewer",
        initials: "RR",
      };
  const executor = options.includeExecutor === false
    ? null
    : {
        id: operatorId("executor"),
        name: "Elliot Executor",
        initials: "EE",
      };
  fixtureOrganizationIds.add(organizationId);

  await database.begin(async (transaction) => {
    await transaction`
      insert into maintainflow_organizations (
        id, name, customer_type, status
      ) values (
        ${organizationId}, 'Live Approval Agency', 'agency', 'active'
      )
    `;
    await transaction`
      insert into maintainflow_advertiser_accounts (
        id, external_account_id, name, owner_organization_id,
        connection_mode, status
      ) values (
        ${advertiserAccountId}, ${accountId}, 'Live Approval Account',
        null, 'environment', 'active'
      )
    `;
    await transaction`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      ) values (
        ${organizationId}, ${advertiserAccountId}, 'manager', ${requester.id}
      )
    `;
    await transaction`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values (
        ${organizationId}, ${requester.id},
        ${options.requesterRole ?? "analyst"}
      )
    `;
    if (reviewer) {
      await transaction`
        insert into maintainflow_organization_memberships (
          organization_id, clerk_user_id, role
        ) values (${organizationId}, ${reviewer.id}, 'owner')
      `;
    }
    if (executor) {
      await transaction`
        insert into maintainflow_organization_memberships (
          organization_id, clerk_user_id, role
        ) values (${organizationId}, ${executor.id}, 'admin')
      `;
    }
  });

  return {
    organizationId,
    advertiserAccountId,
    accountId,
    requester,
    reviewer,
    executor,
  };
}

async function requestAccess(fixture: LiveApprovalFixture) {
  return requireOrganizationAccountAccess(
    fixture.requester.id,
    fixture.organizationId,
    fixture.accountId,
    "read",
  );
}

async function createAndApprove(
  fixture: LiveApprovalFixture,
  recommendation: Recommendation,
  timing: {
    requestedAt?: Date;
    decidedAt?: Date;
  } = {},
) {
  if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
  const requestedAt =
    timing.requestedAt ?? new Date("2099-09-03T09:00:00.000Z");
  const created = await createLiveChangeApprovalRequest({
    operator: fixture.requester,
    access: await requestAccess(fixture),
    recommendation,
    displayedFingerprint: recommendationApprovalFingerprint(recommendation),
    note: "Please independently review this exact live change.",
    now: requestedAt,
  });
  const decision = await decideChangeApprovalRequest({
    requestId: created.id,
    operator: fixture.reviewer,
    action: "approve",
    note: "Approved against the captured evidence and safeguard.",
    expectedVersion: 1,
    now: timing.decidedAt ?? new Date("2099-09-03T10:00:00.000Z"),
  });
  return { created, decision };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(applicationName: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [waiting] = await database<{ is_waiting: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_stat_activity activity
        where activity.datname = current_database()
          and activity.application_name = ${applicationName}
          and activity.state = 'active'
          and activity.wait_event_type = 'Lock'
      ) as is_waiting
    `;
    if (waiting?.is_waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} did not reach the expected database lock.`);
}

async function insertPendingApproval(
  transaction: postgres.TransactionSql,
  options: {
    id: string;
    operatorId: string;
    access: AccountAccess;
    recommendation: Recommendation;
  },
) {
  const monitoringPlan = options.recommendation.monitoringPlan ?? null;
  await transaction`
    insert into ads_approval_records (
      id, account_id, operator_id, acting_organization_id,
      actor_membership_role, actor_account_role, recommendation_id,
      recommendation_title, entity_id, recommendation_approval_fingerprint,
      request_payload, rollback_payload, evidence_payload, safeguard,
      monitoring_plan, monitoring_window_days, apply_provider_attempt_id,
      status
    ) values (
      ${options.id}, ${options.access.accountId}, ${options.operatorId},
      ${options.access.organizationId}, ${options.access.membershipRole},
      ${options.access.accountRole}, ${options.recommendation.id},
      ${options.recommendation.title}, ${options.recommendation.entityId},
      ${recommendationApprovalFingerprint(options.recommendation)},
      ${transaction.json(options.recommendation.mutation as postgres.JSONValue)},
      ${transaction.json(options.recommendation.rollback as postgres.JSONValue)},
      ${transaction.json(options.recommendation.evidence as postgres.JSONValue)},
      ${options.recommendation.safeguard},
      ${transaction.json(monitoringPlan as postgres.JSONValue)},
      ${options.recommendation.monitoringPlan?.windowDays ?? null},
      ${options.id}, 'pending'
    )
  `;
}

async function seedExpiredAwaitingRequest(
  fixture: LiveApprovalFixture,
  recommendation: Recommendation,
) {
  const id = randomUUID();
  const requestedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
  const expiresAt = new Date(requestedAt.getTime() + 7 * 24 * 60 * 60 * 1_000);
  await database`
    insert into maintainflow_change_approval_requests (
      id, organization_id, advertiser_account_id,
      account_id_snapshot, account_name_snapshot, source,
      recommendation_id, recommendation_title, entity_id,
      recommendation_fingerprint, decision_context, request_payload,
      rollback_payload, evidence_payload, safeguard,
      requester_operator_id, requester_name_snapshot,
      requester_membership_role, request_note, requested_at, expires_at,
      created_at, updated_at
    ) values (
      ${id}, ${fixture.organizationId}, ${fixture.advertiserAccountId},
      ${fixture.accountId}, 'Live Approval Account', 'live',
      ${recommendation.id}, ${recommendation.title}, ${recommendation.entityId},
      ${recommendationApprovalFingerprint(recommendation)},
      ${database.json(
        buildChangeApprovalDecisionContext(recommendation) as postgres.JSONValue,
      )},
      ${database.json(recommendation.mutation as postgres.JSONValue)},
      ${database.json(recommendation.rollback as postgres.JSONValue)},
      ${database.json(recommendation.evidence as postgres.JSONValue)},
      ${recommendation.safeguard}, ${fixture.requester.id},
      ${fixture.requester.name}, 'analyst',
      'Please independently review this exact live change.',
      ${requestedAt}, ${expiresAt}, ${requestedAt}, ${requestedAt}
    )
  `;
  return { id, requestedAt, expiresAt, version: 1 };
}

async function seedExpiredApprovedRequest(
  fixture: LiveApprovalFixture,
  recommendation: Recommendation,
) {
  if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
  const awaiting = await seedExpiredAwaitingRequest(fixture, recommendation);
  const decidedAt = new Date(
    awaiting.requestedAt.getTime() + 60 * 60 * 1_000,
  );
  await database`
    update maintainflow_change_approval_requests set
      status = 'approved',
      decision_operator_id = ${fixture.reviewer.id},
      decision_name_snapshot = ${fixture.reviewer.name},
      decision_membership_role = 'owner',
      decision_note = 'Approved against the captured evidence and safeguard.',
      decided_at = ${decidedAt},
      version = version + 1,
      updated_at = ${decidedAt}
    where id = ${awaiting.id}
  `;
  return { ...awaiting, version: 2 };
}

function legacyDecisionContext(recommendation: Recommendation) {
  return {
    schemaVersion: 1,
    priority: recommendation.priority,
    summary: recommendation.summary,
    entityLabel: recommendation.entityLabel,
    currentValue: recommendation.currentValue,
    proposedValue: recommendation.proposedValue,
    estimatedImpact: recommendation.estimatedImpact,
    confidence: recommendation.confidence,
    nextStep: recommendation.nextStep,
    monitoringPlan: recommendation.monitoringPlan ?? null,
  };
}

async function seedLegacyLiveRequest(
  fixture: LiveApprovalFixture,
  recommendation: Recommendation,
  status: "awaiting_approval" | "approved",
) {
  if (status === "approved" && !fixture.reviewer) {
    throw new Error("Reviewer fixture is missing.");
  }
  const id = randomUUID();
  const requestedAt = new Date("2099-09-03T09:00:00.000Z");
  const decidedAt = status === "approved"
    ? new Date("2099-09-03T10:00:00.000Z")
    : null;
  const expiresAt = new Date("2099-09-10T09:00:00.000Z");
  await database.begin(async (transaction) => {
    // Reproduce a packet written before migration 020's v2 insert guard.
    await transaction`set local session_replication_role = replica`;
    await transaction`
      insert into maintainflow_change_approval_requests (
        id, organization_id, advertiser_account_id,
        account_id_snapshot, account_name_snapshot, source,
        recommendation_id, recommendation_title, entity_id,
        recommendation_fingerprint, decision_context, request_payload,
        rollback_payload, evidence_payload, safeguard,
        requester_operator_id, requester_name_snapshot,
        requester_membership_role, request_note, status,
        decision_operator_id, decision_name_snapshot,
        decision_membership_role, decision_note, requested_at, decided_at,
        expires_at, version, created_at, updated_at
      ) values (
        ${id}, ${fixture.organizationId}, ${fixture.advertiserAccountId},
        ${fixture.accountId}, 'Live Approval Account', 'live',
        ${recommendation.id}, ${recommendation.title},
        ${recommendation.entityId},
        ${recommendationApprovalFingerprint(recommendation)},
        ${transaction.json(
          legacyDecisionContext(recommendation) as postgres.JSONValue,
        )},
        ${transaction.json(recommendation.mutation as postgres.JSONValue)},
        ${transaction.json(recommendation.rollback as postgres.JSONValue)},
        ${transaction.json(recommendation.evidence as postgres.JSONValue)},
        ${recommendation.safeguard}, ${fixture.requester.id},
        ${fixture.requester.name}, 'analyst',
        'Legacy review packet awaiting a v2 replacement.', ${status},
        ${status === "approved" ? fixture.reviewer!.id : null},
        ${status === "approved" ? fixture.reviewer!.name : null},
        ${status === "approved" ? "owner" : null},
        ${status === "approved"
          ? "Approved before the executable v2 review format."
          : null},
        ${requestedAt}, ${decidedAt}, ${expiresAt},
        ${status === "approved" ? 2 : 1}, ${requestedAt},
        ${decidedAt ?? requestedAt}
      )
    `;
  });
  return { id, version: status === "approved" ? 2 : 1 };
}

beforeAll(async () => {
  await database`select 1`;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  const organizationIds = [...fixtureOrganizationIds];
  fixtureOrganizationIds.clear();
  if (organizationIds.length === 0) return;

  await database`
    delete from maintainflow_change_approval_requests
    where organization_id = any(${organizationIds}::uuid[])
  `;
  await database`
    delete from ads_approval_records
    where acting_organization_id = any(${organizationIds}::uuid[])
  `;
  await database`
    delete from maintainflow_account_access
    where organization_id = any(${organizationIds}::uuid[])
  `;
  await database`
    delete from maintainflow_organization_memberships
    where organization_id = any(${organizationIds}::uuid[])
  `;
  await database`
    delete from maintainflow_advertiser_accounts account
    where account.id not in (
      select advertiser_account_id from maintainflow_account_access
    )
      and account.external_account_id like 'adacct_live_approval_%'
  `;
  await database`
    delete from maintainflow_organizations
    where id = any(${organizationIds}::uuid[])
  `;
});

afterAll(async () => {
  await closeRuntimeDatabase();
  await database.end({ timeout: 5 });
});

describe("live agency approval data boundary", () => {
  it("binds access to one exact operator, organization, and advertiser account", async () => {
    const fixture = await createFixture();
    const requesterAccess = await getOrganizationAccountAccess(
      fixture.requester.id,
      fixture.organizationId,
      fixture.accountId,
    );
    expect(requesterAccess).toMatchObject({
      organizationId: fixture.organizationId,
      organizationType: "agency",
      accountId: fixture.accountId,
      membershipRole: "analyst",
      accountRole: "manager",
    });
    await expect(
      getOrganizationAccountAccess(
        fixture.requester.id,
        randomUUID(),
        fixture.accountId,
      ),
    ).resolves.toBeNull();
    await expect(
      getOrganizationAccountAccess(
        fixture.requester.id,
        fixture.organizationId,
        `${fixture.accountId}_other`,
      ),
    ).resolves.toBeNull();
    await expect(
      requireOrganizationAccountAccess(
        fixture.requester.id,
        fixture.organizationId,
        fixture.accountId,
        "write",
      ),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
  });

  it("creates one immutable live packet and reuses the exact unconsumed duplicate", async () => {
    const fixture = await createFixture();
    const recommendation = liveRecommendation();
    const access = await requestAccess(fixture);
    const options = {
      operator: fixture.requester,
      access,
      recommendation,
      displayedFingerprint: recommendationApprovalFingerprint(recommendation),
      now: new Date("2099-09-03T09:00:00.000Z"),
    };

    const first = await createLiveChangeApprovalRequest(options);
    const second = await createLiveChangeApprovalRequest({
      ...options,
      now: new Date("2099-09-03T09:01:00.000Z"),
    });
    expect(first).toMatchObject({ created: true, eligibleReviewerCount: 2 });
    expect(second).toMatchObject({
      id: first.id,
      created: false,
      eligibleReviewerCount: 2,
    });
    if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
    await decideChangeApprovalRequest({
      requestId: first.id,
      operator: fixture.reviewer,
      action: "approve",
      expectedVersion: 1,
      now: new Date("2099-09-03T09:02:00.000Z"),
    });
    await expect(
      createLiveChangeApprovalRequest({
        ...options,
        now: new Date("2099-09-03T09:03:00.000Z"),
      }),
    ).resolves.toMatchObject({ id: first.id, created: false });

    const rows = await database<
      {
        advertiser_account_id: string;
        source: string;
        status: string;
        recommendation_fingerprint: string;
        requested_at: Date;
        expires_at: Date;
      }[]
    >`
      select advertiser_account_id, source, status,
        recommendation_fingerprint, requested_at, expires_at
      from maintainflow_change_approval_requests
      where id = ${first.id}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      advertiser_account_id: fixture.advertiserAccountId,
      source: "live",
      status: "approved",
      recommendation_fingerprint:
        recommendationApprovalFingerprint(recommendation),
    });
    expect(
      rows[0]!.expires_at.getTime() - rows[0]!.requested_at.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1_000);
  });

  it("does not treat an unadmitted owner as the second live reviewer", async () => {
    const fixture = await createFixture({ includeExecutor: false });
    if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "private_beta");
    vi.stubEnv(
      "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS",
      fixture.requester.id,
    );
    vi.stubEnv("MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS", "");
    const recommendation = liveRecommendation();

    await expect(
      createLiveChangeApprovalRequest({
        operator: fixture.requester,
        access: await requestAccess(fixture),
        recommendation,
        displayedFingerprint: recommendationApprovalFingerprint(
          recommendation,
        ),
      }),
    ).rejects.toThrow(/Add another agency owner or admin/i);
  });

  it("settles a duplicate request racing an independent decision without a lock cycle", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
    const recommendation = liveRecommendation();
    const access = await requestAccess(fixture);
    const created = await createLiveChangeApprovalRequest({
      operator: fixture.requester,
      access,
      recommendation,
      displayedFingerprint: recommendationApprovalFingerprint(recommendation),
      now: new Date("2099-09-03T09:00:00.000Z"),
    });

    const [duplicate, decision] = await Promise.all([
      createLiveChangeApprovalRequest({
        operator: fixture.requester,
        access,
        recommendation,
        displayedFingerprint: recommendationApprovalFingerprint(recommendation),
        now: new Date("2099-09-03T09:01:00.000Z"),
      }),
      decideChangeApprovalRequest({
        requestId: created.id,
        operator: fixture.reviewer,
        action: "approve",
        expectedVersion: 1,
        now: new Date("2099-09-03T09:02:00.000Z"),
      }),
    ]);

    expect(duplicate).toMatchObject({ id: created.id, created: false });
    expect(decision).toMatchObject({ status: "approved", version: 2 });
  });

  it("retires an expired approved packet and creates a fresh independently reviewable duplicate", async () => {
    const fixture = await createFixture();
    if (!fixture.executor) throw new Error("Executor fixture is missing.");
    const recommendation = liveRecommendation();
    const expired = await seedExpiredApprovedRequest(
      fixture,
      recommendation,
    );
    const capturedBeforeExpiry = new Date(
      expired.requestedAt.getTime() + 60 * 60 * 1_000,
    );
    const resolved = await resolveLiveChangeApprovalExecution({
      requestId: expired.id,
      expectedVersion: expired.version,
      operatorId: fixture.executor.id,
      now: capturedBeforeExpiry,
    });
    const approvalRecordId = randomUUID();
    const boundaryLink = database.begin(async (transaction) => {
      await insertPendingApproval(transaction, {
        id: approvalRecordId,
        operatorId: fixture.executor!.id,
        access: resolved.access,
        recommendation,
      });
      return linkLiveChangeApprovalExecution({
        transaction,
        requestId: expired.id,
        expectedVersion: expired.version,
        operatorId: fixture.executor!.id,
        access: resolved.access,
        recommendation,
        approvalRecordId,
        now: capturedBeforeExpiry,
      });
    });
    await expect(boundaryLink).rejects.toBeInstanceOf(
      ChangeApprovalRequestTransitionError,
    );
    await expect(boundaryLink).rejects.toThrow("expired before it could be consumed");
    const [rolledBackApproval] = await database<{ count: number }[]>`
      select count(*)::integer as count
      from ads_approval_records
      where id = ${approvalRecordId}
    `;
    expect(rolledBackApproval?.count).toBe(0);
    const beforeRetirement = Date.now();

    const replacement = await createLiveChangeApprovalRequest({
      operator: fixture.requester,
      access: await requestAccess(fixture),
      recommendation,
      displayedFingerprint: recommendationApprovalFingerprint(recommendation),
      now: new Date(),
    });
    const afterRetirement = Date.now();

    expect(replacement).toMatchObject({ created: true });
    expect(replacement.id).not.toBe(expired.id);
    const [retired] = await database<
      {
        status: string;
        decision_operator_id: string | null;
        decision_note: string | null;
        retired_at: Date | null;
        version: number;
        ads_approval_record_id: string | null;
      }[]
    >`
      select status, decision_operator_id, decision_note, retired_at,
        version::integer as version, ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${expired.id}
    `;
    expect(retired).toMatchObject({
      status: "approved",
      decision_operator_id: fixture.reviewer!.id,
      decision_note: "Approved against the captured evidence and safeguard.",
      version: expired.version + 1,
      ads_approval_record_id: null,
    });
    expect(retired?.retired_at?.getTime()).toBeGreaterThanOrEqual(
      beforeRetirement,
    );
    expect(retired?.retired_at?.getTime()).toBeLessThanOrEqual(afterRetirement);
  });

  it("uses database time to reject and expire a decision whose app clock is stale", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
    const recommendation = liveRecommendation();
    const expired = await seedExpiredAwaitingRequest(fixture, recommendation);
    const capturedBeforeExpiry = new Date(
      expired.requestedAt.getTime() + 60 * 60 * 1_000,
    );

    await expect(
      decideChangeApprovalRequest({
        requestId: expired.id,
        operator: fixture.reviewer,
        action: "approve",
        expectedVersion: expired.version,
        now: capturedBeforeExpiry,
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestTransitionError);

    const [request] = await database<
      {
        status: string;
        decision_operator_id: string | null;
        version: number;
      }[]
    >`
      select status, decision_operator_id, version::integer as version
      from maintainflow_change_approval_requests
      where id = ${expired.id}
    `;
    expect(request).toEqual({
      status: "expired",
      decision_operator_id: null,
      version: expired.version + 1,
    });
  });

  it("serializes expired-packet replacement against a stale decision without deadlock", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
    const recommendation = liveRecommendation();
    const expired = await seedExpiredAwaitingRequest(fixture, recommendation);
    const capturedBeforeExpiry = new Date(
      expired.requestedAt.getTime() + 60 * 60 * 1_000,
    );

    const [replacementOutcome, decisionOutcome] = await Promise.allSettled([
      createLiveChangeApprovalRequest({
        operator: fixture.requester,
        access: await requestAccess(fixture),
        recommendation,
        displayedFingerprint: recommendationApprovalFingerprint(recommendation),
        now: new Date(),
      }),
      decideChangeApprovalRequest({
        requestId: expired.id,
        operator: fixture.reviewer,
        action: "approve",
        expectedVersion: expired.version,
        now: capturedBeforeExpiry,
      }),
    ]);

    expect(replacementOutcome).toMatchObject({
      status: "fulfilled",
      value: { created: true },
    });
    expect(decisionOutcome.status).toBe("rejected");
    if (decisionOutcome.status === "rejected") {
      expect(decisionOutcome.reason).toBeInstanceOf(
        ChangeApprovalRequestTransitionError,
      );
      expect((decisionOutcome.reason as { code?: string }).code).not.toBe(
        "40P01",
      );
    }

    const [request] = await database<
      { status: string; version: number; decision_operator_id: string | null }[]
    >`
      select status, version::integer as version, decision_operator_id
      from maintainflow_change_approval_requests
      where id = ${expired.id}
    `;
    expect(request).toEqual({
      status: "expired",
      version: expired.version + 1,
      decision_operator_id: null,
    });
  });

  it("expires a legacy awaiting packet instead of approving or reusing it", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer) throw new Error("Reviewer fixture is missing.");
    const recommendation = liveRecommendation();
    const legacy = await seedLegacyLiveRequest(
      fixture,
      recommendation,
      "awaiting_approval",
    );

    await expect(
      decideChangeApprovalRequest({
        requestId: legacy.id,
        operator: fixture.reviewer,
        action: "approve",
        expectedVersion: legacy.version,
        now: new Date("2099-09-03T10:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestTransitionError);

    const replacement = await createLiveChangeApprovalRequest({
      operator: fixture.requester,
      access: await requestAccess(fixture),
      recommendation,
      displayedFingerprint: recommendationApprovalFingerprint(recommendation),
      now: new Date("2099-09-03T11:00:00.000Z"),
    });
    expect(replacement).toMatchObject({ created: true });
    expect(replacement.id).not.toBe(legacy.id);

    const [expired] = await database<
      { status: string; version: number; decision_operator_id: string | null }[]
    >`
      select status, version::integer as version, decision_operator_id
      from maintainflow_change_approval_requests
      where id = ${legacy.id}
    `;
    expect(expired).toEqual({
      status: "expired",
      version: legacy.version + 1,
      decision_operator_id: null,
    });
  });

  it("retires a legacy approved packet and refuses to resolve it for execution", async () => {
    const fixture = await createFixture();
    if (!fixture.executor) throw new Error("Executor fixture is missing.");
    const recommendation = liveRecommendation();
    const legacy = await seedLegacyLiveRequest(
      fixture,
      recommendation,
      "approved",
    );

    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: legacy.id,
        expectedVersion: legacy.version,
        operatorId: fixture.executor.id,
        now: new Date("2099-09-03T11:00:00.000Z"),
      }),
    ).rejects.toThrow("incompatible review packet");

    const replacement = await createLiveChangeApprovalRequest({
      operator: fixture.requester,
      access: await requestAccess(fixture),
      recommendation,
      displayedFingerprint: recommendationApprovalFingerprint(recommendation),
      now: new Date("2099-09-03T11:01:00.000Z"),
    });
    expect(replacement).toMatchObject({ created: true });
    expect(replacement.id).not.toBe(legacy.id);

    const [retired] = await database<
      { status: string; retired_at: Date | null; version: number }[]
    >`
      select status, retired_at, version::integer as version
      from maintainflow_change_approval_requests
      where id = ${legacy.id}
    `;
    expect(retired).toMatchObject({
      status: "approved",
      retired_at: expect.any(Date),
      version: legacy.version + 1,
    });
  });

  it("serializes approver demotion against execution, then retires the ineligible packet before replacement", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer || !fixture.executor) {
      throw new Error("Review fixtures are missing.");
    }
    const recommendation = liveRecommendation();
    const { created, decision } = await createAndApprove(
      fixture,
      recommendation,
    );
    const resolved = await resolveLiveChangeApprovalExecution({
      requestId: created.id,
      expectedVersion: decision.version,
      operatorId: fixture.executor.id,
      now: new Date("2099-09-03T11:00:00.000Z"),
    });
    const raceId = randomUUID().replaceAll("-", "");
    const roleApplicationName = `maintainflow-role-race-${raceId}`;
    const linkApplicationName = `maintainflow-link-race-${raceId}`;
    const roleDatabase = postgres(databaseUrl, {
      connection: { application_name: roleApplicationName },
      max: 1,
      prepare: false,
    });
    const linkDatabase = postgres(databaseUrl, {
      connection: { application_name: linkApplicationName },
      max: 1,
      prepare: false,
    });
    const demotionHeld = deferred();
    const allowDemotionCommit = deferred();
    const demotion = roleDatabase.begin(async (transaction) => {
      await transaction`
        update maintainflow_organization_memberships
        set role = 'analyst', updated_at = pg_catalog.statement_timestamp()
        where organization_id = ${fixture.organizationId}
          and clerk_user_id = ${fixture.reviewer!.id}
      `;
      demotionHeld.resolve();
      await allowDemotionCommit.promise;
    });
    let link: Promise<unknown> | undefined;
    let replacement: Promise<unknown> | undefined;
    const approvalRecordId = randomUUID();
    try {
      await demotionHeld.promise;
      link = linkDatabase.begin(async (transaction) => {
        await insertPendingApproval(transaction, {
          id: approvalRecordId,
          operatorId: fixture.executor!.id,
          access: resolved.access,
          recommendation,
        });
        return linkLiveChangeApprovalExecution({
          transaction,
          requestId: created.id,
          expectedVersion: decision.version,
          operatorId: fixture.executor!.id,
          access: resolved.access,
          recommendation,
          approvalRecordId,
          now: new Date("2099-09-03T11:01:00.000Z"),
        });
      });
      await waitForDatabaseLock(linkApplicationName);

      replacement = createLiveChangeApprovalRequest({
        operator: fixture.requester,
        access: await requestAccess(fixture),
        recommendation,
        displayedFingerprint: recommendationApprovalFingerprint(recommendation),
        now: new Date("2099-09-03T11:02:00.000Z"),
      });
      await waitForDatabaseLock("maintainflow-ads");
      allowDemotionCommit.resolve();

      const [linkOutcome, replacementOutcome] = await Promise.allSettled([
        link,
        replacement,
      ]);
      expect(linkOutcome.status).toBe("rejected");
      if (linkOutcome.status === "rejected") {
        expect(linkOutcome.reason).toBeInstanceOf(
          ChangeApprovalRequestTransitionError,
        );
      }
      expect(replacementOutcome).toMatchObject({
        status: "fulfilled",
        value: { created: true },
      });
      if (replacementOutcome.status === "fulfilled") {
        expect(
          (replacementOutcome.value as { id: string }).id,
        ).not.toBe(created.id);
      }
    } finally {
      allowDemotionCommit.resolve();
      await Promise.allSettled([
        demotion,
        ...(link ? [link] : []),
        ...(replacement ? [replacement] : []),
      ]);
      await roleDatabase.end({ timeout: 5 });
      await linkDatabase.end({ timeout: 5 });
    }

    const [retired] = await database<
      {
        retired_at: Date | null;
        version: number;
        ads_approval_record_id: string | null;
      }[]
    >`
      select retired_at, version::integer as version, ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${created.id}
    `;
    expect(retired).toMatchObject({
      retired_at: expect.any(Date),
      version: decision.version + 1,
      ads_approval_record_id: null,
    });
    const [rolledBackApproval] = await database<{ count: number }[]>`
      select count(*)::integer as count
      from ads_approval_records
      where id = ${approvalRecordId}
    `;
    expect(rolledBackApproval?.count).toBe(0);
  });

  it("refuses a live packet when no different owner or admin can review it", async () => {
    const fixture = await createFixture({
      requesterRole: "owner",
      includeReviewer: false,
      includeExecutor: false,
    });
    const recommendation = liveRecommendation();

    await expect(
      createLiveChangeApprovalRequest({
        operator: fixture.requester,
        access: await requestAccess(fixture),
        recommendation,
        displayedFingerprint: recommendationApprovalFingerprint(recommendation),
        now: new Date("2099-09-03T09:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestInvalidError);
    const [count] = await database<{ count: number }[]>`
      select count(*)::integer as count
      from maintainflow_change_approval_requests
      where organization_id = ${fixture.organizationId}
    `;
    expect(count?.count).toBe(0);
  });

  it("resolves from the stored internal account and atomically consumes the exact approved packet", async () => {
    const fixture = await createFixture();
    if (!fixture.executor) throw new Error("Executor fixture is missing.");
    const recommendation = liveRecommendation();
    const { created, decision } = await createAndApprove(
      fixture,
      recommendation,
    );
    expect(decision).toMatchObject({ status: "approved", version: 2 });

    const resolved = await resolveLiveChangeApprovalExecution({
      requestId: created.id,
      expectedVersion: decision.version,
      operatorId: fixture.executor.id,
      now: new Date("2099-09-03T11:00:00.000Z"),
    });
    expect(resolved).toMatchObject({
      request: {
        id: created.id,
        accountId: fixture.accountId,
        organizationId: fixture.organizationId,
        status: "approved",
        adsApprovalRecordId: null,
      },
      access: {
        accountId: fixture.accountId,
        organizationId: fixture.organizationId,
        membershipRole: "admin",
        accountRole: "manager",
      },
    });

    const approvalRecordId = randomUUID();
    const linked = await database.begin(async (transaction) => {
      await insertPendingApproval(transaction, {
        id: approvalRecordId,
        operatorId: fixture.executor!.id,
        access: resolved.access,
        recommendation,
      });
      return linkLiveChangeApprovalExecution({
        transaction,
        requestId: created.id,
        expectedVersion: decision.version,
        operatorId: fixture.executor!.id,
        access: resolved.access,
        recommendation,
        approvalRecordId,
        now: new Date("2099-09-03T11:01:00.000Z"),
      });
    });
    expect(linked).toEqual({
      id: created.id,
      version: 3,
      adsApprovalRecordId: approvalRecordId,
    });

    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: created.id,
        expectedVersion: 3,
        operatorId: fixture.executor.id,
        now: new Date("2099-09-03T11:02:00.000Z"),
      }),
    ).rejects.toThrow("already been consumed");
  });

  it("allows exactly one concurrent transaction to consume an approved packet", async () => {
    const fixture = await createFixture();
    if (!fixture.executor) throw new Error("Executor fixture is missing.");
    const recommendation = liveRecommendation();
    const { created, decision } = await createAndApprove(
      fixture,
      recommendation,
    );
    const resolved = await resolveLiveChangeApprovalExecution({
      requestId: created.id,
      expectedVersion: decision.version,
      operatorId: fixture.executor.id,
      now: new Date("2099-09-03T11:00:00.000Z"),
    });

    const attempts = [randomUUID(), randomUUID()].map((approvalRecordId) =>
      database.begin(async (transaction) => {
        await insertPendingApproval(transaction, {
          id: approvalRecordId,
          operatorId: fixture.executor!.id,
          access: resolved.access,
          recommendation,
        });
        return linkLiveChangeApprovalExecution({
          transaction,
          requestId: created.id,
          expectedVersion: decision.version,
          operatorId: fixture.executor!.id,
          access: resolved.access,
          recommendation,
          approvalRecordId,
          now: new Date("2099-09-03T11:01:00.000Z"),
        });
      }),
    );
    const outcomes = await Promise.allSettled(attempts);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);

    const [request] = await database<
      { version: number; ads_approval_record_id: string | null }[]
    >`
      select version::integer as version, ads_approval_record_id
      from maintainflow_change_approval_requests
      where id = ${created.id}
    `;
    expect(request).toMatchObject({
      version: 3,
      ads_approval_record_id: expect.stringMatching(/^[a-f0-9-]{36}$/),
    });
  });

  it("rolls back a mismatched durable operation and rechecks the approver's current role", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer || !fixture.executor) {
      throw new Error("Review fixtures are missing.");
    }
    const recommendation = liveRecommendation();
    const { created, decision } = await createAndApprove(
      fixture,
      recommendation,
    );
    const resolved = await resolveLiveChangeApprovalExecution({
      requestId: created.id,
      expectedVersion: decision.version,
      operatorId: fixture.executor.id,
      now: new Date("2099-09-03T11:00:00.000Z"),
    });
    const changedRecommendation: Recommendation = {
      ...recommendation,
      evidence: [
        ...recommendation.evidence,
        {
          label: "Changed evidence",
          value: "Stale",
          detail: "Added after the independent decision.",
        },
      ],
    };
    const mismatchedApprovalId = randomUUID();
    await expect(
      database.begin(async (transaction) => {
        await insertPendingApproval(transaction, {
          id: mismatchedApprovalId,
          operatorId: fixture.executor!.id,
          access: resolved.access,
          recommendation: changedRecommendation,
        });
        return linkLiveChangeApprovalExecution({
          transaction,
          requestId: created.id,
          expectedVersion: decision.version,
          operatorId: fixture.executor!.id,
          access: resolved.access,
          recommendation: changedRecommendation,
          approvalRecordId: mismatchedApprovalId,
          now: new Date("2099-09-03T11:01:00.000Z"),
        });
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestInvalidError);
    const [rolledBack] = await database<{ count: number }[]>`
      select count(*)::integer as count
      from ads_approval_records
      where id = ${mismatchedApprovalId}
    `;
    expect(rolledBack?.count).toBe(0);

    await database`
      update maintainflow_organization_memberships
      set role = 'analyst', updated_at = now()
      where organization_id = ${fixture.organizationId}
        and clerk_user_id = ${fixture.reviewer.id}
    `;
    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: created.id,
        expectedVersion: decision.version,
        operatorId: fixture.executor.id,
        now: new Date("2099-09-03T11:02:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestTransitionError);
  });

  it("rejects an approved packet when its recorded approver is removed from private-beta admission", async () => {
    const fixture = await createFixture();
    if (!fixture.reviewer || !fixture.executor) {
      throw new Error("Review fixtures are missing.");
    }
    vi.stubEnv("MAINTAINFLOW_ADMISSION_MODE", "private_beta");
    vi.stubEnv(
      "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS",
      [fixture.requester.id, fixture.reviewer.id, fixture.executor.id].join(","),
    );
    vi.stubEnv("MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS", "");
    const recommendation = liveRecommendation();
    const { created, decision } = await createAndApprove(
      fixture,
      recommendation,
    );

    vi.stubEnv(
      "MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS",
      [fixture.requester.id, fixture.executor.id].join(","),
    );

    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: created.id,
        expectedVersion: decision.version,
        operatorId: fixture.executor.id,
        now: new Date("2099-09-03T11:02:00.000Z"),
      }),
    ).rejects.toThrow(/no longer an admitted, eligible owner or admin/i);
  });

  it("rejects cross-tenant, stale-version, and expired execution preparation", async () => {
    const fixture = await createFixture();
    if (!fixture.executor) throw new Error("Executor fixture is missing.");
    const recommendation = liveRecommendation();
    const { created, decision } = await createAndApprove(
      fixture,
      recommendation,
    );

    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: created.id,
        expectedVersion: decision.version,
        operatorId: operatorId("outsider"),
        now: new Date("2099-09-03T11:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestForbiddenError);
    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: created.id,
        expectedVersion: 1,
        operatorId: fixture.executor.id,
        now: new Date("2099-09-03T11:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(ChangeApprovalRequestTransitionError);
    await expect(
      resolveLiveChangeApprovalExecution({
        requestId: created.id,
        expectedVersion: decision.version,
        operatorId: fixture.executor.id,
        now: new Date("2099-09-11T09:00:00.000Z"),
      }),
    ).rejects.toThrow("expired");
  });
});
