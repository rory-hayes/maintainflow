import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { AccountAccess } from "../tenancy/schema";
import {
  acknowledgeChangeIntegrityEvent,
  ChangeIntegritySnapshotOrderError,
  listChangeIntegrityEvents,
  recordChangeIntegritySnapshot,
  verifyChangeIntegrityStore,
} from "../openai-ads/change-integrity-store.server";
import {
  CHANGE_INTEGRITY_PROJECTION_VERSION,
  changeIntegrityFingerprint,
  type ChangeIntegritySnapshot,
} from "../openai-ads/change-integrity";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for the database integration suite.");
}

const owner = postgres(databaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
  prepare: false,
});
const runtime = postgres(
  process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL ?? databaseUrl,
  {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
    prepare: false,
  },
);

const organizationId = randomUUID();
const advertiserAccountId = randomUUID();
const externalAccountId = `adacct_integrity_${randomUUID().replaceAll("-", "")}`;
const operatorId = `user_integrity_${randomUUID().replaceAll("-", "")}`;

const access: AccountAccess = {
  organizationId,
  organizationName: "Integrity Fixture",
  organizationType: "advertiser",
  accountId: externalAccountId,
  accountName: "Integrity Fixture Account",
  connectionMode: "environment",
  membershipRole: "owner",
  accountRole: "owner",
};

function snapshot(observedAt: string, dailySpendLimitMicros: number) {
  const accountConfiguration = {
    name: "Integrity Fixture Account",
    status: "active",
  };
  const campaignConfiguration = {
    name: "Autumn launch",
    status: "active",
    budget: { daily_spend_limit_micros: dailySpendLimitMicros },
  };
  return {
    projectionVersion: CHANGE_INTEGRITY_PROJECTION_VERSION,
    accountId: externalAccountId,
    observationStartedAt: observedAt,
    observedAt,
    resources: [
      {
        resourceType: "ad_account" as const,
        resourceId: externalAccountId,
        parentResourceId: null,
        resourceLabel: "Integrity Fixture Account",
        providerUpdatedAt: null,
        configuration: accountConfiguration,
        fingerprint: changeIntegrityFingerprint(accountConfiguration),
      },
      {
        resourceType: "campaign" as const,
        resourceId: "campaign_integrity_fixture",
        parentResourceId: externalAccountId,
        resourceLabel: "Autumn launch",
        providerUpdatedAt: null,
        configuration: campaignConfiguration,
        fingerprint: changeIntegrityFingerprint(campaignConfiguration),
      },
    ],
  } satisfies ChangeIntegritySnapshot;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForDatabaseLock(applicationName: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const [waiting] = await owner<{ is_waiting: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_stat_activity activity
        where activity.datname = current_database()
          and activity.application_name = ${applicationName}
          and activity.state = 'active'
          and activity.wait_event_type = 'Lock'
      ) as is_waiting
    `;
    if (waiting?.is_waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} did not reach the expected database lock.`);
}

describe("durable change-integrity storage", () => {
  beforeAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`
        insert into public.maintainflow_organizations (
          id, name, customer_type
        ) values (${organizationId}, 'Integrity Fixture', 'advertiser')
      `;
      await transaction`
        insert into public.maintainflow_organization_memberships (
          organization_id, clerk_user_id, role
        ) values (${organizationId}, ${operatorId}, 'owner')
      `;
      await transaction`
        insert into public.maintainflow_advertiser_accounts (
          id, external_account_id, name, owner_organization_id,
          connection_mode, status
        ) values (
          ${advertiserAccountId}, ${externalAccountId},
          'Integrity Fixture Account', ${organizationId},
          'environment', 'active'
        )
      `;
      await transaction`
        insert into public.maintainflow_account_access (
          organization_id, advertiser_account_id, role, granted_by
        ) values (${organizationId}, ${advertiserAccountId}, 'owner', ${operatorId})
      `;
    });
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`
        delete from public.maintainflow_account_access
        where advertiser_account_id = ${advertiserAccountId}
      `;
      await transaction`
        delete from public.maintainflow_advertiser_accounts
        where id = ${advertiserAccountId}
      `;
      await transaction`
        delete from public.maintainflow_organization_memberships
        where organization_id = ${organizationId}
      `;
      await transaction`
        delete from public.maintainflow_organizations
        where id = ${organizationId}
      `;
    });
    await runtime.end({ timeout: 5 });
    await owner.end({ timeout: 5 });
  });

  it("reports the store unavailable while its event guard is disabled", async () => {
    await owner.begin(async (transaction) => {
      await transaction`
        alter table public.maintainflow_ads_config_integrity_events
        disable trigger maintainflow_ads_config_integrity_event_guard
      `;
      await expect(verifyChangeIntegrityStore(transaction)).resolves.toBe(false);
      await transaction`
        alter table public.maintainflow_ads_config_integrity_events
        enable trigger maintainflow_ads_config_integrity_event_guard
      `;
      await expect(verifyChangeIntegrityStore(transaction)).resolves.toBe(true);
    });
  });

  it("stores a credential-independent baseline and immutable review evidence", async () => {
    const baseline = snapshot("2026-09-04T08:00:00.000Z", 10_000_000);
    const changed = snapshot("2026-09-04T08:05:00.000Z", 12_000_000);

    await expect(
      runtime.begin((transaction) =>
        recordChangeIntegritySnapshot({ snapshot: baseline, operations: [] }, transaction),
      ),
    ).resolves.toMatchObject({
      baselineCreated: true,
      baselineAdvanced: true,
      events: [],
    });
    const result = await runtime.begin((transaction) =>
      recordChangeIntegritySnapshot({ snapshot: changed, operations: [] }, transaction),
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      resourceType: "campaign",
      classification: "unexplained",
      reviewStatus: "open",
      changedFieldPaths: ["budget.daily_spend_limit_micros"],
      unexplainedFieldPaths: ["budget.daily_spend_limit_micros"],
    });

    const page = await listChangeIntegrityEvents(
      { accountId: externalAccountId, limit: 1 },
      runtime,
    );
    expect(page).toMatchObject({
      hasMore: false,
      summary: {
        baselineReady: true,
        lastCheckedAt: changed.observedAt,
        retainedEventCount: 1,
        openUnexplainedCount: 1,
        openIndeterminateCount: 0,
        consistentCount: 0,
        reviewedCount: 0,
      },
    });

    const reviewed = await acknowledgeChangeIntegrityEvent(
      {
        accountId: externalAccountId,
        eventId: result.events[0]!.id,
        operatorId,
        reviewerName: "Integration Owner",
        access,
        note: "Confirmed as an expected external account change.",
      },
      runtime,
    );
    expect(reviewed).toMatchObject({
      reviewStatus: "reviewed",
      reviewedByName: "Integration Owner",
    });
    expect(reviewed.reviewedAt).not.toBeNull();

    await expect(
      owner`
        update public.maintainflow_ads_config_integrity_events
        set resource_label = 'Rewritten evidence'
        where id = ${result.events[0]!.id}
      `,
    ).rejects.toThrow(/evidence is immutable/i);

    await expect(
      runtime.begin((transaction) =>
        recordChangeIntegritySnapshot(
          {
            snapshot: snapshot("2026-09-04T08:10:00.000Z", 10_000_000),
            operations: [],
          },
          transaction,
        ),
      ),
    ).resolves.toMatchObject({ events: [expect.objectContaining({ changeType: "updated" })] });
    await expect(
      runtime.begin((transaction) =>
        recordChangeIntegritySnapshot(
          {
            snapshot: snapshot("2026-09-04T08:15:00.000Z", 12_000_000),
            operations: [],
          },
          transaction,
        ),
      ),
    ).resolves.toMatchObject({ events: [expect.objectContaining({ changeType: "updated" })] });
    const [recurrence] = await owner<{ event_count: number }[]>`
      select count(*)::int as event_count
      from public.maintainflow_ads_config_integrity_events
      where advertiser_account_id = ${advertiserAccountId}
    `;
    expect(recurrence?.event_count).toBe(3);

    const ordered = await listChangeIntegrityEvents(
      { accountId: externalAccountId, limit: 10 },
      runtime,
    );
    expect(ordered.events.map((event) => event.reviewStatus)).toEqual([
      "open",
      "open",
      "reviewed",
    ]);

    const [stateShape] = await owner<
      { state_count: number; has_credential_generation: boolean }[]
    >`
      select
        count(*)::int as state_count,
        exists (
          select 1
          from pg_catalog.pg_attribute attribute
          where attribute.attrelid =
            'public.maintainflow_ads_config_integrity_state'::regclass
            and attribute.attname = 'credential_generation'
            and attribute.attnum > 0
            and not attribute.attisdropped
        ) as has_credential_generation
      from public.maintainflow_ads_config_integrity_state
      where advertiser_account_id = ${advertiserAccountId}
    `;
    expect(stateShape).toEqual({
      state_count: 1,
      has_credential_generation: false,
    });
  });

  it("rejects out-of-order or same-time conflicting snapshots", async () => {
    await expect(
      runtime.begin((transaction) =>
        recordChangeIntegritySnapshot(
          {
            snapshot: snapshot("2026-09-04T08:14:00.000Z", 11_000_000),
            operations: [],
          },
          transaction,
        ),
      ),
    ).rejects.toBeInstanceOf(ChangeIntegritySnapshotOrderError);

    await expect(
      runtime.begin((transaction) =>
        recordChangeIntegritySnapshot(
          {
            snapshot: snapshot("2026-09-04T08:15:00.000Z", 13_000_000),
            operations: [],
          },
          transaction,
        ),
      ),
    ).rejects.toBeInstanceOf(ChangeIntegritySnapshotOrderError);
  });

  it("keeps acknowledgement behind the offboarding account/auth/event lock order", async () => {
    const result = await runtime.begin((transaction) =>
      recordChangeIntegritySnapshot(
        {
          snapshot: snapshot("2026-09-04T08:20:00.000Z", 14_000_000),
          operations: [],
        },
        transaction,
      ),
    );
    const event = result.events[0];
    if (!event) throw new Error("The lock-order event fixture is missing.");

    const raceId = randomUUID().replaceAll("-", "");
    const reviewApplicationName = `maintainflow-integrity-review-${raceId}`;
    const offboardingDatabase = postgres(databaseUrl, {
      connection: {
        application_name: `maintainflow-integrity-offboarding-${raceId}`,
      },
      connect_timeout: 5,
      idle_timeout: 5,
      max: 1,
      prepare: false,
    });
    const reviewDatabase = postgres(
      process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL ?? databaseUrl,
      {
        connection: { application_name: reviewApplicationName },
        connect_timeout: 5,
        idle_timeout: 5,
        max: 1,
        prepare: false,
      },
    );
    const offboardingLocksHeld = deferred();
    const allowOffboardingEventLock = deferred();
    let offboarding: Promise<unknown> | undefined;
    let review: ReturnType<typeof acknowledgeChangeIntegrityEvent> | undefined;

    try {
      offboarding = offboardingDatabase.begin(async (transaction) => {
        const [account] = await transaction<{ id: string }[]>`
          select id
          from maintainflow_advertiser_accounts
          where external_account_id = ${externalAccountId}
          for update
        `;
        expect(account?.id).toBe(advertiserAccountId);
        await transaction`
          select organization.id
          from maintainflow_organizations organization
          join maintainflow_organization_memberships membership
            on membership.organization_id = organization.id
          join maintainflow_account_access account_access
            on account_access.organization_id = organization.id
          where organization.id = ${organizationId}
            and membership.clerk_user_id = ${operatorId}
            and account_access.advertiser_account_id = ${advertiserAccountId}
          for update of organization, membership, account_access
        `;
        offboardingLocksHeld.resolve();
        await allowOffboardingEventLock.promise;
        const lockedEvents = await transaction<{ id: string }[]>`
          select id
          from maintainflow_ads_config_integrity_events
          where id = ${event.id}
          for update
        `;
        expect(lockedEvents).toEqual([{ id: event.id }]);
      });

      await offboardingLocksHeld.promise;
      review = acknowledgeChangeIntegrityEvent(
        {
          accountId: externalAccountId,
          eventId: event.id,
          operatorId,
          reviewerName: "Concurrent Integration Owner",
          access,
          note: "Confirmed after the offboarding lock-order regression check.",
        },
        reviewDatabase,
      );
      await waitForDatabaseLock(reviewApplicationName);
      allowOffboardingEventLock.resolve();

      const [reviewed] = await Promise.all([review, offboarding]).then(
        ([reviewedEvent]) => [reviewedEvent],
      );
      expect(reviewed).toMatchObject({
        id: event.id,
        reviewStatus: "reviewed",
        reviewedByName: "Concurrent Integration Owner",
      });
    } finally {
      allowOffboardingEventLock.resolve();
      await Promise.allSettled(
        [review, offboarding].filter(
          (operation): operation is Promise<unknown> => operation !== undefined,
        ),
      );
      await reviewDatabase.end({ timeout: 5 });
      await offboardingDatabase.end({ timeout: 5 });
    }
  });
});
