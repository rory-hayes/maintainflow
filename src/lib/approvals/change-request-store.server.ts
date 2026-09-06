import "server-only";

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type postgres from "postgres";
import type { Sql } from "postgres";
import { z } from "zod";

import {
  getWorkspaceAdmissionMode,
  getWorkspaceAdmittedOperatorIds,
  isWorkspaceAdmissionAllowed,
} from "../auth/config";
import type { Operator } from "../auth/operator.server";
import { recommendationApprovalFingerprint } from "../audit/recommendation-decision";
import { getRuntimeDatabase } from "../database/client.server";
import type { Recommendation } from "../openai-ads/demo-data";
import {
  accountAccessSchema,
  canWriteAccount,
  type AccountAccess,
  type AccountAccessRole,
  type AccountConnectionMode,
  type MembershipRole,
  type OrganizationType,
} from "../tenancy/schema";
import { lockCurrentAccountWriteAccess } from "../tenancy/store.server";
import {
  buildChangeApprovalDecisionContext,
  changeApprovalRequestSchema,
  type ChangeApprovalDecisionAction,
  type ChangeApprovalRequest,
} from "./change-request-schema";
import { isApprovalEmailEnabledForOrganization } from "./notification-config.server";
import {
  enqueueApprovalNotificationDeliveriesInTransaction,
  verifyApprovalNotificationDeliveryStore,
} from "./notification-delivery-store.server";

type ChangeApprovalRequestRow = {
  id: string;
  organization_id: string;
  organization_name: string;
  advertiser_account_id: string | null;
  account_id_snapshot: string;
  account_name_snapshot: string;
  source: "simulator" | "live";
  recommendation_id: string;
  recommendation_title: string;
  entity_id: string;
  recommendation_fingerprint: string;
  decision_context: unknown;
  request_payload: unknown;
  rollback_payload: unknown;
  evidence_payload: unknown;
  safeguard: string;
  requester_operator_id: string;
  requester_name_snapshot: string;
  requester_membership_role: MembershipRole;
  request_note: string | null;
  status:
    | "awaiting_approval"
    | "approved"
    | "changes_requested"
    | "cancelled"
    | "expired";
  decision_operator_id: string | null;
  decision_name_snapshot: string | null;
  decision_membership_role: MembershipRole | null;
  decision_note: string | null;
  requested_at: Date;
  decided_at: Date | null;
  expires_at: Date;
  retired_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
  ads_approval_record_id: string | null;
};

type LockedChangeApprovalRequestRow = ChangeApprovalRequestRow & {
  current_membership_role: MembershipRole;
};

type LiveRequestAccessRow = {
  advertiser_account_id: string;
  organization_id: string;
  organization_name: string;
  organization_type: OrganizationType;
  account_id: string;
  account_name: string;
  connection_mode: AccountConnectionMode;
  membership_role: MembershipRole;
  account_role: AccountAccessRole;
};

function currentReviewerAdmissionScope() {
  return {
    open: getWorkspaceAdmissionMode() === "open",
    operatorIds: getWorkspaceAdmittedOperatorIds(),
  };
}

type LiveExecutionResolutionRow = ChangeApprovalRequestRow & {
  current_organization_type: OrganizationType;
  current_account_id: string;
  current_account_name: string;
  current_connection_mode: AccountConnectionMode;
  current_membership_role: MembershipRole;
  current_account_role: AccountAccessRole;
  current_approver_membership_role: MembershipRole | null;
};

type LinkedApprovalRecordRow = {
  id: string;
  account_id: string;
  operator_id: string;
  acting_organization_id: string | null;
  actor_membership_role: MembershipRole | null;
  actor_account_role: AccountAccessRole | null;
  recommendation_id: string;
  recommendation_title: string;
  entity_id: string;
  recommendation_approval_fingerprint: string;
  request_payload: unknown;
  rollback_payload: unknown;
  evidence_payload: unknown;
  safeguard: string;
  monitoring_plan: unknown | null;
  monitoring_window_days: number | null;
  apply_provider_attempt_id: string | null;
  apply_provider_attempted_at: Date | null;
  response_payload: unknown | null;
  error_message: string | null;
  applied_at: Date | null;
  status: string;
};

const changeApprovalRequestCursorSchema = z
  .object({
    version: z.literal(1),
    statusBucket: z.union([z.literal(0), z.literal(1)]),
    requestedAt: z.string().datetime(),
    id: z.string().uuid(),
  })
  .strict();

type ChangeApprovalRequestCursor = z.infer<
  typeof changeApprovalRequestCursorSchema
>;

export class ChangeApprovalRequestStoreUnavailableError extends Error {
  constructor(message = "The agency approval queue is not configured.") {
    super(message);
    this.name = "ChangeApprovalRequestStoreUnavailableError";
  }
}

export class ChangeApprovalRequestForbiddenError extends Error {
  constructor(message = "This approval request is not available in your agency workspace.") {
    super(message);
    this.name = "ChangeApprovalRequestForbiddenError";
  }
}

export class ChangeApprovalRequestInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeApprovalRequestInvalidError";
  }
}

export class ChangeApprovalRequestTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChangeApprovalRequestTransitionError";
  }
}

function statusBucket(status: ChangeApprovalRequest["status"]): 0 | 1 {
  return status === "awaiting_approval" ? 0 : 1;
}

function encodeChangeApprovalRequestCursor(
  cursor: ChangeApprovalRequestCursor,
) {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeChangeApprovalRequestCursor(
  value: string,
): ChangeApprovalRequestCursor {
  try {
    if (
      value.length < 1 ||
      value.length > 512 ||
      !/^[A-Za-z0-9_-]+$/.test(value)
    ) {
      throw new Error("Malformed cursor.");
    }
    return changeApprovalRequestCursorSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw new ChangeApprovalRequestInvalidError(
      "The approval queue cursor is invalid. Refresh before loading more.",
    );
  }
}

function getDatabase() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new ChangeApprovalRequestStoreUnavailableError();
  return getRuntimeDatabase(connectionString);
}

async function requireApprovalNotificationStoreWhenEnabled(
  organizationId: string,
  database?: Sql | postgres.TransactionSql,
) {
  let enabled: boolean;
  try {
    enabled = isApprovalEmailEnabledForOrganization(organizationId);
  } catch {
    throw new ChangeApprovalRequestStoreUnavailableError(
      "Approval email delivery is not configured safely.",
    );
  }
  if (
    enabled &&
    !(await verifyApprovalNotificationDeliveryStore(database))
  ) {
    throw new ChangeApprovalRequestStoreUnavailableError(
      "Apply the approval notification outbox migration before enabling approval email.",
    );
  }
}

function parseChangeApprovalRequest(
  row: ChangeApprovalRequestRow,
): ChangeApprovalRequest {
  return changeApprovalRequestSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    advertiserAccountId: row.advertiser_account_id,
    accountId: row.account_id_snapshot,
    accountName: row.account_name_snapshot,
    source: row.source,
    recommendationId: row.recommendation_id,
    recommendationTitle: row.recommendation_title,
    entityId: row.entity_id,
    recommendationFingerprint: row.recommendation_fingerprint,
    decisionContext: row.decision_context,
    mutation: row.request_payload,
    rollback: row.rollback_payload,
    evidence: row.evidence_payload,
    safeguard: row.safeguard,
    requesterOperatorId: row.requester_operator_id,
    requesterName: row.requester_name_snapshot,
    requesterMembershipRole: row.requester_membership_role,
    requestNote: row.request_note,
    status: row.status,
    decisionOperatorId: row.decision_operator_id,
    decisionName: row.decision_name_snapshot,
    decisionMembershipRole: row.decision_membership_role,
    decisionNote: row.decision_note,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    expiresAt: row.expires_at,
    retiredAt: row.retired_at,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    adsApprovalRecordId: row.ads_approval_record_id,
  });
}

function parseLiveRequestAccess(row: LiveRequestAccessRow): AccountAccess {
  return accountAccessSchema.parse({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationType: row.organization_type,
    accountId: row.account_id,
    accountName: row.account_name,
    connectionMode: row.connection_mode,
    membershipRole: row.membership_role,
    accountRole: row.account_role,
  });
}

function parseLiveExecutionAccess(
  row: LiveExecutionResolutionRow,
): AccountAccess {
  return accountAccessSchema.parse({
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationType: row.current_organization_type,
    accountId: row.current_account_id,
    accountName: row.current_account_name,
    connectionMode: row.current_connection_mode,
    membershipRole: row.current_membership_role,
    accountRole: row.current_account_role,
  });
}

function assertLiveRecommendationCanBeRequested(
  recommendation: Recommendation,
) {
  if (recommendation.source !== "live" || recommendation.status !== "ready") {
    throw new ChangeApprovalRequestInvalidError(
      "Only a fresh, ready live recommendation can enter the agency approval queue.",
    );
  }
}

function assertLivePacketMatchesRecommendation(options: {
  request: ChangeApprovalRequest;
  access: AccountAccess;
  recommendation: Recommendation;
}) {
  const { request, access, recommendation } = options;
  assertLiveRecommendationCanBeRequested(recommendation);
  const fingerprint = recommendationApprovalFingerprint(recommendation);
  const decisionContext = buildChangeApprovalDecisionContext(recommendation);
  const matches =
    request.source === "live" &&
    access.organizationType === "agency" &&
    request.organizationId === access.organizationId &&
    request.accountId === access.accountId &&
    request.recommendationId === recommendation.id &&
    request.recommendationTitle === recommendation.title &&
    request.entityId === recommendation.entityId &&
    request.recommendationFingerprint === fingerprint &&
    isDeepStrictEqual(request.decisionContext, decisionContext) &&
    isDeepStrictEqual(request.mutation, recommendation.mutation) &&
    isDeepStrictEqual(request.rollback, recommendation.rollback) &&
    isDeepStrictEqual(request.evidence, recommendation.evidence) &&
    request.safeguard === recommendation.safeguard;
  if (!matches) {
    throw new ChangeApprovalRequestInvalidError(
      "The approved packet no longer matches the fresh live recommendation. Refresh and request a new decision.",
    );
  }
}

export function isChangeApprovalRequestStoreConfigured(database?: Sql) {
  return Boolean(database ?? process.env.DATABASE_URL);
}

export async function verifyChangeApprovalRequestStore(database?: Sql) {
  if (!isChangeApprovalRequestStoreConfigured(database)) return false;
  const sql = database ?? getDatabase();
  const [result] = await sql<{ ready: boolean }[]>`
    select (
      to_regclass('public.maintainflow_change_approval_requests') is not null
      and to_regclass(
        'public.maintainflow_change_approval_requests_awaiting_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_change_approval_requests_organization_status_idx'
      ) is not null
      and to_regclass(
        'public.maintainflow_change_approval_requests_live_unconsumed_idx'
      ) is not null
      and exists (
        select 1
        from pg_catalog.pg_index index_definition
        where index_definition.indexrelid = to_regclass(
            'public.maintainflow_change_approval_requests_live_unconsumed_idx'
          )
          and index_definition.indisunique
          and index_definition.indisvalid
          and index_definition.indisready
          and lower(pg_catalog.pg_get_expr(
            index_definition.indpred,
            index_definition.indrelid
          )) like '%retired_at is null%'
      )
      and to_regprocedure(
        'public.maintainflow_enforce_change_approval_transition()'
      ) is not null
      and to_regprocedure(
        'public.maintainflow_enforce_ads_approval_identity()'
      ) is not null
      and to_regprocedure(
        'public.maintainflow_enforce_change_approval_insert()'
      ) is not null
      and to_regprocedure(
        'public.maintainflow_validate_change_approval_link()'
      ) is not null
      and to_regprocedure(
        'public.maintainflow_require_agency_approval_binding()'
      ) is not null
      and to_regprocedure(
        'public.maintainflow_enforce_runtime_lock_only_update()'
      ) is not null
      and position(
        'retired_at' in pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_enforce_change_approval_transition()'
        ))
      ) > 0
      and position(
        'schemaversion' in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_enforce_change_approval_transition()'
        )))
      ) > 0
      and position(
        'retired_at' in pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_enforce_change_approval_insert()'
        ))
      ) > 0
      and position(
        'schemaversion' in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_enforce_change_approval_insert()'
        )))
      ) > 0
      and position(
        'retired_at' in pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_validate_change_approval_link()'
        ))
      ) > 0
      and position(
        'schemaversion' in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_validate_change_approval_link()'
        )))
      ) > 0
      and position(
        'retired_at' in pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_require_agency_approval_binding()'
        ))
      ) > 0
      and position(
        'schemaversion' in lower(pg_catalog.pg_get_functiondef(to_regprocedure(
          'public.maintainflow_require_agency_approval_binding()'
        )))
      ) > 0
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation
          on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'maintainflow_change_approval_requests'
          and trigger.tgname =
            'maintainflow_change_approval_transition_guard'
          and trigger.tgfoid = to_regprocedure(
            'public.maintainflow_enforce_change_approval_transition()'
          )
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
      )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation
          on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'ads_approval_records'
          and trigger.tgname = 'maintainflow_ads_approval_identity_guard'
          and trigger.tgfoid = to_regprocedure(
            'public.maintainflow_enforce_ads_approval_identity()'
          )
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
      )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation
          on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'maintainflow_change_approval_requests'
          and trigger.tgname = 'maintainflow_change_approval_insert_guard'
          and trigger.tgfoid = to_regprocedure(
            'public.maintainflow_enforce_change_approval_insert()'
          )
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
      )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation
          on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'maintainflow_change_approval_requests'
          and trigger.tgname =
            'maintainflow_change_approval_execution_binding_guard'
          and trigger.tgfoid = to_regprocedure(
            'public.maintainflow_validate_change_approval_link()'
          )
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
      )
      and exists (
        select 1
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation
          on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and relation.relname = 'ads_approval_records'
          and trigger.tgname =
            'maintainflow_ads_approval_agency_binding_guard'
          and trigger.tgfoid = to_regprocedure(
            'public.maintainflow_require_agency_approval_binding()'
          )
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
          and trigger.tgdeferrable
          and trigger.tginitdeferred
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'ads_approval_records'
          and column_name = 'recommendation_approval_fingerprint'
      )
      and exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'maintainflow_change_approval_requests'
          and column_name = 'retired_at'
          and data_type = 'timestamp with time zone'
          and is_nullable = 'YES'
      )
      and exists (
        select 1
        from pg_catalog.pg_constraint constraint_definition
        where constraint_definition.conrelid =
            'public.maintainflow_change_approval_requests'::regclass
          and constraint_definition.conname =
            'maintainflow_change_approval_requests_retirement_check'
          and constraint_definition.contype = 'c'
          and constraint_definition.convalidated
      )
      and (
        select count(*) = 3
        from pg_catalog.pg_trigger trigger
        join pg_catalog.pg_class relation
          on relation.oid = trigger.tgrelid
        join pg_catalog.pg_namespace namespace
          on namespace.oid = relation.relnamespace
        where namespace.nspname = 'public'
          and (relation.relname, trigger.tgname) in (
            (
              'maintainflow_organizations',
              'maintainflow_organizations_runtime_lock_only_guard'
            ),
            (
              'maintainflow_organization_memberships',
              'maintainflow_memberships_runtime_lock_only_guard'
            ),
            (
              'maintainflow_account_access',
              'maintainflow_account_access_runtime_lock_only_guard'
            )
          )
          and trigger.tgfoid = to_regprocedure(
            'public.maintainflow_enforce_runtime_lock_only_update()'
          )
          and not trigger.tgisinternal
          and trigger.tgenabled = 'O'
      )
      and (
        select count(*) = 10
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'maintainflow_change_approval_requests'
          and column_name in (
            'organization_id',
            'recommendation_fingerprint',
            'decision_context',
            'requester_operator_id',
            'decision_operator_id',
            'status',
            'expires_at',
            'retired_at',
            'version',
            'ads_approval_record_id'
          )
      )
    ) as ready
  `;
  return result?.ready === true;
}

async function lockAgencyMembership(
  transaction: postgres.TransactionSql,
  options: { organizationId: string; operatorId: string },
) {
  const [membership] = await transaction<
    { organization_name: string; membership_role: MembershipRole }[]
  >`
    select
      organization.name as organization_name,
      membership.role as membership_role
    from maintainflow_organization_memberships membership
    join maintainflow_organizations organization
      on organization.id = membership.organization_id
    where organization.id = ${options.organizationId}
      and organization.customer_type = 'agency'
      and organization.status = 'active'
      and membership.clerk_user_id = ${options.operatorId}
    for update of organization, membership
  `;
  if (!membership) throw new ChangeApprovalRequestForbiddenError();
  return membership;
}

export async function createSimulatorChangeApprovalRequest(options: {
  organizationId: string;
  operator: Operator;
  account: { id: string; name: string };
  recommendation: Recommendation;
  displayedFingerprint: string;
  note?: string;
  now?: Date;
}) {
  await requireApprovalNotificationStoreWhenEnabled(options.organizationId);
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError(
      "Apply the agency approval queue migration before requesting a decision.",
    );
  }
  if (options.recommendation.source !== "demo") {
    throw new ChangeApprovalRequestInvalidError(
      "Only labelled simulator recommendations can enter this credential-free approval queue.",
    );
  }
  const fingerprint = recommendationApprovalFingerprint(options.recommendation);
  const decisionContext = buildChangeApprovalDecisionContext(
    options.recommendation,
  );
  if (fingerprint !== options.displayedFingerprint) {
    throw new ChangeApprovalRequestInvalidError(
      "This recommendation changed after it was displayed. Refresh before requesting approval.",
    );
  }
  const note = options.note?.trim() || null;
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const reviewerAdmission = currentReviewerAdmissionScope();
  const sql = getDatabase();

  return sql.begin(async (transaction) => {
    const membership = await lockAgencyMembership(transaction, {
      organizationId: options.organizationId,
      operatorId: options.operator.id,
    });
    const [reviewerCapacity] = await transaction<
      { eligible_reviewer_count: number }[]
    >`
      select count(*)::integer as eligible_reviewer_count
      from maintainflow_organization_memberships reviewer
      where reviewer.organization_id = ${options.organizationId}
        and reviewer.role in ('owner', 'admin')
        and reviewer.clerk_user_id <> ${options.operator.id}
        and (
          ${reviewerAdmission.open}
          or reviewer.clerk_user_id = any(
            ${reviewerAdmission.operatorIds}::text[]
          )
        )
    `;
    const eligibleReviewerCount = Number(
      reviewerCapacity?.eligible_reviewer_count ?? 0,
    );
    await transaction`
      update maintainflow_change_approval_requests set
        status = 'expired',
        version = version + 1,
        updated_at = ${now}
      where organization_id = ${options.organizationId}
        and status = 'awaiting_approval'
        and expires_at <= ${now}
    `;
    const id = randomUUID();
    const inserted = await transaction<{ id: string }[]>`
      insert into maintainflow_change_approval_requests (
        id, organization_id, advertiser_account_id,
        account_id_snapshot, account_name_snapshot, source,
        recommendation_id, recommendation_title, entity_id,
        recommendation_fingerprint, decision_context, request_payload, rollback_payload,
        evidence_payload, safeguard, requester_operator_id,
        requester_name_snapshot, requester_membership_role, request_note,
        requested_at, expires_at
      ) values (
        ${id}, ${options.organizationId}, null,
        ${options.account.id}, ${options.account.name}, 'simulator',
        ${options.recommendation.id}, ${options.recommendation.title},
        ${options.recommendation.entityId}, ${fingerprint},
        ${transaction.json(decisionContext as postgres.JSONValue)},
        ${transaction.json(options.recommendation.mutation as postgres.JSONValue)},
        ${transaction.json(options.recommendation.rollback as postgres.JSONValue)},
        ${transaction.json(options.recommendation.evidence as postgres.JSONValue)},
        ${options.recommendation.safeguard}, ${options.operator.id},
        ${options.operator.name.slice(0, 120)}, ${membership.membership_role},
        ${note}, ${now}, ${expiresAt}
      )
      on conflict (
        organization_id, source, account_id_snapshot, recommendation_id,
        entity_id, recommendation_fingerprint
      ) where status = 'awaiting_approval'
      do nothing
      returning id
    `;
    if (inserted[0]) {
      const notificationDeliveryIds =
        await enqueueApprovalNotificationDeliveriesInTransaction(transaction, {
          approvalRequestId: inserted[0].id,
          organizationId: options.organizationId,
          eventType: "review_requested",
          approvalRequestVersion: 1,
        });
      return {
        id: inserted[0].id,
        created: true,
        eligibleReviewerCount,
        notificationDeliveryIds,
      };
    }

    const [existing] = await transaction<{ id: string }[]>`
      select id
      from maintainflow_change_approval_requests
      where organization_id = ${options.organizationId}
        and source = 'simulator'
        and account_id_snapshot = ${options.account.id}
        and recommendation_id = ${options.recommendation.id}
        and entity_id = ${options.recommendation.entityId}
        and recommendation_fingerprint = ${fingerprint}
        and status = 'awaiting_approval'
    `;
    if (!existing) {
      throw new ChangeApprovalRequestTransitionError(
        "The approval queue changed concurrently. Refresh before trying again.",
      );
    }
    return {
      id: existing.id,
      created: false,
      eligibleReviewerCount,
      notificationDeliveryIds: [],
    };
  });
}

async function lockLiveRequestAccess(
  transaction: postgres.TransactionSql,
  options: { operatorId: string; access: AccountAccess },
) {
  if (options.access.organizationType !== "agency") {
    throw new ChangeApprovalRequestForbiddenError(
      "A live approval packet must belong to an active agency workspace.",
    );
  }

  const [account] = await transaction<{ id: string }[]>`
    select id
    from maintainflow_advertiser_accounts
    where external_account_id = ${options.access.accountId}
      and status = 'active'
    for update
  `;
  if (!account) throw new ChangeApprovalRequestForbiddenError();

  const [row] = await transaction<LiveRequestAccessRow[]>`
    select
      account.id as advertiser_account_id,
      organization.id as organization_id,
      organization.name as organization_name,
      organization.customer_type as organization_type,
      account.external_account_id as account_id,
      account.name as account_name,
      account.connection_mode as connection_mode,
      membership.role as membership_role,
      account_access.role as account_role
    from maintainflow_organizations organization
    join maintainflow_organization_memberships membership
      on membership.organization_id = organization.id
    join maintainflow_account_access account_access
      on account_access.organization_id = organization.id
    join maintainflow_advertiser_accounts account
      on account.id = account_access.advertiser_account_id
    where organization.id = ${options.access.organizationId}
      and organization.customer_type = 'agency'
      and organization.status = 'active'
      and membership.clerk_user_id = ${options.operatorId}
      and account.id = ${account.id}
      and account.status = 'active'
      and account_access.role in ('owner', 'manager')
    for update of organization, membership, account_access
  `;
  if (!row) throw new ChangeApprovalRequestForbiddenError();

  const access = parseLiveRequestAccess(row);
  if (!isDeepStrictEqual(access, options.access)) {
    throw new ChangeApprovalRequestForbiddenError(
      "Agency account access changed while the recommendation was being reviewed. Refresh before requesting approval.",
    );
  }
  return { advertiserAccountId: row.advertiser_account_id, access };
}

async function retireUnavailableLiveDuplicate(options: {
  transaction: postgres.TransactionSql;
  organizationId: string;
  advertiserAccountId: string;
  recommendationId: string;
  entityId: string;
  recommendationFingerprint: string;
}) {
  const reviewerAdmission = currentReviewerAdmissionScope();
  const candidates = await options.transaction<
    { id: string; decision_operator_id: string | null }[]
  >`
    select id, decision_operator_id
    from maintainflow_change_approval_requests
    where organization_id = ${options.organizationId}
      and advertiser_account_id = ${options.advertiserAccountId}
      and source = 'live'
      and recommendation_id = ${options.recommendationId}
      and entity_id = ${options.entityId}
      and recommendation_fingerprint = ${options.recommendationFingerprint}
      and status = 'approved'
      and retired_at is null
      and ads_approval_record_id is null
    order by id
    for update
  `;
  if (candidates.length === 0) return;

  const approverIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        candidate.decision_operator_id ? [candidate.decision_operator_id] : [],
      ),
    ),
  ].sort();
  if (approverIds.length > 0) {
    await options.transaction`
      select clerk_user_id
      from maintainflow_organization_memberships
      where organization_id = ${options.organizationId}
        and clerk_user_id = any(${approverIds}::text[])
      order by clerk_user_id
      for update
    `;
  }

  const candidateIds = candidates.map((candidate) => candidate.id);
  await options.transaction`
    update maintainflow_change_approval_requests request set
      retired_at = pg_catalog.statement_timestamp(),
      version = request.version + 1,
      updated_at = greatest(
        request.updated_at,
        pg_catalog.statement_timestamp()
      )
    where request.id = any(${candidateIds}::uuid[])
      and request.organization_id = ${options.organizationId}
      and request.advertiser_account_id = ${options.advertiserAccountId}
      and request.source = 'live'
      and request.status = 'approved'
      and request.retired_at is null
      and request.ads_approval_record_id is null
      and (
        request.expires_at <= pg_catalog.statement_timestamp()
        or request.decision_context ->> 'schemaVersion' is distinct from '2'
        or request.decision_operator_id is null
        or not exists (
          select 1
          from maintainflow_organization_memberships approver
          where approver.organization_id = request.organization_id
            and approver.clerk_user_id = request.decision_operator_id
            and approver.role in ('owner', 'admin')
            and (
              ${reviewerAdmission.open}
              or approver.clerk_user_id = any(
                ${reviewerAdmission.operatorIds}::text[]
              )
            )
        )
      )
  `;
}

export async function createLiveChangeApprovalRequest(options: {
  operator: Operator;
  access: AccountAccess;
  recommendation: Recommendation;
  displayedFingerprint: string;
  note?: string;
  now?: Date;
}) {
  await requireApprovalNotificationStoreWhenEnabled(
    options.access.organizationId,
  );
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError(
      "Apply the agency approval queue migration before requesting a live decision.",
    );
  }
  assertLiveRecommendationCanBeRequested(options.recommendation);
  const fingerprint = recommendationApprovalFingerprint(options.recommendation);
  const decisionContext = buildChangeApprovalDecisionContext(
    options.recommendation,
  );
  if (fingerprint !== options.displayedFingerprint) {
    throw new ChangeApprovalRequestInvalidError(
      "This recommendation changed after it was displayed. Refresh before requesting approval.",
    );
  }
  const note = options.note?.trim() || null;
  const now = options.now ?? new Date();
  const expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000);
  const reviewerAdmission = currentReviewerAdmissionScope();
  const sql = getDatabase();

  return sql.begin(async (transaction) => {
    const authorized = await lockLiveRequestAccess(transaction, {
      operatorId: options.operator.id,
      access: options.access,
    });
    const [reviewerCapacity] = await transaction<
      { eligible_reviewer_count: number }[]
    >`
      select count(*)::integer as eligible_reviewer_count
      from maintainflow_organization_memberships reviewer
      where reviewer.organization_id = ${authorized.access.organizationId}
        and reviewer.role in ('owner', 'admin')
        and reviewer.clerk_user_id <> ${options.operator.id}
        and (
          ${reviewerAdmission.open}
          or reviewer.clerk_user_id = any(
            ${reviewerAdmission.operatorIds}::text[]
          )
        )
    `;
    const eligibleReviewerCount = Number(
      reviewerCapacity?.eligible_reviewer_count ?? 0,
    );
    if (eligibleReviewerCount === 0) {
      throw new ChangeApprovalRequestInvalidError(
        "Add another agency owner or admin before requesting a live approval.",
      );
    }
    await transaction`
      update maintainflow_change_approval_requests set
        status = 'expired',
        version = version + 1,
        updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
      where organization_id = ${authorized.access.organizationId}
        and advertiser_account_id = ${authorized.advertiserAccountId}
        and source = 'live'
        and status = 'awaiting_approval'
        and (
          expires_at <= pg_catalog.statement_timestamp()
          or decision_context ->> 'schemaVersion' is distinct from '2'
        )
    `;
    await retireUnavailableLiveDuplicate({
      transaction,
      organizationId: authorized.access.organizationId,
      advertiserAccountId: authorized.advertiserAccountId,
      recommendationId: options.recommendation.id,
      entityId: options.recommendation.entityId,
      recommendationFingerprint: fingerprint,
    });

    const id = randomUUID();
    const inserted = await transaction<{ id: string }[]>`
      insert into maintainflow_change_approval_requests (
        id, organization_id, advertiser_account_id,
        account_id_snapshot, account_name_snapshot, source,
        recommendation_id, recommendation_title, entity_id,
        recommendation_fingerprint, decision_context, request_payload,
        rollback_payload, evidence_payload, safeguard,
        requester_operator_id, requester_name_snapshot,
        requester_membership_role, request_note, requested_at, expires_at
      ) values (
        ${id}, ${authorized.access.organizationId},
        ${authorized.advertiserAccountId}, ${authorized.access.accountId},
        ${authorized.access.accountName}, 'live',
        ${options.recommendation.id}, ${options.recommendation.title},
        ${options.recommendation.entityId}, ${fingerprint},
        ${transaction.json(decisionContext as postgres.JSONValue)},
        ${transaction.json(options.recommendation.mutation as postgres.JSONValue)},
        ${transaction.json(options.recommendation.rollback as postgres.JSONValue)},
        ${transaction.json(options.recommendation.evidence as postgres.JSONValue)},
        ${options.recommendation.safeguard}, ${options.operator.id},
        ${options.operator.name.slice(0, 120)},
        ${authorized.access.membershipRole}, ${note}, ${now}, ${expiresAt}
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) {
      const notificationDeliveryIds =
        await enqueueApprovalNotificationDeliveriesInTransaction(transaction, {
          approvalRequestId: inserted[0].id,
          organizationId: authorized.access.organizationId,
          eventType: "review_requested",
          approvalRequestVersion: 1,
        });
      return {
        id: inserted[0].id,
        created: true,
        eligibleReviewerCount,
        notificationDeliveryIds,
      };
    }

    const [existing] = await transaction<{ id: string }[]>`
      select id
      from maintainflow_change_approval_requests
      where organization_id = ${authorized.access.organizationId}
        and advertiser_account_id = ${authorized.advertiserAccountId}
        and source = 'live'
        and account_id_snapshot = ${authorized.access.accountId}
        and recommendation_id = ${options.recommendation.id}
        and entity_id = ${options.recommendation.entityId}
        and recommendation_fingerprint = ${fingerprint}
        and status in ('awaiting_approval', 'approved')
        and retired_at is null
        and decision_context ->> 'schemaVersion' = '2'
        and expires_at > pg_catalog.statement_timestamp()
        and ads_approval_record_id is null
        and (
          status = 'awaiting_approval'
          or exists (
            select 1
            from maintainflow_organization_memberships approver
            where approver.organization_id =
                maintainflow_change_approval_requests.organization_id
              and approver.clerk_user_id =
                maintainflow_change_approval_requests.decision_operator_id
              and approver.role in ('owner', 'admin')
              and (
                ${reviewerAdmission.open}
                or approver.clerk_user_id = any(
                  ${reviewerAdmission.operatorIds}::text[]
                )
              )
          )
        )
    `;
    if (!existing) {
      throw new ChangeApprovalRequestTransitionError(
        "The approval queue changed concurrently. Refresh before trying again.",
      );
    }
    return {
      id: existing.id,
      created: false,
      eligibleReviewerCount,
      notificationDeliveryIds: [],
    };
  });
}

export async function listChangeApprovalRequests(options: {
  operatorId: string;
  organizationId?: string;
  limit?: number;
}) {
  const page = await listChangeApprovalRequestPage({
    operatorId: options.operatorId,
    organizationId: options.organizationId,
    pageSize: options.limit ?? 100,
  });
  return page.requests;
}

export async function getChangeApprovalRequestForOperator(options: {
  operatorId: string;
  organizationId: string;
  requestId: string;
}) {
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError();
  }
  const parsedRequestId = z.string().uuid().safeParse(options.requestId);
  const parsedOrganizationId = z.string().uuid().safeParse(options.organizationId);
  if (!parsedRequestId.success || !parsedOrganizationId.success) return null;
  const sql = getDatabase();
  const [row] = await sql<ChangeApprovalRequestRow[]>`
    select request.*, organization.name as organization_name
    from maintainflow_change_approval_requests request
    join maintainflow_organizations organization
      on organization.id = request.organization_id
    join maintainflow_organization_memberships membership
      on membership.organization_id = request.organization_id
      and membership.clerk_user_id = ${options.operatorId}
    where request.id = ${parsedRequestId.data}
      and request.organization_id = ${parsedOrganizationId.data}
      and organization.status = 'active'
  `;
  return row ? parseChangeApprovalRequest(row) : null;
}

export async function listChangeApprovalRequestPage(options: {
  operatorId: string;
  organizationId?: string;
  pageSize?: number;
  cursor?: string;
}) {
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError();
  }
  const sql = getDatabase();
  const pageSize = Math.max(
    1,
    Math.min(100, Math.trunc(options.pageSize ?? 50)),
  );
  const cursor = options.cursor
    ? decodeChangeApprovalRequestCursor(options.cursor)
    : undefined;
  const organizationFilter = options.organizationId
    ? sql`and request.organization_id = ${options.organizationId}`
    : sql``;
  const cursorFilter = cursor
    ? sql`and (
        (case request.status when 'awaiting_approval' then 0 else 1 end)
          > ${cursor.statusBucket}
        or (
          (case request.status when 'awaiting_approval' then 0 else 1 end)
            = ${cursor.statusBucket}
          and request.requested_at < ${new Date(cursor.requestedAt)}
        )
        or (
          (case request.status when 'awaiting_approval' then 0 else 1 end)
            = ${cursor.statusBucket}
          and request.requested_at = ${new Date(cursor.requestedAt)}
          and request.id > ${cursor.id}
        )
      )`
    : sql``;

  await sql`
    update maintainflow_change_approval_requests request set
      status = 'expired',
      version = version + 1,
      updated_at = now()
    where request.status = 'awaiting_approval'
      and request.expires_at <= now()
      and exists (
        select 1
        from maintainflow_organization_memberships membership
        join maintainflow_organizations organization
          on organization.id = membership.organization_id
        where membership.organization_id = request.organization_id
          and membership.clerk_user_id = ${options.operatorId}
          and organization.status = 'active'
      )
      ${organizationFilter}
  `;

  const rows = await sql<ChangeApprovalRequestRow[]>`
    select
      request.*,
      organization.name as organization_name
    from maintainflow_change_approval_requests request
    join maintainflow_organizations organization
      on organization.id = request.organization_id
    join maintainflow_organization_memberships membership
      on membership.organization_id = request.organization_id
    where membership.clerk_user_id = ${options.operatorId}
      and organization.status = 'active'
      ${organizationFilter}
      ${cursorFilter}
    order by
      case request.status when 'awaiting_approval' then 0 else 1 end,
      request.requested_at desc,
      request.id
    limit ${pageSize + 1}
  `;
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const requests = pageRows.map(parseChangeApprovalRequest);
  const last = requests.at(-1);
  return {
    requests,
    nextCursor:
      hasMore && last
        ? encodeChangeApprovalRequestCursor({
            version: 1,
            statusBucket: statusBucket(last.status),
            requestedAt: last.requestedAt.toISOString(),
            id: last.id,
          })
        : null,
  };
}

function assertLiveExecutionLifecycle(options: {
  request: ChangeApprovalRequest;
  access: AccountAccess;
  expectedVersion: number;
  currentApproverMembershipRole: MembershipRole | null;
  currentApproverAdmitted: boolean;
  now: Date;
}) {
  const { request, access } = options;
  if (
    request.source !== "live" ||
    access.organizationType !== "agency" ||
    request.organizationId !== access.organizationId ||
    request.accountId !== access.accountId
  ) {
    throw new ChangeApprovalRequestForbiddenError(
      "This approval request does not belong to the current live agency account.",
    );
  }
  if (!canWriteAccount(access)) {
    throw new ChangeApprovalRequestForbiddenError(
      "Current owner or admin write access is required to execute this approved packet.",
    );
  }
  if (request.version !== options.expectedVersion) {
    throw new ChangeApprovalRequestTransitionError(
      "This approval request changed. Refresh before executing it.",
    );
  }
  if (request.status !== "approved") {
    throw new ChangeApprovalRequestTransitionError(
      "Only an approved live request can be executed.",
    );
  }
  if (request.retiredAt !== null) {
    throw new ChangeApprovalRequestTransitionError(
      "This approved request was retired. Create and approve a fresh packet before executing it.",
    );
  }
  if (request.decisionContext.schemaVersion !== 2) {
    throw new ChangeApprovalRequestTransitionError(
      "This approved request uses an incompatible review packet. Create and approve a fresh packet before executing it.",
    );
  }
  if (request.expiresAt <= options.now) {
    throw new ChangeApprovalRequestTransitionError(
      "This approved request expired. Create and approve a fresh packet before executing it.",
    );
  }
  if (request.adsApprovalRecordId !== null) {
    throw new ChangeApprovalRequestTransitionError(
      "This approved request has already been consumed by a live operation.",
    );
  }
  if (
    !request.decisionOperatorId ||
    request.decisionOperatorId === request.requesterOperatorId ||
    (request.decisionMembershipRole !== "owner" &&
      request.decisionMembershipRole !== "admin") ||
    !options.currentApproverAdmitted ||
    (options.currentApproverMembershipRole !== "owner" &&
      options.currentApproverMembershipRole !== "admin")
  ) {
    throw new ChangeApprovalRequestTransitionError(
      "The recorded approver is no longer an admitted, eligible owner or admin. Request a fresh decision.",
    );
  }
}

/**
 * Read-only preparation for a live execution. The account selector comes from
 * the immutable request's internal advertiser UUID, never from the caller.
 * Every authorization is re-checked again under locks by the link helper.
 */
export async function resolveLiveChangeApprovalExecution(options: {
  requestId: string;
  expectedVersion: number;
  operatorId: string;
  now?: Date;
}) {
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError();
  }
  const sql = getDatabase();
  const [row] = await sql<LiveExecutionResolutionRow[]>`
    select
      approval_request.*,
      organization.name as organization_name,
      organization.customer_type as current_organization_type,
      account.external_account_id as current_account_id,
      account.name as current_account_name,
      account.connection_mode as current_connection_mode,
      executor.role as current_membership_role,
      account_access.role as current_account_role,
      approver.role as current_approver_membership_role
    from maintainflow_change_approval_requests approval_request
    join maintainflow_organizations organization
      on organization.id = approval_request.organization_id
    join maintainflow_advertiser_accounts account
      on account.id = approval_request.advertiser_account_id
    join maintainflow_account_access account_access
      on account_access.organization_id = approval_request.organization_id
      and account_access.advertiser_account_id = account.id
    join maintainflow_organization_memberships executor
      on executor.organization_id = approval_request.organization_id
      and executor.clerk_user_id = ${options.operatorId}
    left join maintainflow_organization_memberships approver
      on approver.organization_id = approval_request.organization_id
      and approver.clerk_user_id = approval_request.decision_operator_id
    where approval_request.id = ${options.requestId}
      and organization.customer_type = 'agency'
      and organization.status = 'active'
      and account.status = 'active'
  `;
  if (!row) throw new ChangeApprovalRequestForbiddenError();

  const request = parseChangeApprovalRequest(row);
  const access = parseLiveExecutionAccess(row);
  assertLiveExecutionLifecycle({
    request,
    access,
    expectedVersion: options.expectedVersion,
    currentApproverMembershipRole: row.current_approver_membership_role,
    currentApproverAdmitted: request.decisionOperatorId
      ? isWorkspaceAdmissionAllowed(request.decisionOperatorId)
      : false,
    now: options.now ?? new Date(),
  });
  return { request, access };
}

export async function linkLiveChangeApprovalExecution(options: {
  transaction: postgres.TransactionSql;
  requestId: string;
  expectedVersion: number;
  operatorId: string;
  access: AccountAccess;
  recommendation: Recommendation;
  approvalRecordId: string;
  now?: Date;
}) {
  if (options.access.organizationType !== "agency") {
    throw new ChangeApprovalRequestForbiddenError(
      "This approval request does not belong to a live agency workspace.",
    );
  }
  const now = options.now ?? new Date();
  const authorized = await lockCurrentAccountWriteAccess({
    transaction: options.transaction,
    operatorId: options.operatorId,
    accountId: options.access.accountId,
    access: options.access,
    forbiddenMessage:
      "Agency account access changed before this approved packet could execute. Refresh before trying again.",
  });
  if (
    authorized.access.organizationType !== "agency" ||
    !isDeepStrictEqual(authorized.access, options.access)
  ) {
    throw new ChangeApprovalRequestForbiddenError(
      "Agency account access changed before this approved packet could execute. Refresh before trying again.",
    );
  }

  const [row] = await options.transaction<ChangeApprovalRequestRow[]>`
    select
      approval_request.*,
      organization.name as organization_name
    from maintainflow_change_approval_requests approval_request
    join maintainflow_organizations organization
      on organization.id = approval_request.organization_id
    where approval_request.id = ${options.requestId}
      and approval_request.organization_id = ${authorized.access.organizationId}
      and approval_request.advertiser_account_id = ${authorized.advertiserAccountId}
      and approval_request.source = 'live'
      and organization.customer_type = 'agency'
      and organization.status = 'active'
    for update of approval_request
  `;
  if (!row) throw new ChangeApprovalRequestForbiddenError();
  const request = parseChangeApprovalRequest(row);

  const [approver] = await options.transaction<
    { membership_role: MembershipRole }[]
  >`
    select role as membership_role
    from maintainflow_organization_memberships
    where organization_id = ${request.organizationId}
      and clerk_user_id = ${request.decisionOperatorId}
    for update
  `;
  assertLiveExecutionLifecycle({
    request,
    access: authorized.access,
    expectedVersion: options.expectedVersion,
    currentApproverMembershipRole: approver?.membership_role ?? null,
    currentApproverAdmitted: request.decisionOperatorId
      ? isWorkspaceAdmissionAllowed(request.decisionOperatorId)
      : false,
    now,
  });
  assertLivePacketMatchesRecommendation({
    request,
    access: authorized.access,
    recommendation: options.recommendation,
  });

  const approvalFingerprint = recommendationApprovalFingerprint(
    options.recommendation,
  );
  const [approval] = await options.transaction<LinkedApprovalRecordRow[]>`
    select
      id, account_id, operator_id, acting_organization_id,
      actor_membership_role, actor_account_role, recommendation_id,
      recommendation_title, entity_id, recommendation_approval_fingerprint,
      request_payload, rollback_payload, evidence_payload, safeguard,
      monitoring_plan, monitoring_window_days, apply_provider_attempt_id,
      apply_provider_attempted_at, response_payload, error_message,
      applied_at, status
    from ads_approval_records
    where id = ${options.approvalRecordId}
    for update
  `;
  const approvalMatches =
    approval?.account_id === authorized.access.accountId &&
    approval.operator_id === options.operatorId &&
    approval.acting_organization_id === authorized.access.organizationId &&
    approval.actor_membership_role === authorized.access.membershipRole &&
    approval.actor_account_role === authorized.access.accountRole &&
    approval.recommendation_id === options.recommendation.id &&
    approval.recommendation_title === options.recommendation.title &&
    approval.entity_id === options.recommendation.entityId &&
    approval.recommendation_approval_fingerprint === approvalFingerprint &&
    isDeepStrictEqual(approval.request_payload, options.recommendation.mutation) &&
    isDeepStrictEqual(approval.rollback_payload, options.recommendation.rollback) &&
    isDeepStrictEqual(approval.evidence_payload, options.recommendation.evidence) &&
    approval.safeguard === options.recommendation.safeguard &&
    isDeepStrictEqual(
      approval.monitoring_plan,
      options.recommendation.monitoringPlan ?? null,
    ) &&
    approval.monitoring_window_days ===
      (options.recommendation.monitoringPlan?.windowDays ?? null) &&
    approval.apply_provider_attempt_id === approval.id &&
    approval.apply_provider_attempted_at === null &&
    approval.response_payload === null &&
    approval.error_message === null &&
    approval.applied_at === null &&
    approval.status === "pending";
  if (!approvalMatches) {
    throw new ChangeApprovalRequestInvalidError(
      "The durable live operation does not exactly match the approved packet.",
    );
  }

  const [linked] = await options.transaction<
    { id: string; version: number; ads_approval_record_id: string }[]
  >`
    update maintainflow_change_approval_requests set
      ads_approval_record_id = ${options.approvalRecordId},
      version = version + 1,
      updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
    where id = ${options.requestId}
      and organization_id = ${authorized.access.organizationId}
      and advertiser_account_id = ${authorized.advertiserAccountId}
      and source = 'live'
      and status = 'approved'
      and version = ${options.expectedVersion}
      and expires_at > pg_catalog.statement_timestamp()
      and retired_at is null
      and decision_context ->> 'schemaVersion' = '2'
      and ads_approval_record_id is null
    returning id, version, ads_approval_record_id
  `;
  if (!linked) {
    const [current] = await options.transaction<
      {
        expired: boolean;
        retired_at: Date | null;
        incompatible_decision_context: boolean;
      }[]
    >`
      select
        expires_at <= pg_catalog.statement_timestamp() as expired,
        retired_at,
        decision_context ->> 'schemaVersion' is distinct from '2'
          as incompatible_decision_context
      from maintainflow_change_approval_requests
      where id = ${options.requestId}
        and organization_id = ${authorized.access.organizationId}
        and advertiser_account_id = ${authorized.advertiserAccountId}
      for update
    `;
    if (current?.expired) {
      throw new ChangeApprovalRequestTransitionError(
        "This approved request expired before it could be consumed. Create and approve a fresh packet.",
      );
    }
    if (current?.retired_at) {
      throw new ChangeApprovalRequestTransitionError(
        "This approved request was retired before it could be consumed. Create and approve a fresh packet.",
      );
    }
    if (current?.incompatible_decision_context) {
      throw new ChangeApprovalRequestTransitionError(
        "This approved request uses an incompatible review packet. Create and approve a fresh packet before executing it.",
      );
    }
    throw new ChangeApprovalRequestTransitionError(
      "This approved request changed before it could be consumed. Refresh before trying again.",
    );
  }
  return {
    id: linked.id,
    version: Number(linked.version),
    adsApprovalRecordId: linked.ads_approval_record_id,
  };
}

async function lockVisibleRequest(
  transaction: postgres.TransactionSql,
  options: { requestId: string; operatorId: string },
) {
  const [scope] = await transaction<{ organization_id: string }[]>`
    select organization_id
    from maintainflow_change_approval_requests
    where id = ${options.requestId}
  `;
  if (!scope) throw new ChangeApprovalRequestForbiddenError();

  const membership = await lockAgencyMembership(transaction, {
    organizationId: scope.organization_id,
    operatorId: options.operatorId,
  });
  const [request] = await transaction<ChangeApprovalRequestRow[]>`
    select
      approval_request.*,
      organization.name as organization_name
    from maintainflow_change_approval_requests approval_request
    join maintainflow_organizations organization
      on organization.id = approval_request.organization_id
    where approval_request.id = ${options.requestId}
      and approval_request.organization_id = ${scope.organization_id}
    for update of approval_request
  `;
  if (!request) throw new ChangeApprovalRequestForbiddenError();
  return {
    ...request,
    current_membership_role: membership.membership_role,
  } satisfies LockedChangeApprovalRequestRow;
}

export async function decideChangeApprovalRequest(options: {
  requestId: string;
  operator: Operator;
  action: ChangeApprovalDecisionAction;
  note?: string;
  expectedVersion: number;
  now?: Date;
}) {
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError();
  }
  const note = options.note?.trim() || null;
  if (options.action === "approve" && note && note.length < 5) {
    throw new ChangeApprovalRequestInvalidError(
      "Leave the approval note empty or enter at least 5 characters.",
    );
  }
  if (options.action === "request_changes" && (!note || note.length < 10)) {
    throw new ChangeApprovalRequestInvalidError(
      "Explain the requested changes in at least 10 characters.",
    );
  }
  const now = options.now ?? new Date();
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const request = await lockVisibleRequest(transaction, {
      requestId: options.requestId,
      operatorId: options.operator.id,
    });
    await requireApprovalNotificationStoreWhenEnabled(
      request.organization_id,
      transaction,
    );
    if (Number(request.version) !== options.expectedVersion) {
      throw new ChangeApprovalRequestTransitionError(
        "This approval request changed. Refresh before recording a decision.",
      );
    }
    if (request.status !== "awaiting_approval") {
      throw new ChangeApprovalRequestTransitionError(
        "This approval request is no longer awaiting a decision.",
      );
    }
    const incompatibleLiveDecisionContext =
      request.source === "live" &&
      (typeof request.decision_context !== "object" ||
        request.decision_context === null ||
        !("schemaVersion" in request.decision_context) ||
        request.decision_context.schemaVersion !== 2);
    if (request.expires_at <= now || incompatibleLiveDecisionContext) {
      const [expired] = await transaction<{ id: string; version: number }[]>`
        update maintainflow_change_approval_requests set
          status = 'expired',
          version = version + 1,
          updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
        where id = ${options.requestId}
          and status = 'awaiting_approval'
          and version = ${options.expectedVersion}
          and (
            expires_at <= ${now}
            or (
              source = 'live'
              and decision_context ->> 'schemaVersion' is distinct from '2'
            )
          )
        returning id, version
      `;
      if (!expired) {
        throw new ChangeApprovalRequestTransitionError(
          "This approval request changed. Refresh before recording a decision.",
        );
      }
      return {
        id: expired.id,
        status: "expired" as const,
        version: Number(expired.version),
      };
    }
    if (
      request.current_membership_role !== "owner" &&
      request.current_membership_role !== "admin"
    ) {
      throw new ChangeApprovalRequestForbiddenError(
        "Only an agency owner or admin can record this decision.",
      );
    }
    if (request.requester_operator_id === options.operator.id) {
      throw new ChangeApprovalRequestForbiddenError(
        "The requester cannot approve or request changes on their own packet.",
      );
    }

    const status = options.action === "approve"
      ? "approved"
      : "changes_requested";
    const rows = await transaction<{ id: string; version: number }[]>`
      update maintainflow_change_approval_requests set
        status = ${status},
        decision_operator_id = ${options.operator.id},
        decision_name_snapshot = ${options.operator.name.slice(0, 120)},
        decision_membership_role = ${request.current_membership_role},
        decision_note = ${note},
        decided_at = ${now},
        version = version + 1,
        updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
      where id = ${options.requestId}
        and status = 'awaiting_approval'
        and version = ${options.expectedVersion}
        and expires_at > pg_catalog.statement_timestamp()
        and (
          source <> 'live'
          or decision_context ->> 'schemaVersion' = '2'
        )
      returning id, version
    `;
    if (!rows[0]) {
      const [expired] = await transaction<{ id: string; version: number }[]>`
        update maintainflow_change_approval_requests set
          status = 'expired',
          version = version + 1,
          updated_at = greatest(updated_at, pg_catalog.statement_timestamp())
        where id = ${options.requestId}
          and status = 'awaiting_approval'
          and version = ${options.expectedVersion}
          and (
            expires_at <= pg_catalog.statement_timestamp()
            or (
              source = 'live'
              and decision_context ->> 'schemaVersion' is distinct from '2'
            )
          )
        returning id, version
      `;
      if (expired) {
        return {
          id: expired.id,
          status: "expired" as const,
          version: Number(expired.version),
        };
      }
      throw new ChangeApprovalRequestTransitionError(
        "Another operator recorded a decision first. Refresh to see the current outcome.",
      );
    }
    const version = Number(rows[0].version);
    const notificationDeliveryIds =
      await enqueueApprovalNotificationDeliveriesInTransaction(transaction, {
        approvalRequestId: rows[0].id,
        organizationId: request.organization_id,
        eventType:
          status === "approved"
            ? "approval_approved"
            : "approval_changes_requested",
        approvalRequestVersion: version,
      });
    return {
      id: rows[0].id,
      status,
      version,
      notificationDeliveryIds,
    };
  });
  if (result.status === "expired") {
    throw new ChangeApprovalRequestTransitionError(
      "This approval request expired. Ask the requester to create a fresh review packet.",
    );
  }
  return result;
}

export async function cancelChangeApprovalRequest(options: {
  requestId: string;
  operator: Operator;
  expectedVersion: number;
  now?: Date;
}) {
  if (!(await verifyChangeApprovalRequestStore())) {
    throw new ChangeApprovalRequestStoreUnavailableError();
  }
  const now = options.now ?? new Date();
  const sql = getDatabase();
  const result = await sql.begin(async (transaction) => {
    const request = await lockVisibleRequest(transaction, {
      requestId: options.requestId,
      operatorId: options.operator.id,
    });
    await requireApprovalNotificationStoreWhenEnabled(
      request.organization_id,
      transaction,
    );
    if (Number(request.version) !== options.expectedVersion) {
      throw new ChangeApprovalRequestTransitionError(
        "This approval request changed. Refresh before cancelling it.",
      );
    }
    if (request.status !== "awaiting_approval") {
      throw new ChangeApprovalRequestTransitionError(
        "Only an awaiting approval request can be cancelled.",
      );
    }
    if (request.expires_at <= now) {
      const [expired] = await transaction<{ id: string; version: number }[]>`
        update maintainflow_change_approval_requests set
          status = 'expired',
          version = version + 1,
          updated_at = ${now}
        where id = ${options.requestId}
          and status = 'awaiting_approval'
          and version = ${options.expectedVersion}
        returning id, version
      `;
      if (!expired) {
        throw new ChangeApprovalRequestTransitionError(
          "This approval request changed. Refresh before cancelling it.",
        );
      }
      return {
        id: expired.id,
        status: "expired" as const,
        version: Number(expired.version),
      };
    }
    const ownsRequest = request.requester_operator_id === options.operator.id;
    const canManage =
      request.current_membership_role === "owner" ||
      request.current_membership_role === "admin";
    if (!ownsRequest && !canManage) {
      throw new ChangeApprovalRequestForbiddenError(
        "Only the requester or an agency owner or admin can cancel this packet.",
      );
    }
    const rows = await transaction<{ id: string; version: number }[]>`
      update maintainflow_change_approval_requests set
        status = 'cancelled',
        decision_operator_id = ${options.operator.id},
        decision_name_snapshot = ${options.operator.name.slice(0, 120)},
        decision_membership_role = ${request.current_membership_role},
        decision_note = 'Cancelled before a decision was recorded.',
        decided_at = ${now},
        version = version + 1,
        updated_at = ${now}
      where id = ${options.requestId}
        and status = 'awaiting_approval'
        and version = ${options.expectedVersion}
      returning id, version
    `;
    if (!rows[0]) {
      throw new ChangeApprovalRequestTransitionError(
        "The approval request changed before it could be cancelled. Refresh and try again.",
      );
    }
    const version = Number(rows[0].version);
    const notificationDeliveryIds =
      await enqueueApprovalNotificationDeliveriesInTransaction(transaction, {
        approvalRequestId: rows[0].id,
        organizationId: request.organization_id,
        eventType: "approval_cancelled",
        approvalRequestVersion: version,
      });
    return {
      id: rows[0].id,
      status: "cancelled" as const,
      version,
      notificationDeliveryIds,
    };
  });
  if (result.status === "expired") {
    throw new ChangeApprovalRequestTransitionError(
      "This approval request expired and cannot be cancelled. Create a fresh review packet instead.",
    );
  }
  return result;
}
