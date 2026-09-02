import "server-only";

import { getRuntimeDatabase } from "../database/client.server";
import { organizationIdSchema } from "../tenancy/schema";
import type {
  LivePortfolioAccount,
  LivePortfolioEvidenceState,
  LivePortfolioOperationalExceptions,
} from "./live-portfolio";
import { LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION } from "./live-sync-snapshot";

type LivePortfolioRow = {
  account_id: string;
  account_name: string;
  payload_schema_version: number | null;
  detected_signal_count: number | null;
  synced_at: Date | null;
  fresh_until: Date | null;
  stale_until: Date | null;
  safeguard_triggered_count: number;
  safeguard_triggered_oldest_at: Date | null;
  insufficient_evidence_count: number;
  insufficient_evidence_oldest_at: Date | null;
  monitoring_failure_count: number;
  monitoring_failure_oldest_at: Date | null;
  reconciliation_required_count: number;
  reconciliation_required_oldest_at: Date | null;
};

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Live agency portfolio storage is not configured.");
  }
  return getRuntimeDatabase(connectionString);
}

function validDate(value: unknown): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function parseExceptionEvidence(
  count: number,
  oldestAt: Date | null,
): { count: number; oldestAt: string | null } {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("Live portfolio exception counts must be non-negative integers.");
  }
  if (count === 0) {
    if (oldestAt !== null) {
      throw new TypeError("An empty live portfolio exception set cannot have a timestamp.");
    }
    return { count: 0, oldestAt: null };
  }
  if (!validDate(oldestAt)) {
    throw new TypeError("A live portfolio exception requires a valid timestamp.");
  }
  return { count, oldestAt: oldestAt.toISOString() };
}

function operationalExceptions(
  row: LivePortfolioRow,
): LivePortfolioOperationalExceptions {
  return {
    safeguardTriggered: parseExceptionEvidence(
      row.safeguard_triggered_count,
      row.safeguard_triggered_oldest_at,
    ),
    insufficientEvidence: parseExceptionEvidence(
      row.insufficient_evidence_count,
      row.insufficient_evidence_oldest_at,
    ),
    monitoringFailures: parseExceptionEvidence(
      row.monitoring_failure_count,
      row.monitoring_failure_oldest_at,
    ),
    reconciliationRequired: parseExceptionEvidence(
      row.reconciliation_required_count,
      row.reconciliation_required_oldest_at,
    ),
  };
}

function invalidEvidence(
  row: LivePortfolioRow,
  exceptions: LivePortfolioOperationalExceptions,
): LivePortfolioAccount {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    hasConfirmedSnapshot: false,
    detectedSignalCount: null,
    evidenceState: "invalid",
    evidenceAt: validDate(row.synced_at) ? row.synced_at.toISOString() : null,
    operationalExceptions: exceptions,
  };
}

function evidenceState(
  row: LivePortfolioRow,
  now: Date,
): Extract<LivePortfolioEvidenceState, `confirmed_${string}`> {
  if (row.fresh_until!.getTime() > now.getTime()) return "confirmed_fresh";
  if (row.stale_until!.getTime() > now.getTime()) return "confirmed_stale";
  return "confirmed_expired";
}

export function toLivePortfolioAccount(
  row: LivePortfolioRow,
  now: Date,
): LivePortfolioAccount {
  const exceptions = operationalExceptions(row);
  if (
    row.payload_schema_version === null &&
    row.detected_signal_count === null &&
    row.synced_at === null &&
    row.fresh_until === null &&
    row.stale_until === null
  ) {
    return {
      accountId: row.account_id,
      accountName: row.account_name,
      hasConfirmedSnapshot: false,
      detectedSignalCount: null,
      evidenceState: "not_confirmed",
      evidenceAt: null,
      operationalExceptions: exceptions,
    };
  }

  if (
    row.payload_schema_version !== LIVE_WORKBENCH_SNAPSHOT_SCHEMA_VERSION ||
    !validDate(row.synced_at) ||
    !validDate(row.fresh_until) ||
    !validDate(row.stale_until) ||
    row.synced_at > row.fresh_until ||
    row.fresh_until > row.stale_until
  ) {
    return invalidEvidence(row, exceptions);
  }

  if (row.detected_signal_count === null) {
    return {
      accountId: row.account_id,
      accountName: row.account_name,
      hasConfirmedSnapshot: false,
      detectedSignalCount: null,
      evidenceState: "refresh_required",
      evidenceAt: row.synced_at.toISOString(),
      operationalExceptions: exceptions,
    };
  }

  if (
    !Number.isSafeInteger(row.detected_signal_count) ||
    row.detected_signal_count < 0 ||
    row.detected_signal_count > 1_000_000
  ) {
    return invalidEvidence(row, exceptions);
  }

  return {
    accountId: row.account_id,
    accountName: row.account_name,
    hasConfirmedSnapshot: true,
    detectedSignalCount: row.detected_signal_count,
    evidenceState: evidenceState(row, now),
    evidenceAt: row.synced_at.toISOString(),
    operationalExceptions: exceptions,
  };
}

export async function listLivePortfolioAccounts(options: {
  operatorId: string;
  organizationId: string;
  now?: Date;
}): Promise<LivePortfolioAccount[]> {
  const operatorId = options.operatorId.trim();
  if (!operatorId || operatorId.length > 255) {
    throw new TypeError("operatorId must be a bounded non-empty identifier.");
  }
  const organizationId = organizationIdSchema.parse(options.organizationId);
  const now = options.now ?? new Date();
  if (!validDate(now)) throw new TypeError("now must be a valid Date.");
  const sql = getDatabase();

  const rows = await sql<LivePortfolioRow[]>`
    select
      account.external_account_id as account_id,
      account.name as account_name,
      snapshot.payload_schema_version,
      snapshot.detected_signal_count,
      snapshot.synced_at,
      snapshot.fresh_until,
      snapshot.stale_until,
      coalesce(exception_summary.safeguard_triggered_count, 0)::int
        as safeguard_triggered_count,
      exception_summary.safeguard_triggered_oldest_at,
      coalesce(exception_summary.insufficient_evidence_count, 0)::int
        as insufficient_evidence_count,
      exception_summary.insufficient_evidence_oldest_at,
      coalesce(monitoring_schedule.consecutive_failures, 0)::int
        as monitoring_failure_count,
      case
        when coalesce(monitoring_schedule.consecutive_failures, 0) > 0
          then coalesce(
            exception_summary.oldest_unevaluated_monitoring_at,
            monitoring_schedule.last_failed_at
          )
        else null
      end as monitoring_failure_oldest_at,
      coalesce(exception_summary.reconciliation_required_count, 0)::int
        as reconciliation_required_count,
      exception_summary.reconciliation_required_oldest_at
    from maintainflow_organization_memberships membership
    join maintainflow_organizations organization
      on organization.id = membership.organization_id
    join maintainflow_account_access account_access
      on account_access.organization_id = organization.id
    join maintainflow_advertiser_accounts account
      on account.id = account_access.advertiser_account_id
    left join lateral (
      select credential.id, credential.credential_version
      from maintainflow_advertiser_credentials credential
      where credential.advertiser_account_id = account.id
        and credential.provider = 'openai_ads'
        and credential.status = 'active'
      order by credential.credential_version desc
      limit 1
    ) active_credential on account.connection_mode = 'vault'
    left join maintainflow_live_workbench_snapshots snapshot
      on snapshot.advertiser_account_id = account.id
      and snapshot.credential_generation = concat(
        'vault:',
        active_credential.id::text,
        ':',
        active_credential.credential_version::text
      )
    left join lateral (
      select
        count(*) filter (
          where approval.monitoring_outcome = 'safeguard_triggered'
            and approval.status in (
              'applied',
              'reconciliation_required',
              'rollback_pending',
              'rollback_failed',
              'rollback_reconciliation_required'
            )
        ) as safeguard_triggered_count,
        min(approval.monitoring_evaluated_at) filter (
          where approval.monitoring_outcome = 'safeguard_triggered'
            and approval.status in (
              'applied',
              'reconciliation_required',
              'rollback_pending',
              'rollback_failed',
              'rollback_reconciliation_required'
            )
        ) as safeguard_triggered_oldest_at,
        count(*) filter (
          where approval.monitoring_outcome = 'insufficient_evidence'
            and approval.status in (
              'applied',
              'reconciliation_required',
              'rollback_pending',
              'rollback_failed',
              'rollback_reconciliation_required'
            )
        ) as insufficient_evidence_count,
        min(approval.monitoring_evaluated_at) filter (
          where approval.monitoring_outcome = 'insufficient_evidence'
            and approval.status in (
              'applied',
              'reconciliation_required',
              'rollback_pending',
              'rollback_failed',
              'rollback_reconciliation_required'
            )
        ) as insufficient_evidence_oldest_at,
        count(*) filter (
          where approval.status in (
            'reconciliation_required',
            'rollback_reconciliation_required'
          )
        ) as reconciliation_required_count,
        min(approval.updated_at) filter (
          where approval.status in (
            'reconciliation_required',
            'rollback_reconciliation_required'
          )
        ) as reconciliation_required_oldest_at,
        min(approval.monitoring_ends_at) filter (
          where approval.monitoring_evaluated_at is null
            and approval.monitoring_started_at is not null
            and approval.monitoring_ends_at <= ${now}
            and approval.status in ('applied', 'rollback_failed')
        ) as oldest_unevaluated_monitoring_at
      from ads_approval_records approval
      where approval.account_id = account.external_account_id
    ) exception_summary on true
    left join maintainflow_monitoring_account_schedule monitoring_schedule
      on monitoring_schedule.advertiser_account_id = account.id
    where membership.clerk_user_id = ${operatorId}
      and organization.id = ${organizationId}
      and organization.customer_type = 'agency'
      and organization.status = 'active'
      and account.status = 'active'
      and not exists (
        select 1
        from maintainflow_customer_lifecycle_records lifecycle
        where lifecycle.advertiser_account_id = account.id
          and lifecycle.action = 'offboarded'
      )
    order by account.name, account.external_account_id
  `;

  return rows.map((row) => toLivePortfolioAccount(row, now));
}
