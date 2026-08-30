import "server-only";

import { randomUUID } from "node:crypto";

import type postgres from "postgres";

import type { Recommendation } from "../openai-ads/demo-data";
import { getRuntimeDatabase } from "../database/client.server";
import {
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
  rollback_payload: unknown;
  safeguard: string;
  status: ApprovalStatus;
  error_message: string | null;
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
  "rollback_payload",
  "safeguard",
  "status",
  "error_message",
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
        select count(*) = 24
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
            'monitoring_evaluation_claimed_at'
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
    rollback: row.rollback_payload,
    safeguard: row.safeguard,
    status: row.status,
    errorMessage: row.error_message,
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
      monitoring_plan, monitoring_window_days, status
    ) values (
      ${id}, ${accountId}, ${operatorId}, ${access.organizationId},
      ${access.membershipRole}, ${access.accountRole}, ${recommendation.id},
      ${recommendation.title}, ${recommendation.entityId},
      ${sql.json(recommendation.mutation as postgres.JSONValue)},
      ${sql.json(recommendation.rollback as postgres.JSONValue)},
      ${sql.json(recommendation.evidence as postgres.JSONValue)},
      ${recommendation.safeguard}, ${monitoringPlan},
      ${monitoringWindowDays}, 'pending'
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
  await sql`
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
  `;
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
  const rows = await sql<ApprovalRow[]>`
    select approval.*, organization.name as organization_name
    from ads_approval_records approval
    left join maintainflow_organizations organization
      on organization.id = approval.acting_organization_id
    where approval.account_id = ${accountId}
      and approval.monitoring_evaluated_at is null
      and approval.monitoring_started_at is not null
      and approval.monitoring_ends_at <= ${now}
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
  const rows = await sql<{ account_id: string }[]>`
    select account_id
    from ads_approval_records
    where monitoring_evaluated_at is null
      and monitoring_started_at is not null
      and monitoring_ends_at <= ${now}
      and (
        monitoring_evaluation_claimed_at is null
        or monitoring_evaluation_claimed_at < ${now} - interval '15 minutes'
      )
      and status in ('applied', 'rollback_failed')
    group by account_id
    order by min(monitoring_ends_at), account_id
    limit ${safeLimit}
  `;
  return rows.map((row) => row.account_id);
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
  const rows = await sql<ApprovalRow[]>`
    with candidates as (
      select id
      from ads_approval_records
      where account_id = ${options.accountId}
        and monitoring_evaluated_at is null
        and monitoring_started_at is not null
        and monitoring_ends_at <= ${now}
        and (
          monitoring_evaluation_claimed_at is null
          or monitoring_evaluation_claimed_at < ${now} - interval '15 minutes'
        )
        and status in ('applied', 'rollback_failed')
      order by monitoring_ends_at, id
      limit ${safeLimit}
      for update skip locked
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
  const rows = await sql<{ id: string }[]>`
    update ads_approval_records set
      monitoring_outcome = ${outcome},
      monitoring_observation = ${sql.json(observation as postgres.JSONValue)},
      monitoring_evaluated_at = ${evaluatedAt},
      monitoring_evaluation_claim_id = null,
      monitoring_evaluation_claimed_at = null,
      updated_at = now()
    where id = ${options.id}
      and account_id = ${options.accountId}
      and monitoring_evaluated_at is null
      and monitoring_evaluation_claim_id = ${options.claimId}
      and monitoring_ends_at <= ${evaluatedAt}
      and status in ('applied', 'rollback_failed')
    returning id
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
  const rows = await sql<ApprovalRow[]>`
    update ads_approval_records set
      status = 'rollback_pending', rollback_operator_id = ${operatorId},
      rollback_organization_id = ${access.organizationId},
      rollback_membership_role = ${access.membershipRole},
      rollback_account_role = ${access.accountRole},
      rollback_error_message = null, updated_at = now()
    where id = ${id} and account_id = ${accountId}
      and status in ('applied', 'rollback_failed')
    returning ${sql(approvalColumns)}
  `;
  if (!rows[0]) {
    throw new ApprovalTransitionError(
      "This approval is not eligible for rollback or belongs to another account.",
    );
  }
  return parseApprovalRow(rows[0]);
}

export async function updateRollbackRecord(
  id: string,
  status: "rolled_back" | "rollback_failed" | "rollback_reconciliation_required",
  options: { response?: unknown; error?: string } = {},
) {
  const sql = getDatabase();
  const responsePayload =
    options.response === undefined
      ? null
      : sql.json(options.response as postgres.JSONValue);
  await sql`
    update ads_approval_records set
      status = ${status}, rollback_response_payload = ${responsePayload},
      rollback_error_message = ${options.error ?? null},
      rolled_back_at = case when ${status} = 'rolled_back' then now() else rolled_back_at end,
      updated_at = now()
    where id = ${id} and status = 'rollback_pending'
  `;
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
