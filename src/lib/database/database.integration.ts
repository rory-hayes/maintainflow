import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import postgres, { type Sql } from "postgres";
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
  ApprovalTransitionError,
  claimApprovalRollback,
  claimDueMonitoringRecords,
  createApprovalRecord,
  getApprovalAccountId,
  listActiveApprovalRecords,
  listApprovalRecords,
  listDueMonitoringAccountIds,
  listDueMonitoringRecords,
  reconcileApprovalRecord,
  recordMonitoringOutcome,
  updateApprovalRecord,
  updateRollbackRecord,
  verifyApprovalStore,
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
import {
  claimLiveSyncRefresh,
  completeLiveSyncRefresh,
  failLiveSyncRefresh,
  pruneExpiredLiveSyncSnapshots,
  readLiveSyncState,
  verifyLiveSyncStore,
} from "../openai-ads/live-sync-store.server";
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
  attachAdvertiserAccountToAgency,
  bootstrapWorkspace,
  getAccountAccess,
  getAdsApiKeyForAccount,
  getAdsCredentialMaterialForAccount,
  getConversionsApiCredentialForAccount,
  listAccountAccesses,
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

async function applyMigrations(sql: Sql) {
  const migrationFiles = [
    "docs/database/001_ads_approval_records.sql",
    "docs/database/002_customer_tenancy.sql",
    "docs/database/003_advertiser_credentials.sql",
    "docs/database/004_creative_review_history.sql",
    "docs/database/005_durable_monitoring_windows.sql",
    "docs/database/006_monitoring_outcomes.sql",
    "docs/database/007_monitoring_evaluation_leases.sql",
    "docs/database/008_readiness_rate_limits.sql",
    "docs/database/009_recommendation_dismissals.sql",
    "docs/database/010_conversion_credentials.sql",
    "docs/database/011_readiness_audit_history.sql",
    "docs/database/012_live_workbench_snapshots.sql",
    "docs/database/013_customer_offboarding.sql",
  ];
  await sql.begin(async (transaction) => {
    for (const migrationFile of migrationFiles) {
      const migration = await readFile(
        path.join(process.cwd(), migrationFile),
        "utf8",
      );
      await transaction.unsafe(migration);
    }
  });
}

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

describe("PostgreSQL customer and approval boundary", () => {
  beforeAll(async () => {
    await applyMigrations(database);
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
    const [runtimeSettings] = await getRuntimeDatabase(databaseUrl)<
      { search_path: string }[]
    >`show search_path`;
    expect(runtimeSettings?.search_path).toBe("public");

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
        },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(AdvertiserCredentialChangedError);

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
    await updateRollbackRecord(rollbackApprovalId, "rolled_back", {
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
    const evaluatedAt = new Date("2026-08-30T12:00:00.000Z");
    await database`
      update ads_approval_records set
        monitoring_started_at = ${startedAt},
        monitoring_ends_at = ${endsAt}
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
    if (!source) throw new Error("The offboarding fixture is missing.");
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

    const plan = await prepareCustomerOffboarding(database, {
      accountId: offboardingAccountId,
      organizationId: access.organizationId,
      operatorId: ownerOperatorId,
      generatedAt: new Date("2026-08-30T19:15:00.000Z"),
    });
    expect(plan.blockers).toEqual([]);
    expect(plan.confirmationToken).toMatch(
      /^OFFBOARD:adacct_integration_offboarding:[a-f0-9]{64}$/,
    );
    expect(plan.inventory).toMatchObject({
      accessGrants: 2,
      advertiserCredentials: 1,
      conversionCredentials: 1,
      approvals: 2,
      unresolvedApprovals: 0,
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
    let concurrentOutcome: "blocked" | "settled" = "blocked";
    try {
      concurrentOutcome = await Promise.race([
        concurrentRotation.then(
          () => "settled" as const,
          () => "settled" as const,
        ),
        new Promise<"blocked">((resolve) =>
          setTimeout(() => resolve("blocked"), 100),
        ),
      ]);
    } finally {
      releaseValidatedExport();
    }
    expect(concurrentOutcome).toBe("blocked");
    const result = await offboarding;
    await expect(concurrentRotation).rejects.toBeInstanceOf(
      AccountAccessForbiddenError,
    );
    expect(committedExport).toContain(offboardingAccountId);
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
      approval_count: 2,
      lifecycle_count: 1,
      export_sha256: result.exportSha256,
      provider_revocation_required: true,
    });
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
  });
});
