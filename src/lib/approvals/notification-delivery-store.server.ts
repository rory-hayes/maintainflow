import "server-only";

import { randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { Sql } from "postgres";

import {
  getWorkspaceAdmissionMode,
  getWorkspaceAdmittedOperatorIds,
} from "../auth/config";
import { getRuntimeDatabase } from "../database/client.server";
import { isApprovalEmailEnabledForOrganization } from "./notification-config.server";
import type { ApprovalNotificationEvent } from "./notification-email";

export type ApprovalNotificationFailureCode =
  | "identity_provider_unavailable"
  | "recipient_unavailable"
  | "provider_timeout"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_rejected"
  | "provider_configuration"
  | "worker_lease_expired"
  | "delivery_confirmation_missing";

export type ApprovalNotificationProviderEvent =
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.suppressed"
  | "email.failed";

type ClaimedDeliveryRow = {
  id: string;
  approval_request_id: string;
  organization_id: string;
  event_type: ApprovalNotificationEvent;
  recipient_operator_id: string;
  approval_request_version: number;
  claim_id: string;
  attempt_count: number;
};

type DeliveryIdentityRow = {
  id: string;
  approval_request_id: string;
  organization_id: string;
  recipient_operator_id: string;
};

export type ClaimedApprovalNotificationDelivery = {
  id: string;
  approvalRequestId: string;
  organizationId: string;
  eventType: ApprovalNotificationEvent;
  recipientOperatorId: string;
  approvalRequestVersion: number;
  claimId: string;
  attemptCount: number;
};

export type ApprovalNotificationRecoverySummary = Readonly<{
  cancelledIneligible: number;
  retryScheduledAfterLeaseExpiry: number;
  permanentFailuresAfterLeaseExpiry: number;
  permanentFailuresAfterIdempotencyExpiry: number;
  permanentFailuresAfterConfirmationTimeout: number;
}>;

export type ApprovalNotificationClaimBatch = Readonly<{
  deliveries: ClaimedApprovalNotificationDelivery[];
  recovery: ApprovalNotificationRecoverySummary;
}>;

export type ApprovalNotificationDeepLink = {
  approvalRequestId: string;
  organizationId: string;
  accountId: string;
  source: "simulator" | "live";
  eventType: ApprovalNotificationEvent;
};

export class ApprovalNotificationStoreUnavailableError extends Error {
  constructor(message = "Approval email delivery is not configured.") {
    super(message);
    this.name = "ApprovalNotificationStoreUnavailableError";
  }
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new ApprovalNotificationStoreUnavailableError();
  return getRuntimeDatabase(connectionString);
}

function mapClaim(row: ClaimedDeliveryRow): ClaimedApprovalNotificationDelivery {
  return {
    id: row.id,
    approvalRequestId: row.approval_request_id,
    organizationId: row.organization_id,
    eventType: row.event_type,
    recipientOperatorId: row.recipient_operator_id,
    approvalRequestVersion: Number(row.approval_request_version),
    claimId: row.claim_id,
    attemptCount: Number(row.attempt_count),
  };
}

export async function verifyApprovalNotificationDeliveryStore(
  database?: Sql | postgres.TransactionSql,
) {
  const connectionString = process.env.DATABASE_URL;
  if (!database && !connectionString) return false;
  try {
    const sql = database ?? getRuntimeDatabase(connectionString!);
    const [result] = await sql<{ ready: boolean }[]>`
      select (
        to_regclass(
          'public.maintainflow_approval_notification_deliveries'
        ) is not null
        and to_regprocedure(
          'public.maintainflow_enforce_approval_notification_delivery()'
        ) is not null
      ) as ready
    `;
    return result?.ready === true;
  } catch {
    return false;
  }
}

export async function enqueueApprovalNotificationDeliveriesInTransaction(
  transaction: postgres.TransactionSql,
  options: {
    approvalRequestId: string;
    organizationId: string;
    eventType: ApprovalNotificationEvent;
    approvalRequestVersion: number;
  },
) {
  if (!isApprovalEmailEnabledForOrganization(options.organizationId)) return [];
  const admissionOpen = getWorkspaceAdmissionMode() === "open";
  const admittedOperatorIds = getWorkspaceAdmittedOperatorIds();

  if (options.eventType === "review_requested") {
    const rows = await transaction<{ id: string }[]>`
      insert into maintainflow_approval_notification_deliveries (
        id, approval_request_id, organization_id, event_type,
        recipient_operator_id, recipient_membership_role_snapshot,
        approval_request_version
      )
      select
        gen_random_uuid(), request.id, request.organization_id,
        'review_requested', reviewer.clerk_user_id, reviewer.role,
        request.version
      from maintainflow_change_approval_requests request
      join maintainflow_organizations organization
        on organization.id = request.organization_id
      join maintainflow_organization_memberships reviewer
        on reviewer.organization_id = request.organization_id
      where request.id = ${options.approvalRequestId}
        and request.organization_id = ${options.organizationId}
        and request.status = 'awaiting_approval'
        and request.version = ${options.approvalRequestVersion}
        and organization.customer_type = 'agency'
        and organization.status = 'active'
        and reviewer.role in ('owner', 'admin')
        and reviewer.clerk_user_id <> request.requester_operator_id
        and (
          ${admissionOpen}
          or reviewer.clerk_user_id = any(${admittedOperatorIds}::text[])
        )
      order by reviewer.clerk_user_id
      on conflict (
        approval_request_id, event_type, recipient_operator_id
      ) do nothing
      returning id
    `;
    return rows.map((row) => row.id);
  }

  const expectedStatus =
    options.eventType === "approval_approved"
      ? "approved"
      : options.eventType === "approval_changes_requested"
        ? "changes_requested"
        : "cancelled";
  const rows = await transaction<{ id: string }[]>`
    insert into maintainflow_approval_notification_deliveries (
      id, approval_request_id, organization_id, event_type,
      recipient_operator_id, recipient_membership_role_snapshot,
      approval_request_version
    )
    select
      gen_random_uuid(), request.id, request.organization_id,
      ${options.eventType}, requester.clerk_user_id, requester.role,
      request.version
    from maintainflow_change_approval_requests request
    join maintainflow_organizations organization
      on organization.id = request.organization_id
    join maintainflow_organization_memberships requester
      on requester.organization_id = request.organization_id
      and requester.clerk_user_id = request.requester_operator_id
    where request.id = ${options.approvalRequestId}
      and request.organization_id = ${options.organizationId}
      and request.status = ${expectedStatus}
      and request.version = ${options.approvalRequestVersion}
      and organization.customer_type = 'agency'
      and organization.status = 'active'
      and (
        ${admissionOpen}
        or requester.clerk_user_id = any(${admittedOperatorIds}::text[])
      )
      and (
        ${options.eventType} <> 'approval_cancelled'
        or request.decision_operator_id <> request.requester_operator_id
      )
    on conflict (
      approval_request_id, event_type, recipient_operator_id
    ) do nothing
    returning id
  `;
  return rows.map((row) => row.id);
}

const deliveryStillEligibleSql = `
  organization.customer_type = 'agency'
  and organization.status = 'active'
  and (
    (
      delivery.event_type = 'review_requested'
      and request.status = 'awaiting_approval'
      and request.version = delivery.approval_request_version
      and membership.role in ('owner', 'admin')
      and membership.clerk_user_id <> request.requester_operator_id
    )
    or (
      delivery.event_type = 'approval_approved'
      and request.status = 'approved'
      and request.version >= delivery.approval_request_version
      and membership.clerk_user_id = request.requester_operator_id
    )
    or (
      delivery.event_type = 'approval_changes_requested'
      and request.status = 'changes_requested'
      and request.version = delivery.approval_request_version
      and membership.clerk_user_id = request.requester_operator_id
    )
    or (
      delivery.event_type = 'approval_cancelled'
      and request.status = 'cancelled'
      and request.version = delivery.approval_request_version
      and membership.clerk_user_id = request.requester_operator_id
      and request.decision_operator_id <> request.requester_operator_id
    )
  )
`;

const CLEANUP_BATCH_SIZE = 100;
const MAX_TARGETED_DELIVERY_IDS = 100;
// Resend's documented automatic schedule can extend beyond 24 hours. A
// 48-hour grace period is beyond that retry window while still permitting a
// later signed terminal event to replace the provisional timeout state.
export const APPROVAL_NOTIFICATION_CONFIRMATION_RECOVERY_MS =
  48 * 60 * 60 * 1_000;
// The stable per-delivery Resend idempotency key is only retained for 24 hours.
// An ambiguous send older than that cannot be retried without risking a
// duplicate email, so recovery must fail it closed for operator attention.
export const APPROVAL_NOTIFICATION_IDEMPOTENCY_RECOVERY_MS =
  24 * 60 * 60 * 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function emptyClaimBatch(): ApprovalNotificationClaimBatch {
  return {
    deliveries: [],
    recovery: {
      cancelledIneligible: 0,
      retryScheduledAfterLeaseExpiry: 0,
      permanentFailuresAfterLeaseExpiry: 0,
      permanentFailuresAfterIdempotencyExpiry: 0,
      permanentFailuresAfterConfirmationTimeout: 0,
    },
  };
}

async function lockDeliveryIdentityParents(
  transaction: postgres.TransactionSql,
  identities: readonly DeliveryIdentityRow[],
) {
  if (identities.length === 0) return false;
  const organizationIds = [
    ...new Set(identities.map((identity) => identity.organization_id)),
  ].sort();
  if (organizationIds.length !== 1) {
    throw new ApprovalNotificationStoreUnavailableError(
      "Approval notification claims must be isolated to one organization.",
    );
  }
  const organizationId = organizationIds[0]!;
  const recipientOperatorIds = [
    ...new Set(identities.map((identity) => identity.recipient_operator_id)),
  ].sort();
  const approvalRequestIds = [
    ...new Set(identities.map((identity) => identity.approval_request_id)),
  ].sort();

  const organizations = await transaction<{ id: string }[]>`
    select id
    from maintainflow_organizations
    where id = ${organizationId}
    order by id
    for share
  `;
  await transaction`
    select organization_id, clerk_user_id
    from maintainflow_organization_memberships
    where organization_id = ${organizationId}
      and clerk_user_id = any(${recipientOperatorIds}::text[])
    order by organization_id, clerk_user_id
    for share
  `;
  await transaction`
    select id
    from maintainflow_change_approval_requests
    where organization_id = ${organizationId}
      and id = any(${approvalRequestIds}::uuid[])
    order by id
    for share
  `;
  return organizations.length === 1;
}

export async function claimApprovalNotificationDeliveries(options: {
  deliveryIds?: readonly string[];
  limit?: number;
  now?: Date;
}): Promise<ApprovalNotificationClaimBatch> {
  const sql = getDatabase();
  const limit = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 25)));
  const ids = options.deliveryIds
    ? [...new Set(options.deliveryIds)]
        .filter((id) => UUID_PATTERN.test(id))
        .slice(0, MAX_TARGETED_DELIVERY_IDS)
    : [];
  if (options.deliveryIds && ids.length === 0) return emptyClaimBatch();

  return sql.begin(async (transaction) => {
    // Keep the default clock inside PostgreSQL. Round-tripping its
    // microsecond-precise timestamp through JavaScript's millisecond Date can
    // make a just-enqueued row appear not due. Tests and bounded recovery jobs
    // may still inject an explicit clock.
    const nowSql = options.now
      ? transaction`${options.now}`
      : transaction`pg_catalog.statement_timestamp()`;
    const confirmationCutoffSql = options.now
      ? transaction`${new Date(
          options.now.getTime() -
            APPROVAL_NOTIFICATION_CONFIRMATION_RECOVERY_MS,
        )}`
      : transaction`pg_catalog.statement_timestamp() - interval '48 hours'`;
    const idempotencyCutoffSql = options.now
      ? transaction`${new Date(
          options.now.getTime() -
            APPROVAL_NOTIFICATION_IDEMPOTENCY_RECOVERY_MS,
        )}`
      : transaction`pg_catalog.statement_timestamp() - interval '24 hours'`;
    const targetedFilter = options.deliveryIds
      ? transaction`and delivery.id = any(${ids}::uuid[])`
      : transaction``;
    let organizationId: string | undefined;
    if (options.deliveryIds) {
      const organizations = await transaction<{ organization_id: string }[]>`
        select distinct delivery.organization_id
        from maintainflow_approval_notification_deliveries delivery
        where delivery.id = any(${ids}::uuid[])
        order by delivery.organization_id
      `;
      if (organizations.length > 1) {
        throw new ApprovalNotificationStoreUnavailableError(
          "Targeted approval notification claims cannot span organizations.",
        );
      }
      organizationId = organizations[0]?.organization_id;
    } else {
      const [organization] = await transaction<{ organization_id: string }[]>`
        select delivery.organization_id
        from maintainflow_approval_notification_deliveries delivery
        where (
            delivery.status in ('queued', 'retry_scheduled')
            and delivery.next_attempt_at <= ${nowSql}
          )
          or (
            delivery.status = 'sending'
            and delivery.claim_expires_at <= ${nowSql}
          )
          or (
            delivery.status = 'provider_accepted'
            and delivery.provider_accepted_at <= ${confirmationCutoffSql}
          )
        order by case delivery.status
            when 'provider_accepted' then 1
            when 'sending' then 2
            else 3
          end,
          coalesce(
            delivery.provider_accepted_at,
            delivery.claim_expires_at,
            delivery.next_attempt_at
          ),
          delivery.id
        limit 1
      `;
      organizationId = organization?.organization_id;
    }
    if (!organizationId) return emptyClaimBatch();

    const identities = await transaction<DeliveryIdentityRow[]>`
      select delivery.id, delivery.approval_request_id,
        delivery.organization_id, delivery.recipient_operator_id
      from maintainflow_approval_notification_deliveries delivery
      where delivery.organization_id = ${organizationId}
        ${targetedFilter}
        and (
          (
            delivery.status in ('queued', 'retry_scheduled')
            and delivery.next_attempt_at <= ${nowSql}
          )
          or (
            delivery.status = 'sending'
            and delivery.claim_expires_at <= ${nowSql}
          )
          or (
            delivery.status = 'provider_accepted'
            and delivery.provider_accepted_at <= ${confirmationCutoffSql}
          )
        )
      order by case delivery.status
          when 'provider_accepted' then 1
          when 'sending' then 2
          else 3
        end,
        coalesce(
          delivery.provider_accepted_at,
          delivery.claim_expires_at,
          delivery.next_attempt_at
        ),
        delivery.id
      limit ${CLEANUP_BATCH_SIZE}
    `;
    if (identities.length === 0) return emptyClaimBatch();
    if (!(await lockDeliveryIdentityParents(transaction, identities))) {
      return emptyClaimBatch();
    }
    const candidateIds = identities.map((identity) => identity.id);

    const cancelledIneligible = await transaction<{ id: string }[]>`
      with candidates as (
        select delivery.id
        from maintainflow_approval_notification_deliveries delivery
        where delivery.organization_id = ${organizationId}
          and delivery.id = any(${candidateIds}::uuid[])
          and delivery.status in ('queued', 'retry_scheduled')
          and delivery.next_attempt_at <= ${nowSql}
          and not exists (
            select 1
            from maintainflow_change_approval_requests request
            join maintainflow_organizations organization
              on organization.id = request.organization_id
            join maintainflow_organization_memberships membership
              on membership.organization_id = delivery.organization_id
              and membership.clerk_user_id = delivery.recipient_operator_id
            where request.id = delivery.approval_request_id
              and request.organization_id = delivery.organization_id
              and ${transaction.unsafe(deliveryStillEligibleSql)}
          )
        order by delivery.id
        for update of delivery skip locked
      )
      update maintainflow_approval_notification_deliveries delivery set
        status = 'cancelled', cancellation_code = 'recipient_ineligible'
      from candidates
      where delivery.id = candidates.id
      returning delivery.id
    `;
    const leaseRecoveries = await transaction<{ status: string }[]>`
      with candidates as (
        select delivery.id
        from maintainflow_approval_notification_deliveries delivery
        where delivery.organization_id = ${organizationId}
          and delivery.id = any(${candidateIds}::uuid[])
          and delivery.status = 'sending'
          and delivery.claim_expires_at <= ${nowSql}
        order by delivery.id
        for update of delivery skip locked
      )
      update maintainflow_approval_notification_deliveries delivery set
        status = case
          when delivery.attempt_count >= 5
            or delivery.first_attempted_at <= ${idempotencyCutoffSql}
            then 'permanent_failure'
          else 'retry_scheduled'
        end,
        last_failure_code = 'worker_lease_expired'
      from candidates
      where delivery.id = candidates.id
      returning delivery.status
    `;
    const idempotencyExpiries = await transaction<{ id: string }[]>`
      with candidates as (
        select delivery.id
        from maintainflow_approval_notification_deliveries delivery
        where delivery.organization_id = ${organizationId}
          and delivery.id = any(${candidateIds}::uuid[])
          and delivery.status = 'retry_scheduled'
          and delivery.next_attempt_at <= ${nowSql}
          and delivery.first_attempted_at <= ${idempotencyCutoffSql}
          and delivery.last_failure_code in (
            'provider_timeout',
            'provider_unavailable',
            'worker_lease_expired'
          )
        order by delivery.id
        for update of delivery skip locked
      )
      update maintainflow_approval_notification_deliveries delivery set
        status = 'permanent_failure'
      from candidates
      where delivery.id = candidates.id
      returning delivery.id
    `;
    const confirmationTimeouts = await transaction<{ id: string }[]>`
      with candidates as (
        select delivery.id
        from maintainflow_approval_notification_deliveries delivery
        where delivery.organization_id = ${organizationId}
          and delivery.id = any(${candidateIds}::uuid[])
          and delivery.status = 'provider_accepted'
          and delivery.provider_accepted_at <= ${confirmationCutoffSql}
        order by delivery.id
        for update of delivery skip locked
      )
      update maintainflow_approval_notification_deliveries delivery set
        status = 'permanent_failure',
        last_failure_code = 'delivery_confirmation_missing'
      from candidates
      where delivery.id = candidates.id
      returning delivery.id
    `;

    const claimId = randomUUID();
    const rows = await transaction<ClaimedDeliveryRow[]>`
      with candidates as (
        select delivery.id
        from maintainflow_approval_notification_deliveries delivery
        join maintainflow_change_approval_requests request
          on request.id = delivery.approval_request_id
          and request.organization_id = delivery.organization_id
        join maintainflow_organizations organization
          on organization.id = delivery.organization_id
        join maintainflow_organization_memberships membership
          on membership.organization_id = delivery.organization_id
          and membership.clerk_user_id = delivery.recipient_operator_id
        where delivery.id = any(${candidateIds}::uuid[])
          and delivery.status in ('queued', 'retry_scheduled')
          and delivery.next_attempt_at <= ${nowSql}
          and ${transaction.unsafe(deliveryStillEligibleSql)}
        order by delivery.next_attempt_at, delivery.created_at, delivery.id
        for update of delivery skip locked
        limit ${limit}
      )
      update maintainflow_approval_notification_deliveries delivery set
        status = 'sending', claim_id = ${claimId}
      from candidates
      where delivery.id = candidates.id
      returning delivery.id, delivery.approval_request_id,
        delivery.organization_id, delivery.event_type,
        delivery.recipient_operator_id, delivery.approval_request_version,
        delivery.claim_id, delivery.attempt_count
    `;
    return {
      deliveries: rows.map(mapClaim),
      recovery: {
        cancelledIneligible: cancelledIneligible.length,
        retryScheduledAfterLeaseExpiry: leaseRecoveries.filter(
          (recovery) => recovery.status === "retry_scheduled",
        ).length,
        permanentFailuresAfterLeaseExpiry: leaseRecoveries.filter(
          (recovery) => recovery.status === "permanent_failure",
        ).length,
        permanentFailuresAfterIdempotencyExpiry: idempotencyExpiries.length,
        permanentFailuresAfterConfirmationTimeout: confirmationTimeouts.length,
      },
    };
  });
}

export async function isApprovalNotificationClaimEligible(options: {
  deliveryId: string;
  claimId: string;
}) {
  const sql = getDatabase();
  const [result] = await sql<{ eligible: boolean }[]>`
    select exists (
      select 1
      from maintainflow_approval_notification_deliveries delivery
      join maintainflow_change_approval_requests request
        on request.id = delivery.approval_request_id
        and request.organization_id = delivery.organization_id
      join maintainflow_organizations organization
        on organization.id = delivery.organization_id
      join maintainflow_organization_memberships membership
        on membership.organization_id = delivery.organization_id
        and membership.clerk_user_id = delivery.recipient_operator_id
      where delivery.id = ${options.deliveryId}
        and delivery.status = 'sending'
        and delivery.claim_id = ${options.claimId}
        and ${sql.unsafe(deliveryStillEligibleSql)}
    ) as eligible
  `;
  return result?.eligible === true;
}

export async function finalizeApprovalNotificationDelivery(options: {
  deliveryId: string;
  claimId: string;
  outcome:
    | { kind: "accepted"; providerMessageId: string }
    | { kind: "retry"; failureCode: ApprovalNotificationFailureCode }
    | { kind: "permanent_failure"; failureCode: ApprovalNotificationFailureCode }
    | { kind: "cancelled"; cancellationCode: "recipient_ineligible" };
}) {
  const sql = getDatabase();
  const status =
    options.outcome.kind === "accepted"
      ? "provider_accepted"
      : options.outcome.kind === "retry"
        ? "retry_scheduled"
        : options.outcome.kind;
  const providerMessageId =
    options.outcome.kind === "accepted"
      ? options.outcome.providerMessageId
      : null;
  const failureCode =
    options.outcome.kind === "retry" ||
    options.outcome.kind === "permanent_failure"
      ? options.outcome.failureCode
      : null;
  const cancellationCode =
    options.outcome.kind === "cancelled"
      ? options.outcome.cancellationCode
      : null;
  return sql.begin(async (transaction) => {
    const identities = await transaction<DeliveryIdentityRow[]>`
      select id, approval_request_id, organization_id, recipient_operator_id
      from maintainflow_approval_notification_deliveries
      where id = ${options.deliveryId}
        and status = 'sending'
        and claim_id = ${options.claimId}
    `;
    if (identities.length !== 1) return false;
    if (!(await lockDeliveryIdentityParents(transaction, identities))) return false;
    const rows =
      options.outcome.kind === "accepted"
        ? await transaction<{ id: string }[]>`
            update maintainflow_approval_notification_deliveries set
              status = ${status}, provider_message_id = ${providerMessageId}
            where id = ${options.deliveryId}
              and status = 'sending'
              and claim_id = ${options.claimId}
            returning id
          `
        : options.outcome.kind === "cancelled"
          ? await transaction<{ id: string }[]>`
              update maintainflow_approval_notification_deliveries set
                status = ${status}, cancellation_code = ${cancellationCode}
              where id = ${options.deliveryId}
                and status = 'sending'
                and claim_id = ${options.claimId}
              returning id
            `
          : await transaction<{ id: string }[]>`
              update maintainflow_approval_notification_deliveries set
                status = ${status}, last_failure_code = ${failureCode}
              where id = ${options.deliveryId}
                and status = 'sending'
                and claim_id = ${options.claimId}
              returning id
            `;
    return rows.length === 1;
  });
}

export async function recordApprovalNotificationProviderEvent(options: {
  providerMessageId: string;
  eventType: ApprovalNotificationProviderEvent;
  eventAt: Date;
}) {
  const sql = getDatabase();
  const status =
    options.eventType === "email.delivered"
      ? "delivered"
      : options.eventType === "email.bounced"
        ? "bounced"
        : options.eventType === "email.complained"
          ? "complained"
          : options.eventType === "email.suppressed"
            ? "suppressed"
            : options.eventType === "email.failed"
              ? "permanent_failure"
              : "provider_accepted";
  const rows = await sql<{ id: string }[]>`
    update maintainflow_approval_notification_deliveries set
      status = ${status}, provider_event_type = ${options.eventType},
      provider_event_at = ${options.eventAt},
      last_failure_code = case
        when ${options.eventType} = 'email.failed' then 'provider_rejected'
        else last_failure_code
      end
    where provider = 'resend'
      and provider_message_id = ${options.providerMessageId}
      and (
        provider_event_at is null
        or provider_event_at <= ${options.eventAt}
      )
      and (
        status = 'provider_accepted'
        or (status = 'delivered' and ${status} = 'complained')
        or (
          status = 'permanent_failure'
          and last_failure_code = 'delivery_confirmation_missing'
          and ${options.eventType} in (
            'email.delivered',
            'email.bounced',
            'email.complained',
            'email.suppressed',
            'email.failed'
          )
        )
      )
    returning id
  `;
  if (rows.length === 1) return "updated" as const;
  const [known] = await sql<{ known: boolean }[]>`
    select exists (
      select 1
      from maintainflow_approval_notification_deliveries
      where provider = 'resend'
        and provider_message_id = ${options.providerMessageId}
    ) as known
  `;
  return known?.known === true ? ("known" as const) : ("unknown" as const);
}

export async function resolveApprovalNotificationDeepLink(options: {
  deliveryId: string;
  operatorId: string;
}): Promise<ApprovalNotificationDeepLink | null> {
  const sql = getDatabase();
  const [row] = await sql<{
    approval_request_id: string;
    organization_id: string;
    account_id_snapshot: string;
    source: "simulator" | "live";
    event_type: ApprovalNotificationEvent;
  }[]>`
    select delivery.approval_request_id, delivery.organization_id,
      request.account_id_snapshot, request.source, delivery.event_type
    from maintainflow_approval_notification_deliveries delivery
    join maintainflow_change_approval_requests request
      on request.id = delivery.approval_request_id
      and request.organization_id = delivery.organization_id
    join maintainflow_organizations organization
      on organization.id = delivery.organization_id
    join maintainflow_organization_memberships membership
      on membership.organization_id = delivery.organization_id
      and membership.clerk_user_id = ${options.operatorId}
    where delivery.id = ${options.deliveryId}
      and delivery.recipient_operator_id = ${options.operatorId}
      and organization.customer_type = 'agency'
      and organization.status = 'active'
  `;
  return row
    ? {
        approvalRequestId: row.approval_request_id,
        organizationId: row.organization_id,
        accountId: row.account_id_snapshot,
        source: row.source,
        eventType: row.event_type,
      }
    : null;
}
