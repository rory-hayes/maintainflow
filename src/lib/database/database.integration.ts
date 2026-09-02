import { randomUUID } from "node:crypto";

import postgres from "postgres";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));

import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
} from "./client.server";
import {
  applyCustomerOffboarding,
  prepareCustomerOffboarding,
} from "../../../scripts/customer-offboarding.mjs";
import {
  applyProviderRevocationConfirmation,
  applyRetentionPurge,
  prepareProviderRevocationConfirmation,
  prepareRetentionPurge,
} from "../../../scripts/customer-lifecycle.mjs";

import {
  APPROVAL_OPERATION_LEASE_MS,
  ApprovalProviderSendFenceUnavailableError,
  ApprovalTransitionError,
  MONITORING_ACCOUNT_ATTEMPT_LEASE_MS,
  claimApprovalRollback,
  claimDueMonitoringAccounts,
  claimDueMonitoringRecords,
  completeMonitoringAccountAttempt,
  countUnresolvedApprovalOperations,
  createApprovalRecord,
  getApprovalAccountId,
  listActiveApprovalRecords,
  listApprovalRecords,
  listDueMonitoringAccountIds,
  listDueMonitoringRecords,
  reconcileApprovalRecord,
  recordMonitoringOutcome,
  recoverStaleApprovalOperations,
  releaseMonitoringClaim,
  markApprovalProviderAttempt,
  updateApprovalRecord,
  updateRollbackRecord,
  verifyApprovalStore,
  withApprovalProviderSendFence,
} from "../audit/approval-store.server";
import {
  RecommendationDecisionTransitionError,
  dismissRecommendation,
  listActiveRecommendationDismissals,
  listRecommendationDecisionHistory,
  restoreRecommendation,
  verifyRecommendationDecisionStore,
} from "../audit/recommendation-decision-store.server";
import { applyRecommendationDismissals } from "../audit/recommendation-decision";
import {
  encryptAdsApiKey,
  encryptConversionsApiCredential,
} from "../credentials/crypto.server";
import {
  listCreativeReviewEvents,
  recordCreativeReviewSnapshot,
  verifyCreativeHistoryStore,
} from "../openai-ads/creative-history.server";
import {
  getConversionsApiConnectionStatus,
  validateConversionsApiPayload,
} from "../openai-ads/conversions.server";
import {
  demoAccount,
  demoAds,
  demoCampaignPerformance,
  demoCampaigns,
  getDemoRecommendation,
} from "../openai-ads/demo-data";
import { MONITORING_ATTRIBUTION_MATURITY_MS } from "../openai-ads/monitoring";
import {
  claimLiveSyncRefresh,
  completeLiveSyncRefresh,
  failLiveSyncRefresh,
  pruneExpiredLiveSyncSnapshots,
  readLiveSyncState,
  verifyLiveSyncStore,
} from "../openai-ads/live-sync-store.server";
import { listLivePortfolioAccounts } from "../openai-ads/live-portfolio.server";
import {
  consumeReadinessAuditQuota,
  pruneExpiredReadinessRateLimitBuckets,
  verifyReadinessRateLimitStore,
} from "../readiness/rate-limit.server";
import {
  listReadinessAuditRuns,
  ReadinessHistoryTransitionError,
  recordReadinessAuditRun,
  verifyReadinessHistoryStore,
} from "../readiness/history.server";
import type { ReadinessAudit } from "../readiness/schema";
import type { AccountAccess } from "../tenancy/schema";
import {
  AccountAccessForbiddenError,
  AdvertiserAccountAttachConflictError,
  AdvertiserCredentialChangedError,
  AdvertiserCredentialUnavailableError,
  AdvertiserWriteBlockedError,
  attachAdvertiserAccountToAgency,
  bootstrapWorkspace,
  getAccountAccess,
  getAdsApiKeyForAccount,
  getAdsCredentialMaterialForAccount,
  getConversionsApiCredentialForAccount,
  listAccountAccesses,
  lockCurrentAccountWriteAccess,
  requireAgencyAccountAttachAuthorization,
  requireAccountAccess,
  rotateAdsApiCredential,
  rotateConversionsApiCredential,
  verifyConversionCredentialStore,
  verifyCredentialStore,
  verifyAdvertiserAccountAttachStore,
  verifyTenancyStore,
  withAuthorizedAdsWriteFence,
} from "../tenancy/store.server";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the database integration suite.");
}
const runtimeDriverDatabaseUrl =
  process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL ?? databaseUrl;

const database = postgres(databaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 3,
  prepare: false,
});
const ownerOperatorId = "user_integration_owner";
const viewerOperatorId = "user_integration_viewer";
const mixedAccessOperatorId = "user_integration_mixed_access";
const unknownOperatorId = "user_integration_unknown";
const advertiserAccountId = "adacct_integration_alpha";
const agencyAccountId = "adacct_integration_beta";
const initialAdvertiserKey = "ads-integration-alpha-initial";
const replacementAdvertiserKey = "ads-integration-alpha-replacement";
const agencyKey = "ads-integration-beta-initial";
let advertiserAccess: AccountAccess;
let agencyAccess: AccountAccess;

async function addReviewOnlyAccess(accountId: string) {
  const organizationId = randomUUID();
  const [account] = await database<{ id: string }[]>`
    select id from maintainflow_advertiser_accounts
    where external_account_id = ${accountId}
  `;
  if (!account) throw new Error("The integration account was not created.");
  await database.begin(async (transaction) => {
    await transaction`
      insert into maintainflow_organizations (id, name, customer_type)
      values (${organizationId}, 'Review Partners', 'agency')
    `;
    await transaction`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values (${organizationId}, ${viewerOperatorId}, 'analyst')
    `;
    await transaction`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      ) values (
        ${organizationId}, ${account.id}, 'viewer', ${ownerOperatorId}
      )
    `;
  });
}

async function addMixedCapabilityAccess(accountId: string) {
  const blockedOrganizationId = randomUUID();
  const writableOrganizationId = randomUUID();
  const [account] = await database<{ id: string }[]>`
    select id from maintainflow_advertiser_accounts
    where external_account_id = ${accountId}
  `;
  if (!account) throw new Error("The integration account was not created.");

  await database.begin(async (transaction) => {
    await transaction`
      insert into maintainflow_organizations (id, name, customer_type)
      values
        (${blockedOrganizationId}, 'Owner Role Reviewers', 'agency'),
        (${writableOrganizationId}, 'Client Account Operators', 'agency')
    `;
    await transaction`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values
        (${blockedOrganizationId}, ${mixedAccessOperatorId}, 'analyst'),
        (${writableOrganizationId}, ${mixedAccessOperatorId}, 'admin')
    `;
    await transaction`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      ) values
        (${blockedOrganizationId}, ${account.id}, 'owner', ${ownerOperatorId}),
        (${writableOrganizationId}, ${account.id}, 'manager', ${ownerOperatorId})
    `;
  });
}

async function createMonitoringFairnessFixture(options: {
  prefix: string;
  now: Date;
  dueRows: readonly number[];
}) {
  const accountIds: string[] = [];
  for (const [accountIndex, dueRows] of options.dueRows.entries()) {
    const advertiserAccountId = randomUUID();
    const accountId = `adacct_${options.prefix}_${accountIndex + 1}`;
    accountIds.push(accountId);
    await database`
      insert into maintainflow_advertiser_accounts (
        id, external_account_id, name, connection_mode, status
      ) values (
        ${advertiserAccountId}, ${accountId},
        ${`Fairness fixture ${accountIndex + 1}`}, 'environment', 'active'
      )
    `;
    for (let rowIndex = 0; rowIndex < dueRows; rowIndex += 1) {
      const endsAt = new Date(
        options.now.getTime()
          - 4 * 24 * 60 * 60 * 1_000
          + accountIndex * 60 * 60 * 1_000
          + rowIndex * 60 * 1_000,
      );
      const startedAt = new Date(endsAt.getTime() - 7 * 24 * 60 * 60 * 1_000);
      await database`
        insert into ads_approval_records (
          id, account_id, operator_id, recommendation_id,
          recommendation_title, entity_id, request_payload,
          rollback_payload, evidence_payload, safeguard, status,
          monitoring_plan, monitoring_window_days, monitoring_started_at,
          monitoring_ends_at, applied_at
        ) values (
          ${randomUUID()}, ${accountId}, 'monitoring_fairness_fixture',
          ${`rec_${options.prefix}_${accountIndex + 1}_${rowIndex + 1}`},
          'Fair monitoring scheduler',
          ${`adgroup_${options.prefix}_${accountIndex + 1}_${rowIndex + 1}`},
          ${database.json({ operation: "update" })},
          ${database.json({ operation: "update" })},
          ${database.json({ source: "integration_fixture" })},
          'Human approval required', 'applied',
          ${database.json({
            kind: "click_attributed_conversion_guardrail",
            windowDays: 7,
            baseline: {
              rangeStart: Math.floor(startedAt.getTime() / 1_000),
              rangeEnd: Math.floor(endsAt.getTime() / 1_000),
              spend: 2_000,
              clickAttributedConversions: 100,
              cpa: 20,
              configuredBidMicros: 25_000_000,
              currencyCode: "EUR",
            },
            rollbackRule: {
              metric: "click_attributed_conversions",
              comparison: "decrease_percent_greater_than",
              thresholdPercent: 15,
            },
          })},
          7, ${startedAt}, ${endsAt}, ${startedAt}
        )
      `;
    }
  }
  return accountIds;
}

async function removeMonitoringFairnessFixture(accountIds: readonly string[]) {
  await database`
    delete from ads_approval_records
    where account_id = any(${accountIds}::text[])
  `;
  await database`
    delete from maintainflow_advertiser_accounts
    where external_account_id = any(${accountIds}::text[])
  `;
}

describe("PostgreSQL customer and approval boundary", () => {
  beforeAll(async () => {
    advertiserAccess = await bootstrapWorkspace({
      operatorId: ownerOperatorId,
      organizationName: "Alpine Retail",
      organizationType: "advertiser",
      accountId: advertiserAccountId,
      accountName: "Alpine Home",
      connection: {
        mode: "vault",
        credential: encryptAdsApiKey({
          apiKey: initialAdvertiserKey,
          externalAccountId: advertiserAccountId,
        }),
        verifiedAt: new Date("2026-08-30T08:00:00.000Z"),
      },
    });
    agencyAccess = await bootstrapWorkspace({
      operatorId: ownerOperatorId,
      organizationName: "Beacon Agency",
      organizationType: "agency",
      accountId: agencyAccountId,
      accountName: "Beacon Client",
      connection: {
        mode: "vault",
        credential: encryptAdsApiKey({
          apiKey: agencyKey,
          externalAccountId: agencyAccountId,
        }),
        verifiedAt: new Date("2026-08-30T08:05:00.000Z"),
      },
    });
    await addReviewOnlyAccess(advertiserAccountId);
    await addMixedCapabilityAccess(advertiserAccountId);
  }, 20_000);

  afterAll(async () => {
    await closeRuntimeDatabase();
    await database.end({ timeout: 5 });
  });

  it("applies every migration and enforces multi-account roles", async () => {
    await expect(verifyApprovalStore()).resolves.toBe(true);
    await expect(verifyTenancyStore()).resolves.toBe(true);
    await expect(verifyCredentialStore()).resolves.toBe(true);
    await expect(verifyConversionCredentialStore()).resolves.toBe(true);
    await expect(verifyReadinessRateLimitStore()).resolves.toBe(true);
    await expect(verifyRecommendationDecisionStore()).resolves.toBe(true);
    await expect(verifyReadinessHistoryStore()).resolves.toBe(true);
    await expect(verifyLiveSyncStore()).resolves.toBe(true);

    const expectedRlsTables = [
      "ads_approval_records",
      "maintainflow_account_access",
      "maintainflow_advertiser_accounts",
      "maintainflow_advertiser_credentials",
      "maintainflow_conversion_credentials",
      "maintainflow_creative_review_events",
      "maintainflow_creative_review_state",
      "maintainflow_customer_lifecycle_records",
      "maintainflow_live_workbench_snapshots",
      "maintainflow_monitoring_account_schedule",
      "maintainflow_organization_memberships",
      "maintainflow_organizations",
      "maintainflow_rate_limit_buckets",
      "maintainflow_readiness_audit_runs",
      "maintainflow_recommendation_dismissals",
      "maintainflow_schema_migrations",
    ];
    const rlsTables = await database<
      { table_name: string; rls_enabled: boolean }[]
    >`
      select c.relname as table_name, c.relrowsecurity as rls_enabled
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname = any(${expectedRlsTables}::text[])
      order by c.relname
    `;
    expect(rlsTables).toEqual(
      expectedRlsTables.map((tableName) => ({
        table_name: tableName,
        rls_enabled: true,
      })),
    );

    const hardeningIndexes = await database<
      {
        index_name: string;
        table_name: string;
        column_name: string;
        predicate: string | null;
        is_valid: boolean;
        is_ready: boolean;
        is_unique: boolean;
      }[]
    >`
      select
        index_relation.relname as index_name,
        table_relation.relname as table_name,
        pg_get_indexdef(indexes.indexrelid, 1, true) as column_name,
        pg_get_expr(indexes.indpred, indexes.indrelid) as predicate,
        indexes.indisvalid as is_valid,
        indexes.indisready as is_ready,
        indexes.indisunique as is_unique
      from pg_catalog.pg_index indexes
      join pg_catalog.pg_class index_relation
        on index_relation.oid = indexes.indexrelid
      join pg_catalog.pg_class table_relation
        on table_relation.oid = indexes.indrelid
      join pg_catalog.pg_namespace namespace
        on namespace.oid = table_relation.relnamespace
      where namespace.nspname = 'public'
        and index_relation.relname = any(${[
          "maintainflow_advertiser_accounts_owner_organization_idx",
          "ads_approval_records_rollback_organization_idx",
          "ads_approval_records_reconciled_organization_idx",
        ]}::text[])
      order by index_relation.relname
    `;
    expect(hardeningIndexes).toEqual([
      {
        index_name: "ads_approval_records_reconciled_organization_idx",
        table_name: "ads_approval_records",
        column_name: "reconciled_organization_id",
        predicate: "(reconciled_organization_id IS NOT NULL)",
        is_valid: true,
        is_ready: true,
        is_unique: false,
      },
      {
        index_name: "ads_approval_records_rollback_organization_idx",
        table_name: "ads_approval_records",
        column_name: "rollback_organization_id",
        predicate: "(rollback_organization_id IS NOT NULL)",
        is_valid: true,
        is_ready: true,
        is_unique: false,
      },
      {
        index_name:
          "maintainflow_advertiser_accounts_owner_organization_idx",
        table_name: "maintainflow_advertiser_accounts",
        column_name: "owner_organization_id",
        predicate: "(owner_organization_id IS NOT NULL)",
        is_valid: true,
        is_ready: true,
        is_unique: false,
      },
    ]);

    const publicTablePrivileges = await database<
      { table_name: string; privilege_type: string }[]
    >`
      select c.relname as table_name, acl.privilege_type
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(
        coalesce(c.relacl, acldefault('r', c.relowner))
      ) acl
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
        and c.relname = any(${expectedRlsTables}::text[])
        and acl.grantee = 0
      order by c.relname, acl.privilege_type
    `;
    expect(publicTablePrivileges).toEqual([]);

    const publicSchemaPrivileges = await database<
      { privilege_type: string }[]
    >`
      select acl.privilege_type
      from pg_catalog.pg_namespace namespace
      cross join lateral aclexplode(
        coalesce(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) acl
      where namespace.nspname = 'public'
        and acl.grantee = 0
      order by acl.privilege_type
    `;
    expect(publicSchemaPrivileges).toEqual([]);

    const dataApiRolePrivileges = await database<
      { role_name: string; object_type: string; object_name: string }[]
    >`
      with data_api_roles as (
        select rolname
        from pg_catalog.pg_roles
        where rolname = any(${[
          "anon",
          "authenticated",
          "service_role",
        ]}::text[])
      )
      select roles.rolname as role_name, 'schema' as object_type,
        'public' as object_name
      from data_api_roles roles
      where has_schema_privilege(roles.rolname, 'public', 'USAGE')
        or has_schema_privilege(roles.rolname, 'public', 'CREATE')
      union all
      select roles.rolname, 'table', relation.relname
      from data_api_roles roles
      cross join pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and (
          has_table_privilege(roles.rolname, relation.oid, 'SELECT')
          or has_table_privilege(roles.rolname, relation.oid, 'INSERT')
          or has_table_privilege(roles.rolname, relation.oid, 'UPDATE')
          or has_table_privilege(roles.rolname, relation.oid, 'DELETE')
          or has_table_privilege(roles.rolname, relation.oid, 'TRUNCATE')
          or has_table_privilege(roles.rolname, relation.oid, 'REFERENCES')
          or has_table_privilege(roles.rolname, relation.oid, 'TRIGGER')
        )
      union all
      select roles.rolname, 'sequence', relation.relname
      from data_api_roles roles
      cross join pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace
        on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'S'
        and (
          has_sequence_privilege(roles.rolname, relation.oid, 'USAGE')
          or has_sequence_privilege(roles.rolname, relation.oid, 'SELECT')
          or has_sequence_privilege(roles.rolname, relation.oid, 'UPDATE')
        )
      union all
      select roles.rolname, 'function', procedure.proname
      from data_api_roles roles
      cross join pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace
        on namespace.oid = procedure.pronamespace
      where namespace.nspname = 'public'
        and has_function_privilege(roles.rolname, procedure.oid, 'EXECUTE')
      order by role_name, object_type, object_name
    `;
    expect(dataApiRolePrivileges).toEqual([]);

    const publicDefaultPrivileges = await database<
      { object_type: string; privilege_type: string }[]
    >`
      select defaults.defaclobjtype as object_type, acl.privilege_type
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_namespace n
        on n.oid = defaults.defaclnamespace
      cross join lateral aclexplode(defaults.defaclacl) acl
      where defaults.defaclrole = (
          select oid
          from pg_catalog.pg_roles
          where rolname = current_user
        )
        and n.nspname = 'public'
        and defaults.defaclobjtype in ('r', 'S', 'f')
        and acl.grantee = 0
      order by defaults.defaclobjtype, acl.privilege_type
    `;
    expect(publicDefaultPrivileges).toEqual([]);

    const dataApiDefaultPrivileges = await database<
      {
        owner_role: string;
        grantee_role: string;
        object_type: string;
        privilege_type: string;
      }[]
    >`
      select
        owner.rolname as owner_role,
        grantee.rolname as grantee_role,
        defaults.defaclobjtype as object_type,
        acl.privilege_type
      from pg_catalog.pg_default_acl defaults
      join pg_catalog.pg_roles owner on owner.oid = defaults.defaclrole
      join pg_catalog.pg_namespace namespace
        on namespace.oid = defaults.defaclnamespace
      cross join lateral aclexplode(defaults.defaclacl) acl
      join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
      where namespace.nspname = 'public'
        and defaults.defaclobjtype in ('r', 'S', 'f')
        and grantee.rolname = any(${[
          "anon",
          "authenticated",
          "service_role",
        ]}::text[])
      order by owner_role, grantee_role, object_type, privilege_type
    `;
    expect(dataApiDefaultPrivileges).toEqual([]);

    const runtimeDatabase = getRuntimeDatabase(databaseUrl);
    const [
      [runtimeSettings],
      [statementTimeout],
      [lockTimeout],
      [idleInTransactionTimeout],
    ] =
      await Promise.all([
        runtimeDatabase<{ search_path: string }[]>`show search_path`,
        runtimeDatabase<{ statement_timeout: string }[]>`show statement_timeout`,
        runtimeDatabase<{ lock_timeout: string }[]>`show lock_timeout`,
        runtimeDatabase<{
          idle_in_transaction_session_timeout: string;
        }[]>`show idle_in_transaction_session_timeout`,
      ]);
    expect(runtimeSettings?.search_path).toBe("public");
    expect(statementTimeout?.statement_timeout).toBe("20s");
    expect(lockTimeout?.lock_timeout).toBe("18s");
    expect(
      idleInTransactionTimeout?.idle_in_transaction_session_timeout,
    ).toBe("30s");

    let cancellationCode: unknown;
    try {
      await runtimeDatabase.begin(async (transaction) => {
        await transaction`set local statement_timeout = '50ms'`;
        await transaction`select pg_sleep(0.2)`;
      });
    } catch (error) {
      cancellationCode = (error as { code?: unknown }).code;
    }
    expect(cancellationCode).toBe("57014");
    const [postCancellationProbe] = await runtimeDatabase<
      { ready: boolean }[]
    >`select true as ready`;
    expect(postCancellationProbe?.ready).toBe(true);

    expect(advertiserAccess).toMatchObject({
      organizationType: "advertiser",
      accountId: advertiserAccountId,
      connectionMode: "vault",
      membershipRole: "owner",
      accountRole: "owner",
    });
    expect(agencyAccess).toMatchObject({
      organizationType: "agency",
      accountId: agencyAccountId,
      connectionMode: "vault",
      membershipRole: "owner",
      accountRole: "manager",
    });

    const accounts = await listAccountAccesses(ownerOperatorId);
    expect(accounts.map((account) => account.accountId)).toEqual([
      advertiserAccountId,
      agencyAccountId,
    ]);
    await expect(
      requireAccountAccess(viewerOperatorId, advertiserAccountId, "read"),
    ).resolves.toMatchObject({
      membershipRole: "analyst",
      accountRole: "viewer",
    });
    await expect(
      requireAccountAccess(viewerOperatorId, advertiserAccountId, "write"),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      requireAccountAccess(
        mixedAccessOperatorId,
        advertiserAccountId,
        "write",
      ),
    ).resolves.toMatchObject({
      membershipRole: "admin",
      accountRole: "manager",
    });
    await expect(
      requireAccountAccess(unknownOperatorId, advertiserAccountId, "read"),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      getAccountAccess(unknownOperatorId, advertiserAccountId),
    ).resolves.toBeNull();

    await expect(
      bootstrapWorkspace({
        operatorId: unknownOperatorId,
        organizationName: "Duplicate Claim",
        organizationType: "advertiser",
        accountId: advertiserAccountId,
        accountName: "Alpine Home",
        connection: { mode: "environment" },
      }),
    ).rejects.toThrow("already claimed");
  });

  it("serializes Supavisor-safe queries and preserves transaction isolation", async () => {
    const dispatched: string[] = [];
    let markFirstDispatched: (() => void) | undefined;
    const firstDispatched = new Promise<void>((resolve) => {
      markFirstDispatched = resolve;
    });
    let releaseTransactionBarrier: (() => void) | undefined;
    let barrierTimeout: ReturnType<typeof setTimeout> | undefined;
    const serialDatabase = postgres(runtimeDriverDatabaseUrl, {
      connect_timeout: 5,
      idle_timeout: 5,
      max: 1,
      max_pipeline: 0,
      prepare: false,
      debug: (_connection, query) => {
        dispatched.push(query);
        if (query.includes("'first'")) markFirstDispatched?.();
      },
    });
    const transactionDatabase = postgres(runtimeDriverDatabaseUrl, {
      connect_timeout: 5,
      idle_timeout: 5,
      max: 2,
      max_pipeline: 0,
      prepare: false,
    });

    try {
      const first = serialDatabase.unsafe(
        "select pg_sleep(0.15), 'first'::text as marker",
      ).execute();
      const second = serialDatabase.unsafe(
        "select 'second'::text as marker",
      ).execute();

      let dispatchTimeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        firstDispatched,
        new Promise<never>((_resolve, reject) => {
          dispatchTimeout = setTimeout(
            () => reject(new Error("The first serial query was not dispatched.")),
            2_000,
          );
        }),
      ]).finally(() => {
        if (dispatchTimeout !== undefined) clearTimeout(dispatchTimeout);
      });
      expect(dispatched.some((query) => query.includes("'first'"))).toBe(true);
      expect(dispatched.some((query) => query.includes("'second'"))).toBe(false);
      await Promise.all([first, second]);
      expect(dispatched.some((query) => query.includes("'second'"))).toBe(true);

      const blocker = serialDatabase`select pg_sleep(0.05)`.execute();
      const transactionAfterBusyConnection = serialDatabase.begin(
        async (transaction) => {
          const [row] = await transaction<{ ready: boolean }[]>`
            select true as ready
          `;
          return row?.ready;
        },
      );
      const [blockerResult, transactionResult] = await Promise.all([
        blocker,
        transactionAfterBusyConnection,
      ]);
      expect(blockerResult).toHaveLength(1);
      expect(transactionResult).toBe(true);

      let barrierArrivals = 0;
      const transactionBarrier = new Promise<void>((resolve, reject) => {
        releaseTransactionBarrier = resolve;
        barrierTimeout = setTimeout(
          () =>
            reject(
              new Error("Concurrent transaction barrier was not reached."),
            ),
          2_000,
        );
      });
      function waitForBothTransactions() {
        barrierArrivals += 1;
        if (barrierArrivals === 2) {
          if (barrierTimeout !== undefined) clearTimeout(barrierTimeout);
          releaseTransactionBarrier?.();
        }
        return transactionBarrier;
      }

      const runTransaction = (marker: string) =>
        transactionDatabase.begin(async (transaction) => {
          const [identity] = await transaction<{
            pid: number;
            marker: string;
          }[]>`
            select pg_backend_pid() as pid,
              set_config('maintainflow.transaction_marker', ${marker}, true)
                as marker
          `;
          await waitForBothTransactions();
          await transaction`select pg_sleep(0.05)`;
          const readings = await Promise.all([
            transaction<{ pid: number; marker: string }[]>`
              select pg_backend_pid() as pid,
                current_setting('maintainflow.transaction_marker') as marker
            `,
            transaction<{ pid: number; marker: string }[]>`
              select pg_backend_pid() as pid,
                current_setting('maintainflow.transaction_marker') as marker
            `,
          ]);
          return { identity, readings: readings.flat() };
        });

      const [alpha, beta] = await Promise.all([
        runTransaction("alpha"),
        runTransaction("beta"),
      ]);
      expect(alpha.identity?.marker).toBe("alpha");
      expect(beta.identity?.marker).toBe("beta");
      expect(alpha.identity?.pid).not.toBe(beta.identity?.pid);
      expect(alpha.readings).toEqual([
        { pid: alpha.identity?.pid, marker: "alpha" },
        { pid: alpha.identity?.pid, marker: "alpha" },
      ]);
      expect(beta.readings).toEqual([
        { pid: beta.identity?.pid, marker: "beta" },
        { pid: beta.identity?.pid, marker: "beta" },
      ]);
    } finally {
      if (barrierTimeout !== undefined) clearTimeout(barrierTimeout);
      releaseTransactionBarrier?.();
      await Promise.all([
        serialDatabase.end({ timeout: 5 }),
        transactionDatabase.end({ timeout: 5 }),
      ]);
    }
  });

  it("attaches an agency client idempotently without rotating its credential", async () => {
    const accountId = "adacct_integration_agency_additional";
    const initialKey = "ads-integration-agency-additional-initial";
    const retryKey = "ads-integration-agency-additional-retry";

    await expect(verifyAdvertiserAccountAttachStore()).resolves.toBe(true);
    await expect(
      requireAgencyAccountAttachAuthorization(
        ownerOperatorId,
        agencyAccess.organizationId,
      ),
    ).resolves.toMatchObject({
      organizationId: agencyAccess.organizationId,
      membershipRole: "owner",
    });

    const firstCredential = encryptAdsApiKey({
      apiKey: initialKey,
      externalAccountId: accountId,
    });
    const first = await attachAdvertiserAccountToAgency({
      operatorId: ownerOperatorId,
      organizationId: agencyAccess.organizationId,
      accountId,
      accountName: "Beacon Additional Client",
      credential: firstCredential,
      verifiedAt: new Date("2026-08-30T08:10:00.000Z"),
    });
    expect(first).toMatchObject({
      created: true,
      credentialUpdated: true,
      access: {
        organizationId: agencyAccess.organizationId,
        organizationType: "agency",
        accountId,
        connectionMode: "vault",
        accountRole: "manager",
      },
    });
    await expect(getAdsApiKeyForAccount(accountId)).resolves.toBe(initialKey);

    const retry = await attachAdvertiserAccountToAgency({
      operatorId: ownerOperatorId,
      organizationId: agencyAccess.organizationId,
      accountId,
      accountName: "Provider Rename Must Not Mutate Stored Account",
      credential: encryptAdsApiKey({
        apiKey: retryKey,
        externalAccountId: accountId,
      }),
      verifiedAt: new Date("2026-08-30T08:11:00.000Z"),
    });
    expect(retry).toMatchObject({
      created: false,
      credentialUpdated: false,
      access: {
        accountId,
        accountName: "Beacon Additional Client",
      },
    });
    await expect(getAdsApiKeyForAccount(accountId)).resolves.toBe(initialKey);

    const [stored] = await database<
      {
        advertiser_account_id: string;
        status: string;
        credential_count: number;
        credential_id: string;
      }[]
    >`
      select account.id as advertiser_account_id, account.status,
        count(credential.id)::int as credential_count,
        min(credential.id::text) as credential_id
      from maintainflow_advertiser_accounts account
      join maintainflow_advertiser_credentials credential
        on credential.advertiser_account_id = account.id
      where account.external_account_id = ${accountId}
      group by account.id, account.status
    `;
    expect(stored).toMatchObject({
      status: "active",
      credential_count: 1,
      credential_id: firstCredential.id,
    });

    const retryAttachment = () =>
      attachAdvertiserAccountToAgency({
        operatorId: ownerOperatorId,
        organizationId: agencyAccess.organizationId,
        accountId,
        accountName: "Retry Must Preserve Existing State",
        credential: encryptAdsApiKey({
          apiKey: retryKey,
          externalAccountId: accountId,
        }),
        verifiedAt: new Date("2026-08-30T08:11:30.000Z"),
      });

    await database`
      update maintainflow_account_access set
        role = 'viewer', updated_at = now()
      where organization_id = ${agencyAccess.organizationId}
        and advertiser_account_id = ${stored!.advertiser_account_id}
    `;
    await expect(retryAttachment()).rejects.toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );
    await database`
      update maintainflow_account_access set
        role = 'manager', updated_at = now()
      where organization_id = ${agencyAccess.organizationId}
        and advertiser_account_id = ${stored!.advertiser_account_id}
    `;

    await database`
      update maintainflow_advertiser_accounts set
        connection_mode = 'environment', updated_at = now()
      where id = ${stored!.advertiser_account_id}
    `;
    await expect(retryAttachment()).rejects.toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );
    await database`
      update maintainflow_advertiser_accounts set
        connection_mode = 'vault', updated_at = now()
      where id = ${stored!.advertiser_account_id}
    `;

    await database`
      update maintainflow_advertiser_credentials set
        status = 'revoked', revoked_at = now(), updated_at = now()
      where id = ${firstCredential.id}
    `;
    await expect(retryAttachment()).rejects.toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );
    await database`
      update maintainflow_advertiser_credentials set
        status = 'active', revoked_at = null, updated_at = now()
      where id = ${firstCredential.id}
    `;

    await database`
      update maintainflow_advertiser_accounts set
        owner_organization_id = ${advertiserAccess.organizationId},
        updated_at = now()
      where id = ${stored!.advertiser_account_id}
    `;
    await expect(retryAttachment()).rejects.toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );
    await database`
      update maintainflow_advertiser_accounts set
        owner_organization_id = null, updated_at = now()
      where id = ${stored!.advertiser_account_id}
    `;

    await database`
      update maintainflow_advertiser_accounts set
        status = 'disconnected', updated_at = now()
      where id = ${stored!.advertiser_account_id}
    `;
    await expect(retryAttachment()).rejects.toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );
    await database`
      update maintainflow_advertiser_accounts set
        status = 'active', updated_at = now()
      where id = ${stored!.advertiser_account_id}
    `;
    await database`
      insert into maintainflow_customer_lifecycle_records (
        id, advertiser_account_id, external_account_id,
        acting_organization_id, operator_id, action,
        state_fingerprint, export_sha256, inventory_counts
      ) values (
        ${randomUUID()}, ${stored!.advertiser_account_id}, ${accountId},
        ${agencyAccess.organizationId}, ${ownerOperatorId}, 'offboarded',
        ${"a".repeat(64)}, ${"b".repeat(64)}, ${database.json({})}
      )
    `;
    await expect(retryAttachment()).rejects.toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );
  });

  it("reauthorizes the active agency owner or admin inside the attach transaction", async () => {
    const accountId = "adacct_integration_stale_agency_authority";
    await expect(
      requireAgencyAccountAttachAuthorization(
        ownerOperatorId,
        advertiserAccess.organizationId,
      ),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      requireAgencyAccountAttachAuthorization(
        ownerOperatorId,
        agencyAccess.organizationId,
      ),
    ).resolves.toBeDefined();

    await database`
      update maintainflow_organization_memberships set
        role = 'analyst', updated_at = now()
      where organization_id = ${agencyAccess.organizationId}
        and clerk_user_id = ${ownerOperatorId}
    `;
    try {
      await expect(
        attachAdvertiserAccountToAgency({
          operatorId: ownerOperatorId,
          organizationId: agencyAccess.organizationId,
          accountId,
          accountName: "Stale Agency Authority",
          credential: encryptAdsApiKey({
            apiKey: "ads-integration-stale-agency-authority",
            externalAccountId: accountId,
          }),
          verifiedAt: new Date("2026-08-30T08:13:00.000Z"),
        }),
      ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    } finally {
      await database`
        update maintainflow_organization_memberships set
          role = 'owner', updated_at = now()
        where organization_id = ${agencyAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
    }
    const rows = await database`
      select id from maintainflow_advertiser_accounts
      where external_account_id = ${accountId}
    `;
    expect(rows).toEqual([]);
  });

  it("serializes concurrent agency claims for one external advertiser account", async () => {
    const competingAgency = await bootstrapWorkspace({
      operatorId: ownerOperatorId,
      organizationName: "Competing Integration Agency",
      organizationType: "agency",
      accountId: "adacct_integration_competing_agency_seed",
      accountName: "Competing Agency Seed Client",
      connection: {
        mode: "vault",
        credential: encryptAdsApiKey({
          apiKey: "ads-integration-competing-agency-seed",
          externalAccountId: "adacct_integration_competing_agency_seed",
        }),
        verifiedAt: new Date("2026-08-30T08:14:00.000Z"),
      },
    });
    const accountId = "adacct_integration_concurrent_agency_claim";
    const attempts = await Promise.allSettled(
      [agencyAccess.organizationId, competingAgency.organizationId].map(
        (organizationId, index) =>
          attachAdvertiserAccountToAgency({
            operatorId: ownerOperatorId,
            organizationId,
            accountId,
            accountName: "Concurrent Agency Client",
            credential: encryptAdsApiKey({
              apiKey: `ads-integration-concurrent-agency-${index}`,
              externalAccountId: accountId,
            }),
            verifiedAt: new Date("2026-08-30T08:15:00.000Z"),
          }),
      ),
    );
    const fulfilled = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof attachAdvertiserAccountToAgency>>> =>
        attempt.status === "fulfilled",
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.created).toBe(true);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(
      AdvertiserAccountAttachConflictError,
    );

    const [stored] = await database<
      { access_count: number; credential_count: number }[]
    >`
      select count(distinct account_access.organization_id)::int as access_count,
        count(distinct credential.id)::int as credential_count
      from maintainflow_advertiser_accounts account
      join maintainflow_account_access account_access
        on account_access.advertiser_account_id = account.id
      join maintainflow_advertiser_credentials credential
        on credential.advertiser_account_id = account.id
      where account.external_account_id = ${accountId}
    `;
    expect(stored).toEqual({ access_count: 1, credential_count: 1 });
  });

  it("keeps recommendation dismissals account scoped, auditable, and reversible", async () => {
    const recommendation = getDemoRecommendation("rec_bid_20");
    if (!recommendation) {
      throw new Error("The recommendation dismissal fixture is missing.");
    }
    const reason = "Keep the current bid until the seasonal test completes.";

    const duplicateAttempts = await Promise.all([
      dismissRecommendation({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: advertiserAccess,
        recommendation,
        reason,
      }),
      dismissRecommendation({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: advertiserAccess,
        recommendation,
        reason,
      }),
    ]);
    expect(duplicateAttempts.filter((result) => result.created)).toHaveLength(1);
    expect(duplicateAttempts.filter((result) => !result.created)).toHaveLength(1);

    const dismissals = await listActiveRecommendationDismissals(
      advertiserAccountId,
    );
    expect(dismissals).toEqual([
      expect.objectContaining({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        organizationId: advertiserAccess.organizationId,
        membershipRole: "owner",
        accountRole: "owner",
        recommendationId: recommendation.id,
        entityId: recommendation.entityId,
        reason,
      }),
    ]);
    await expect(
      listActiveRecommendationDismissals(agencyAccountId),
    ).resolves.toEqual([]);
    await expect(
      listRecommendationDecisionHistory(agencyAccountId),
    ).resolves.toEqual([]);
    const historyBeforeRestore = await listRecommendationDecisionHistory(
      advertiserAccountId,
    );
    expect(historyBeforeRestore).toEqual([
      expect.objectContaining({
        id: dismissals[0].id,
        organizationName: "Alpine Retail",
        restoredBy: null,
        restoredAt: null,
      }),
    ]);
    expect(
      applyRecommendationDismissals([recommendation], dismissals)[0],
    ).toMatchObject({ status: "dismissed", dismissal: { reason } });
    await expect(
      createApprovalRecord({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: advertiserAccess,
        recommendation,
      }),
    ).rejects.toThrow("actively dismissed");

    const [stored] = await database<
      {
        recommendation_payload: unknown;
        reason: string;
        actor_membership_role: string;
        actor_account_role: string;
      }[]
    >`
      select recommendation_payload, reason,
        actor_membership_role, actor_account_role
      from maintainflow_recommendation_dismissals
      where id = ${dismissals[0].id}
    `;
    expect(stored).toEqual({
      recommendation_payload: recommendation,
      reason,
      actor_membership_role: "owner",
      actor_account_role: "owner",
    });

    const viewerAccess = await requireAccountAccess(
      viewerOperatorId,
      advertiserAccountId,
      "read",
    );
    await expect(
      restoreRecommendation({
        accountId: advertiserAccountId,
        operatorId: viewerOperatorId,
        access: viewerAccess,
        recommendation,
      }),
    ).rejects.toBeInstanceOf(RecommendationDecisionTransitionError);

    await expect(
      restoreRecommendation({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: advertiserAccess,
        recommendation,
      }),
    ).resolves.toEqual({ id: dismissals[0].id });
    await expect(
      listActiveRecommendationDismissals(advertiserAccountId),
    ).resolves.toEqual([]);
    await expect(
      listRecommendationDecisionHistory(advertiserAccountId),
    ).resolves.toEqual([
      expect.objectContaining({
        id: dismissals[0].id,
        organizationName: "Alpine Retail",
        restoredBy: ownerOperatorId,
        restoredOrganizationName: "Alpine Retail",
        restoredMembershipRole: "owner",
        restoredAccountRole: "owner",
        restoredAt: expect.any(Date),
      }),
    ]);
    await expect(
      listRecommendationDecisionHistory(advertiserAccountId, 101),
    ).rejects.toBeInstanceOf(RecommendationDecisionTransitionError);

    const [restored] = await database<
      {
        restored_by: string;
        restored_organization_id: string;
        restored_membership_role: string;
        restored_account_role: string;
        restored_at: Date;
      }[]
    >`
      select restored_by, restored_organization_id,
        restored_membership_role, restored_account_role, restored_at
      from maintainflow_recommendation_dismissals
      where id = ${dismissals[0].id}
    `;
    expect(restored).toMatchObject({
      restored_by: ownerOperatorId,
      restored_organization_id: advertiserAccess.organizationId,
      restored_membership_role: "owner",
      restored_account_role: "owner",
      restored_at: expect.any(Date),
    });
  });

  it("enforces shared readiness quotas atomically without storing raw subjects", async () => {
    const now = new Date("2026-08-30T12:15:00.000Z");
    const sameClient = await Promise.all(
      Array.from({ length: 10 }, () =>
        consumeReadinessAuditQuota({
          clientIp: "203.0.113.20",
          hostname: "shop-rate-limit.example",
          now,
        }),
      ),
    );
    expect(sameClient.filter((decision) => decision.allowed)).toHaveLength(6);
    expect(sameClient.filter((decision) => !decision.allowed)).toHaveLength(4);
    expect(sameClient.at(-1)).toMatchObject({ limit: 6 });

    await expect(
      consumeReadinessAuditQuota({
        clientIp: "203.0.113.21",
        hostname: "shop-rate-limit.example",
        now,
      }),
    ).resolves.toMatchObject({ allowed: true, remaining: 5 });
    await expect(
      consumeReadinessAuditQuota({
        clientIp: "203.0.113.20",
        hostname: "shop-rate-limit.example",
        now: new Date("2026-08-30T13:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ allowed: true, remaining: 5 });

    const hostCap = await Promise.all(
      Array.from({ length: 31 }, (_, index) =>
        consumeReadinessAuditQuota({
          clientIp: `198.51.100.${index + 1}`,
          hostname: "shared-target.example",
          now,
        }),
      ),
    );
    expect(hostCap.filter((decision) => decision.allowed)).toHaveLength(30);
    expect(hostCap.filter((decision) => !decision.allowed)).toHaveLength(1);

    const buckets = await database<
      { subject_hash: string; window_started_at: Date }[]
    >`
      select subject_hash, window_started_at
      from maintainflow_rate_limit_buckets
    `;
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets.every((bucket) => bucket.subject_hash.length === 64)).toBe(
      true,
    );
    expect(JSON.stringify(buckets)).not.toContain("203.0.113.20");
    expect(JSON.stringify(buckets)).not.toContain("shop-rate-limit.example");

    await database`
      update maintainflow_rate_limit_buckets
      set window_started_at = ${new Date("2026-08-20T00:00:00.000Z")}
      where (scope, subject_hash) = (
        select scope, subject_hash
        from maintainflow_rate_limit_buckets
        limit 1
      )
    `;
    await expect(
      pruneExpiredReadinessRateLimitBuckets(now, 1),
    ).resolves.toBe(1);
  });

  it("retains sanitized readiness evidence with account and actor provenance", async () => {
    function readinessAudit(options: {
      url: string;
      score: number;
      scannedAt: string;
    }): ReadinessAudit {
      return {
        requestedUrl: options.url,
        finalUrl: options.url,
        scannedAt: options.scannedAt,
        score: options.score,
        verdict: options.score >= 90 ? "ready" : "needs_work",
        checks: [
          {
            id: "oai_searchbot",
            title: "OAI-SearchBot is allowed",
            status: "pass",
            weight: 15,
            evidence: "No blocking rule applies.",
            recommendation: "Keep public crawler access available.",
          },
        ],
        measurement: {
          status: "not_detected",
          sdkDetected: false,
          initializationDetected: false,
          pixelIdDetected: false,
          imageTagDetected: false,
          consentSignalDetected: false,
          eventNames: [],
          csp: { present: false, compatible: false, missingSources: [] },
          checks: [],
        },
        limitations: ["Static evidence only; no runtime events were fired."],
      };
    }

    const baseline = readinessAudit({
      url: "https://shop.example/products/bench",
      score: 72,
      scannedAt: "2026-08-29T15:00:00.000Z",
    });
    const improved = readinessAudit({
      url: baseline.finalUrl,
      score: 94,
      scannedAt: "2026-08-30T15:00:00.000Z",
    });
    const agencyAudit = readinessAudit({
      url: "https://agency-client.example/products/lamp",
      score: 81,
      scannedAt: "2026-08-30T15:05:00.000Z",
    });

    await expect(
      recordReadinessAuditRun({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: agencyAccess,
        audit: baseline,
      }),
    ).rejects.toBeInstanceOf(ReadinessHistoryTransitionError);

    const first = await recordReadinessAuditRun({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      access: advertiserAccess,
      audit: baseline,
    });
    const second = await recordReadinessAuditRun({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      access: advertiserAccess,
      audit: improved,
    });
    await recordReadinessAuditRun({
      accountId: agencyAccountId,
      operatorId: ownerOperatorId,
      access: agencyAccess,
      audit: agencyAudit,
    });

    await expect(listReadinessAuditRuns({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      access: advertiserAccess,
    })).resolves.toEqual([
      expect.objectContaining({ id: second.id, audit: improved }),
      expect.objectContaining({ id: first.id, audit: baseline }),
    ]);
    await expect(listReadinessAuditRuns({
      accountId: agencyAccountId,
      operatorId: ownerOperatorId,
      access: agencyAccess,
    })).resolves.toEqual([
      expect.objectContaining({ accountId: agencyAccountId, audit: agencyAudit }),
    ]);
    await expect(
      listReadinessAuditRuns({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: advertiserAccess,
        limit: 51,
      }),
    ).rejects.toBeInstanceOf(ReadinessHistoryTransitionError);

    const viewerAccess = await requireAccountAccess(
      viewerOperatorId,
      advertiserAccountId,
      "read",
    );
    await expect(
      recordReadinessAuditRun({
        accountId: advertiserAccountId,
        operatorId: viewerOperatorId,
        access: viewerAccess,
        audit: improved,
      }),
    ).rejects.toBeInstanceOf(ReadinessHistoryTransitionError);

    const rows = await database<
      {
        account_id: string;
        operator_id: string;
        acting_organization_id: string;
        actor_membership_role: string;
        actor_account_role: string;
        audit_payload: unknown;
      }[]
    >`
      select account.external_account_id as account_id,
        run.operator_id, run.acting_organization_id,
        run.actor_membership_role, run.actor_account_role,
        run.audit_payload
      from maintainflow_readiness_audit_runs run
      join maintainflow_advertiser_accounts account
        on account.id = run.advertiser_account_id
      where run.id = ${second.id}
    `;
    expect(rows).toEqual([
      {
        account_id: advertiserAccountId,
        operator_id: ownerOperatorId,
        acting_organization_id: advertiserAccess.organizationId,
        actor_membership_role: "owner",
        actor_account_role: "owner",
        audit_payload: improved,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("apiKey");
    expect(JSON.stringify(rows)).not.toContain("cookie");
    expect(JSON.stringify(rows)).not.toContain("<html");
  });

  it("stores ciphertext and rotates credentials atomically", async () => {
    const initialMaterial = await getAdsCredentialMaterialForAccount(
      advertiserAccountId,
    );
    await expect(
      getAdsApiKeyForAccount(advertiserAccountId),
    ).resolves.toBe(initialAdvertiserKey);
    const [initialRow] = await database<
      { id: string; ciphertext: Buffer; credential_version: number; status: string }[]
    >`
      select credential.id, credential.ciphertext,
        credential.credential_version, credential.status
      from maintainflow_advertiser_credentials credential
      join maintainflow_advertiser_accounts account
        on account.id = credential.advertiser_account_id
      where account.external_account_id = ${advertiserAccountId}
    `;
    expect(initialRow).toMatchObject({ credential_version: 1, status: "active" });
    expect(initialMaterial).toEqual({
      apiKey: initialAdvertiserKey,
      credentialGeneration: `vault:${initialRow!.id}:1`,
    });
    expect(initialRow?.ciphertext.toString("utf8")).not.toContain(
      initialAdvertiserKey,
    );

    const replacement = encryptAdsApiKey({
      apiKey: replacementAdvertiserKey,
      externalAccountId: advertiserAccountId,
    });
    const viewerAccess = await requireAccountAccess(
      viewerOperatorId,
      advertiserAccountId,
      "read",
    );
    const forgedViewerAccess: AccountAccess = {
      ...viewerAccess,
      membershipRole: "owner",
      accountRole: "owner",
    };
    await expect(
      rotateAdsApiCredential({
        operatorId: viewerOperatorId,
        accountId: advertiserAccountId,
        access: forgedViewerAccess,
        credential: encryptAdsApiKey({
          apiKey: replacementAdvertiserKey,
          externalAccountId: advertiserAccountId,
        }),
        verifiedAt: new Date("2026-08-30T08:50:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      getAdsApiKeyForAccount(advertiserAccountId),
    ).resolves.toBe(initialAdvertiserKey);

    await database`
      update maintainflow_organization_memberships set
        role = 'analyst', updated_at = now()
      where organization_id = ${advertiserAccess.organizationId}
        and clerk_user_id = ${ownerOperatorId}
    `;
    try {
      await expect(
        rotateAdsApiCredential({
          operatorId: ownerOperatorId,
          accountId: advertiserAccountId,
          access: advertiserAccess,
          credential: encryptAdsApiKey({
            apiKey: replacementAdvertiserKey,
            externalAccountId: advertiserAccountId,
          }),
          verifiedAt: new Date("2026-08-30T08:55:00.000Z"),
        }),
      ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
      await expect(
        getAdsApiKeyForAccount(advertiserAccountId),
      ).resolves.toBe(initialAdvertiserKey);
    } finally {
      await database`
        update maintainflow_organization_memberships set
          role = 'owner', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
    }

    await expect(
      rotateAdsApiCredential({
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: advertiserAccess,
        credential: { ...replacement, id: initialRow!.id },
        verifiedAt: new Date("2026-08-30T09:00:00.000Z"),
      }),
    ).rejects.toThrow();
    await expect(
      getAdsApiKeyForAccount(advertiserAccountId),
    ).resolves.toBe(initialAdvertiserKey);

    await expect(
      rotateAdsApiCredential({
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: advertiserAccess,
        credential: replacement,
        verifiedAt: new Date("2026-08-30T09:05:00.000Z"),
      }),
    ).resolves.toMatchObject({ credentialVersion: 2 });
    await expect(
      getAdsApiKeyForAccount(advertiserAccountId),
    ).resolves.toBe(replacementAdvertiserKey);
    const replacementMaterial = await getAdsCredentialMaterialForAccount(
      advertiserAccountId,
    );
    expect(replacementMaterial).toEqual({
      apiKey: replacementAdvertiserKey,
      credentialGeneration: `vault:${replacement.id}:2`,
    });
    expect(replacementMaterial.credentialGeneration).not.toBe(
      initialMaterial.credentialGeneration,
    );
    const fenced = await withAuthorizedAdsWriteFence(
      {
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        access: advertiserAccess,
        expectedCredentialGeneration:
          replacementMaterial.credentialGeneration,
        requireClearProviderOperationLedger: false,
      },
      async ({ access, credentialMaterial }) => ({
        access,
        credentialGeneration: credentialMaterial.credentialGeneration,
      }),
    );
    expect(fenced.value).toMatchObject({
      access: { accountId: advertiserAccountId, membershipRole: "owner" },
      credentialGeneration: replacementMaterial.credentialGeneration,
    });
    await expect(
      withAuthorizedAdsWriteFence(
        {
          accountId: advertiserAccountId,
          operatorId: ownerOperatorId,
          access: advertiserAccess,
          expectedCredentialGeneration: initialMaterial.credentialGeneration,
          requireClearProviderOperationLedger: false,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(AdvertiserCredentialChangedError);

    const unresolvedSource = getDemoRecommendation("rec_bid_20");
    if (!unresolvedSource) {
      throw new Error("The provider-operation interlock fixture is missing.");
    }
    const unresolvedApprovalId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: {
        ...unresolvedSource,
        id: "rec_provider_operation_interlock",
        title: "Provider operation interlock",
        entityId: `${unresolvedSource.entityId}_operation_interlock`,
      },
      access: advertiserAccess,
    });
    await updateApprovalRecord(
      unresolvedApprovalId,
      "reconciliation_required",
      { error: "The provider outcome is intentionally unresolved for this test." },
    );
    await expect(
      countUnresolvedApprovalOperations({ accountId: advertiserAccountId }),
    ).resolves.toBe(1);
    await expect(
      withAuthorizedAdsWriteFence(
        {
          accountId: advertiserAccountId,
          operatorId: ownerOperatorId,
          access: advertiserAccess,
          expectedCredentialGeneration:
            replacementMaterial.credentialGeneration,
          requireClearProviderOperationLedger: true,
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(AdvertiserWriteBlockedError);
    await reconcileApprovalRecord({
      id: unresolvedApprovalId,
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      action: "mark_not_applied",
      note: "Ads Manager confirmed that the provider change was not applied.",
      access: advertiserAccess,
    });
    await expect(
      withAuthorizedAdsWriteFence(
        {
          accountId: advertiserAccountId,
          operatorId: ownerOperatorId,
          access: advertiserAccess,
          expectedCredentialGeneration:
            replacementMaterial.credentialGeneration,
          requireClearProviderOperationLedger: true,
        },
        async () => "write-ledger-clear",
      ),
    ).resolves.toMatchObject({ value: "write-ledger-clear" });
    await expect(
      countUnresolvedApprovalOperations({ accountId: advertiserAccountId }),
    ).resolves.toBe(0);
    await database`
      delete from ads_approval_records
      where id = ${unresolvedApprovalId}
    `;

    const versions = await database<
      {
        credential_version: number;
        status: string;
        revoked: boolean;
      }[]
    >`
      select credential.credential_version, credential.status,
        credential.revoked_at is not null as revoked
      from maintainflow_advertiser_credentials credential
      join maintainflow_advertiser_accounts account
        on account.id = credential.advertiser_account_id
      where account.external_account_id = ${advertiserAccountId}
      order by credential.credential_version
    `;
    expect(versions).toEqual([
      { credential_version: 1, status: "revoked", revoked: true },
      { credential_version: 2, status: "active", revoked: false },
    ]);
  });

  it("locks the advertiser account before actor authorization rows", async () => {
    let markAccountLockHeld!: () => void;
    let startActorLocks!: () => void;
    let markActorLocksHeld!: () => void;
    let releaseHolder!: () => void;
    const accountLockHeld = new Promise<void>((resolve) => {
      markAccountLockHeld = resolve;
    });
    const actorLockStart = new Promise<void>((resolve) => {
      startActorLocks = resolve;
    });
    const actorLocksHeld = new Promise<void>((resolve) => {
      markActorLocksHeld = resolve;
    });
    const holderRelease = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = database.begin(async (transaction) => {
      await transaction`set local lock_timeout = '2s'`;
      const [account] = await transaction<{ id: string }[]>`
        select id
        from maintainflow_advertiser_accounts
        where external_account_id = ${advertiserAccountId}
        for update
      `;
      if (!account) throw new Error("The lock-order account is missing.");
      markAccountLockHeld();
      await actorLockStart;
      await transaction`
        select organization.id
        from maintainflow_organizations organization
        join maintainflow_organization_memberships membership
          on membership.organization_id = organization.id
        join maintainflow_account_access account_access
          on account_access.organization_id = organization.id
        where organization.id = ${advertiserAccess.organizationId}
          and membership.clerk_user_id = ${ownerOperatorId}
          and account_access.advertiser_account_id = ${account.id}
        for update of organization, membership, account_access
      `;
      markActorLocksHeld();
      await holderRelease;
    });
    await accountLockHeld;

    const authorization = database.begin(async (transaction) => {
      await transaction`set local lock_timeout = '2s'`;
      return lockCurrentAccountWriteAccess({
        transaction,
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: advertiserAccess,
        forbiddenMessage: "The lock-order authorization failed.",
      });
    });

    try {
      await expect(
        Promise.race([
          authorization.then(
            () => "settled" as const,
            () => "settled" as const,
          ),
          new Promise<"blocked">((resolve) =>
            setTimeout(() => resolve("blocked"), 100),
          ),
        ]),
      ).resolves.toBe("blocked");

      startActorLocks();
      await expect(
        Promise.race([
          actorLocksHeld.then(() => "locked" as const),
          new Promise<"timed_out">((resolve) =>
            setTimeout(() => resolve("timed_out"), 2_500),
          ),
        ]),
      ).resolves.toBe("locked");
    } finally {
      startActorLocks();
      releaseHolder();
    }

    await expect(holder).resolves.toBeUndefined();
    await expect(authorization).resolves.toMatchObject({
      advertiserAccountId: expect.any(String),
      access: {
        accountId: advertiserAccountId,
        organizationId: advertiserAccess.organizationId,
      },
    });
  });

  it("waits for an in-flight role change and reauthorizes before credential rotation", async () => {
    const materialBefore = await getAdsCredentialMaterialForAccount(
      advertiserAccountId,
    );
    let releaseDowngrade!: () => void;
    let markDowngradeStarted!: () => void;
    const downgradeRelease = new Promise<void>((resolve) => {
      releaseDowngrade = resolve;
    });
    const downgradeStarted = new Promise<void>((resolve) => {
      markDowngradeStarted = resolve;
    });
    const downgrade = database.begin(async (transaction) => {
      await transaction`
        update maintainflow_organization_memberships set
          role = 'analyst', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
      markDowngradeStarted();
      await downgradeRelease;
    });
    await downgradeStarted;

    const rotation = rotateAdsApiCredential({
      operatorId: ownerOperatorId,
      accountId: advertiserAccountId,
      access: advertiserAccess,
      credential: encryptAdsApiKey({
        apiKey: "must-not-become-active",
        externalAccountId: advertiserAccountId,
      }),
      verifiedAt: new Date("2026-08-30T09:06:00.000Z"),
    });
    let earlyOutcome: "blocked" | "settled" = "blocked";
    try {
      earlyOutcome = await Promise.race([
        rotation.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 100),
        ),
      ]);
    } finally {
      releaseDowngrade();
      await downgrade;
    }

    try {
      expect(earlyOutcome).toBe("blocked");
      await expect(rotation).rejects.toBeInstanceOf(
        AccountAccessForbiddenError,
      );
      await expect(
        getAdsCredentialMaterialForAccount(advertiserAccountId),
      ).resolves.toEqual(materialBefore);
    } finally {
      await database`
        update maintainflow_organization_memberships set
          role = 'owner', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
    }
  });

  it("single-flights and generation-scopes durable live workbench snapshots", async () => {
    const credential = await getAdsCredentialMaterialForAccount(
      advertiserAccountId,
    );
    const now = new Date("2026-08-30T12:00:00.000Z");
    const claims = await Promise.all([
      claimLiveSyncRefresh({
        accountId: advertiserAccountId,
        credentialGeneration: credential.credentialGeneration,
        now,
        leaseMs: 90_000,
      }),
      claimLiveSyncRefresh({
        accountId: advertiserAccountId,
        credentialGeneration: credential.credentialGeneration,
        now,
        leaseMs: 90_000,
      }),
    ]);
    const winningClaims = claims.filter(
      (claim): claim is NonNullable<typeof claim> => Boolean(claim),
    );
    expect(winningClaims).toHaveLength(1);

    const snapshot = {
      account: { ...demoAccount, id: advertiserAccountId },
      campaigns: demoCampaigns,
      ads: demoAds,
      performance: demoCampaignPerformance,
      recommendations: [],
      budgetGuardEvidence: [],
      conversionMeasurement: {
        source: "live" as const,
        status: "ready" as const,
        checkedAt: now.toISOString(),
        activeConversionCampaigns: 0,
        healthyCampaigns: 0,
        eventSettingCount: 0,
        checks: [],
        message: "Integration snapshot.",
      },
      syncedAt: now.toISOString(),
    };
    await expect(
      completeLiveSyncRefresh({
        accountId: advertiserAccountId,
        credentialGeneration: credential.credentialGeneration,
        claimId: winningClaims[0].claimId,
        snapshot,
        now,
        freshForMs: 120_000,
        staleForMs: 900_000,
      }),
    ).resolves.toBe(true);
    await expect(
      readLiveSyncState({
        accountId: advertiserAccountId,
        credentialGeneration: credential.credentialGeneration,
      }),
    ).resolves.toMatchObject({ snapshot, consecutiveFailures: 0, claim: null });
    await expect(
      readLiveSyncState({
        accountId: advertiserAccountId,
        credentialGeneration: "vault:unreachable-after-rotation:3",
      }),
    ).resolves.toBeNull();

    // A failed refresh may update retry metadata, but must not extend the
    // retention lifetime of the older customer payload.
    const failedRefreshAt = new Date(now.getTime() + 23 * 60 * 60 * 1_000);
    const failedClaim = await claimLiveSyncRefresh({
      accountId: advertiserAccountId,
      credentialGeneration: credential.credentialGeneration,
      now: failedRefreshAt,
      leaseMs: 90_000,
    });
    expect(failedClaim).not.toBeNull();
    await expect(
      failLiveSyncRefresh({
        accountId: advertiserAccountId,
        credentialGeneration: credential.credentialGeneration,
        claimId: failedClaim!.claimId,
        failureCode: "provider_unavailable",
        now: failedRefreshAt,
        retryAfter: new Date(failedRefreshAt.getTime() + 60_000),
      }),
    ).resolves.toBe(true);

    await expect(
      pruneExpiredLiveSyncSnapshots({
        now: new Date(now.getTime() + 25 * 60 * 60 * 1_000),
        retentionMs: 24 * 60 * 60 * 1_000,
        limit: 500,
      }),
    ).resolves.toBe(1);
  });

  it("lists only credential-matched compact evidence for one active agency organization", async () => {
    const now = new Date("2026-09-02T12:00:00.000Z");
    const sourceRecommendation = getDemoRecommendation("rec_bid_20");
    if (!sourceRecommendation) throw new Error("Missing recommendation fixture.");
    const agencyCredential = await getAdsCredentialMaterialForAccount(
      agencyAccountId,
    );
    const agencyClaim = await claimLiveSyncRefresh({
      accountId: agencyAccountId,
      credentialGeneration: agencyCredential.credentialGeneration,
      now,
      leaseMs: 90_000,
    });
    expect(agencyClaim).not.toBeNull();
    await expect(
      completeLiveSyncRefresh({
        accountId: agencyAccountId,
        credentialGeneration: agencyCredential.credentialGeneration,
        claimId: agencyClaim!.claimId,
        snapshot: {
          account: { ...demoAccount, id: agencyAccountId, name: "Beacon Client" },
          campaigns: demoCampaigns,
          ads: demoAds,
          performance: demoCampaignPerformance,
          recommendations: [
            { ...sourceRecommendation, source: "live" as const },
          ],
          budgetGuardEvidence: [],
          conversionMeasurement: {
            source: "live",
            status: "ready",
            checkedAt: now.toISOString(),
            activeConversionCampaigns: 0,
            healthyCampaigns: 0,
            eventSettingCount: 0,
            checks: [],
            message: "Portfolio integration snapshot.",
          },
          syncedAt: now.toISOString(),
        },
        now,
        freshForMs: 120_000,
        staleForMs: 900_000,
      }),
    ).resolves.toBe(true);

    const mismatchedAccountId = `adacct_portfolio_mismatch_${randomUUID()}`;
    const mismatchedCredential = encryptAdsApiKey({
      apiKey: "ads-integration-portfolio-mismatch",
      externalAccountId: mismatchedAccountId,
    });
    const attached = await attachAdvertiserAccountToAgency({
      operatorId: ownerOperatorId,
      organizationId: agencyAccess.organizationId,
      accountId: mismatchedAccountId,
      accountName: "Credential Mismatch Client",
      credential: mismatchedCredential,
      verifiedAt: now,
    });
    const wrongGeneration = `vault:${randomUUID()}:99`;
    const wrongClaim = await claimLiveSyncRefresh({
      accountId: mismatchedAccountId,
      credentialGeneration: wrongGeneration,
      now,
      leaseMs: 90_000,
    });
    expect(wrongClaim).not.toBeNull();
    await expect(
      completeLiveSyncRefresh({
        accountId: mismatchedAccountId,
        credentialGeneration: wrongGeneration,
        claimId: wrongClaim!.claimId,
        snapshot: {
          account: {
            ...demoAccount,
            id: mismatchedAccountId,
            name: attached.access.accountName,
          },
          campaigns: [],
          ads: [],
          performance: [],
          recommendations: [],
          budgetGuardEvidence: [],
          conversionMeasurement: {
            source: "live",
            status: "ready",
            checkedAt: now.toISOString(),
            activeConversionCampaigns: 0,
            healthyCampaigns: 0,
            eventSettingCount: 0,
            checks: [],
            message: "Wrong-generation fixture.",
          },
          syncedAt: now.toISOString(),
        },
        now,
        freshForMs: 120_000,
        staleForMs: 900_000,
      }),
    ).resolves.toBe(true);

    try {
      const portfolio = await listLivePortfolioAccounts({
        operatorId: ownerOperatorId,
        organizationId: agencyAccess.organizationId,
        now: new Date(now.getTime() + 60_000),
      });
      expect(portfolio).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId: agencyAccountId,
            hasConfirmedSnapshot: true,
            detectedSignalCount: 1,
            evidenceState: "confirmed_fresh",
          }),
          expect.objectContaining({
            accountId: mismatchedAccountId,
            hasConfirmedSnapshot: false,
            detectedSignalCount: null,
            evidenceState: "not_confirmed",
          }),
        ]),
      );
      expect(portfolio.map((account) => account.accountId)).not.toContain(
        advertiserAccountId,
      );

      await database`
        update maintainflow_advertiser_accounts set
          status = 'disconnected', updated_at = now()
        where external_account_id = ${mismatchedAccountId}
      `;
      await expect(
        listLivePortfolioAccounts({
          operatorId: ownerOperatorId,
          organizationId: agencyAccess.organizationId,
          now: new Date(now.getTime() + 60_000),
        }),
      ).resolves.not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: mismatchedAccountId }),
        ]),
      );
    } finally {
      await database`
        delete from maintainflow_live_workbench_snapshots
        where advertiser_account_id = (
          select id from maintainflow_advertiser_accounts
          where external_account_id = ${mismatchedAccountId}
        )
      `;
      await database`
        delete from maintainflow_advertiser_credentials
        where advertiser_account_id = (
          select id from maintainflow_advertiser_accounts
          where external_account_id = ${mismatchedAccountId}
        )
      `;
      await database`
        delete from maintainflow_account_access
        where advertiser_account_id = (
          select id from maintainflow_advertiser_accounts
          where external_account_id = ${mismatchedAccountId}
        )
      `;
      await database`
        delete from maintainflow_advertiser_accounts
        where external_account_id = ${mismatchedAccountId}
      `;
    }
  });

  it("aggregates account-wide operational exceptions for each live agency account", async () => {
    const source = getDemoRecommendation("rec_bid_20");
    if (!source) throw new Error("The portfolio exception fixture is missing.");

    const accountId = `adacct_portfolio_exceptions_${randomUUID()}`;
    const credential = encryptAdsApiKey({
      apiKey: `ads-integration-${randomUUID()}`,
      externalAccountId: accountId,
    });
    const attached = await attachAdvertiserAccountToAgency({
      operatorId: ownerOperatorId,
      organizationId: agencyAccess.organizationId,
      accountId,
      accountName: "Operational Exception Client",
      credential,
      verifiedAt: new Date("2026-08-27T09:00:00.000Z"),
    });
    await database`
      insert into maintainflow_account_access (
        organization_id, advertiser_account_id, role, granted_by
      )
      select ${advertiserAccess.organizationId}, account.id, 'manager',
        ${ownerOperatorId}
      from maintainflow_advertiser_accounts account
      where account.external_account_id = ${accountId}
    `;
    const sharedAdvertiserAccess: AccountAccess = {
      ...attached.access,
      organizationId: advertiserAccess.organizationId,
      organizationName: advertiserAccess.organizationName,
      organizationType: "advertiser",
      membershipRole: "owner",
      accountRole: "manager",
    };
    const approvalIds: string[] = [];
    const reconciliationAt = new Date("2026-08-29T09:00:00.000Z");
    const safeguardAt = new Date("2026-08-30T09:00:00.000Z");
    const insufficientAt = new Date("2026-08-31T09:00:00.000Z");
    const monitoringFailureAt = new Date("2026-08-28T09:00:00.000Z");

    try {
      const reconciliationId = await createApprovalRecord({
        accountId,
        operatorId: ownerOperatorId,
        access: sharedAdvertiserAccess,
        recommendation: {
          ...source,
          id: `rec_portfolio_reconciliation_${randomUUID()}`,
          entityId: `${source.entityId}_portfolio_reconciliation_${randomUUID()}`,
        },
      });
      approvalIds.push(reconciliationId);
      await updateApprovalRecord(reconciliationId, "reconciliation_required", {
        error: "The provider response is intentionally ambiguous.",
      });
      await database`
        update ads_approval_records set updated_at = ${reconciliationAt}
        where id = ${reconciliationId}
      `;
      const [sharedApproval] = await database<
        { acting_organization_id: string }[]
      >`
        select acting_organization_id
        from ads_approval_records
        where id = ${reconciliationId}
      `;
      expect(sharedApproval?.acting_organization_id).toBe(
        advertiserAccess.organizationId,
      );

      for (const [outcome, evaluatedAt] of [
        ["safeguard_triggered", safeguardAt],
        ["insufficient_evidence", insufficientAt],
      ] as const) {
        const approvalId = await createApprovalRecord({
          accountId,
          operatorId: ownerOperatorId,
          access: attached.access,
          recommendation: {
            ...source,
            id: `rec_portfolio_${outcome}_${randomUUID()}`,
            entityId: `${source.entityId}_portfolio_${outcome}_${randomUUID()}`,
          },
        });
        approvalIds.push(approvalId);
        await updateApprovalRecord(approvalId, "applied");
        await database`
          update ads_approval_records set
            monitoring_started_at = ${new Date(
              evaluatedAt.getTime() - 9 * 24 * 60 * 60 * 1_000,
            )},
            monitoring_ends_at = ${new Date(
              evaluatedAt.getTime() - 2 * 24 * 60 * 60 * 1_000,
            )},
            monitoring_outcome = ${outcome},
            monitoring_observation = ${database.json({
              evidenceState:
                outcome === "insufficient_evidence" ? "incomplete" : "complete",
            })},
            monitoring_evaluated_at = ${evaluatedAt},
            updated_at = ${evaluatedAt}
          where id = ${approvalId}
        `;
      }

      await database`
        insert into maintainflow_monitoring_account_schedule (
          advertiser_account_id, attempt_count, consecutive_failures,
          last_attempted_at, last_failed_at, backoff_until, updated_at
        )
        select account.id, 3, 3, ${monitoringFailureAt},
          ${monitoringFailureAt},
          ${new Date(monitoringFailureAt.getTime() + 60 * 60 * 1_000)},
          ${monitoringFailureAt}
        from maintainflow_advertiser_accounts account
        where account.external_account_id = ${accountId}
      `;

      const portfolio = await listLivePortfolioAccounts({
        operatorId: ownerOperatorId,
        organizationId: agencyAccess.organizationId,
        now: new Date("2026-09-02T12:00:00.000Z"),
      });

      expect(portfolio).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            accountId,
            operationalExceptions: {
              safeguardTriggered: {
                count: 1,
                oldestAt: safeguardAt.toISOString(),
              },
              insufficientEvidence: {
                count: 1,
                oldestAt: insufficientAt.toISOString(),
              },
              monitoringFailures: {
                count: 3,
                oldestAt: monitoringFailureAt.toISOString(),
              },
              reconciliationRequired: {
                count: 1,
                oldestAt: reconciliationAt.toISOString(),
              },
            },
          }),
        ]),
      );
    } finally {
      if (approvalIds.length > 0) {
        await database`
          delete from ads_approval_records
          where id = any(${approvalIds}::uuid[])
        `;
      }
      await database`
        delete from maintainflow_advertiser_credentials
        where advertiser_account_id = (
          select id from maintainflow_advertiser_accounts
          where external_account_id = ${accountId}
        )
      `;
      await database`
        delete from maintainflow_account_access
        where advertiser_account_id = (
          select id from maintainflow_advertiser_accounts
          where external_account_id = ${accountId}
        )
      `;
      await database`
        delete from maintainflow_advertiser_accounts
        where external_account_id = ${accountId}
      `;
    }
  });

  it("encrypts, scopes, and atomically rotates conversion credentials", async () => {
    const initialCredential = {
      pixelId: "pixel-integration-alpha-initial",
      apiKey: "capi-integration-alpha-initial",
    };
    const replacementCredential = {
      pixelId: "pixel-integration-alpha-replacement",
      apiKey: "capi-integration-alpha-replacement",
    };
    const agencyCredential = {
      pixelId: "pixel-integration-beta-initial",
      apiKey: "capi-integration-beta-initial",
    };

    await expect(
      getConversionsApiCredentialForAccount(advertiserAccountId),
    ).rejects.toThrow("unavailable");
    await expect(
      rotateConversionsApiCredential({
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: agencyAccess,
        credential: encryptConversionsApiCredential({
          credential: initialCredential,
          externalAccountId: advertiserAccountId,
        }),
        validatedAt: new Date("2026-08-30T09:10:00.000Z"),
        validation: { providerStatus: 204, eventCount: 1 },
      }),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      rotateConversionsApiCredential({
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: advertiserAccess,
        credential: encryptConversionsApiCredential({
          credential: initialCredential,
          externalAccountId: advertiserAccountId,
        }),
        validatedAt: new Date("2026-08-30T09:12:00.000Z"),
        validation: { providerStatus: 199, eventCount: 0 },
      }),
    ).rejects.toThrow("Valid dry-run evidence");

    const initialEncrypted = encryptConversionsApiCredential({
      credential: initialCredential,
      externalAccountId: advertiserAccountId,
    });
    await expect(
      rotateConversionsApiCredential({
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: advertiserAccess,
        credential: initialEncrypted,
        validatedAt: new Date("2026-08-30T09:15:00.000Z"),
        validation: { providerStatus: 204, eventCount: 1 },
      }),
    ).resolves.toMatchObject({ credentialVersion: 1 });
    await expect(
      getConversionsApiCredentialForAccount(advertiserAccountId),
    ).resolves.toEqual(initialCredential);

    const viewerAccess = await requireAccountAccess(
      viewerOperatorId,
      advertiserAccountId,
      "read",
    );
    const forgedViewerAccess: AccountAccess = {
      ...viewerAccess,
      membershipRole: "owner",
      accountRole: "owner",
    };
    await expect(
      rotateConversionsApiCredential({
        operatorId: viewerOperatorId,
        accountId: advertiserAccountId,
        access: forgedViewerAccess,
        credential: encryptConversionsApiCredential({
          credential: replacementCredential,
          externalAccountId: advertiserAccountId,
        }),
        validatedAt: new Date("2026-08-30T09:16:00.000Z"),
        validation: { providerStatus: 204, eventCount: 1 },
      }),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      getConversionsApiCredentialForAccount(advertiserAccountId),
    ).resolves.toEqual(initialCredential);

    await database`
      update maintainflow_account_access set
        role = 'viewer', updated_at = now()
      where organization_id = ${advertiserAccess.organizationId}
        and advertiser_account_id = (
          select id from maintainflow_advertiser_accounts
          where external_account_id = ${advertiserAccountId}
        )
    `;
    try {
      await expect(
        rotateConversionsApiCredential({
          operatorId: ownerOperatorId,
          accountId: advertiserAccountId,
          access: advertiserAccess,
          credential: encryptConversionsApiCredential({
            credential: replacementCredential,
            externalAccountId: advertiserAccountId,
          }),
          validatedAt: new Date("2026-08-30T09:17:00.000Z"),
          validation: { providerStatus: 204, eventCount: 1 },
        }),
      ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
      await expect(
        getConversionsApiCredentialForAccount(advertiserAccountId),
      ).resolves.toEqual(initialCredential);
    } finally {
      await database`
        update maintainflow_account_access set
          role = 'owner', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and advertiser_account_id = (
            select id from maintainflow_advertiser_accounts
            where external_account_id = ${advertiserAccountId}
          )
      `;
    }

    const [initialRow] = await database<
      {
        id: string;
        ciphertext: Buffer;
        credential_version: number;
        status: string;
        acting_organization_id: string;
        actor_membership_role: string;
        actor_account_role: string;
        validation_provider_status: number;
        validation_event_count: number;
      }[]
    >`
      select credential.id, credential.ciphertext,
        credential.credential_version, credential.status,
        credential.acting_organization_id,
        credential.actor_membership_role,
        credential.actor_account_role,
        credential.validation_provider_status,
        credential.validation_event_count
      from maintainflow_conversion_credentials credential
      join maintainflow_advertiser_accounts account
        on account.id = credential.advertiser_account_id
      where account.external_account_id = ${advertiserAccountId}
    `;
    expect(initialRow).toMatchObject({
      credential_version: 1,
      status: "active",
      acting_organization_id: advertiserAccess.organizationId,
      actor_membership_role: "owner",
      actor_account_role: "owner",
      validation_provider_status: 204,
      validation_event_count: 1,
    });
    expect(initialRow.ciphertext.toString("utf8")).not.toContain(
      initialCredential.pixelId,
    );
    expect(initialRow.ciphertext.toString("utf8")).not.toContain(
      initialCredential.apiKey,
    );

    const replacementEncrypted = encryptConversionsApiCredential({
      credential: replacementCredential,
      externalAccountId: advertiserAccountId,
    });
    await expect(
      rotateConversionsApiCredential({
        operatorId: ownerOperatorId,
        accountId: advertiserAccountId,
        access: advertiserAccess,
        credential: { ...replacementEncrypted, id: initialRow.id },
        validatedAt: new Date("2026-08-30T09:20:00.000Z"),
        validation: { providerStatus: 204, eventCount: 1 },
      }),
    ).rejects.toThrow();
    await expect(
      getConversionsApiCredentialForAccount(advertiserAccountId),
    ).resolves.toEqual(initialCredential);

    await database.begin(async (transaction) => {
      await transaction`
        update maintainflow_organization_memberships set
          role = 'admin', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
      await transaction`
        update maintainflow_account_access set
          role = 'manager', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and advertiser_account_id = (
            select id from maintainflow_advertiser_accounts
            where external_account_id = ${advertiserAccountId}
          )
      `;
    });
    try {
      await expect(
        rotateConversionsApiCredential({
          operatorId: ownerOperatorId,
          accountId: advertiserAccountId,
          access: advertiserAccess,
          credential: replacementEncrypted,
          validatedAt: new Date("2026-08-30T09:25:00.000Z"),
          validation: { providerStatus: 204, eventCount: 1 },
        }),
      ).resolves.toMatchObject({ credentialVersion: 2 });
    } finally {
      await database.begin(async (transaction) => {
        await transaction`
          update maintainflow_organization_memberships set
            role = 'owner', updated_at = now()
          where organization_id = ${advertiserAccess.organizationId}
            and clerk_user_id = ${ownerOperatorId}
        `;
        await transaction`
          update maintainflow_account_access set
            role = 'owner', updated_at = now()
          where organization_id = ${advertiserAccess.organizationId}
            and advertiser_account_id = (
              select id from maintainflow_advertiser_accounts
              where external_account_id = ${advertiserAccountId}
            )
        `;
      });
    }
    await expect(
      getConversionsApiCredentialForAccount(advertiserAccountId),
    ).resolves.toEqual(replacementCredential);

    const originalFetch = globalThis.fetch;
    const originalValidationEnabled =
      process.env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED;
    const originalReleaseStage = process.env.MAINTAINFLOW_RELEASE_STAGE;
    process.env.MAINTAINFLOW_RELEASE_STAGE = "private_read";
    process.env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED = "true";
    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      const headers = new Headers(init?.headers);
      expect(url.searchParams.get("pid")).toBe(
        replacementCredential.pixelId,
      );
      expect(headers.get("Authorization")).toBe(
        `Bearer ${replacementCredential.apiKey}`,
      );
      return new Response(null, { status: 204 });
    });
    try {
      const connectionStatus =
        await getConversionsApiConnectionStatus(advertiserAccountId);
      expect(connectionStatus).toEqual({
        state: "connected",
        source: "vault",
        validationEnabled: true,
        credentialVersion: 2,
        validatedAt: "2026-08-30T09:25:00.000Z",
        providerStatus: 204,
        eventCount: 1,
      });
      expect(JSON.stringify(connectionStatus)).not.toContain(
        replacementCredential.pixelId,
      );
      expect(JSON.stringify(connectionStatus)).not.toContain(
        replacementCredential.apiKey,
      );

      await expect(
        validateConversionsApiPayload({
          accountId: advertiserAccountId,
          now: new Date("2026-08-30T09:26:00.000Z"),
          payload: {
            validate_only: true,
            events: [
              {
                id: "order_database_integration",
                type: "order_created",
                timestamp_ms: new Date("2026-08-30T09:26:00.000Z").getTime(),
                source_url: "https://shop.example/orders/integration",
                action_source: "web",
                data: {
                  type: "contents",
                  amount: 2500,
                  currency: "EUR",
                  contents: [
                    {
                      id: "sku_database_integration",
                      content_type: "product",
                      quantity: 1,
                    },
                  ],
                },
              },
            ],
          },
        }),
      ).resolves.toMatchObject({
        status: "validated",
        mode: "validate_only",
        providerStatus: 204,
      });
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalValidationEnabled === undefined) {
        delete process.env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED;
      } else {
        process.env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED =
          originalValidationEnabled;
      }
      if (originalReleaseStage === undefined) {
        delete process.env.MAINTAINFLOW_RELEASE_STAGE;
      } else {
        process.env.MAINTAINFLOW_RELEASE_STAGE = originalReleaseStage;
      }
    }

    await expect(
      rotateConversionsApiCredential({
        operatorId: ownerOperatorId,
        accountId: agencyAccountId,
        access: agencyAccess,
        credential: encryptConversionsApiCredential({
          credential: agencyCredential,
          externalAccountId: agencyAccountId,
        }),
        validatedAt: new Date("2026-08-30T09:30:00.000Z"),
        validation: { providerStatus: 204, eventCount: 1 },
      }),
    ).resolves.toMatchObject({ credentialVersion: 1 });
    await expect(
      getConversionsApiCredentialForAccount(agencyAccountId),
    ).resolves.toEqual(agencyCredential);

    const versions = await database<
      {
        account_id: string;
        credential_version: number;
        status: string;
        revoked: boolean;
        actor_membership_role: string;
        actor_account_role: string;
      }[]
    >`
      select account.external_account_id as account_id,
        credential.credential_version, credential.status,
        credential.revoked_at is not null as revoked,
        credential.actor_membership_role,
        credential.actor_account_role
      from maintainflow_conversion_credentials credential
      join maintainflow_advertiser_accounts account
        on account.id = credential.advertiser_account_id
      order by account.external_account_id, credential.credential_version
    `;
    expect(versions).toEqual([
      {
        account_id: advertiserAccountId,
        credential_version: 1,
        status: "revoked",
        revoked: true,
        actor_membership_role: "owner",
        actor_account_role: "owner",
      },
      {
        account_id: advertiserAccountId,
        credential_version: 2,
        status: "active",
        revoked: false,
        actor_membership_role: "admin",
        actor_account_role: "manager",
      },
      {
        account_id: agencyAccountId,
        credential_version: 1,
        status: "active",
        revoked: false,
        actor_membership_role: "owner",
        actor_account_role: "manager",
      },
    ]);
  });

  it("records creative review transitions once and keeps them account scoped", async () => {
    await expect(verifyCreativeHistoryStore()).resolves.toBe(true);
    const source = demoAds.find((ad) => ad.id === "ad_503");
    if (!source) throw new Error("The creative-history fixture is missing.");
    const baseline = {
      ...source,
      id: "ad_history_integration",
      ad_group_id: "adgrp_history_integration",
      name: "Integration review creative",
    };

    await expect(
      recordCreativeReviewSnapshot({
        accountId: advertiserAccountId,
        ads: [baseline],
        observedAt: new Date("2026-08-30T10:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    const approved = {
      ...baseline,
      updated_at: baseline.updated_at + 60,
      status: "active" as const,
      review_status: "approved" as const,
    };
    const concurrentResults = await Promise.all([
      recordCreativeReviewSnapshot({
        accountId: advertiserAccountId,
        ads: [approved],
        observedAt: new Date("2026-08-30T10:05:00.000Z"),
      }),
      recordCreativeReviewSnapshot({
        accountId: advertiserAccountId,
        ads: [approved],
        observedAt: new Date("2026-08-30T10:05:01.000Z"),
      }),
    ]);
    expect(concurrentResults.flat()).toHaveLength(1);

    const events = await listCreativeReviewEvents(advertiserAccountId);
    expect(events).toEqual([
      expect.objectContaining({
        accountId: advertiserAccountId,
        adId: approved.id,
        eventType: "review_and_delivery_changed",
        previousReviewStatus: "in_review",
        reviewStatus: "approved",
        previousDeliveryStatus: "paused",
        deliveryStatus: "active",
      }),
    ]);
    await expect(listCreativeReviewEvents(agencyAccountId)).resolves.toEqual([]);

    const stale = {
      ...baseline,
      review_status: "rejected" as const,
    };
    await expect(
      recordCreativeReviewSnapshot({
        accountId: advertiserAccountId,
        ads: [stale],
        observedAt: new Date("2026-08-30T10:10:00.000Z"),
      }),
    ).resolves.toEqual([]);
    const [state] = await database<
      { review_status: string; delivery_status: string }[]
    >`
      select state.review_status, state.delivery_status
      from maintainflow_creative_review_state state
      join maintainflow_advertiser_accounts account
        on account.id = state.advertiser_account_id
      where account.external_account_id = ${advertiserAccountId}
        and state.ad_id = ${approved.id}
    `;
    expect(state).toEqual({
      review_status: "approved",
      delivery_status: "active",
    });
    await expect(listCreativeReviewEvents(advertiserAccountId)).resolves.toHaveLength(
      1,
    );
  });

  it("persists approval, rollback, and reconciliation transitions", async () => {
    const recommendation = getDemoRecommendation("rec_bid_20");
    if (!recommendation) throw new Error("The integration recommendation is missing.");

    const rollbackApprovalId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation,
      access: advertiserAccess,
    });
    const [storedPayloads] = await database<
      {
        evidence_payload: unknown;
        request_payload: unknown;
        rollback_payload: unknown;
      }[]
    >`
      select request_payload, rollback_payload, evidence_payload
      from ads_approval_records
      where id = ${rollbackApprovalId}
    `;
    expect(storedPayloads).toEqual({
      request_payload: recommendation.mutation,
      rollback_payload: recommendation.rollback,
      evidence_payload: recommendation.evidence,
    });
    await updateApprovalRecord(rollbackApprovalId, "applied", {
      response: { id: recommendation.entityId },
    });
    const appliedRecord = (await listApprovalRecords(advertiserAccountId)).find(
      (record) => record.id === rollbackApprovalId,
    );
    expect(appliedRecord).toMatchObject({
      monitoringPlan: recommendation.monitoringPlan,
      monitoringStartedAt: expect.any(Date),
      monitoringEndsAt: expect.any(Date),
    });
    expect(
      appliedRecord!.monitoringEndsAt!.getTime() -
        appliedRecord!.monitoringStartedAt!.getTime(),
    ).toBe(7 * 24 * 60 * 60 * 1_000);
    const [storedResponse] = await database<{ response_payload: unknown }[]>`
      select response_payload from ads_approval_records
      where id = ${rollbackApprovalId}
    `;
    expect(storedResponse?.response_payload).toEqual({
      id: recommendation.entityId,
    });
    await expect(getApprovalAccountId(rollbackApprovalId)).resolves.toBe(
      advertiserAccountId,
    );

    const rollbackClaims = await Promise.allSettled([
      claimApprovalRollback(
        rollbackApprovalId,
        advertiserAccountId,
        ownerOperatorId,
        advertiserAccess,
      ),
      claimApprovalRollback(
        rollbackApprovalId,
        advertiserAccountId,
        ownerOperatorId,
        advertiserAccess,
      ),
    ]);
    const rollbackDiagnostics = rollbackClaims
      .map((result) =>
        result.status === "fulfilled"
          ? "fulfilled"
          : result.reason instanceof Error
            ? `${result.reason.name}: ${result.reason.message}`
            : String(result.reason),
      )
      .join("\n");
    expect(
      rollbackClaims.filter((result) => result.status === "fulfilled"),
      rollbackDiagnostics,
    ).toHaveLength(1);
    expect(
      rollbackClaims.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      rollbackClaims.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(ApprovalTransitionError) });
    const successfulRollbackClaim = rollbackClaims.find(
      (result) => result.status === "fulfilled",
    );
    if (!successfulRollbackClaim || successfulRollbackClaim.status !== "fulfilled") {
      throw new Error("The rollback claim fixture did not produce a winner.");
    }
    await updateRollbackRecord(rollbackApprovalId, "rolled_back", {
      accountId: advertiserAccountId,
      attemptId: successfulRollbackClaim.value.attemptId,
      response: { id: recommendation.entityId },
    });
    const [storedRollbackResponse] = await database<
      { rollback_response_payload: unknown }[]
    >`
      select rollback_response_payload from ads_approval_records
      where id = ${rollbackApprovalId}
    `;
    expect(storedRollbackResponse?.rollback_response_payload).toEqual({
      id: recommendation.entityId,
    });

    const reconciliationApprovalId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation,
      access: advertiserAccess,
    });
    await updateApprovalRecord(
      reconciliationApprovalId,
      "reconciliation_required",
      { error: "The provider response was ambiguous." },
    );
    const reconciled = await reconcileApprovalRecord({
      id: reconciliationApprovalId,
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      action: "mark_applied",
      note: "Verified as applied in the advertiser account.",
      access: advertiserAccess,
    });
    expect(reconciled).toMatchObject({
      status: "applied",
      reconciliationNote: "Verified as applied in the advertiser account.",
      monitoringPlan: recommendation.monitoringPlan,
      monitoringStartedAt: expect.any(Date),
      monitoringEndsAt: expect.any(Date),
    });

    const records = await listApprovalRecords(advertiserAccountId);
    expect(records).toHaveLength(2);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: rollbackApprovalId,
          organizationName: "Alpine Retail",
          membershipRole: "owner",
          accountRole: "owner",
          status: "rolled_back",
        }),
        expect.objectContaining({
          id: reconciliationApprovalId,
          status: "applied",
        }),
      ]),
    );

    const concurrentRecommendation = {
      ...recommendation,
      id: "rec_concurrent_monitoring",
    };
    const duplicateAttempts = await Promise.allSettled([
      createApprovalRecord({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        recommendation: concurrentRecommendation,
        access: advertiserAccess,
      }),
      createApprovalRecord({
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        recommendation: concurrentRecommendation,
        access: advertiserAccess,
      }),
    ]);
    expect(
      duplicateAttempts.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      duplicateAttempts.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      duplicateAttempts.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(ApprovalTransitionError) });
    const [duplicateCount] = await database<{ count: number }[]>`
      select count(*)::int as count
      from ads_approval_records
      where account_id = ${advertiserAccountId}
        and recommendation_id = ${concurrentRecommendation.id}
    `;
    expect(duplicateCount?.count).toBe(1);
    await expect(
      listActiveApprovalRecords(advertiserAccountId),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recommendationId: recommendation.id,
          status: "applied",
        }),
        expect.objectContaining({
          recommendationId: concurrentRecommendation.id,
          status: "pending",
        }),
      ]),
    );
  });

  it("waits for an in-flight role change and reauthorizes before reconciliation", async () => {
    const source = getDemoRecommendation("rec_bid_20");
    if (!source) throw new Error("The reconciliation fixture is missing.");
    const recommendation = {
      ...source,
      id: "rec_reconciliation_authorization_fence",
    };
    const approvalId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation,
      access: advertiserAccess,
    });
    await updateApprovalRecord(approvalId, "reconciliation_required", {
      error: "The provider response was ambiguous.",
    });

    let releaseDowngrade!: () => void;
    let markDowngradeStarted!: () => void;
    const downgradeRelease = new Promise<void>((resolve) => {
      releaseDowngrade = resolve;
    });
    const downgradeStarted = new Promise<void>((resolve) => {
      markDowngradeStarted = resolve;
    });
    const downgrade = database.begin(async (transaction) => {
      await transaction`
        update maintainflow_organization_memberships set
          role = 'analyst', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
      markDowngradeStarted();
      await downgradeRelease;
    });
    await downgradeStarted;

    const reconciliation = reconcileApprovalRecord({
      id: approvalId,
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      action: "mark_not_applied",
      note: "Verified that the change was not applied.",
      access: advertiserAccess,
    });
    let earlyOutcome: "blocked" | "settled" = "blocked";
    try {
      earlyOutcome = await Promise.race([
        reconciliation.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 100),
        ),
      ]);
    } finally {
      releaseDowngrade();
      await downgrade;
    }

    try {
      expect(earlyOutcome).toBe("blocked");
      await expect(reconciliation).rejects.toBeInstanceOf(
        AccountAccessForbiddenError,
      );
      const [blockedRecord] = await database<
        {
          status: string;
          reconciled_by: string | null;
          reconciled_organization_id: string | null;
          reconciled_membership_role: string | null;
          reconciled_account_role: string | null;
        }[]
      >`
        select status, reconciled_by, reconciled_organization_id,
          reconciled_membership_role, reconciled_account_role
        from ads_approval_records
        where id = ${approvalId}
      `;
      expect(blockedRecord).toEqual({
        status: "reconciliation_required",
        reconciled_by: null,
        reconciled_organization_id: null,
        reconciled_membership_role: null,
        reconciled_account_role: null,
      });
    } finally {
      await database`
        update maintainflow_organization_memberships set
          role = 'owner', updated_at = now()
        where organization_id = ${advertiserAccess.organizationId}
          and clerk_user_id = ${ownerOperatorId}
      `;
    }

    await expect(
      reconcileApprovalRecord({
        id: approvalId,
        accountId: advertiserAccountId,
        operatorId: ownerOperatorId,
        action: "mark_not_applied",
        note: "Verified that the change was not applied.",
        access: advertiserAccess,
      }),
    ).resolves.toMatchObject({ status: "failed" });
    const [reconciledRecord] = await database<
      {
        reconciled_by: string | null;
        reconciled_organization_id: string | null;
        reconciled_membership_role: string | null;
        reconciled_account_role: string | null;
      }[]
    >`
      select reconciled_by, reconciled_organization_id,
        reconciled_membership_role, reconciled_account_role
      from ads_approval_records
      where id = ${approvalId}
    `;
    expect(reconciledRecord).toEqual({
      reconciled_by: ownerOperatorId,
      reconciled_organization_id: advertiserAccess.organizationId,
      reconciled_membership_role: "owner",
      reconciled_account_role: "owner",
    });
  });

  it("evaluates each completed monitoring window once and keeps it account scoped", async () => {
    const source = getDemoRecommendation("rec_bid_20");
    if (!source) throw new Error("The monitoring fixture is missing.");
    const recommendation = {
      ...source,
      id: "rec_monitoring_outcome_integration",
    };
    const approvalId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation,
      access: advertiserAccess,
    });
    await updateApprovalRecord(approvalId, "applied");
    const startedAt = new Date("2026-08-20T00:00:00.000Z");
    const endsAt = new Date("2026-08-27T00:00:00.000Z");
    const evaluatedAt = new Date(
      endsAt.getTime() + MONITORING_ATTRIBUTION_MATURITY_MS,
    );
    const beforeMaturity = new Date(evaluatedAt.getTime() - 1);
    const observation = {
      rangeStart: Math.floor(startedAt.getTime() / 1_000),
      rangeEnd: Math.floor(endsAt.getTime() / 1_000),
      spend: 4_100,
      clickAttributedConversions: 12,
      cpa: 341.6667,
      conversionChangePercent: -20,
      baselineClickAttributedConversions:
        recommendation.monitoringPlan!.baseline.clickAttributedConversions,
      thresholdPercent: 15,
      evidenceState: "complete" as const,
    };
    await database`
      update ads_approval_records set
        monitoring_started_at = ${startedAt},
        monitoring_ends_at = ${endsAt}
      where id = ${approvalId}
    `;

    await expect(
      listDueMonitoringRecords(advertiserAccountId, beforeMaturity),
    ).resolves.toEqual([]);
    await expect(
      listDueMonitoringAccountIds(beforeMaturity),
    ).resolves.not.toContain(advertiserAccountId);
    await expect(
      claimDueMonitoringRecords({
        accountId: advertiserAccountId,
        claimId: randomUUID(),
        now: beforeMaturity,
        limit: 1,
      }),
    ).resolves.toEqual([]);

    const prematureClaimId = randomUUID();
    await database`
      update ads_approval_records set
        monitoring_evaluation_claim_id = ${prematureClaimId},
        monitoring_evaluation_claimed_at = ${beforeMaturity}
      where id = ${approvalId}
    `;
    await expect(
      recordMonitoringOutcome({
        id: approvalId,
        accountId: advertiserAccountId,
        outcome: "safeguard_triggered",
        observation,
        claimId: prematureClaimId,
        evaluatedAt: beforeMaturity,
      }),
    ).resolves.toBe(false);
    await database`
      update ads_approval_records set
        monitoring_evaluation_claim_id = null,
        monitoring_evaluation_claimed_at = null
      where id = ${approvalId}
    `;

    await expect(
      listDueMonitoringRecords(agencyAccountId, evaluatedAt),
    ).resolves.toEqual([]);
    await expect(
      listDueMonitoringRecords(advertiserAccountId, evaluatedAt),
    ).resolves.toEqual([
      expect.objectContaining({
        id: approvalId,
        monitoringOutcome: null,
        monitoringEvaluatedAt: null,
      }),
    ]);
    await expect(listDueMonitoringAccountIds(evaluatedAt)).resolves.toContain(
      advertiserAccountId,
    );
    await expect(listDueMonitoringAccountIds(evaluatedAt)).resolves.not.toContain(
      agencyAccountId,
    );

    const firstClaimId = randomUUID();
    const secondClaimId = randomUUID();
    const [firstClaim, secondClaim] = await Promise.all([
      claimDueMonitoringRecords({
        accountId: advertiserAccountId,
        claimId: firstClaimId,
        now: evaluatedAt,
        limit: 1,
      }),
      claimDueMonitoringRecords({
        accountId: advertiserAccountId,
        claimId: secondClaimId,
        now: evaluatedAt,
        limit: 1,
      }),
    ]);
    const claimedRecords = [...firstClaim, ...secondClaim].filter(
      (record) => record.id === approvalId,
    );
    expect(claimedRecords).toHaveLength(1);
    const winningClaimId = firstClaim.some((record) => record.id === approvalId)
      ? firstClaimId
      : secondClaimId;
    await expect(
      listDueMonitoringRecords(advertiserAccountId, evaluatedAt),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: approvalId })]),
    );

    await expect(
      recordMonitoringOutcome({
        id: approvalId,
        accountId: agencyAccountId,
        outcome: "safeguard_triggered",
        observation,
        claimId: winningClaimId,
        evaluatedAt,
      }),
    ).resolves.toBe(false);

    const writes = await Promise.all([
      recordMonitoringOutcome({
        id: approvalId,
        accountId: advertiserAccountId,
        outcome: "safeguard_triggered",
        observation,
        claimId: winningClaimId,
        evaluatedAt,
      }),
      recordMonitoringOutcome({
        id: approvalId,
        accountId: advertiserAccountId,
        outcome: "safeguard_triggered",
        observation,
        claimId: winningClaimId,
        evaluatedAt,
      }),
    ]);
    expect(writes.filter(Boolean)).toHaveLength(1);

    const stored = (await listApprovalRecords(advertiserAccountId)).find(
      (record) => record.id === approvalId,
    );
    expect(stored).toMatchObject({
      monitoringOutcome: "safeguard_triggered",
      monitoringObservation: observation,
      monitoringEvaluatedAt: evaluatedAt,
    });
    await expect(
      listDueMonitoringRecords(advertiserAccountId, evaluatedAt),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: approvalId })]),
    );

    const leaseRecommendation = {
      ...source,
      id: "rec_monitoring_lease_recovery_integration",
    };
    const leaseApprovalId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: leaseRecommendation,
      access: advertiserAccess,
    });
    await updateApprovalRecord(leaseApprovalId, "applied");
    await database`
      update ads_approval_records set
        monitoring_started_at = ${startedAt},
        monitoring_ends_at = ${endsAt}
      where id = ${leaseApprovalId}
    `;
    const abandonedClaimId = randomUUID();
    await expect(
      claimDueMonitoringRecords({
        accountId: advertiserAccountId,
        claimId: abandonedClaimId,
        now: evaluatedAt,
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: leaseApprovalId }),
    ]);
    await expect(
      claimDueMonitoringRecords({
        accountId: advertiserAccountId,
        claimId: randomUUID(),
        now: new Date(evaluatedAt.getTime() + 14 * 60 * 1_000),
        limit: 1,
      }),
    ).resolves.toEqual([]);
    const recoveryClaimId = randomUUID();
    await expect(
      claimDueMonitoringRecords({
        accountId: advertiserAccountId,
        claimId: recoveryClaimId,
        now: new Date(evaluatedAt.getTime() + 16 * 60 * 1_000),
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: leaseApprovalId }),
    ]);
    await expect(
      recordMonitoringOutcome({
        id: leaseApprovalId,
        accountId: advertiserAccountId,
        outcome: "safeguard_triggered",
        observation,
        claimId: recoveryClaimId,
        evaluatedAt: new Date(evaluatedAt.getTime() + 16 * 60 * 1_000),
      }),
    ).resolves.toBe(true);
  });

  it("does not replace an unexpired account attempt or backoff from a stale claim snapshot", async () => {
    const now = new Date("2026-08-31T11:00:00.000Z");
    const leaseUntil = new Date(
      now.getTime() + MONITORING_ACCOUNT_ATTEMPT_LEASE_MS,
    );
    const backoffUntil = new Date(now.getTime() + 5 * 60 * 1_000);
    const raceDatabase = postgres(databaseUrl, {
      connect_timeout: 5,
      idle_timeout: 5,
      max: 1,
      prepare: false,
      connection: { application_name: "maintainflow-monitoring-race-holder" },
    });

    try {
      for (const mode of ["lease", "backoff"] as const) {
        const [accountId] = await createMonitoringFairnessFixture({
          prefix: `claim_race_${mode}`,
          now,
          dueRows: [1],
        });
        if (!accountId) throw new Error("The claim race fixture is missing.");
        let releaseBlocker: (() => void) | undefined;
        const blockerGate = new Promise<void>((resolve) => {
          releaseBlocker = resolve;
        });
        let signalBlockerReady: ((pid: number) => void) | undefined;
        const blockerReady = new Promise<number>((resolve) => {
          signalBlockerReady = resolve;
        });
        const winningAttemptId = randomUUID();
        let blockerTransaction: Promise<unknown> | undefined;
        let staleClaim:
          | ReturnType<typeof claimDueMonitoringAccounts>
          | undefined;

        try {
          await database`
            update ads_approval_records set
              monitoring_started_at = '2019-12-01T00:00:00.000Z',
              monitoring_ends_at = '2020-01-01T00:00:00.000Z'
            where account_id = ${accountId}
          `;
          await database`
            insert into maintainflow_monitoring_account_schedule (
              advertiser_account_id
            )
            select id from maintainflow_advertiser_accounts
            where external_account_id = ${accountId}
          `;

          blockerTransaction = raceDatabase.begin(async (transaction) => {
            const [backend] = await transaction<{ pid: number }[]>`
              select pg_backend_pid()::int as pid
            `;
            if (!backend) throw new Error("The blocker backend is missing.");
            if (mode === "lease") {
              await transaction`
                update maintainflow_monitoring_account_schedule schedule set
                  current_attempt_id = ${winningAttemptId},
                  attempt_count = 1,
                  last_attempted_at = ${now},
                  attempt_lease_until = ${leaseUntil},
                  updated_at = ${now}
                from maintainflow_advertiser_accounts advertiser_account
                where advertiser_account.id = schedule.advertiser_account_id
                  and advertiser_account.external_account_id = ${accountId}
              `;
            } else {
              await transaction`
                update maintainflow_monitoring_account_schedule schedule set
                  attempt_count = 1,
                  consecutive_failures = 1,
                  last_attempted_at = ${now},
                  last_failed_at = ${now},
                  backoff_until = ${backoffUntil},
                  updated_at = ${now}
                from maintainflow_advertiser_accounts advertiser_account
                where advertiser_account.id = schedule.advertiser_account_id
                  and advertiser_account.external_account_id = ${accountId}
              `;
            }
            signalBlockerReady?.(backend.pid);
            await blockerGate;
          });

          const blockerPid = await blockerReady;
          staleClaim = claimDueMonitoringAccounts({
            attemptId: randomUUID(),
            now,
            limit: 1,
          });

          const waitDeadline = Date.now() + 3_000;
          let observedConflictWait = false;
          while (Date.now() < waitDeadline) {
            const [activity] = await database<{ blocked: boolean }[]>`
              select exists (
                select 1
                from pg_stat_activity activity
                where ${blockerPid}::int = any(pg_blocking_pids(activity.pid))
                  and activity.wait_event_type = 'Lock'
                  and activity.query ilike '%with due_accounts as materialized%'
              ) as blocked
            `;
            if (activity?.blocked) {
              observedConflictWait = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          expect(observedConflictWait).toBe(true);

          releaseBlocker?.();
          await blockerTransaction;
          const staleResult = await staleClaim;
          expect(staleResult).not.toEqual(
            expect.arrayContaining([
              expect.objectContaining({ accountId }),
            ]),
          );

          const [stored] = await database<
            {
              attempt_count: number;
              current_attempt_id: string | null;
              attempt_lease_until: Date | null;
              backoff_until: Date | null;
            }[]
          >`
            select schedule.attempt_count::int as attempt_count,
              schedule.current_attempt_id, schedule.attempt_lease_until,
              schedule.backoff_until
            from maintainflow_monitoring_account_schedule schedule
            join maintainflow_advertiser_accounts advertiser_account
              on advertiser_account.id = schedule.advertiser_account_id
            where advertiser_account.external_account_id = ${accountId}
          `;
          expect(stored).toEqual(
            mode === "lease"
              ? {
                  attempt_count: 1,
                  current_attempt_id: winningAttemptId,
                  attempt_lease_until: leaseUntil,
                  backoff_until: null,
                }
              : {
                  attempt_count: 1,
                  current_attempt_id: null,
                  attempt_lease_until: null,
                  backoff_until: backoffUntil,
                },
          );
        } finally {
          releaseBlocker?.();
          await blockerTransaction?.catch(() => undefined);
          await staleClaim?.catch(() => undefined);
          await removeMonitoringFairnessFixture([accountId]);
        }
      }
    } finally {
      await raceDatabase.end({ timeout: 5 });
    }
  });

  it("backs off six broken monitoring accounts so the seventh account is selected next", async () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const accountIds = await createMonitoringFairnessFixture({
      prefix: "fair_failure",
      now,
      dueRows: [1, 1, 1, 1, 1, 1, 1],
    });
    try {
      const firstAttemptId = randomUUID();
      const firstSelection = await claimDueMonitoringAccounts({
        attemptId: firstAttemptId,
        now,
        limit: 6,
      });
      expect(firstSelection.map((account) => account.accountId)).toEqual(
        accountIds.slice(0, 6),
      );
      expect(firstSelection).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ dueCount: 1, oldestDueAt: expect.any(Date) }),
        ]),
      );

      await expect(
        completeMonitoringAccountAttempt({
          accountId: accountIds[6]!,
          attemptId: firstSelection[0]!.attemptId,
          succeeded: true,
          now,
        }),
      ).resolves.toBe(false);
      const [stillClaimed] = await database<
        { current_attempt_id: string | null }[]
      >`
        select schedule.current_attempt_id
        from maintainflow_monitoring_account_schedule schedule
        join maintainflow_advertiser_accounts advertiser_account
          on advertiser_account.id = schedule.advertiser_account_id
        where advertiser_account.external_account_id = ${accountIds[0]!}
      `;
      expect(stillClaimed?.current_attempt_id).toBe(
        firstSelection[0]!.attemptId,
      );

      await Promise.all(
        firstSelection.map((account) =>
          completeMonitoringAccountAttempt({
            accountId: account.accountId,
            attemptId: account.attemptId,
            succeeded: false,
            now,
          }),
        ),
      ).then((results) => expect(results).toEqual(Array(6).fill(true)));

      const nextRunAt = new Date(now.getTime() + 1_000);
      const secondAttemptId = randomUUID();
      const secondSelection = await claimDueMonitoringAccounts({
        attemptId: secondAttemptId,
        now: nextRunAt,
        limit: 6,
      });
      expect(secondSelection).toEqual([
        expect.objectContaining({ accountId: accountIds[6], dueCount: 1 }),
      ]);
      await expect(
        completeMonitoringAccountAttempt({
          accountId: accountIds[6]!,
          attemptId: secondSelection[0]!.attemptId,
          succeeded: true,
          now: nextRunAt,
        }),
      ).resolves.toBe(true);

      const failureState = await database<
        {
          external_account_id: string;
          consecutive_failures: number;
          backoff_until: Date | null;
          current_attempt_id: string | null;
        }[]
      >`
        select advertiser_account.external_account_id,
          schedule.consecutive_failures, schedule.backoff_until,
          schedule.current_attempt_id
        from maintainflow_monitoring_account_schedule schedule
        join maintainflow_advertiser_accounts advertiser_account
          on advertiser_account.id = schedule.advertiser_account_id
        where advertiser_account.external_account_id = any(
          ${accountIds.slice(0, 6)}::text[]
        )
        order by advertiser_account.external_account_id
      `;
      expect(failureState).toHaveLength(6);
      expect(failureState).toEqual(
        expect.arrayContaining(
          accountIds.slice(0, 6).map((accountId) =>
            expect.objectContaining({
              external_account_id: accountId,
              consecutive_failures: 1,
              backoff_until: new Date(now.getTime() + 5 * 60 * 1_000),
              current_attempt_id: null,
            }),
          ),
        ),
      );

      const resetAttemptAt = new Date(now.getTime() + 5 * 60 * 1_000 + 1);
      const resetAttemptId = randomUUID();
      const [resetCandidate] = await claimDueMonitoringAccounts({
        attemptId: resetAttemptId,
        now: resetAttemptAt,
        limit: 1,
      });
      expect(resetCandidate?.accountId).toBe(accountIds[0]);
      await expect(
        completeMonitoringAccountAttempt({
          accountId: accountIds[0]!,
          attemptId: resetCandidate!.attemptId,
          succeeded: true,
          now: resetAttemptAt,
        }),
      ).resolves.toBe(true);
      const [resetState] = await database<
        {
          consecutive_failures: number;
          backoff_until: Date | null;
          last_succeeded_at: Date | null;
        }[]
      >`
        select schedule.consecutive_failures, schedule.backoff_until,
          schedule.last_succeeded_at
        from maintainflow_monitoring_account_schedule schedule
        join maintainflow_advertiser_accounts advertiser_account
          on advertiser_account.id = schedule.advertiser_account_id
        where advertiser_account.external_account_id = ${accountIds[0]!}
      `;
      expect(resetState).toEqual({
        consecutive_failures: 0,
        backoff_until: null,
        last_succeeded_at: resetAttemptAt,
      });
    } finally {
      await removeMonitoringFairnessFixture(accountIds);
    }
  });

  it("rotates successful high-backlog accounts behind an untouched seventh account", async () => {
    const now = new Date("2026-08-31T13:00:00.000Z");
    const accountIds = await createMonitoringFairnessFixture({
      prefix: "fair_success",
      now,
      dueRows: [3, 3, 3, 3, 3, 3, 1],
    });
    try {
      const firstAttemptId = randomUUID();
      const firstSelection = await claimDueMonitoringAccounts({
        attemptId: firstAttemptId,
        now,
        limit: 6,
      });
      expect(firstSelection.map((account) => account.accountId)).toEqual(
        accountIds.slice(0, 6),
      );
      expect(firstSelection.every((account) => account.dueCount === 3)).toBe(
        true,
      );
      await Promise.all(
        firstSelection.map((account) =>
          completeMonitoringAccountAttempt({
            accountId: account.accountId,
            attemptId: account.attemptId,
            succeeded: true,
            now,
          }),
        ),
      ).then((results) => expect(results).toEqual(Array(6).fill(true)));

      const secondAttemptId = randomUUID();
      const nextRunAt = new Date(now.getTime() + 1_000);
      const secondSelection = await claimDueMonitoringAccounts({
        attemptId: secondAttemptId,
        now: nextRunAt,
        limit: 6,
      });
      expect(secondSelection[0]?.accountId).toBe(accountIds[6]);
      expect(secondSelection.map((account) => account.accountId)).toContain(
        accountIds[6],
      );
      expect(secondSelection.map((account) => account.accountId)).not.toContain(
        accountIds[5],
      );
      await expect(
        completeMonitoringAccountAttempt({
          accountId: accountIds[5]!,
          attemptId: secondSelection[0]!.attemptId,
          succeeded: false,
          now: nextRunAt,
        }),
      ).resolves.toBe(false);
      await Promise.all(
        secondSelection.map((account) =>
          completeMonitoringAccountAttempt({
            accountId: account.accountId,
            attemptId: account.attemptId,
            succeeded: true,
            now: nextRunAt,
          }),
        ),
      ).then((results) => expect(results).toEqual(Array(6).fill(true)));
    } finally {
      await removeMonitoringFairnessFixture(accountIds);
    }
  });

  it("recovers interrupted Ads operations without retrying an unknown provider outcome", async () => {
    const source = getDemoRecommendation("rec_bid_20");
    if (!source) throw new Error("The operation recovery fixture is missing.");
    const now = new Date("2026-08-31T12:00:00.000Z");
    const staleAt = new Date(
      now.getTime() - APPROVAL_OPERATION_LEASE_MS - 1_000,
    );
    const recommendation = (suffix: string) => ({
      ...source,
      id: `rec_operation_recovery_${suffix}`,
      title: `Operation recovery ${suffix}`,
      entityId: `${source.entityId}_${suffix}`,
    });

    const applyNotAttempted = recommendation("apply_not_attempted");
    const applyNotAttemptedId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: applyNotAttempted,
      access: advertiserAccess,
    });
    await database`
      update ads_approval_records set updated_at = ${staleAt}
      where id = ${applyNotAttemptedId}
    `;

    const applyAttempted = recommendation("apply_attempted");
    const applyAttemptedId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: applyAttempted,
      access: advertiserAccess,
    });
    await markApprovalProviderAttempt({
      id: applyAttemptedId,
      accountId: advertiserAccountId,
      attemptId: applyAttemptedId,
      status: "pending",
      now: staleAt,
    });

    const rollbackNotAttempted = recommendation("rollback_not_attempted");
    const rollbackNotAttemptedId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: rollbackNotAttempted,
      access: advertiserAccess,
    });
    await updateApprovalRecord(rollbackNotAttemptedId, "applied");
    await claimApprovalRollback(
      rollbackNotAttemptedId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    await database`
      update ads_approval_records set updated_at = ${staleAt}
      where id = ${rollbackNotAttemptedId}
    `;

    const rollbackAttempted = recommendation("rollback_attempted");
    const rollbackAttemptedId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: rollbackAttempted,
      access: advertiserAccess,
    });
    await updateApprovalRecord(rollbackAttemptedId, "applied");
    const rollbackAttemptedClaim = await claimApprovalRollback(
      rollbackAttemptedId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    await markApprovalProviderAttempt({
      id: rollbackAttemptedId,
      accountId: advertiserAccountId,
      attemptId: rollbackAttemptedClaim.attemptId,
      status: "rollback_pending",
      now: staleAt,
    });

    const freshRecommendation = recommendation("fresh");
    const freshId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: freshRecommendation,
      access: advertiserAccess,
    });
    const otherAccountRecommendation = recommendation("other_account");
    const otherAccountId = await createApprovalRecord({
      accountId: agencyAccountId,
      operatorId: ownerOperatorId,
      recommendation: otherAccountRecommendation,
      access: agencyAccess,
    });
    await database`
      update ads_approval_records set updated_at = ${staleAt}
      where id = ${otherAccountId}
    `;

    await expect(
      recoverStaleApprovalOperations({
        accountId: advertiserAccountId,
        now,
        limit: 10,
      }),
    ).resolves.toEqual({
      recovered: 4,
      apply: 2,
      rollback: 2,
      backlog: false,
    });
    await expect(
      recoverStaleApprovalOperations({
        accountId: advertiserAccountId,
        now,
        limit: 10,
      }),
    ).resolves.toEqual({
      recovered: 0,
      apply: 0,
      rollback: 0,
      backlog: false,
    });

    const recoveredRows = await database<
      {
        id: string;
        status: string;
        error_message: string | null;
        rollback_error_message: string | null;
      }[]
    >`
      select id, status, error_message, rollback_error_message
      from ads_approval_records
      where id in (
        ${applyNotAttemptedId}, ${applyAttemptedId},
        ${rollbackNotAttemptedId}, ${rollbackAttemptedId},
        ${freshId}, ${otherAccountId}
      )
    `;
    expect(recoveredRows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: applyNotAttemptedId,
        status: "failed",
        error_message: expect.stringMatching(/No mutation was sent/i),
      }),
      expect.objectContaining({
        id: applyAttemptedId,
        status: "reconciliation_required",
        error_message: expect.stringMatching(/provider attempt/i),
      }),
      expect.objectContaining({
        id: rollbackNotAttemptedId,
        status: "rollback_failed",
        rollback_error_message: expect.stringMatching(/No rollback was sent/i),
      }),
      expect.objectContaining({
        id: rollbackAttemptedId,
        status: "rollback_reconciliation_required",
        rollback_error_message: expect.stringMatching(/provider attempt/i),
      }),
      expect.objectContaining({ id: freshId, status: "pending" }),
      expect.objectContaining({ id: otherAccountId, status: "pending" }),
    ]));

    await expect(
      updateApprovalRecord(applyAttemptedId, "applied"),
    ).rejects.toBeInstanceOf(ApprovalTransitionError);
    await expect(
      updateRollbackRecord(rollbackAttemptedId, "rolled_back", {
        accountId: advertiserAccountId,
        attemptId: rollbackAttemptedClaim.attemptId,
      }),
    ).rejects.toBeInstanceOf(ApprovalTransitionError);

    const retryApplyId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: applyNotAttempted,
      access: advertiserAccess,
    });
    expect(retryApplyId).toEqual(expect.any(String));
    await updateApprovalRecord(retryApplyId, "failed");
    const rollbackNotAttemptedRetry = await claimApprovalRollback(
      rollbackNotAttemptedId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    expect(rollbackNotAttemptedRetry).toMatchObject({ id: rollbackNotAttemptedId });
    await updateRollbackRecord(rollbackNotAttemptedId, "rolled_back", {
      accountId: advertiserAccountId,
      attemptId: rollbackNotAttemptedRetry.attemptId,
    });

    const retryableRollback = recommendation("rollback_retry_after_rejection");
    const retryableRollbackId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: retryableRollback,
      access: advertiserAccess,
    });
    await updateApprovalRecord(retryableRollbackId, "applied");
    const firstRetryableRollbackClaim = await claimApprovalRollback(
      retryableRollbackId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    await markApprovalProviderAttempt({
      id: retryableRollbackId,
      accountId: advertiserAccountId,
      attemptId: firstRetryableRollbackClaim.attemptId,
      status: "rollback_pending",
      now: staleAt,
    });
    await updateRollbackRecord(retryableRollbackId, "rollback_failed", {
      accountId: advertiserAccountId,
      attemptId: firstRetryableRollbackClaim.attemptId,
      error: "The provider definitively rejected the first rollback.",
    });
    const [firstRollbackAttempt] = await database<
      { rollback_provider_attempted_at: Date | null }[]
    >`
      select rollback_provider_attempted_at
      from ads_approval_records
      where id = ${retryableRollbackId}
    `;
    expect(firstRollbackAttempt?.rollback_provider_attempted_at).toEqual(
      expect.any(Date),
    );

    const secondRetryableRollbackClaim = await claimApprovalRollback(
      retryableRollbackId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    const [reclaimedRollback] = await database<
      { rollback_provider_attempted_at: Date | null }[]
    >`
      select rollback_provider_attempted_at
      from ads_approval_records
      where id = ${retryableRollbackId}
    `;
    expect(reclaimedRollback?.rollback_provider_attempted_at).toBeNull();
    await expect(
      markApprovalProviderAttempt({
        id: retryableRollbackId,
        accountId: advertiserAccountId,
        attemptId: secondRetryableRollbackClaim.attemptId,
        status: "rollback_pending",
        now,
      }),
    ).resolves.toBeUndefined();
    await updateRollbackRecord(retryableRollbackId, "rolled_back", {
      accountId: advertiserAccountId,
      attemptId: secondRetryableRollbackClaim.attemptId,
    });

    await updateApprovalRecord(freshId, "failed");
    await recoverStaleApprovalOperations({
      accountId: agencyAccountId,
      now,
      limit: 10,
    });
  });

  it("fences apply and rollback provider sends against stale recovery", async () => {
    const source = getDemoRecommendation("rec_bid_20");
    if (!source) throw new Error("The provider-send fence fixture is missing.");
    const startedAt = new Date("2026-08-31T13:00:00.000Z");
    const recoveryAt = new Date(
      startedAt.getTime() + APPROVAL_OPERATION_LEASE_MS + 1_000,
    );
    const recommendation = (suffix: string) => ({
      ...source,
      id: `rec_provider_send_fence_${suffix}`,
      title: `Provider send fence ${suffix}`,
      entityId: `${source.entityId}_${suffix}`,
    });

    const unresolvedBeforeActiveApply =
      await countUnresolvedApprovalOperations({
        accountId: advertiserAccountId,
        now: recoveryAt,
      });
    const activeApplyId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: recommendation("active_apply"),
      access: advertiserAccess,
    });
    await expect(
      markApprovalProviderAttempt({
        id: activeApplyId,
        accountId: agencyAccountId,
        attemptId: activeApplyId,
        status: "pending",
        now: startedAt,
      }),
    ).rejects.toBeInstanceOf(ApprovalTransitionError);
    await markApprovalProviderAttempt({
      id: activeApplyId,
      accountId: advertiserAccountId,
      attemptId: activeApplyId,
      status: "pending",
      now: startedAt,
    });

    let releaseApply!: () => void;
    let markApplyFenceStarted!: () => void;
    const applyRelease = new Promise<void>((resolve) => {
      releaseApply = resolve;
    });
    const applyFenceStarted = new Promise<void>((resolve) => {
      markApplyFenceStarted = resolve;
    });
    let applyProviderCalls = 0;
    const activeApply = withApprovalProviderSendFence(
      {
        id: activeApplyId,
        accountId: advertiserAccountId,
        attemptId: activeApplyId,
        status: "pending",
        now: startedAt,
      },
      async () => {
        markApplyFenceStarted();
        await applyRelease;
        applyProviderCalls += 1;
        return "apply-sent";
      },
    );
    await applyFenceStarted;
    try {
      await expect(
        recoverStaleApprovalOperations({
          accountId: advertiserAccountId,
          now: recoveryAt,
          limit: 10,
        }),
      ).resolves.toEqual({
        recovered: 0,
        apply: 0,
        rollback: 0,
        backlog: false,
      });
      await expect(
        countUnresolvedApprovalOperations({
          accountId: advertiserAccountId,
          now: recoveryAt,
        }),
      ).resolves.toBe(unresolvedBeforeActiveApply + 1);
      expect(applyProviderCalls).toBe(0);
    } finally {
      releaseApply();
    }
    await expect(activeApply).resolves.toBe("apply-sent");
    expect(applyProviderCalls).toBe(1);
    await updateApprovalRecord(activeApplyId, "applied");

    const recoveredApplyId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: recommendation("recovered_apply"),
      access: advertiserAccess,
    });
    await markApprovalProviderAttempt({
      id: recoveredApplyId,
      accountId: advertiserAccountId,
      attemptId: recoveredApplyId,
      status: "pending",
      now: startedAt,
    });
    await expect(
      recoverStaleApprovalOperations({
        accountId: advertiserAccountId,
        now: recoveryAt,
        limit: 10,
      }),
    ).resolves.toMatchObject({ recovered: 1, apply: 1, rollback: 0 });
    let recoveredApplyProviderCalls = 0;
    await expect(
      withApprovalProviderSendFence(
        {
          id: recoveredApplyId,
          accountId: advertiserAccountId,
          attemptId: recoveredApplyId,
          status: "pending",
          now: recoveryAt,
        },
        async () => {
          recoveredApplyProviderCalls += 1;
          return "must-not-send";
        },
      ),
    ).rejects.toBeInstanceOf(ApprovalProviderSendFenceUnavailableError);
    expect(recoveredApplyProviderCalls).toBe(0);

    const unresolvedBeforeActiveRollback =
      await countUnresolvedApprovalOperations({
        accountId: advertiserAccountId,
        now: recoveryAt,
      });
    const activeRollbackId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: recommendation("active_rollback"),
      access: advertiserAccess,
    });
    await updateApprovalRecord(activeRollbackId, "applied");
    const activeRollbackClaim = await claimApprovalRollback(
      activeRollbackId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    await markApprovalProviderAttempt({
      id: activeRollbackId,
      accountId: advertiserAccountId,
      attemptId: activeRollbackClaim.attemptId,
      status: "rollback_pending",
      now: startedAt,
    });

    let releaseRollback!: () => void;
    let markRollbackFenceStarted!: () => void;
    const rollbackRelease = new Promise<void>((resolve) => {
      releaseRollback = resolve;
    });
    const rollbackFenceStarted = new Promise<void>((resolve) => {
      markRollbackFenceStarted = resolve;
    });
    let rollbackProviderCalls = 0;
    const activeRollback = withApprovalProviderSendFence(
      {
        id: activeRollbackId,
        accountId: advertiserAccountId,
        attemptId: activeRollbackClaim.attemptId,
        status: "rollback_pending",
        now: startedAt,
      },
      async () => {
        markRollbackFenceStarted();
        await rollbackRelease;
        rollbackProviderCalls += 1;
        return "rollback-sent";
      },
    );
    await rollbackFenceStarted;
    try {
      await expect(
        recoverStaleApprovalOperations({
          accountId: advertiserAccountId,
          now: recoveryAt,
          limit: 10,
        }),
      ).resolves.toEqual({
        recovered: 0,
        apply: 0,
        rollback: 0,
        backlog: false,
      });
      await expect(
        countUnresolvedApprovalOperations({
          accountId: advertiserAccountId,
          now: recoveryAt,
        }),
      ).resolves.toBe(unresolvedBeforeActiveRollback + 1);
      expect(rollbackProviderCalls).toBe(0);
    } finally {
      releaseRollback();
    }
    await expect(activeRollback).resolves.toBe("rollback-sent");
    expect(rollbackProviderCalls).toBe(1);
    await updateRollbackRecord(activeRollbackId, "rolled_back", {
      accountId: advertiserAccountId,
      attemptId: activeRollbackClaim.attemptId,
    });

    const recoveredRollbackId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: recommendation("recovered_rollback"),
      access: advertiserAccess,
    });
    await updateApprovalRecord(recoveredRollbackId, "applied");
    const recoveredRollbackClaim = await claimApprovalRollback(
      recoveredRollbackId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    await markApprovalProviderAttempt({
      id: recoveredRollbackId,
      accountId: advertiserAccountId,
      attemptId: recoveredRollbackClaim.attemptId,
      status: "rollback_pending",
      now: startedAt,
    });
    await expect(
      recoverStaleApprovalOperations({
        accountId: advertiserAccountId,
        now: recoveryAt,
        limit: 10,
      }),
    ).resolves.toMatchObject({ recovered: 1, apply: 0, rollback: 1 });
    let recoveredRollbackProviderCalls = 0;
    await expect(
      withApprovalProviderSendFence(
        {
          id: recoveredRollbackId,
          accountId: advertiserAccountId,
          attemptId: recoveredRollbackClaim.attemptId,
          status: "rollback_pending",
          now: recoveryAt,
        },
        async () => {
          recoveredRollbackProviderCalls += 1;
          return "must-not-send";
        },
      ),
    ).rejects.toBeInstanceOf(ApprovalProviderSendFenceUnavailableError);
    expect(recoveredRollbackProviderCalls).toBe(0);

    await reconcileApprovalRecord({
      id: recoveredRollbackId,
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      action: "mark_still_applied",
      note: "Ads Manager confirmed that the first rollback was not applied.",
      access: advertiserAccess,
    });
    const replacementRollbackClaim = await claimApprovalRollback(
      recoveredRollbackId,
      advertiserAccountId,
      ownerOperatorId,
      advertiserAccess,
    );
    expect(replacementRollbackClaim.attemptId).not.toBe(
      recoveredRollbackClaim.attemptId,
    );
    const replacementStartedAt = new Date(recoveryAt.getTime() + 1_000);
    await markApprovalProviderAttempt({
      id: recoveredRollbackId,
      accountId: advertiserAccountId,
      attemptId: replacementRollbackClaim.attemptId,
      status: "rollback_pending",
      now: replacementStartedAt,
    });

    let staleRollbackProviderCalls = 0;
    await expect(
      withApprovalProviderSendFence(
        {
          id: recoveredRollbackId,
          accountId: advertiserAccountId,
          attemptId: recoveredRollbackClaim.attemptId,
          status: "rollback_pending",
          now: replacementStartedAt,
        },
        async () => {
          staleRollbackProviderCalls += 1;
          return "stale-worker-must-not-send";
        },
      ),
    ).rejects.toBeInstanceOf(ApprovalProviderSendFenceUnavailableError);
    expect(staleRollbackProviderCalls).toBe(0);

    let replacementRollbackProviderCalls = 0;
    await expect(
      withApprovalProviderSendFence(
        {
          id: recoveredRollbackId,
          accountId: advertiserAccountId,
          attemptId: replacementRollbackClaim.attemptId,
          status: "rollback_pending",
          now: replacementStartedAt,
        },
        async () => {
          replacementRollbackProviderCalls += 1;
          return "replacement-rollback-sent";
        },
      ),
    ).resolves.toBe("replacement-rollback-sent");
    expect(replacementRollbackProviderCalls).toBe(1);
    await expect(
      updateRollbackRecord(recoveredRollbackId, "rolled_back", {
        accountId: advertiserAccountId,
        attemptId: recoveredRollbackClaim.attemptId,
      }),
    ).rejects.toBeInstanceOf(ApprovalTransitionError);
    await updateRollbackRecord(recoveredRollbackId, "rolled_back", {
      accountId: advertiserAccountId,
      attemptId: replacementRollbackClaim.attemptId,
    });

    const failedSendId = await createApprovalRecord({
      accountId: advertiserAccountId,
      operatorId: ownerOperatorId,
      recommendation: recommendation("failed_send"),
      access: advertiserAccess,
    });
    await markApprovalProviderAttempt({
      id: failedSendId,
      accountId: advertiserAccountId,
      attemptId: failedSendId,
      status: "pending",
      now: startedAt,
    });
    await expect(
      withApprovalProviderSendFence(
        {
          id: failedSendId,
          accountId: advertiserAccountId,
          attemptId: failedSendId,
          status: "pending",
          now: startedAt,
        },
        async () => {
          throw new Error("provider connection ended without a response");
        },
      ),
    ).rejects.toThrow("provider connection ended without a response");
    await expect(
      recoverStaleApprovalOperations({
        accountId: advertiserAccountId,
        now: recoveryAt,
        limit: 10,
      }),
    ).resolves.toMatchObject({ recovered: 1, apply: 1, rollback: 0 });
    const [failedSend] = await database<
      { status: string; apply_provider_attempted_at: Date | null }[]
    >`
      select status, apply_provider_attempted_at
      from ads_approval_records
      where id = ${failedSendId}
    `;
    expect(failedSend).toMatchObject({
      status: "reconciliation_required",
      apply_provider_attempted_at: expect.any(Date),
    });
  });

  it("offboards one exact customer account without exposing credentials or crossing tenants", async () => {
    const offboardingAccountId = "adacct_integration_offboarding";
    const offboardingAdsKey = "ads-integration-offboarding-plaintext";
    const offboardingPixelId = "pixel-integration-offboarding";
    const offboardingCapiKey = "capi-integration-offboarding-plaintext";
    const access = await bootstrapWorkspace({
      operatorId: ownerOperatorId,
      organizationName: "Customer Leaving MaintainFlow",
      organizationType: "advertiser",
      accountId: offboardingAccountId,
      accountName: "Offboarding Fixture",
      connection: {
        mode: "vault",
        credential: encryptAdsApiKey({
          apiKey: offboardingAdsKey,
          externalAccountId: offboardingAccountId,
        }),
        verifiedAt: new Date("2026-08-30T19:00:00.000Z"),
      },
    });
    await rotateConversionsApiCredential({
      operatorId: ownerOperatorId,
      accountId: offboardingAccountId,
      access,
      credential: encryptConversionsApiCredential({
        credential: {
          pixelId: offboardingPixelId,
          apiKey: offboardingCapiKey,
        },
        externalAccountId: offboardingAccountId,
      }),
      validatedAt: new Date("2026-08-30T19:05:00.000Z"),
      validation: { providerStatus: 200, eventCount: 1 },
    });
    await addReviewOnlyAccess(offboardingAccountId);

    const source = getDemoRecommendation("rec_bid_20");
    if (!source?.monitoringPlan) {
      throw new Error("The offboarding fixture is missing monitoring evidence.");
    }
    const unresolvedApprovalId = await createApprovalRecord({
      accountId: offboardingAccountId,
      operatorId: ownerOperatorId,
      recommendation: { ...source, id: "rec_offboarding_unresolved" },
      access,
    });
    const blockedPlan = await prepareCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      generatedAt: new Date("2026-08-30T19:10:00.000Z"),
    });
    expect(blockedPlan.confirmationToken).toBeNull();
    expect(blockedPlan.blockers).toEqual([
      expect.stringMatching(/terminal reconciliation state/i),
    ]);
    await updateApprovalRecord(unresolvedApprovalId, "failed", {
      error: "Provider rejected the request before applying it.",
    });

    const appliedApprovalId = await createApprovalRecord({
      accountId: offboardingAccountId,
      operatorId: ownerOperatorId,
      recommendation: { ...source, id: "rec_offboarding_applied" },
      access,
    });
    await updateApprovalRecord(appliedApprovalId, "applied", {
      response: { id: source.entityId, status: "ACTIVE" },
    });
    await database`
      update ads_approval_records set
        monitoring_started_at = ${new Date("2026-08-20T00:00:00.000Z")},
        monitoring_ends_at = ${new Date("2026-08-27T00:00:00.000Z")}
      where id = ${appliedApprovalId}
    `;

    const inFlightMonitoringClaimId = randomUUID();
    await expect(
      claimDueMonitoringRecords({
        accountId: offboardingAccountId,
        claimId: inFlightMonitoringClaimId,
        now: new Date("2026-08-30T19:12:00.000Z"),
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: appliedApprovalId }),
    ]);
    await expect(
      claimApprovalRollback(
        appliedApprovalId,
        offboardingAccountId,
        ownerOperatorId,
        access,
      ),
    ).rejects.toBeInstanceOf(ApprovalTransitionError);
    const monitoringBlockedPlan = await prepareCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      generatedAt: new Date("2026-08-30T19:13:00.000Z"),
    });
    expect(monitoringBlockedPlan.confirmationToken).toBeNull();
    expect(monitoringBlockedPlan.blockers).toEqual([
      expect.stringMatching(/monitoring evaluation.*active database claim/i),
    ]);
    await expect(
      releaseMonitoringClaim({
        id: appliedApprovalId,
        accountId: offboardingAccountId,
        claimId: inFlightMonitoringClaimId,
      }),
    ).resolves.toBe(true);

    const monitoringAccountAttemptId = randomUUID();
    const monitoringAccountAttemptedAt = new Date(
      "2026-08-30T19:13:30.000Z",
    );
    await database`
      insert into maintainflow_monitoring_account_schedule (
        advertiser_account_id, current_attempt_id, attempt_count,
        last_attempted_at, attempt_lease_until, updated_at
      )
      select id, ${monitoringAccountAttemptId}, 1,
        ${monitoringAccountAttemptedAt},
        ${new Date("2026-08-30T19:28:30.000Z")},
        ${monitoringAccountAttemptedAt}
      from maintainflow_advertiser_accounts
      where external_account_id = ${offboardingAccountId}
    `;
    const accountAttemptBlockedPlan = await prepareCustomerOffboarding(
      database,
      {
        accountId: offboardingAccountId,
        organizationId: access.organizationId,
        operatorId: ownerOperatorId,
        generatedAt: new Date("2026-08-30T19:13:35.000Z"),
      },
    );
    expect(accountAttemptBlockedPlan.confirmationToken).toBeNull();
    expect(accountAttemptBlockedPlan.inventory.monitoringAccountSchedules).toBe(
      1,
    );
    expect(accountAttemptBlockedPlan.serializedExport).toContain(
      '"monitoringAccountSchedules"',
    );
    expect(accountAttemptBlockedPlan.blockers).toEqual([
      expect.stringMatching(/scheduled monitoring account attempt.*database lease/i),
    ]);
    await expect(
      completeMonitoringAccountAttempt({
        accountId: offboardingAccountId,
        attemptId: monitoringAccountAttemptId,
        succeeded: true,
        now: new Date("2026-08-30T19:13:40.000Z"),
      }),
    ).resolves.toBe(true);

    const completedMonitoringClaimId = randomUUID();
    await expect(
      claimDueMonitoringRecords({
        accountId: offboardingAccountId,
        claimId: completedMonitoringClaimId,
        now: new Date("2026-08-30T19:13:45.000Z"),
        limit: 1,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: appliedApprovalId }),
    ]);
    const offboardingObservation = {
      rangeStart: Math.floor(
        new Date("2026-08-20T00:00:00.000Z").getTime() / 1_000,
      ),
      rangeEnd: Math.floor(
        new Date("2026-08-27T00:00:00.000Z").getTime() / 1_000,
      ),
      spend: source.monitoringPlan.baseline.spend,
      clickAttributedConversions:
        source.monitoringPlan.baseline.clickAttributedConversions,
      cpa: source.monitoringPlan.baseline.cpa,
      conversionChangePercent: 0,
      baselineClickAttributedConversions:
        source.monitoringPlan.baseline.clickAttributedConversions,
      thresholdPercent: source.monitoringPlan.rollbackRule.thresholdPercent,
      evidenceState: "complete" as const,
    };
    await expect(
      recordMonitoringOutcome({
        id: appliedApprovalId,
        accountId: offboardingAccountId,
        outcome: "within_safeguard",
        observation: offboardingObservation,
        claimId: completedMonitoringClaimId,
        evaluatedAt: new Date("2026-08-30T19:13:46.000Z"),
      }),
    ).resolves.toBe(true);

    const orphanedMonitoringAttemptId = randomUUID();
    await database`
      update maintainflow_monitoring_account_schedule schedule set
        current_attempt_id = ${orphanedMonitoringAttemptId},
        attempt_count = schedule.attempt_count + 1,
        last_attempted_at = ${new Date("2026-08-30T19:13:50.000Z")},
        attempt_lease_until = ${new Date("2026-08-30T19:14:50.000Z")},
        updated_at = ${new Date("2026-08-30T19:13:50.000Z")}
      from maintainflow_advertiser_accounts account
      where account.id = schedule.advertiser_account_id
        and account.external_account_id = ${offboardingAccountId}
    `;
    const expiredAttemptPlan = await prepareCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      generatedAt: new Date("2026-08-30T19:15:00.000Z"),
    });
    expect(expiredAttemptPlan.blockers).toEqual([]);
    expect(
      expiredAttemptPlan.snapshot.monitoringAccountSchedules[0]
        ?.current_attempt_id,
    ).toBe(orphanedMonitoringAttemptId);

    const concurrentApprovalId = await createApprovalRecord({
      accountId: offboardingAccountId,
      operatorId: ownerOperatorId,
      recommendation: {
        ...source,
        id: "rec_offboarding_concurrent_monitoring",
      },
      access,
    });
    await updateApprovalRecord(concurrentApprovalId, "applied", {
      response: { id: source.entityId, status: "ACTIVE" },
    });
    await database`
      update ads_approval_records set
        monitoring_started_at = ${new Date("2026-08-20T00:00:00.000Z")},
        monitoring_ends_at = ${new Date("2026-08-27T00:00:00.000Z")}
      where id = ${concurrentApprovalId}
    `;

    const offboardingCredential = await getAdsCredentialMaterialForAccount(
      offboardingAccountId,
    );
    const refreshClaimedAt = new Date("2026-08-30T19:15:10.000Z");
    const inFlightRefresh = await claimLiveSyncRefresh({
      accountId: offboardingAccountId,
      credentialGeneration: offboardingCredential.credentialGeneration,
      now: refreshClaimedAt,
      leaseMs: 60_000,
    });
    expect(inFlightRefresh).toEqual({
      claimId: expect.any(String),
      expiresAt: new Date("2026-08-30T19:16:10.000Z"),
    });
    const refreshBlockedPlan = await prepareCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      generatedAt: new Date("2026-08-30T19:15:20.000Z"),
    });
    expect(refreshBlockedPlan.confirmationToken).toBeNull();
    expect(refreshBlockedPlan.blockers).toEqual([
      expect.stringMatching(/live account refresh.*database claim/i),
    ]);
    await expect(
      failLiveSyncRefresh({
        accountId: offboardingAccountId,
        credentialGeneration: offboardingCredential.credentialGeneration,
        claimId: inFlightRefresh!.claimId,
        failureCode: "offboarding_drain",
        retryAfter: new Date("2026-08-30T19:15:30.000Z"),
        now: new Date("2026-08-30T19:15:30.000Z"),
      }),
    ).resolves.toBe(true);

    const plan = await prepareCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      generatedAt: new Date("2026-08-30T19:16:00.000Z"),
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.confirmationToken).toMatch(
      /^OFFBOARD:adacct_integration_offboarding:[a-f0-9]{64}$/,
    );
    expect(plan.inventory).toMatchObject({
      accessGrants: 2,
      advertiserCredentials: 1,
      conversionCredentials: 1,
      approvals: 3,
      unresolvedApprovals: 0,
      monitoringAccountSchedules: 1,
    });
    expect(plan.serializedExport).not.toContain(offboardingAdsKey);
    expect(plan.serializedExport).not.toContain(offboardingCapiKey);
    expect(plan.serializedExport).not.toContain(offboardingPixelId);
    expect(plan.serializedExport).not.toMatch(
      /ciphertext|initialization_vector|authentication_tag/i,
    );

    let wrongTokenExportCalled = false;
    await expect(
      applyCustomerOffboarding(database, {
        accountId: offboardingAccountId,
        organizationId: access.organizationId,
        operatorId: ownerOperatorId,
        confirmationToken: `${plan.confirmationToken}-wrong`,
        writeValidatedExport: async () => {
          wrongTokenExportCalled = true;
        },
      }),
    ).rejects.toThrow(/does not match/i);
    expect(wrongTokenExportCalled).toBe(false);
    await expect(
      getAdsApiKeyForAccount(offboardingAccountId),
    ).resolves.toBe(offboardingAdsKey);
    await expect(
      requireAccountAccess(viewerOperatorId, offboardingAccountId, "read"),
    ).resolves.toMatchObject({ accountRole: "viewer" });

    const concurrentReadinessAudit: ReadinessAudit = {
      requestedUrl: "https://leaving.example/products/final",
      finalUrl: "https://leaving.example/products/final",
      scannedAt: "2026-08-30T19:20:30.000Z",
      score: 90,
      verdict: "ready",
      checks: [
        {
          id: "oai_searchbot",
          title: "OAI-SearchBot is allowed",
          status: "pass",
          weight: 15,
          evidence: "No blocking rule applies.",
          recommendation: "Keep public crawler access available.",
        },
      ],
      measurement: {
        status: "not_detected",
        sdkDetected: false,
        initializationDetected: false,
        pixelIdDetected: false,
        imageTagDetected: false,
        consentSignalDetected: false,
        eventNames: [],
        csp: { present: false, compatible: false, missingSources: [] },
        checks: [],
      },
      limitations: ["Static evidence only; no runtime events were fired."],
    };
    let committedExport = "";
    let releaseValidatedExport!: () => void;
    let markValidatedExportStarted!: () => void;
    const validatedExportRelease = new Promise<void>((resolve) => {
      releaseValidatedExport = resolve;
    });
    const validatedExportStarted = new Promise<void>((resolve) => {
      markValidatedExportStarted = resolve;
    });
    const offboarding = applyCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      confirmationToken: plan.confirmationToken,
      generatedAt: new Date("2026-08-30T19:20:00.000Z"),
      writeValidatedExport: async ({ serialized }: { serialized: string }) => {
        committedExport = serialized;
        markValidatedExportStarted();
        await validatedExportRelease;
      },
    });
    await validatedExportStarted;
    const concurrentReadinessSave = recordReadinessAuditRun({
      accountId: offboardingAccountId,
      operatorId: ownerOperatorId,
      access,
      audit: concurrentReadinessAudit,
    });
    const concurrentRotation = rotateAdsApiCredential({
      operatorId: ownerOperatorId,
      accountId: offboardingAccountId,
      access,
      credential: encryptAdsApiKey({
        apiKey: "must-not-land-after-offboarding",
        externalAccountId: offboardingAccountId,
      }),
      verifiedAt: new Date("2026-08-30T19:21:00.000Z"),
    });
    const concurrentLiveRefreshClaim = claimLiveSyncRefresh({
      accountId: offboardingAccountId,
      credentialGeneration: offboardingCredential.credentialGeneration,
      now: new Date("2026-08-30T19:20:30.000Z"),
      leaseMs: 60_000,
    });
    const concurrentMonitoringClaimId = randomUUID();
    const concurrentMonitoringClaim = claimDueMonitoringRecords({
      accountId: offboardingAccountId,
      claimId: concurrentMonitoringClaimId,
      now: new Date("2026-08-30T19:20:30.000Z"),
      limit: 1,
    });
    let concurrentOutcome: "blocked" | "settled" = "blocked";
    let readinessOutcome: "blocked" | "settled" = "blocked";
    let refreshClaimOutcome: "blocked" | "settled" = "blocked";
    let monitoringClaimOutcome: "blocked" | "settled" = "blocked";
    try {
      [
        concurrentOutcome,
        readinessOutcome,
        refreshClaimOutcome,
        monitoringClaimOutcome,
      ] = await Promise.all([
          Promise.race([
            concurrentRotation.then(
              () => "settled" as const,
              () => "settled" as const,
            ),
            new Promise<"blocked">((resolve) =>
              setTimeout(() => resolve("blocked"), 100),
            ),
          ]),
          Promise.race([
            concurrentReadinessSave.then(
              () => "settled" as const,
              () => "settled" as const,
            ),
            new Promise<"blocked">((resolve) =>
              setTimeout(() => resolve("blocked"), 100),
            ),
          ]),
          Promise.race([
            concurrentLiveRefreshClaim.then(
              () => "settled" as const,
              () => "settled" as const,
            ),
            new Promise<"blocked">((resolve) =>
              setTimeout(() => resolve("blocked"), 100),
            ),
          ]),
          Promise.race([
            concurrentMonitoringClaim.then(
              () => "settled" as const,
              () => "settled" as const,
            ),
            new Promise<"blocked">((resolve) =>
              setTimeout(() => resolve("blocked"), 100),
            ),
          ]),
        ]);
    } finally {
      releaseValidatedExport();
    }
    expect(concurrentOutcome).toBe("blocked");
    expect(readinessOutcome).toBe("blocked");
    expect(refreshClaimOutcome).toBe("blocked");
    expect(monitoringClaimOutcome).toBe("blocked");
    const result = await offboarding;
    await expect(concurrentRotation).rejects.toBeInstanceOf(
      AccountAccessForbiddenError,
    );
    await expect(concurrentReadinessSave).rejects.toBeInstanceOf(
      ReadinessHistoryTransitionError,
    );
    await expect(concurrentLiveRefreshClaim).resolves.toBeNull();
    await expect(concurrentMonitoringClaim).resolves.toEqual([]);
    expect(committedExport).toContain(offboardingAccountId);
    expect(committedExport).toContain('"monitoringAccountSchedules"');
    expect(committedExport).not.toContain(offboardingAdsKey);
    expect(result.deleted).toEqual({
      accountAccess: 2,
      advertiserCredentials: 1,
      conversionCredentials: 1,
    });
    expect(result.providerRevocationRequired).toBe(true);

    const [stored] = await database<
      {
        status: string;
        access_count: number;
        ads_credential_count: number;
        conversion_credential_count: number;
        approval_count: number;
        readiness_audit_count: number;
        monitoring_schedule_count: number;
        lifecycle_count: number;
        export_sha256: string;
        provider_revocation_required: boolean;
      }[]
    >`
      select account.status,
        (select count(*)::int from maintainflow_account_access
          where advertiser_account_id = account.id) as access_count,
        (select count(*)::int from maintainflow_advertiser_credentials
          where advertiser_account_id = account.id) as ads_credential_count,
        (select count(*)::int from maintainflow_conversion_credentials
          where advertiser_account_id = account.id) as conversion_credential_count,
        (select count(*)::int from ads_approval_records
          where account_id = account.external_account_id) as approval_count,
        (select count(*)::int from maintainflow_readiness_audit_runs
          where advertiser_account_id = account.id) as readiness_audit_count,
        (select count(*)::int from maintainflow_monitoring_account_schedule
          where advertiser_account_id = account.id) as monitoring_schedule_count,
        (select count(*)::int from maintainflow_customer_lifecycle_records
          where advertiser_account_id = account.id) as lifecycle_count,
        lifecycle.export_sha256, lifecycle.provider_revocation_required
      from maintainflow_advertiser_accounts account
      join maintainflow_customer_lifecycle_records lifecycle
        on lifecycle.advertiser_account_id = account.id
      where account.external_account_id = ${offboardingAccountId}
    `;
    expect(stored).toMatchObject({
      status: "disconnected",
      access_count: 0,
      ads_credential_count: 0,
      conversion_credential_count: 0,
      approval_count: 3,
      readiness_audit_count: 0,
      monitoring_schedule_count: 1,
      lifecycle_count: 1,
      export_sha256: result.exportSha256,
      provider_revocation_required: true,
    });
    const [refreshStateAfterOffboarding] = await database<
      { refresh_claim_id: string | null }[]
    >`
      select snapshot.refresh_claim_id
      from maintainflow_live_workbench_snapshots snapshot
      join maintainflow_advertiser_accounts account
        on account.id = snapshot.advertiser_account_id
      where account.external_account_id = ${offboardingAccountId}
        and snapshot.credential_generation =
          ${offboardingCredential.credentialGeneration}
    `;
    expect(refreshStateAfterOffboarding?.refresh_claim_id).toBeNull();
    const disconnectedMonitoringAttemptId = randomUUID();
    await database`
      update maintainflow_monitoring_account_schedule schedule set
        current_attempt_id = ${disconnectedMonitoringAttemptId},
        attempt_count = schedule.attempt_count + 1,
        last_attempted_at = ${new Date("2026-08-30T19:31:00.000Z")},
        attempt_lease_until = ${new Date("2026-08-30T19:46:00.000Z")},
        updated_at = ${new Date("2026-08-30T19:31:00.000Z")}
      from maintainflow_advertiser_accounts account
      where account.id = schedule.advertiser_account_id
        and account.external_account_id = ${offboardingAccountId}
    `;
    await expect(
      completeMonitoringAccountAttempt({
        accountId: offboardingAccountId,
        attemptId: disconnectedMonitoringAttemptId,
        succeeded: true,
        now: new Date("2026-08-30T19:31:01.000Z"),
      }),
    ).resolves.toBe(false);
    const [disconnectedSchedule] = await database<
      { current_attempt_id: string | null }[]
    >`
      select schedule.current_attempt_id
      from maintainflow_monitoring_account_schedule schedule
      join maintainflow_advertiser_accounts account
        on account.id = schedule.advertiser_account_id
      where account.external_account_id = ${offboardingAccountId}
    `;
    expect(disconnectedSchedule?.current_attempt_id).toBe(
      disconnectedMonitoringAttemptId,
    );
    const disconnectedMonitoringClaimId = randomUUID();
    await database`
      update ads_approval_records set
        monitoring_evaluation_claim_id = ${disconnectedMonitoringClaimId},
        monitoring_evaluation_claimed_at =
          ${new Date("2026-08-30T19:31:02.000Z")}
      where id = ${concurrentApprovalId}
    `;
    await expect(
      recordMonitoringOutcome({
        id: concurrentApprovalId,
        accountId: offboardingAccountId,
        outcome: "within_safeguard",
        observation: offboardingObservation,
        claimId: disconnectedMonitoringClaimId,
        evaluatedAt: new Date("2026-08-30T19:31:03.000Z"),
      }),
    ).resolves.toBe(false);
    const [disconnectedMonitoringRecord] = await database<
      { monitoring_evaluation_claim_id: string | null }[]
    >`
      select monitoring_evaluation_claim_id
      from ads_approval_records
      where id = ${concurrentApprovalId}
    `;
    expect(
      disconnectedMonitoringRecord?.monitoring_evaluation_claim_id,
    ).toBe(disconnectedMonitoringClaimId);
    await expect(
      requireAccountAccess(ownerOperatorId, offboardingAccountId, "read"),
    ).rejects.toBeInstanceOf(AccountAccessForbiddenError);
    await expect(
      listDueMonitoringAccountIds(new Date("2026-08-30T19:30:00.000Z")),
    ).resolves.not.toContain(offboardingAccountId);
    await expect(
      claimDueMonitoringRecords({
        accountId: offboardingAccountId,
        claimId: randomUUID(),
        now: new Date("2026-08-30T19:30:00.000Z"),
        limit: 5,
      }),
    ).resolves.toEqual([]);
    await expect(
      getAdsApiKeyForAccount(offboardingAccountId),
    ).rejects.toBeInstanceOf(AdvertiserCredentialUnavailableError);
    await expect(
      getAdsApiKeyForAccount(advertiserAccountId),
    ).resolves.toBe(replacementAdvertiserKey);
    await expect(
      requireAccountAccess(ownerOperatorId, advertiserAccountId, "write"),
    ).resolves.toMatchObject({ accountId: advertiserAccountId });
    await expect(
      applyCustomerOffboarding(database, {
        accountId: offboardingAccountId,
        organizationId: access.organizationId,
        operatorId: ownerOperatorId,
        confirmationToken: plan.confirmationToken,
        writeValidatedExport: async () => {},
      }),
    ).rejects.toThrow(/authority could not be resolved/i);

    const lifecycleEvidenceReference = `case_${randomUUID()}`;
    const revocationConfirmedAt = new Date();
    const providerRevokedAt = new Date(
      revocationConfirmedAt.getTime() - 1_000,
    );
    const retainUntil = new Date(revocationConfirmedAt.getTime() + 60_000);
    const revocationPlan = await prepareProviderRevocationConfirmation(
      database,
      {
        lifecycleId: result.lifecycleId,
        providerRevokedAt,
        evidenceReference: lifecycleEvidenceReference,
        retainUntil,
        confirmedAt: revocationConfirmedAt,
      },
    );
    expect(revocationPlan.blockers).toEqual([]);
    expect(revocationPlan.confirmationToken).toMatch(
      /^RECORD-EXTERNAL-REVOCATION:[a-f0-9]{64}$/,
    );
    for (const sensitive of [
      result.lifecycleId,
      result.advertiserAccountId,
      offboardingAccountId,
      access.organizationId,
      ownerOperatorId,
      lifecycleEvidenceReference,
      offboardingAdsKey,
      offboardingCapiKey,
      offboardingPixelId,
    ]) {
      expect(revocationPlan.serializedEvidence).not.toContain(sensitive);
    }

    let wrongRevocationEvidenceCalled = false;
    await expect(
      applyProviderRevocationConfirmation(database, {
        lifecycleId: result.lifecycleId,
        providerRevokedAt,
        evidenceReference: lifecycleEvidenceReference,
        retainUntil,
        confirmedAt: revocationConfirmedAt,
        confirmationToken: `${revocationPlan.confirmationToken}-wrong`,
        writeValidatedEvidence: async () => {
          wrongRevocationEvidenceCalled = true;
        },
      }),
    ).rejects.toThrow(/does not match/i);
    expect(wrongRevocationEvidenceCalled).toBe(false);

    let recordedRevocationEvidence = "";
    const revocationResult = await applyProviderRevocationConfirmation(database, {
      lifecycleId: result.lifecycleId,
      providerRevokedAt,
      evidenceReference: lifecycleEvidenceReference,
      retainUntil,
      confirmedAt: revocationConfirmedAt,
      confirmationToken: revocationPlan.confirmationToken,
      writeValidatedEvidence: async ({ serialized }: { serialized: string }) => {
        recordedRevocationEvidence = serialized;
      },
    });
    expect(recordedRevocationEvidence).toBe(
      revocationPlan.serializedEvidence,
    );
    expect(revocationResult).toMatchObject({
      providerRevokedAt,
      retainUntil,
      evidenceSha256: revocationPlan.evidenceSha256,
    });
    const [confirmedLifecycle] = await database<
      {
        provider_revocation_required: boolean;
        provider_revoked_at: Date;
        provider_revocation_confirmed_at: Date;
        provider_revocation_evidence_ref: string;
        provider_revocation_confirmation_sha256: string;
        retain_until: Date;
      }[]
    >`
      select provider_revocation_required, provider_revoked_at,
        provider_revocation_confirmed_at, provider_revocation_evidence_ref,
        provider_revocation_confirmation_sha256, retain_until
      from maintainflow_customer_lifecycle_records
      where id = ${result.lifecycleId}
    `;
    expect(confirmedLifecycle).toMatchObject({
      provider_revocation_required: false,
      provider_revoked_at: providerRevokedAt,
      provider_revocation_confirmed_at: revocationConfirmedAt,
      provider_revocation_evidence_ref: lifecycleEvidenceReference,
      provider_revocation_confirmation_sha256:
        revocationPlan.evidenceSha256,
      retain_until: retainUntil,
    });

    const earlyPurgePlan = await prepareRetentionPurge(database, {
      lifecycleId: result.lifecycleId,
      now: new Date(retainUntil.getTime() - 1),
    });
    expect(earlyPurgePlan.confirmationToken).toBeNull();
    expect(earlyPurgePlan.blockers).toEqual([
      expect.stringMatching(/retention deadline has not elapsed/i),
    ]);

    const purgeAt = new Date(retainUntil.getTime() + 1_000);
    await database`
      update ads_approval_records set status = 'rollback_failed'
      where id = ${concurrentApprovalId}
    `;
    const unresolvedPurgePlan = await prepareRetentionPurge(database, {
      lifecycleId: result.lifecycleId,
      now: purgeAt,
    });
    expect(unresolvedPurgePlan.confirmationToken).toBeNull();
    expect(unresolvedPurgePlan.blockers).toEqual([
      expect.stringMatching(/unresolved state/i),
    ]);
    await database`
      update ads_approval_records set status = 'applied'
      where id = ${concurrentApprovalId}
    `;
    const purgePlan = await prepareRetentionPurge(database, {
      lifecycleId: result.lifecycleId,
      now: purgeAt,
    });
    expect(purgePlan.blockers).toEqual([]);
    expect(purgePlan.confirmationToken).toMatch(
      /^PURGE-RETAINED-DATA:[a-f0-9]{64}$/,
    );
    expect(purgePlan.inventory).toMatchObject({
      accessGrants: 0,
      advertiserCredentials: 0,
      conversionCredentials: 0,
      approvals: 3,
      monitoringAccountSchedules: 1,
    });
    for (const sensitive of [
      result.lifecycleId,
      result.advertiserAccountId,
      offboardingAccountId,
      access.organizationId,
      ownerOperatorId,
      lifecycleEvidenceReference,
    ]) {
      expect(purgePlan.serializedEvidence).not.toContain(sensitive);
    }

    let wrongPurgeEvidenceCalled = false;
    await expect(
      applyRetentionPurge(database, {
        lifecycleId: result.lifecycleId,
        now: purgeAt,
        confirmationToken: `${purgePlan.confirmationToken}-wrong`,
        writeValidatedEvidence: async () => {
          wrongPurgeEvidenceCalled = true;
        },
      }),
    ).rejects.toThrow(/does not match/i);
    expect(wrongPurgeEvidenceCalled).toBe(false);

    let releasePurgeEvidence!: () => void;
    let markPurgeEvidenceStarted!: () => void;
    const purgeEvidenceRelease = new Promise<void>((resolve) => {
      releasePurgeEvidence = resolve;
    });
    const purgeEvidenceStarted = new Promise<void>((resolve) => {
      markPurgeEvidenceStarted = resolve;
    });
    let recordedPurgeEvidence = "";
    const purge = applyRetentionPurge(database, {
      lifecycleId: result.lifecycleId,
      now: purgeAt,
      confirmationToken: purgePlan.confirmationToken,
      writeValidatedEvidence: async ({ serialized }: { serialized: string }) => {
        recordedPurgeEvidence = serialized;
        markPurgeEvidenceStarted();
        await purgeEvidenceRelease;
      },
    });
    await purgeEvidenceStarted;
    const concurrentAccountUpdate = database`
      update maintainflow_advertiser_accounts set name = 'Must not survive purge'
      where id = ${result.advertiserAccountId}
      returning id
    `;
    const lockOutcome = await Promise.race([
      concurrentAccountUpdate.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), 100),
      ),
    ]);
    expect(lockOutcome).toBe("blocked");
    releasePurgeEvidence();
    const purgeResult = await purge;
    await expect(concurrentAccountUpdate).resolves.toEqual([]);
    expect(recordedPurgeEvidence).toBe(purgePlan.serializedEvidence);
    expect(purgeResult.deleted).toEqual(purgePlan.inventory);

    const [purgedLifecycle] = await database<
      {
        advertiser_account_id: string | null;
        external_account_id: string | null;
        acting_organization_id: string | null;
        operator_id: string | null;
        provider_revocation_required: boolean;
        provider_revocation_evidence_ref: string;
        retain_until: Date;
        purge_completed_at: Date;
        purge_evidence_sha256: string;
      }[]
    >`
      select advertiser_account_id, external_account_id,
        acting_organization_id, operator_id, provider_revocation_required,
        provider_revocation_evidence_ref, retain_until,
        purge_completed_at, purge_evidence_sha256
      from maintainflow_customer_lifecycle_records
      where id = ${result.lifecycleId}
    `;
    expect(purgedLifecycle).toMatchObject({
      advertiser_account_id: null,
      external_account_id: null,
      acting_organization_id: null,
      operator_id: null,
      provider_revocation_required: false,
      provider_revocation_evidence_ref: lifecycleEvidenceReference,
      retain_until: retainUntil,
      purge_completed_at: purgeAt,
      purge_evidence_sha256: purgePlan.evidenceSha256,
    });
    const [purgedCounts] = await database<
      {
        account_count: number;
        approval_count: number;
        organization_count: number;
        membership_count: number;
      }[]
    >`
      select
        (select count(*)::int from maintainflow_advertiser_accounts
          where id = ${result.advertiserAccountId}) as account_count,
        (select count(*)::int from ads_approval_records
          where account_id = ${offboardingAccountId}) as approval_count,
        (select count(*)::int from maintainflow_organizations
          where id = ${access.organizationId}) as organization_count,
        (select count(*)::int from maintainflow_organization_memberships
          where organization_id = ${access.organizationId}) as membership_count
    `;
    expect(purgedCounts).toEqual({
      account_count: 0,
      approval_count: 0,
      organization_count: 1,
      membership_count: 1,
    });
    await expect(
      getAdsApiKeyForAccount(advertiserAccountId),
    ).resolves.toBe(replacementAdvertiserKey);
  });
});
