import "server-only";

import { randomUUID } from "node:crypto";

import type postgres from "postgres";
import type { Sql } from "postgres";

import type { Recommendation } from "../openai-ads/demo-data";
import { getRuntimeDatabase } from "../database/client.server";
import {
  canWriteAccount,
  type AccountAccess,
} from "../tenancy/schema";
import {
  recommendationDismissalReasonSchema,
  recommendationDecisionHistorySchema,
  recommendationDismissalSchema,
  recommendationFingerprint,
  type RecommendationDismissal,
  type RecommendationDecisionHistory,
} from "./recommendation-decision";

type RecommendationDismissalRow = {
  id: string;
  account_id: string;
  operator_id: string;
  acting_organization_id: string;
  actor_membership_role: AccountAccess["membershipRole"];
  actor_account_role: AccountAccess["accountRole"];
  recommendation_id: string;
  recommendation_title: string;
  entity_id: string;
  recommendation_fingerprint: string;
  reason: string;
  dismissed_at: Date;
};

type RecommendationDecisionHistoryRow = RecommendationDismissalRow & {
  organization_name: string;
  restored_by: string | null;
  restored_organization_id: string | null;
  restored_organization_name: string | null;
  restored_membership_role: AccountAccess["membershipRole"] | null;
  restored_account_role: AccountAccess["accountRole"] | null;
  restored_at: Date | null;
};

export class RecommendationDecisionStoreUnavailableError extends Error {
  constructor(message = "Recommendation decision storage is not configured.") {
    super(message);
    this.name = "RecommendationDecisionStoreUnavailableError";
  }
}

export class RecommendationDecisionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecommendationDecisionTransitionError";
  }
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new RecommendationDecisionStoreUnavailableError();
  }
  return getRuntimeDatabase(connectionString);
}

function parseDismissal(
  row: RecommendationDismissalRow,
): RecommendationDismissal {
  return recommendationDismissalSchema.parse({
    id: row.id,
    accountId: row.account_id,
    operatorId: row.operator_id,
    organizationId: row.acting_organization_id,
    membershipRole: row.actor_membership_role,
    accountRole: row.actor_account_role,
    recommendationId: row.recommendation_id,
    recommendationTitle: row.recommendation_title,
    entityId: row.entity_id,
    fingerprint: row.recommendation_fingerprint,
    reason: row.reason,
    dismissedAt: row.dismissed_at,
  });
}

function parseDecisionHistory(
  row: RecommendationDecisionHistoryRow,
): RecommendationDecisionHistory {
  return recommendationDecisionHistorySchema.parse({
    ...parseDismissal(row),
    organizationName: row.organization_name,
    restoredBy: row.restored_by,
    restoredOrganizationId: row.restored_organization_id,
    restoredOrganizationName: row.restored_organization_name,
    restoredMembershipRole: row.restored_membership_role,
    restoredAccountRole: row.restored_account_role,
    restoredAt: row.restored_at,
  });
}

export async function verifyRecommendationDecisionStore(database?: Sql) {
  if (!database && !process.env.DATABASE_URL) return false;
  const sql = database ?? getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_recommendation_dismissals') is not null
      and to_regclass(
        'public.maintainflow_recommendation_dismissals_active_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_recommendation_dismissals_account_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_recommendation_dismissals_history_idx'
      ) is not null
    ) as ready
  `;
  return result?.ready === true;
}

export async function listActiveRecommendationDismissals(
  accountId: string,
  transaction?: postgres.TransactionSql,
) {
  const sql = transaction ?? getDatabase();
  const rows = await sql<RecommendationDismissalRow[]>`
    select
      dismissal.id,
      account.external_account_id as account_id,
      dismissal.operator_id,
      dismissal.acting_organization_id,
      dismissal.actor_membership_role,
      dismissal.actor_account_role,
      dismissal.recommendation_id,
      dismissal.recommendation_title,
      dismissal.entity_id,
      dismissal.recommendation_fingerprint,
      dismissal.reason,
      dismissal.dismissed_at
    from maintainflow_recommendation_dismissals dismissal
    join maintainflow_advertiser_accounts account
      on account.id = dismissal.advertiser_account_id
    where account.external_account_id = ${accountId}
      and account.status = 'active'
      and dismissal.restored_at is null
    order by dismissal.dismissed_at desc
  `;
  return rows.map(parseDismissal);
}

export async function listRecommendationDecisionHistory(
  accountId: string,
  limit = 100,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RecommendationDecisionTransitionError(
      "Recommendation history limit must be between 1 and 100.",
    );
  }
  const sql = getDatabase();
  const rows = await sql<RecommendationDecisionHistoryRow[]>`
    select
      dismissal.id,
      account.external_account_id as account_id,
      dismissal.operator_id,
      dismissal.acting_organization_id,
      acting_organization.name as organization_name,
      dismissal.actor_membership_role,
      dismissal.actor_account_role,
      dismissal.recommendation_id,
      dismissal.recommendation_title,
      dismissal.entity_id,
      dismissal.recommendation_fingerprint,
      dismissal.reason,
      dismissal.dismissed_at,
      dismissal.restored_by,
      dismissal.restored_organization_id,
      restored_organization.name as restored_organization_name,
      dismissal.restored_membership_role,
      dismissal.restored_account_role,
      dismissal.restored_at
    from maintainflow_recommendation_dismissals dismissal
    join maintainflow_advertiser_accounts account
      on account.id = dismissal.advertiser_account_id
    join maintainflow_organizations acting_organization
      on acting_organization.id = dismissal.acting_organization_id
    left join maintainflow_organizations restored_organization
      on restored_organization.id = dismissal.restored_organization_id
    where account.external_account_id = ${accountId}
      and account.status = 'active'
    order by dismissal.dismissed_at desc, dismissal.id desc
    limit ${limit}
  `;
  return rows.map(parseDecisionHistory);
}

export async function dismissRecommendation(options: {
  accountId: string;
  operatorId: string;
  access: AccountAccess;
  recommendation: Recommendation;
  reason: string;
  transaction?: postgres.TransactionSql;
}) {
  if (
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new RecommendationDecisionTransitionError(
      "Write access to this advertiser account is required to dismiss a recommendation.",
    );
  }
  const sql = options.transaction ?? getDatabase();
  const id = randomUUID();
  const fingerprint = recommendationFingerprint(options.recommendation);
  const reason = recommendationDismissalReasonSchema.parse(options.reason);
  const [activeApproval] = await sql<{ id: string }[]>`
    select id
    from ads_approval_records
    where account_id = ${options.accountId}
      and recommendation_id = ${options.recommendation.id}
      and entity_id = ${options.recommendation.entityId}
      and status in (
        'pending',
        'applied',
        'reconciliation_required',
        'rollback_pending',
        'rollback_failed',
        'rollback_reconciliation_required'
      )
    limit 1
  `;
  if (activeApproval) {
    throw new RecommendationDecisionTransitionError(
      "This recommendation already has an active or unresolved approval and cannot be dismissed.",
    );
  }
  const inserted = await sql<{ id: string }[]>`
    insert into maintainflow_recommendation_dismissals (
      id,
      advertiser_account_id,
      operator_id,
      acting_organization_id,
      actor_membership_role,
      actor_account_role,
      recommendation_id,
      recommendation_title,
      entity_id,
      recommendation_fingerprint,
      recommendation_payload,
      reason
    )
    select
      ${id},
      account.id,
      ${options.operatorId},
      ${options.access.organizationId},
      ${options.access.membershipRole},
      ${options.access.accountRole},
      ${options.recommendation.id},
      ${options.recommendation.title},
      ${options.recommendation.entityId},
      ${fingerprint},
      ${sql.json(options.recommendation as postgres.JSONValue)},
      ${reason}
    from maintainflow_advertiser_accounts account
    where account.external_account_id = ${options.accountId}
      and account.status = 'active'
    on conflict (
      advertiser_account_id,
      recommendation_id,
      entity_id,
      recommendation_fingerprint
    ) where restored_at is null
    do nothing
    returning id
  `;

  if (!inserted[0]) {
    const existing = (await listActiveRecommendationDismissals(
      options.accountId,
      options.transaction,
    )).find(
      (dismissal) =>
        dismissal.recommendationId === options.recommendation.id &&
        dismissal.entityId === options.recommendation.entityId &&
        dismissal.fingerprint === fingerprint,
    );
    if (existing) return { dismissal: existing, created: false };
    throw new RecommendationDecisionTransitionError(
      "The recommendation could not be dismissed for this advertiser account.",
    );
  }

  const dismissal = (await listActiveRecommendationDismissals(
    options.accountId,
    options.transaction,
  )).find((item) => item.id === inserted[0].id);
  if (!dismissal) {
    throw new RecommendationDecisionTransitionError(
      "The dismissal was stored but could not be read back.",
    );
  }
  return { dismissal, created: true };
}

export async function restoreRecommendation(options: {
  accountId: string;
  operatorId: string;
  access: AccountAccess;
  recommendation: Recommendation;
  transaction?: postgres.TransactionSql;
}) {
  if (
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new RecommendationDecisionTransitionError(
      "Write access to this advertiser account is required to restore a recommendation.",
    );
  }
  const sql = options.transaction ?? getDatabase();
  const fingerprint = recommendationFingerprint(options.recommendation);
  const restored = await sql<{ id: string }[]>`
    update maintainflow_recommendation_dismissals dismissal set
      restored_by = ${options.operatorId},
      restored_organization_id = ${options.access.organizationId},
      restored_membership_role = ${options.access.membershipRole},
      restored_account_role = ${options.access.accountRole},
      restored_at = now(),
      updated_at = now()
    from maintainflow_advertiser_accounts account
    where account.id = dismissal.advertiser_account_id
      and account.external_account_id = ${options.accountId}
      and account.status = 'active'
      and dismissal.recommendation_id = ${options.recommendation.id}
      and dismissal.entity_id = ${options.recommendation.entityId}
      and dismissal.recommendation_fingerprint = ${fingerprint}
      and dismissal.restored_at is null
    returning dismissal.id
  `;
  if (!restored[0]) {
    throw new RecommendationDecisionTransitionError(
      "This recommendation no longer has an active dismissal. Refresh before trying again.",
    );
  }
  return { id: restored[0].id };
}
