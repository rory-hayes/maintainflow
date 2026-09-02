import "server-only";

import { getRuntimeDatabase } from "../database/client.server";
import { organizationIdSchema } from "../tenancy/schema";
import type {
  LivePortfolioAccount,
  LivePortfolioEvidenceState,
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

function invalidEvidence(row: LivePortfolioRow): LivePortfolioAccount {
  return {
    accountId: row.account_id,
    accountName: row.account_name,
    hasConfirmedSnapshot: false,
    detectedSignalCount: null,
    evidenceState: "invalid",
    evidenceAt: validDate(row.synced_at) ? row.synced_at.toISOString() : null,
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
    return invalidEvidence(row);
  }

  if (row.detected_signal_count === null) {
    return {
      accountId: row.account_id,
      accountName: row.account_name,
      hasConfirmedSnapshot: false,
      detectedSignalCount: null,
      evidenceState: "refresh_required",
      evidenceAt: row.synced_at.toISOString(),
    };
  }

  if (
    !Number.isSafeInteger(row.detected_signal_count) ||
    row.detected_signal_count < 0 ||
    row.detected_signal_count > 1_000_000
  ) {
    return invalidEvidence(row);
  }

  return {
    accountId: row.account_id,
    accountName: row.account_name,
    hasConfirmedSnapshot: true,
    detectedSignalCount: row.detected_signal_count,
    evidenceState: evidenceState(row, now),
    evidenceAt: row.synced_at.toISOString(),
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
      snapshot.stale_until
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
