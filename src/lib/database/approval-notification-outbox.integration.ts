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
const deliveryDatabase = postgres(
  process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL ?? databaseUrl,
  {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 2,
    prepare: false,
  },
);

const organizationId = randomUUID();
const otherOrganizationId = randomUUID();
const requesterOperatorId = `user_notification_requester_${randomUUID()}`;
const reviewerOperatorId = `user_notification_reviewer_${randomUUID()}`;

async function createApprovalRequest() {
  const requestId = randomUUID();
  const requestedAt = new Date();
  const expiresAt = new Date(requestedAt.getTime() + 60 * 60 * 1_000);
  await database`
    insert into public.maintainflow_change_approval_requests (
      id,
      organization_id,
      account_id_snapshot,
      account_name_snapshot,
      source,
      recommendation_id,
      recommendation_title,
      entity_id,
      recommendation_fingerprint,
      decision_context,
      request_payload,
      rollback_payload,
      evidence_payload,
      safeguard,
      requester_operator_id,
      requester_name_snapshot,
      requester_membership_role,
      requested_at,
      expires_at
    ) values (
      ${requestId},
      ${organizationId},
      ${`account_${requestId}`},
      'Notification fixture',
      'simulator',
      ${`recommendation_${requestId}`},
      'Review notification fixture',
      ${`entity_${requestId}`},
      ${"a".repeat(64)},
      ${database.json({ schemaVersion: "simulator" })},
      ${database.json({ operation: "update" })},
      ${database.json({ operation: "restore" })},
      ${database.json({ source: "notification_integration" })},
      'Independent review is required before this change.',
      ${requesterOperatorId},
      'Notification Requester',
      'analyst',
      ${requestedAt},
      ${expiresAt}
    )
  `;
  return requestId;
}

async function createReviewDelivery(requestId: string) {
  const deliveryId = randomUUID();
  await deliveryDatabase`
    insert into public.maintainflow_approval_notification_deliveries (
      id,
      approval_request_id,
      organization_id,
      event_type,
      recipient_operator_id,
      recipient_membership_role_snapshot,
      approval_request_version
    ) values (
      ${deliveryId},
      ${requestId},
      ${organizationId},
      'review_requested',
      ${reviewerOperatorId},
      'admin',
      1
    )
  `;
  return deliveryId;
}

describe("approval notification delivery database boundary", () => {
  beforeAll(async () => {
    await database`
      insert into public.maintainflow_organizations (
        id, name, customer_type, status
      ) values
        (${organizationId}, 'Notification Agency', 'agency', 'active'),
        (${otherOrganizationId}, 'Other Notification Agency', 'agency', 'active')
    `;
    await database`
      insert into public.maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values
        (${organizationId}, ${requesterOperatorId}, 'analyst'),
        (${organizationId}, ${reviewerOperatorId}, 'admin'),
        (${otherOrganizationId}, ${reviewerOperatorId}, 'admin')
    `;
  });

  afterAll(async () => {
    await database`
      delete from public.maintainflow_change_approval_requests
      where organization_id in (${organizationId}, ${otherOrganizationId})
    `;
    await database`
      delete from public.maintainflow_organization_memberships
      where organization_id in (${organizationId}, ${otherOrganizationId})
    `;
    await database`
      delete from public.maintainflow_organizations
      where id in (${organizationId}, ${otherOrganizationId})
    `;
    await deliveryDatabase.end({ timeout: 5 });
    await database.end({ timeout: 5 });
  });

  it("binds request and organization and accepts only an eligible reviewer", async () => {
    const requestId = await createApprovalRequest();
    const deliveryId = await createReviewDelivery(requestId);
    const [delivery] = await deliveryDatabase<
      {
        status: string;
        attempt_count: number;
        channel: string;
        provider: string;
        next_attempt_at: Date | null;
      }[]
    >`
      select status, attempt_count, channel, provider, next_attempt_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;

    expect(delivery).toMatchObject({
      status: "queued",
      attempt_count: 0,
      channel: "email",
      provider: "resend",
    });
    expect(delivery?.next_attempt_at).toBeInstanceOf(Date);

    await expect(
      deliveryDatabase`
        insert into public.maintainflow_approval_notification_deliveries (
          id, approval_request_id, organization_id, event_type,
          recipient_operator_id, recipient_membership_role_snapshot,
          approval_request_version
        ) values (
          ${randomUUID()}, ${requestId}, ${otherOrganizationId},
          'review_requested', ${reviewerOperatorId}, 'admin', 1
        )
      `,
    ).rejects.toThrow(/organization-scoped request/);

    await expect(
      deliveryDatabase`
        insert into public.maintainflow_approval_notification_deliveries (
          id, approval_request_id, organization_id, event_type,
          recipient_operator_id, recipient_membership_role_snapshot,
          approval_request_version
        ) values (
          ${randomUUID()}, ${requestId}, ${organizationId},
          'review_requested', ${requesterOperatorId}, 'analyst', 1
        )
      `,
    ).rejects.toThrow(/another current owner or admin/);
  });

  it("derives leases and accepts ordered provider events that predate local acceptance", async () => {
    const requestId = await createApprovalRequest();
    const deliveryId = await createReviewDelivery(requestId);
    const claimId = randomUUID();

    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'sending', claim_id = ${claimId}
      where id = ${deliveryId}
    `;
    const [sending] = await deliveryDatabase<
      {
        attempt_count: number;
        claimed_at: Date | null;
        claim_expires_at: Date | null;
        first_attempted_at: Date | null;
      }[]
    >`
      select attempt_count, claimed_at, claim_expires_at, first_attempted_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(sending?.attempt_count).toBe(1);
    expect(sending?.claimed_at).toBeInstanceOf(Date);
    expect(sending?.claim_expires_at?.getTime()).toBeGreaterThan(
      sending?.claimed_at?.getTime() ?? Number.MAX_SAFE_INTEGER,
    );
    expect(sending?.first_attempted_at?.getTime()).toBe(
      sending?.claimed_at?.getTime(),
    );

    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'provider_accepted',
        provider_message_id = ${`resend_${randomUUID()}`}
      where id = ${deliveryId} and claim_id = ${claimId}
    `;
    const [accepted] = await deliveryDatabase<
      { provider_accepted_at: Date }[]
    >`
      select provider_accepted_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    // Provider event timestamps describe provider-side occurrence time. An
    // early webhook can be retried after the later local acceptance commit.
    const delayedAt = new Date(accepted.provider_accepted_at.getTime() - 2_000);
    const deliveredAt = new Date(delayedAt.getTime() + 1_000);
    const complainedAt = new Date(accepted.provider_accepted_at.getTime() + 1_000);

    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set provider_event_type = 'email.delivery_delayed',
        provider_event_at = ${delayedAt}
      where id = ${deliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'delivered',
        provider_event_type = 'email.delivered',
        provider_event_at = ${deliveredAt}
      where id = ${deliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'complained',
        provider_event_type = 'email.complained',
        provider_event_at = ${complainedAt}
      where id = ${deliveryId}
    `;

    const [complained] = await deliveryDatabase<
      { status: string; provider_event_type: string; claim_id: string | null }[]
    >`
      select status, provider_event_type, claim_id
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(complained).toEqual({
      status: "complained",
      provider_event_type: "email.complained",
      claim_id: null,
    });
    await expect(
      deliveryDatabase`
        update public.maintainflow_approval_notification_deliveries
        set status = 'delivered',
          provider_event_type = 'email.delivered',
          provider_event_at = ${new Date(complainedAt.getTime() + 1_000)}
        where id = ${deliveryId}
      `,
    ).rejects.toThrow(/lifecycle transition is not allowed/);
  });

  it("reconciles a provisional confirmation timeout with a late signed terminal event", async () => {
    const requestId = await createApprovalRequest();
    const deliveryId = await createReviewDelivery(requestId);
    const claimId = randomUUID();
    const providerMessageId = `resend_${randomUUID()}`;

    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'sending', claim_id = ${claimId}
      where id = ${deliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'provider_accepted',
        provider_message_id = ${providerMessageId}
      where id = ${deliveryId} and claim_id = ${claimId}
    `;
    const [accepted] = await deliveryDatabase<
      { provider_accepted_at: Date }[]
    >`
      select provider_accepted_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'permanent_failure',
        last_failure_code = 'delivery_confirmation_missing'
      where id = ${deliveryId}
    `;

    await expect(
      deliveryDatabase`
        update public.maintainflow_approval_notification_deliveries
        set provider_event_type = 'email.delivery_delayed',
          provider_event_at = ${accepted!.provider_accepted_at}
        where id = ${deliveryId}
      `,
    ).rejects.toThrow(/permits only a signed failed event/);

    const earlyTerminalAt = new Date(
      accepted!.provider_accepted_at.getTime() - 1_000,
    );
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'delivered',
        provider_event_type = 'email.delivered',
        provider_event_at = ${earlyTerminalAt}
      where id = ${deliveryId}
    `;
    const [delivered] = await deliveryDatabase<
      {
        status: string;
        provider_event_type: string;
        provider_event_at: Date;
        last_failure_code: string | null;
        last_failed_at: Date | null;
      }[]
    >`
      select status, provider_event_type, provider_event_at,
        last_failure_code, last_failed_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(delivered).toMatchObject({
      status: "delivered",
      provider_event_type: "email.delivered",
      last_failure_code: null,
      last_failed_at: null,
    });
    expect(delivered?.provider_event_at.getTime()).toBe(
      earlyTerminalAt.getTime(),
    );
  });

  it("replaces a provisional confirmation timeout with a late signed failure", async () => {
    const requestId = await createApprovalRequest();
    const deliveryId = await createReviewDelivery(requestId);
    const claimId = randomUUID();

    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'sending', claim_id = ${claimId}
      where id = ${deliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'provider_accepted',
        provider_message_id = ${`resend_${randomUUID()}`}
      where id = ${deliveryId} and claim_id = ${claimId}
    `;
    const [accepted] = await deliveryDatabase<
      { provider_accepted_at: Date }[]
    >`
      select provider_accepted_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'permanent_failure',
        last_failure_code = 'delivery_confirmation_missing'
      where id = ${deliveryId}
    `;

    const earlyFailureAt = new Date(
      accepted!.provider_accepted_at.getTime() - 1_000,
    );
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'permanent_failure',
        provider_event_type = 'email.failed',
        provider_event_at = ${earlyFailureAt},
        last_failure_code = 'provider_rejected'
      where id = ${deliveryId}
    `;
    const [failed] = await deliveryDatabase<
      {
        status: string;
        provider_event_type: string;
        last_failure_code: string;
        last_failed_at: Date | null;
      }[]
    >`
      select status, provider_event_type, last_failure_code, last_failed_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(failed).toMatchObject({
      status: "permanent_failure",
      provider_event_type: "email.failed",
      last_failure_code: "provider_rejected",
    });
    expect(failed?.last_failed_at).toBeInstanceOf(Date);
  });

  it("derives retry timing and protects terminal cancellation state", async () => {
    const retryRequestId = await createApprovalRequest();
    const retryDeliveryId = await createReviewDelivery(retryRequestId);
    const claimId = randomUUID();
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'sending', claim_id = ${claimId}
      where id = ${retryDeliveryId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'retry_scheduled', last_failure_code = 'provider_timeout'
      where id = ${retryDeliveryId} and claim_id = ${claimId}
    `;
    const [retry] = await deliveryDatabase<
      {
        status: string;
        attempt_count: number;
        next_attempt_at: Date | null;
        last_failed_at: Date | null;
      }[]
    >`
      select status, attempt_count, next_attempt_at, last_failed_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${retryDeliveryId}
    `;
    expect(retry?.status).toBe("retry_scheduled");
    expect(retry?.attempt_count).toBe(1);
    expect(retry?.next_attempt_at).toBeInstanceOf(Date);
    expect(retry?.last_failed_at).toBeInstanceOf(Date);

    const cancelRequestId = await createApprovalRequest();
    const cancelDeliveryId = await createReviewDelivery(cancelRequestId);
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'cancelled', cancellation_code = 'account_offboarded'
      where id = ${cancelDeliveryId}
    `;
    const [cancelled] = await deliveryDatabase<
      { status: string; cancelled_at: Date | null; next_attempt_at: Date | null }[]
    >`
      select status, cancelled_at, next_attempt_at
      from public.maintainflow_approval_notification_deliveries
      where id = ${cancelDeliveryId}
    `;
    expect(cancelled).toMatchObject({
      status: "cancelled",
      next_attempt_at: null,
    });
    expect(cancelled?.cancelled_at).toBeInstanceOf(Date);
    await expect(
      deliveryDatabase`
        update public.maintainflow_approval_notification_deliveries
        set status = 'queued'
        where id = ${cancelDeliveryId}
      `,
    ).rejects.toThrow(/lifecycle transition is not allowed/);

    const eligibilityRequestId = await createApprovalRequest();
    const eligibilityDeliveryId = await createReviewDelivery(
      eligibilityRequestId,
    );
    const eligibilityClaimId = randomUUID();
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'sending', claim_id = ${eligibilityClaimId}
      where id = ${eligibilityDeliveryId}
    `;
    await expect(
      deliveryDatabase`
        update public.maintainflow_approval_notification_deliveries
        set status = 'cancelled', cancellation_code = 'recipient_ineligible'
        where id = ${eligibilityDeliveryId}
          and claim_id = ${eligibilityClaimId}
      `,
    ).rejects.toThrow(/eligible recipient notification cannot be cancelled/);

    await database`
      update public.maintainflow_organization_memberships
      set role = 'analyst'
      where organization_id = ${organizationId}
        and clerk_user_id = ${reviewerOperatorId}
    `;
    await deliveryDatabase`
      update public.maintainflow_approval_notification_deliveries
      set status = 'cancelled', cancellation_code = 'recipient_ineligible'
      where id = ${eligibilityDeliveryId}
        and claim_id = ${eligibilityClaimId}
    `;
    await database`
      update public.maintainflow_organization_memberships
      set role = 'admin'
      where organization_id = ${organizationId}
        and clerk_user_id = ${reviewerOperatorId}
    `;
  });

  it("keeps the outbox behind zero-policy RLS and exact runtime columns", async () => {
    const [security] = await database<
      { row_security_enabled: boolean; policy_count: number }[]
    >`
      select relation.relrowsecurity as row_security_enabled,
        (
          select count(*)::integer
          from pg_catalog.pg_policy policy
          where policy.polrelid = relation.oid
        ) as policy_count
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname =
          'maintainflow_approval_notification_deliveries'
    `;
    expect(security).toEqual({
      row_security_enabled: true,
      policy_count: 0,
    });

    const privileges = await database<
      { privilege_type: string; column_name: string }[]
    >`
      select privilege_type, column_name
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'maintainflow_approval_notification_deliveries'
        and grantee = 'maintainflow_app'
        and privilege_type in ('INSERT', 'UPDATE')
      order by privilege_type, column_name
    `;
    expect(privileges).toEqual([
      { privilege_type: "INSERT", column_name: "approval_request_id" },
      { privilege_type: "INSERT", column_name: "approval_request_version" },
      { privilege_type: "INSERT", column_name: "event_type" },
      { privilege_type: "INSERT", column_name: "id" },
      { privilege_type: "INSERT", column_name: "organization_id" },
      {
        privilege_type: "INSERT",
        column_name: "recipient_membership_role_snapshot",
      },
      { privilege_type: "INSERT", column_name: "recipient_operator_id" },
      { privilege_type: "UPDATE", column_name: "cancellation_code" },
      { privilege_type: "UPDATE", column_name: "claim_id" },
      { privilege_type: "UPDATE", column_name: "last_failure_code" },
      { privilege_type: "UPDATE", column_name: "provider_event_at" },
      { privilege_type: "UPDATE", column_name: "provider_event_type" },
      { privilege_type: "UPDATE", column_name: "provider_message_id" },
      { privilege_type: "UPDATE", column_name: "status" },
    ]);

    const [runtimeBoundary] = await database<
      {
        table_insert: boolean;
        table_update: boolean;
        can_execute_trigger: boolean;
      }[]
    >`
      select has_table_privilege(
          'maintainflow_app',
          'public.maintainflow_approval_notification_deliveries',
          'INSERT'
        ) as table_insert,
        has_table_privilege(
          'maintainflow_app',
          'public.maintainflow_approval_notification_deliveries',
          'UPDATE'
        ) as table_update,
        has_function_privilege(
          'maintainflow_app',
          'public.maintainflow_enforce_approval_notification_delivery()',
          'EXECUTE'
        ) as can_execute_trigger
    `;
    expect(runtimeBoundary).toEqual({
      table_insert: false,
      table_update: false,
      can_execute_trigger: false,
    });

    const dataApiBoundaries = await database<
      {
        role_name: string;
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_execute_trigger: boolean;
      }[]
    >`
      select role.rolname as role_name,
        has_table_privilege(
          role.rolname,
          'public.maintainflow_approval_notification_deliveries',
          'SELECT'
        ) as can_select,
        has_table_privilege(
          role.rolname,
          'public.maintainflow_approval_notification_deliveries',
          'INSERT'
        ) as can_insert,
        has_table_privilege(
          role.rolname,
          'public.maintainflow_approval_notification_deliveries',
          'UPDATE'
        ) as can_update,
        has_function_privilege(
          role.rolname,
          'public.maintainflow_enforce_approval_notification_delivery()',
          'EXECUTE'
        ) as can_execute_trigger
      from pg_catalog.pg_roles role
      where role.rolname in ('anon', 'authenticated', 'service_role')
      order by role.rolname
    `;
    expect(
      dataApiBoundaries.every(
        (boundary) =>
          !boundary.can_select &&
          !boundary.can_insert &&
          !boundary.can_update &&
          !boundary.can_execute_trigger,
      ),
    ).toBe(true);
  });
});
