import "server-only";

import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type { Recommendation } from "../openai-ads/demo-data";
import { getRuntimeDatabase } from "../database/client.server";
import {
  monitoringAttributionMaturityCutoff,
  monitoringObservationSchema,
  monitoringOutcomeSchema,
  type MonitoringObservation,
  type MonitoringOutcome,
} from "../openai-ads/monitoring";
import type { AccountAccess } from "../tenancy/schema";
import { lockCurrentAccountWriteAccess } from "../tenancy/store.server";
import { recommendationFingerprint } from "./recommendation-decision";
import {
  approvalRecordSchema,
  type ApprovalRecord,
  type ApprovalStatus,
  type ReconciliationAction,
} from "./approval-schema";

type ApprovalRecordInput = {
  accountId: string;
  operatorId: string;
  recommendation: Recommendation;
  access: AccountAccess;
};

type ApprovalRow = {
  id: string;
  account_id: string;
  operator_id: string;
  acting_organization_id: string | null;
  organization_name?: string | null;
  actor_membership_role: AccountAccess["membershipRole"] | null;
  actor_account_role: AccountAccess["accountRole"] | null;
  recommendation_id: string;
  recommendation_title: string;
  entity_id: string;
  request_payload?: unknown;
  rollback_payload: unknown;
  evidence_payload?: unknown;
  safeguard: string;
  status: ApprovalStatus;
  error_message: string | null;
  rollback_error_message?: string | null;
  reconciliation_note: string | null;
  monitoring_plan: unknown | null;
  monitoring_window_days: number | null;
  monitoring_started_at: Date | null;
  monitoring_ends_at: Date | null;
  monitoring_outcome: MonitoringOutcome | null;
  monitoring_observation: unknown | null;
  monitoring_evaluated_at: Date | null;
  monitoring_evaluation_claim_id: string | null;
  monitoring_evaluation_claimed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  applied_at: Date | null;
  rolled_back_at: Date | null;
};

const approvalColumns = [
  "id",
  "account_id",
  "operator_id",
  "acting_organization_id",
  "actor_membership_role",
  "actor_account_role",
  "recommendation_id",
  "recommendation_title",
  "entity_id",
  "request_payload",
  "rollback_payload",
  "evidence_payload",
  "safeguard",
  "status",
  "error_message",
  "rollback_error_message",
  "reconciliation_note",
  "monitoring_plan",
  "monitoring_window_days",
  "monitoring_started_at",
  "monitoring_ends_at",
  "monitoring_outcome",
  "monitoring_observation",
  "monitoring_evaluated_at",
  "monitoring_evaluation_claim_id",
  "monitoring_evaluation_claimed_at",
  "created_at",
  "updated_at",
  "applied_at",
  "rolled_back_at",
] as const;

type ApprovalRollbackClaimRow = Pick<ApprovalRow, "id"> & {
  request_payload: unknown;
  rollback_payload: unknown;
  rollback_provider_attempt_id: string;
};

const rollbackClaimColumns = [
  "id",
  "request_payload",
  "rollback_payload",
  "rollback_provider_attempt_id",
] as const;

export class ApprovalStoreUnavailableError extends Error {
  constructor(message = "Durable approval storage is not configured.") {
    super(message);
    this.name = "ApprovalStoreUnavailableError";
  }
}

export class ApprovalTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalTransitionError";
  }
}

export class ApprovalProviderSendFenceUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ApprovalProviderSendFenceUnavailableError";
  }
}

export const APPROVAL_OPERATION_LEASE_MS = 15 * 60 * 1_000;
export const MONITORING_ACCOUNT_ATTEMPT_LEASE_MS = 15 * 60 * 1_000;
export const MONITORING_ACCOUNT_BACKOFF_BASE_MS = 5 * 60 * 1_000;
export const MONITORING_ACCOUNT_BACKOFF_MAX_MS = 6 * 60 * 60 * 1_000;

export type DueMonitoringAccount = {
  accountId: string;
  attemptId: string;
  dueCount: number;
  oldestDueAt: Date;
};

export function isApprovalStoreConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export async function verifyApprovalStore() {
  if (!isApprovalStoreConfigured()) return false;
  const sql = getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.ads_approval_records') is not null
      and (
        select count(*) = 28
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'ads_approval_records'
          and column_name in (
            'rollback_operator_id',
            'rollback_response_payload',
            'rollback_error_message',
            'reconciled_by',
            'reconciled_at',
            'reconciliation_note',
            'acting_organization_id',
            'actor_membership_role',
            'actor_account_role',
            'rollback_organization_id',
            'rollback_membership_role',
            'rollback_account_role',
            'reconciled_organization_id',
            'reconciled_membership_role',
            'reconciled_account_role',
            'monitoring_plan',
            'monitoring_window_days',
            'monitoring_started_at',
            'monitoring_ends_at',
            'monitoring_outcome',
            'monitoring_observation',
            'monitoring_evaluated_at',
            'monitoring_evaluation_claim_id',
            'monitoring_evaluation_claimed_at',
            'apply_provider_attempted_at',
            'rollback_provider_attempted_at',
            'apply_provider_attempt_id',
            'rollback_provider_attempt_id'
          )
      )
      and to_regclass(
        'public.ads_approval_records_active_recommendation_idx'
      ) is not null
      and to_regclass(
        'public.ads_approval_records_monitoring_due_idx'
      ) is not null
      and to_regclass(
        'public.ads_approval_records_monitoring_global_due_idx'
      ) is not null
      and to_regclass(
        'public.ads_approval_records_stale_operation_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_monitoring_account_schedule'
      ) is not null
      and to_regclass(
        'public.maintainflow_monitoring_account_schedule_due_idx'
      ) is not null
    ) as ready
  `;
  return result?.ready === true;
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new ApprovalStoreUnavailableError();
  return getRuntimeDatabase(connectionString);
}

function parseApprovalRow(row: ApprovalRow): ApprovalRecord {
  return approvalRecordSchema.parse({
    id: row.id,
    accountId: row.account_id,
    operatorId: row.operator_id,
    organizationId: row.acting_organization_id,
    organizationName: row.organization_name ?? null,
    membershipRole: row.actor_membership_role,
    accountRole: row.actor_account_role,
    recommendationId: row.recommendation_id,
    recommendationTitle: row.recommendation_title,
    entityId: row.entity_id,
    mutation: row.request_payload ?? null,
    rollback: row.rollback_payload,
    evidence: row.evidence_payload ?? [],
    safeguard: row.safeguard,
    status: row.status,
    errorMessage: row.rollback_error_message ?? row.error_message,
    reconciliationNote: row.reconciliation_note,
    monitoringPlan: row.monitoring_plan,
    monitoringStartedAt: row.monitoring_started_at,
    monitoringEndsAt: row.monitoring_ends_at,
    monitoringOutcome: row.monitoring_outcome,
    monitoringObservation: row.monitoring_observation,
    monitoringEvaluatedAt: row.monitoring_evaluated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    appliedAt: row.applied_at,
    rolledBackAt: row.rolled_back_at,
  });
}

export async function createApprovalRecord({
  accountId,
  operatorId,
  recommendation,
  access,
}: ApprovalRecordInput, transaction?: postgres.TransactionSql) {
  const sql = transaction ?? getDatabase();
  const id = randomUUID();
  const monitoringPlan = recommendation.monitoringPlan
    ? sql.json(recommendation.monitoringPlan as postgres.JSONValue)
    : null;
  const monitoringWindowDays = recommendation.monitoringPlan?.windowDays ?? null;

  const [activeDismissal] = await sql<{ id: string }[]>`
    select dismissal.id
    from maintainflow_recommendation_dismissals dismissal
    join maintainflow_advertiser_accounts account
      on account.id = dismissal.advertiser_account_id
    where account.external_account_id = ${accountId}
      and account.status = 'active'
      and dismissal.recommendation_id = ${recommendation.id}
      and dismissal.entity_id = ${recommendation.entityId}
      and dismissal.recommendation_fingerprint = ${recommendationFingerprint(
        recommendation,
      )}
      and dismissal.restored_at is null
    limit 1
  `;
  if (activeDismissal) {
    throw new ApprovalTransitionError(
      "This recommendation is actively dismissed. Restore it through the audited review action before applying it.",
    );
  }

  const inserted = await sql<{ id: string }[]>`
    insert into ads_approval_records (
      id, account_id, operator_id, acting_organization_id,
      actor_membership_role, actor_account_role, recommendation_id, recommendation_title,
      entity_id, request_payload, rollback_payload, evidence_payload, safeguard,
      monitoring_plan, monitoring_window_days, apply_provider_attempt_id, status
    ) values (
      ${id}, ${accountId}, ${operatorId}, ${access.organizationId},
      ${access.membershipRole}, ${access.accountRole}, ${recommendation.id},
      ${recommendation.title}, ${recommendation.entityId},
      ${sql.json(recommendation.mutation as postgres.JSONValue)},
      ${sql.json(recommendation.rollback as postgres.JSONValue)},
      ${sql.json(recommendation.evidence as postgres.JSONValue)},
      ${recommendation.safeguard}, ${monitoringPlan},
      ${monitoringWindowDays}, ${id}, 'pending'
    )
    on conflict (account_id, recommendation_id, entity_id)
      where status in (
        'pending',
        'applied',
        'reconciliation_required',
        'rollback_pending',
        'rollback_failed',
        'rollback_reconciliation_required'
      )
    do nothing
    returning id
  `;
  if (!inserted[0]) {
    throw new ApprovalTransitionError(
      "This recommendation already has an active or unresolved approval. Refresh before taking another action.",
    );
  }
  return id;
}

export async function updateApprovalRecord(
  id: string,
  status: ApprovalStatus,
  options: { response?: unknown; error?: string } = {},
) {
  const sql = getDatabase();
  const responsePayload =
    options.response === undefined
      ? null
      : sql.json(options.response as postgres.JSONValue);
  const rows = await sql<{ id: string }[]>`
    update ads_approval_records set
      status = ${status}, response_payload = ${responsePayload},
      error_message = ${options.error ?? null},
      monitoring_started_at = case
        when ${status} = 'applied' and monitoring_plan is not null
          then coalesce(
            monitoring_started_at,
            date_trunc('hour', now()) + interval '1 hour'
          )
        else monitoring_started_at
      end,
      monitoring_ends_at = case
        when ${status} = 'applied' and monitoring_plan is not null
          then coalesce(
            monitoring_ends_at,
            date_trunc('hour', now()) + interval '1 hour'
              + make_interval(days => monitoring_window_days)
          )
        else monitoring_ends_at
      end,
      applied_at = case when ${status} = 'applied' then now() else applied_at end,
      rolled_back_at = case when ${status} = 'rolled_back' then now() else rolled_back_at end,
      updated_at = now()
    where id = ${id}
      and status = 'pending'
      and apply_provider_attempt_id = ${id}
    returning id
  `;
  if (!rows[0]) {
    throw new ApprovalTransitionError(
      "This apply operation no longer holds its pending execution lease. Reconcile the durable record before taking another action.",
    );
  }
}

export async function recoverStaleApprovalOperations(options: {
  accountId?: string;
  now?: Date;
  limit?: number;
} = {}) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - APPROVAL_OPERATION_LEASE_MS);
  const limit = Math.max(1, Math.min(500, Math.trunc(options.limit ?? 100)));
  const accountFilter = options.accountId
    ? sql`and approval.account_id = ${options.accountId}`
    : sql``;
  const rows = await sql<
    {
      previous_status: "pending" | "rollback_pending";
      provider_attempted: boolean;
    }[]
  >`
    with candidates as (
      select approval.id, approval.status,
        case approval.status
          when 'pending' then approval.apply_provider_attempted_at is not null
          else approval.rollback_provider_attempted_at is not null
        end as provider_attempted
      from ads_approval_records approval
      where approval.status in ('pending', 'rollback_pending')
        and approval.updated_at < ${staleBefore}
        ${accountFilter}
      order by approval.updated_at, approval.id
      limit ${limit}
      for update of approval skip locked
    )
    update ads_approval_records approval set
      status = case
        when candidates.status = 'pending'
          and not candidates.provider_attempted then 'failed'
        when candidates.status = 'pending' then 'reconciliation_required'
        when not candidates.provider_attempted then 'rollback_failed'
        else 'rollback_reconciliation_required'
      end,
      error_message = case candidates.status
        when 'pending' then case
          when candidates.provider_attempted then
            'The apply worker stopped after marking a provider attempt but before persisting a confirmed outcome. Verify the current provider state before recording whether the change was applied.'
          else
            'The apply worker stopped before any provider attempt was marked. No mutation was sent; a fresh approval may be created.'
        end
        else approval.error_message
      end,
      rollback_error_message = case candidates.status
        when 'rollback_pending' then case
          when candidates.provider_attempted then
            'The rollback worker stopped after marking a provider attempt but before persisting a confirmed outcome. Verify the current provider state before recording whether the rollback completed.'
          else
            'The rollback worker stopped before any provider attempt was marked. No rollback was sent; the stored rollback remains eligible for a deliberate retry.'
        end
        else approval.rollback_error_message
      end,
      updated_at = ${now}
    from candidates
    where approval.id = candidates.id
      and approval.status = candidates.status
    returning candidates.status as previous_status,
      candidates.provider_attempted
  `;
  const apply = rows.filter((row) => row.previous_status === "pending").length;
  const rollback = rows.length - apply;
  return {
    recovered: rows.length,
    apply,
    rollback,
    backlog: rows.length === limit,
  };
}

export async function countUnresolvedApprovalOperations(options: {
  accountId?: string;
  now?: Date;
} = {}) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - APPROVAL_OPERATION_LEASE_MS);
  const accountFilter = options.accountId
    ? sql`and approval.account_id = ${options.accountId}`
    : sql``;
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count
    from (
      select 1
      from ads_approval_records approval
      where (
        approval.status in (
          'reconciliation_required',
          'rollback_reconciliation_required'
        )
        or (
          approval.status in ('pending', 'rollback_pending')
          and approval.updated_at < ${staleBefore}
        )
      )
      ${accountFilter}
      limit 10001
    ) unresolved
  `;
  return row?.count ?? 0;
}

export async function markApprovalProviderAttempt(options: {
  id: string;
  accountId: string;
  attemptId: string;
  status: "pending" | "rollback_pending";
  now?: Date;
}) {
  const sql = getDatabase();
  const attemptedAt = options.now ?? new Date();
  const rows = options.status === "pending"
    ? await sql<{ id: string }[]>`
        update ads_approval_records set
          apply_provider_attempted_at = ${attemptedAt},
          updated_at = ${attemptedAt}
        where id = ${options.id}
          and account_id = ${options.accountId}
          and apply_provider_attempt_id = ${options.attemptId}
          and status = 'pending'
          and apply_provider_attempted_at is null
        returning id
      `
    : await sql<{ id: string }[]>`
        update ads_approval_records set
          rollback_provider_attempted_at = ${attemptedAt},
          updated_at = ${attemptedAt}
        where id = ${options.id}
          and account_id = ${options.accountId}
          and rollback_provider_attempt_id = ${options.attemptId}
          and status = 'rollback_pending'
          and rollback_provider_attempted_at is null
        returning id
      `;
  if (!rows[0]) {
    throw new ApprovalTransitionError(
      "This Ads operation could not mark exactly one provider attempt. Reconcile the durable record before taking another action.",
    );
  }
}

export async function withApprovalProviderSendFence<T>(
  options: {
    id: string;
    accountId: string;
    attemptId: string;
    status: "pending" | "rollback_pending";
    now?: Date;
  },
  operation: () => Promise<T>,
) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const freshAfter = new Date(now.getTime() - APPROVAL_OPERATION_LEASE_MS);
  let operationStarted = false;
  try {
    return await sql.begin(async (transaction) => {
      const rows = options.status === "pending"
        ? await transaction<{ id: string }[]>`
            select id
            from ads_approval_records
            where id = ${options.id}
              and account_id = ${options.accountId}
              and apply_provider_attempt_id = ${options.attemptId}
              and status = 'pending'
              and apply_provider_attempted_at is not null
              and apply_provider_attempted_at > ${freshAfter}
            for update
          `
        : await transaction<{ id: string }[]>`
            select id
            from ads_approval_records
            where id = ${options.id}
              and account_id = ${options.accountId}
              and rollback_provider_attempt_id = ${options.attemptId}
              and status = 'rollback_pending'
              and rollback_provider_attempted_at is not null
              and rollback_provider_attempted_at > ${freshAfter}
            for update
          `;
      if (!rows[0]) {
        throw new ApprovalProviderSendFenceUnavailableError(
          "This provider attempt is no longer current. No mutation was sent.",
        );
      }

      operationStarted = true;
      return operation();
    });
  } catch (error) {
    if (
      !operationStarted &&
      !(error instanceof ApprovalProviderSendFenceUnavailableError)
    ) {
      throw new ApprovalProviderSendFenceUnavailableError(
        "The provider-send database fence could not be established. No mutation was sent.",
        { cause: error },
      );
    }
    throw error;
  }
}

export async function listApprovalRecords(accountId: string, limit = 50) {
  const sql = getDatabase();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await sql<ApprovalRow[]>`
    select approval.*, organization.name as organization_name
    from ads_approval_records approval
    left join maintainflow_organizations organization
      on organization.id = approval.acting_organization_id
    where approval.account_id = ${accountId}
    order by approval.created_at desc
    limit ${safeLimit}
  `;
  return rows.map(parseApprovalRow);
}

export async function listActiveApprovalRecords(accountId: string) {
  const sql = getDatabase();
  const rows = await sql<ApprovalRow[]>`
    select approval.*, organization.name as organization_name
    from ads_approval_records approval
    left join maintainflow_organizations organization
      on organization.id = approval.acting_organization_id
    where approval.account_id = ${accountId}
      and approval.status in (
        'pending',
        'applied',
        'reconciliation_required',
        'rollback_pending',
        'rollback_failed',
        'rollback_reconciliation_required'
      )
    order by approval.created_at desc, approval.id
  `;
  return rows.map(parseApprovalRow);
}

export async function listDueMonitoringRecords(
  accountId: string,
  now = new Date(),
  limit = 20,
) {
  const sql = getDatabase();
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const maturityCutoff = monitoringAttributionMaturityCutoff(now);
  const rows = await sql<ApprovalRow[]>`
    select approval.*, organization.name as organization_name
    from ads_approval_records approval
    join maintainflow_advertiser_accounts advertiser_account
      on advertiser_account.external_account_id = approval.account_id
      and advertiser_account.status = 'active'
    left join maintainflow_organizations organization
      on organization.id = approval.acting_organization_id
    where approval.account_id = ${accountId}
      and approval.monitoring_evaluated_at is null
      and approval.monitoring_started_at is not null
      and approval.monitoring_ends_at <= ${maturityCutoff}
      and (
        approval.monitoring_evaluation_claimed_at is null
        or approval.monitoring_evaluation_claimed_at < ${now} - interval '15 minutes'
      )
      and approval.status in ('applied', 'rollback_failed')
    order by approval.monitoring_ends_at, approval.id
    limit ${safeLimit}
  `;
  return rows.map(parseApprovalRow);
}

export async function listDueMonitoringAccountIds(
  now = new Date(),
  limit = 6,
) {
  const sql = getDatabase();
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  const maturityCutoff = monitoringAttributionMaturityCutoff(now);
  const rows = await sql<{ account_id: string }[]>`
    select approval.account_id
    from ads_approval_records approval
    join maintainflow_advertiser_accounts advertiser_account
      on advertiser_account.external_account_id = approval.account_id
      and advertiser_account.status = 'active'
    left join maintainflow_monitoring_account_schedule schedule
      on schedule.advertiser_account_id = advertiser_account.id
    where approval.monitoring_evaluated_at is null
      and approval.monitoring_started_at is not null
      and approval.monitoring_ends_at <= ${maturityCutoff}
      and (
        approval.monitoring_evaluation_claimed_at is null
        or approval.monitoring_evaluation_claimed_at < ${now} - interval '15 minutes'
      )
      and (schedule.backoff_until is null or schedule.backoff_until <= ${now})
      and (
        schedule.attempt_lease_until is null
        or schedule.attempt_lease_until <= ${now}
      )
      and approval.status in ('applied', 'rollback_failed')
    group by approval.account_id, schedule.last_attempted_at
    order by schedule.last_attempted_at nulls first,
      min(approval.monitoring_ends_at), approval.account_id
    limit ${safeLimit}
  `;
  return rows.map((row) => row.account_id);
}

const MAX_REPORTED_MONITORING_BACKLOG = 10_000;

export async function summarizeDueMonitoringBacklog(now = new Date()) {
  const sql = getDatabase();
  const maturityCutoff = monitoringAttributionMaturityCutoff(now);
  const [row] = await sql<
    {
      due_accounts: number;
      due_windows: number;
      due_accounts_capped: boolean;
      due_windows_capped: boolean;
    }[]
  >`
    select
      least(
        count(distinct approval.account_id),
        ${MAX_REPORTED_MONITORING_BACKLOG + 1}
      )::int as due_accounts,
      least(
        count(*),
        ${MAX_REPORTED_MONITORING_BACKLOG + 1}
      )::int as due_windows,
      count(distinct approval.account_id)
        > ${MAX_REPORTED_MONITORING_BACKLOG} as due_accounts_capped,
      count(*) > ${MAX_REPORTED_MONITORING_BACKLOG} as due_windows_capped
    from ads_approval_records approval
    join maintainflow_advertiser_accounts advertiser_account
      on advertiser_account.external_account_id = approval.account_id
      and advertiser_account.status = 'active'
    left join maintainflow_monitoring_account_schedule schedule
      on schedule.advertiser_account_id = advertiser_account.id
    where approval.monitoring_evaluated_at is null
      and approval.monitoring_started_at is not null
      and approval.monitoring_ends_at <= ${maturityCutoff}
      and (
        approval.monitoring_evaluation_claimed_at is null
        or approval.monitoring_evaluation_claimed_at < ${now} - interval '15 minutes'
      )
      and (schedule.backoff_until is null or schedule.backoff_until <= ${now})
      and (
        schedule.attempt_lease_until is null
        or schedule.attempt_lease_until <= ${now}
      )
      and approval.status in ('applied', 'rollback_failed')
  `;
  return {
    dueAccounts: Math.min(
      row?.due_accounts ?? 0,
      MAX_REPORTED_MONITORING_BACKLOG,
    ),
    dueWindows: Math.min(
      row?.due_windows ?? 0,
      MAX_REPORTED_MONITORING_BACKLOG,
    ),
    dueAccountsCapped: row?.due_accounts_capped ?? false,
    dueWindowsCapped: row?.due_windows_capped ?? false,
  };
}

export async function claimDueMonitoringAccounts(options: {
  attemptId: string;
  now?: Date;
  limit?: number;
}) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const attemptLeaseUntil = new Date(
    now.getTime() + MONITORING_ACCOUNT_ATTEMPT_LEASE_MS,
  );
  const safeLimit = Math.max(
    1,
    Math.min(50, Math.trunc(options.limit ?? 6)),
  );
  const maturityCutoff = monitoringAttributionMaturityCutoff(now);
  const rows = await sql<
    {
      account_id: string;
      attempt_id: string;
      due_count: number;
      oldest_due_at: Date;
    }[]
  >`
    with due_accounts as materialized (
      select advertiser_account.id as advertiser_account_id,
        advertiser_account.external_account_id as account_id,
        least(count(*), 10_001)::int as due_count,
        min(approval.monitoring_ends_at) as oldest_due_at,
        schedule.last_attempted_at
      from maintainflow_advertiser_accounts advertiser_account
      join ads_approval_records approval
        on approval.account_id = advertiser_account.external_account_id
      left join maintainflow_monitoring_account_schedule schedule
        on schedule.advertiser_account_id = advertiser_account.id
      where advertiser_account.status = 'active'
        and approval.monitoring_evaluated_at is null
        and approval.monitoring_started_at is not null
        and approval.monitoring_ends_at <= ${maturityCutoff}
        and (
          approval.monitoring_evaluation_claimed_at is null
          or approval.monitoring_evaluation_claimed_at
            < ${now} - interval '15 minutes'
        )
        and approval.status in ('applied', 'rollback_failed')
        and (
          schedule.backoff_until is null
          or schedule.backoff_until <= ${now}
        )
        and (
          schedule.attempt_lease_until is null
          or schedule.attempt_lease_until <= ${now}
        )
      group by advertiser_account.id, advertiser_account.external_account_id,
        schedule.last_attempted_at
    ),
    candidates as (
      select advertiser_account.id as advertiser_account_id,
        due_accounts.account_id, due_accounts.due_count,
        due_accounts.oldest_due_at, due_accounts.last_attempted_at
      from due_accounts
      join maintainflow_advertiser_accounts advertiser_account
        on advertiser_account.id = due_accounts.advertiser_account_id
      where advertiser_account.status = 'active'
      order by due_accounts.last_attempted_at nulls first,
        due_accounts.oldest_due_at, due_accounts.account_id
      limit ${safeLimit}
      for update of advertiser_account skip locked
    ),
    attempts as (
      insert into maintainflow_monitoring_account_schedule (
        advertiser_account_id, current_attempt_id, attempt_count,
        last_attempted_at, attempt_lease_until, updated_at
      )
      select candidates.advertiser_account_id,
        md5(
          ${options.attemptId}::text
            || ':' || candidates.advertiser_account_id::text
        )::uuid,
        1, ${now}, ${attemptLeaseUntil}, ${now}
      from candidates
      on conflict (advertiser_account_id) do update set
        current_attempt_id = excluded.current_attempt_id,
        attempt_count =
          maintainflow_monitoring_account_schedule.attempt_count + 1,
        last_attempted_at = excluded.last_attempted_at,
        attempt_lease_until = excluded.attempt_lease_until,
        updated_at = excluded.updated_at
      where (
          maintainflow_monitoring_account_schedule.attempt_lease_until is null
          or maintainflow_monitoring_account_schedule.attempt_lease_until
            <= ${now}
        )
        and (
          maintainflow_monitoring_account_schedule.backoff_until is null
          or maintainflow_monitoring_account_schedule.backoff_until <= ${now}
        )
      returning advertiser_account_id, current_attempt_id
    )
    select candidates.account_id,
      attempts.current_attempt_id as attempt_id, candidates.due_count,
      candidates.oldest_due_at
    from candidates
    join attempts using (advertiser_account_id)
    order by candidates.last_attempted_at nulls first,
      candidates.oldest_due_at, candidates.account_id
  `;
  return rows.map(
    (row): DueMonitoringAccount => ({
      accountId: row.account_id,
      attemptId: row.attempt_id,
      dueCount: row.due_count,
      oldestDueAt: row.oldest_due_at,
    }),
  );
}

export async function completeMonitoringAccountAttempt(options: {
  accountId: string;
  attemptId: string;
  succeeded: boolean;
  now?: Date;
}) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const backoffBaseSeconds = MONITORING_ACCOUNT_BACKOFF_BASE_MS / 1_000;
  const backoffMaxSeconds = MONITORING_ACCOUNT_BACKOFF_MAX_MS / 1_000;
  const rows = options.succeeded
    ? await sql<{ advertiser_account_id: string }[]>`
        with locked_account as materialized (
          select id
          from maintainflow_advertiser_accounts
          where external_account_id = ${options.accountId}
            and status = 'active'
          for share
        )
        update maintainflow_monitoring_account_schedule schedule set
          current_attempt_id = null,
          consecutive_failures = 0,
          last_succeeded_at = ${now},
          attempt_lease_until = null,
          backoff_until = null,
          updated_at = ${now}
        from locked_account advertiser_account
        where schedule.advertiser_account_id = advertiser_account.id
          and schedule.current_attempt_id = ${options.attemptId}
        returning schedule.advertiser_account_id
      `
    : await sql<{ advertiser_account_id: string }[]>`
        with locked_account as materialized (
          select id
          from maintainflow_advertiser_accounts
          where external_account_id = ${options.accountId}
            and status = 'active'
          for share
        )
        update maintainflow_monitoring_account_schedule schedule set
          current_attempt_id = null,
          consecutive_failures = schedule.consecutive_failures + 1,
          last_failed_at = ${now},
          attempt_lease_until = null,
          backoff_until = ${now} + make_interval(
            secs => least(
              ${backoffMaxSeconds}::double precision,
              ${backoffBaseSeconds}::double precision
                * power(
                  2::double precision,
                  least(schedule.consecutive_failures, 16)
                )
            )
          ),
          updated_at = ${now}
        from locked_account advertiser_account
        where schedule.advertiser_account_id = advertiser_account.id
          and schedule.current_attempt_id = ${options.attemptId}
        returning schedule.advertiser_account_id
      `;
  return Boolean(rows[0]);
}

export async function releaseMonitoringAccountAttempt(options: {
  accountId: string;
  attemptId: string;
  now?: Date;
}) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const rows = await sql<{ advertiser_account_id: string }[]>`
    with locked_account as materialized (
      select id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    )
    update maintainflow_monitoring_account_schedule schedule set
      current_attempt_id = null,
      attempt_lease_until = null,
      updated_at = ${now}
    from locked_account advertiser_account
    where schedule.advertiser_account_id = advertiser_account.id
      and schedule.current_attempt_id = ${options.attemptId}
    returning schedule.advertiser_account_id
  `;
  return Boolean(rows[0]);
}

export async function claimDueMonitoringRecords(options: {
  accountId: string;
  claimId: string;
  now?: Date;
  limit?: number;
}) {
  const sql = getDatabase();
  const now = options.now ?? new Date();
  const safeLimit = Math.max(
    1,
    Math.min(20, Math.trunc(options.limit ?? 3)),
  );
  const maturityCutoff = monitoringAttributionMaturityCutoff(now);
  const rows = await sql<ApprovalRow[]>`
    with locked_account as materialized (
      select id, external_account_id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    ),
    candidates as (
      select approval.id
      from ads_approval_records approval
      join locked_account advertiser_account
        on advertiser_account.external_account_id = approval.account_id
      where approval.account_id = ${options.accountId}
        and approval.monitoring_evaluated_at is null
        and approval.monitoring_started_at is not null
        and approval.monitoring_ends_at <= ${maturityCutoff}
        and (
          approval.monitoring_evaluation_claimed_at is null
          or approval.monitoring_evaluation_claimed_at < ${now} - interval '15 minutes'
        )
        and approval.status in ('applied', 'rollback_failed')
      order by approval.monitoring_ends_at, approval.id
      limit ${safeLimit}
      for update of approval skip locked
    )
    update ads_approval_records approval set
      monitoring_evaluation_claim_id = ${options.claimId},
      monitoring_evaluation_claimed_at = ${now},
      updated_at = now()
    from candidates
    where approval.id = candidates.id
    returning approval.*
  `;
  return rows.map(parseApprovalRow);
}

export async function releaseMonitoringClaim(options: {
  id: string;
  accountId: string;
  claimId: string;
}) {
  const sql = getDatabase();
  const rows = await sql<{ id: string }[]>`
    update ads_approval_records set
      monitoring_evaluation_claim_id = null,
      monitoring_evaluation_claimed_at = null,
      updated_at = now()
    where id = ${options.id}
      and account_id = ${options.accountId}
      and monitoring_evaluation_claim_id = ${options.claimId}
      and monitoring_evaluated_at is null
    returning id
  `;
  return Boolean(rows[0]);
}

export async function recordMonitoringOutcome(options: {
  id: string;
  accountId: string;
  outcome: MonitoringOutcome;
  observation: MonitoringObservation;
  claimId: string;
  evaluatedAt?: Date;
}) {
  const sql = getDatabase();
  const outcome = monitoringOutcomeSchema.parse(options.outcome);
  const observation = monitoringObservationSchema.parse(options.observation);
  const evaluatedAt = options.evaluatedAt ?? new Date();
  const maturityCutoff = monitoringAttributionMaturityCutoff(evaluatedAt);
  const rows = await sql<{ id: string }[]>`
    with locked_account as materialized (
      select id, external_account_id
      from maintainflow_advertiser_accounts
      where external_account_id = ${options.accountId}
        and status = 'active'
      for share
    )
    update ads_approval_records approval set
      monitoring_outcome = ${outcome},
      monitoring_observation = ${sql.json(observation as postgres.JSONValue)},
      monitoring_evaluated_at = ${evaluatedAt},
      monitoring_evaluation_claim_id = null,
      monitoring_evaluation_claimed_at = null,
      updated_at = now()
    from locked_account advertiser_account
    where approval.id = ${options.id}
      and approval.account_id = advertiser_account.external_account_id
      and approval.monitoring_evaluated_at is null
      and approval.monitoring_evaluation_claim_id = ${options.claimId}
      and approval.monitoring_ends_at <= ${maturityCutoff}
      and approval.status in ('applied', 'rollback_failed')
    returning approval.id
  `;
  return Boolean(rows[0]);
}

export async function getApprovalAccountId(id: string) {
  const sql = getDatabase();
  const [row] = await sql<{ account_id: string }[]>`
    select account_id
    from ads_approval_records
    where id = ${id}
    limit 1
  `;
  if (!row) {
    throw new ApprovalTransitionError("This approval record was not found.");
  }
  return row.account_id;
}

export async function claimApprovalRollback(
  id: string,
  accountId: string,
  operatorId: string,
  access: AccountAccess,
  transaction?: postgres.TransactionSql,
) {
  const sql = transaction ?? getDatabase();
  const attemptId = randomUUID();
  const rows = await sql<ApprovalRollbackClaimRow[]>`
    update ads_approval_records set
      status = 'rollback_pending', rollback_operator_id = ${operatorId},
      rollback_organization_id = ${access.organizationId},
      rollback_membership_role = ${access.membershipRole},
      rollback_account_role = ${access.accountRole},
      rollback_error_message = null,
      rollback_provider_attempted_at = null,
      rollback_provider_attempt_id = ${attemptId},
      updated_at = now()
    where id = ${id} and account_id = ${accountId}
      and status in ('applied', 'rollback_failed')
      and monitoring_evaluation_claim_id is null
    returning ${sql(rollbackClaimColumns)}
  `;
  if (!rows[0]) {
    throw new ApprovalTransitionError(
      "This approval is not eligible for rollback or belongs to another account.",
    );
  }
  return {
    id: rows[0].id,
    // Return both payloads raw so malformed legacy rows can be moved from the
    // committed rollback_pending claim to rollback_failed by the executor.
    // Parsing here could throw at the transaction boundary and strand intent
    // without a durable failure outcome.
    mutationPayload: rows[0].request_payload,
    rollbackPayload: rows[0].rollback_payload,
    attemptId: rows[0].rollback_provider_attempt_id,
  };
}

export async function updateRollbackRecord(
  id: string,
  status: "rolled_back" | "rollback_failed" | "rollback_reconciliation_required",
  options: {
    accountId: string;
    attemptId: string;
    response?: unknown;
    error?: string;
  },
) {
  const sql = getDatabase();
  const responsePayload =
    options.response === undefined
      ? null
      : sql.json(options.response as postgres.JSONValue);
  const rows = await sql<{ id: string }[]>`
    update ads_approval_records set
      status = ${status}, rollback_response_payload = ${responsePayload},
      rollback_error_message = ${options.error ?? null},
      rolled_back_at = case when ${status} = 'rolled_back' then now() else rolled_back_at end,
      updated_at = now()
    where id = ${id}
      and account_id = ${options.accountId}
      and status = 'rollback_pending'
      and rollback_provider_attempt_id = ${options.attemptId}
    returning id
  `;
  if (!rows[0]) {
    throw new ApprovalTransitionError(
      "This rollback no longer holds its pending execution lease. Reconcile the durable record before taking another action.",
    );
  }
}

export function getReconciliationTransition(
  status: ApprovalStatus,
  action: ReconciliationAction,
): ApprovalStatus {
  if (status === "reconciliation_required") {
    if (action === "mark_applied") return "applied";
    if (action === "mark_not_applied") return "failed";
  }
  if (status === "rollback_reconciliation_required") {
    if (action === "mark_rolled_back") return "rolled_back";
    if (action === "mark_still_applied") return "applied";
  }
  throw new ApprovalTransitionError(
    "That reconciliation outcome is not valid for the approval's current state.",
  );
}

export async function reconcileApprovalRecord(options: {
  id: string;
  accountId: string;
  operatorId: string;
  action: ReconciliationAction;
  note: string;
  access: AccountAccess;
}) {
  const sql = getDatabase();
  return sql.begin(async (transaction) => {
    const authorized = await lockCurrentAccountWriteAccess({
      transaction,
      operatorId: options.operatorId,
      accountId: options.accountId,
      access: options.access,
      forbiddenMessage:
        "Write access changed while this approval was being reconciled. Refresh before trying again.",
    });
    const rows = await transaction<ApprovalRow[]>`
      select ${transaction(approvalColumns)} from ads_approval_records
      where id = ${options.id} and account_id = ${options.accountId}
      for update
    `;
    const current = rows[0];
    if (!current) {
      throw new ApprovalTransitionError("This approval was not found in the connected account.");
    }
    const nextStatus = getReconciliationTransition(current.status, options.action);
    const updated = await transaction<ApprovalRow[]>`
      update ads_approval_records set
        status = ${nextStatus}, reconciled_by = ${options.operatorId},
        reconciled_organization_id = ${authorized.access.organizationId},
        reconciled_membership_role = ${authorized.access.membershipRole},
        reconciled_account_role = ${authorized.access.accountRole},
        reconciled_at = now(), reconciliation_note = ${options.note},
        monitoring_started_at = case
          when ${nextStatus} = 'applied' and monitoring_plan is not null
            then coalesce(
              monitoring_started_at,
              date_trunc('hour', now()) + interval '1 hour'
            )
          else monitoring_started_at
        end,
        monitoring_ends_at = case
          when ${nextStatus} = 'applied' and monitoring_plan is not null
            then coalesce(
              monitoring_ends_at,
              date_trunc('hour', now()) + interval '1 hour'
                + make_interval(days => monitoring_window_days)
            )
          else monitoring_ends_at
        end,
        applied_at = case when ${nextStatus} = 'applied' and applied_at is null then now() else applied_at end,
        rolled_back_at = case when ${nextStatus} = 'rolled_back' then now() else rolled_back_at end,
        updated_at = now()
      where id = ${options.id} and account_id = ${options.accountId}
        and status = ${current.status}
      returning ${transaction(approvalColumns)}
    `;
    if (!updated[0]) {
      throw new ApprovalTransitionError(
        "This approval changed while it was being reconciled. Refresh and review it again.",
      );
    }
    return parseApprovalRow(updated[0]);
  });
}
