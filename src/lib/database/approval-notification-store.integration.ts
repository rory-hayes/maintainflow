import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  APPROVAL_NOTIFICATION_CONFIRMATION_RECOVERY_MS,
  APPROVAL_NOTIFICATION_IDEMPOTENCY_RECOVERY_MS,
  ApprovalNotificationStoreUnavailableError,
  claimApprovalNotificationDeliveries,
  enqueueApprovalNotificationDeliveriesInTransaction,
  finalizeApprovalNotificationDelivery,
  isApprovalNotificationClaimEligible,
  recordApprovalNotificationProviderEvent,
  resolveApprovalNotificationDeepLink,
} from "@/lib/approvals/notification-delivery-store.server";
import { closeRuntimeDatabase } from "@/lib/database/client.server";

const ownerDatabaseUrl = process.env.DATABASE_URL;
if (!ownerDatabaseUrl) {
  throw new Error("DATABASE_URL is required for the database integration suite.");
}
const runtimeDatabaseUrl =
  process.env.MAINTAINFLOW_TEST_RUNTIME_DATABASE_URL ?? ownerDatabaseUrl;
const ownerDatabase = postgres(ownerDatabaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 2,
  prepare: false,
});
const runtimeDatabase = postgres(runtimeDatabaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 2,
  max_pipeline: 0,
  prepare: false,
});

const firstOrganizationId = randomUUID();
const secondOrganizationId = randomUUID();
const requesterId = `user_store_requester_${randomUUID()}`;
const firstReviewerId = `user_store_reviewer_${randomUUID()}`;
const secondReviewerId = `user_store_reviewer_${randomUUID()}`;
const originalDatabaseUrl = process.env.DATABASE_URL;

async function seedRequest(organizationId: string, requesterOperatorId: string) {
  const requestId = randomUUID();
  const now = new Date();
  await ownerDatabase`
    insert into maintainflow_change_approval_requests (
      id, organization_id, account_id_snapshot, account_name_snapshot,
      source, recommendation_id, recommendation_title, entity_id,
      recommendation_fingerprint, decision_context, request_payload,
      rollback_payload, evidence_payload, safeguard,
      requester_operator_id, requester_name_snapshot,
      requester_membership_role, requested_at, expires_at
    ) values (
      ${requestId}, ${organizationId}, ${`account_${requestId}`},
      'Store integration account', 'simulator',
      ${`recommendation_${requestId}`}, 'Review a guarded change',
      ${`entity_${requestId}`}, ${"a".repeat(64)},
      ${ownerDatabase.json({ schemaVersion: "simulator" })},
      ${ownerDatabase.json({ operation: "update" })},
      ${ownerDatabase.json({ operation: "restore" })},
      ${ownerDatabase.json({ source: "store_integration" })},
      'Require independent review.', ${requesterOperatorId},
      'Store Integration Requester', 'analyst', ${now},
      ${new Date(now.getTime() + 60 * 60 * 1_000)}
    )
  `;
  return requestId;
}

async function enqueueReview(
  organizationId: string,
  approvalRequestId: string,
) {
  return runtimeDatabase.begin((transaction) =>
    enqueueApprovalNotificationDeliveriesInTransaction(transaction, {
      approvalRequestId,
      organizationId,
      eventType: "review_requested",
      approvalRequestVersion: 1,
    }),
  );
}

describe("approval notification application store", () => {
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", runtimeDatabaseUrl);
    vi.stubEnv("MAINTAINFLOW_APPROVAL_EMAIL_ENABLED", "true");
    vi.stubEnv(
      "MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS",
      `${firstOrganizationId},${secondOrganizationId}`,
    );
    await ownerDatabase`
      insert into maintainflow_organizations (id, name, customer_type, status)
      values
        (${firstOrganizationId}, 'First Store Agency', 'agency', 'active'),
        (${secondOrganizationId}, 'Second Store Agency', 'agency', 'active')
    `;
    await ownerDatabase`
      insert into maintainflow_organization_memberships (
        organization_id, clerk_user_id, role
      ) values
        (${firstOrganizationId}, ${requesterId}, 'analyst'),
        (${firstOrganizationId}, ${firstReviewerId}, 'admin'),
        (${secondOrganizationId}, ${requesterId}, 'analyst'),
        (${secondOrganizationId}, ${secondReviewerId}, 'owner')
    `;
  });

  afterAll(async () => {
    await closeRuntimeDatabase();
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.unstubAllEnvs();
    await ownerDatabase`
      delete from maintainflow_change_approval_requests
      where organization_id in (${firstOrganizationId}, ${secondOrganizationId})
    `;
    await ownerDatabase`
      delete from maintainflow_organization_memberships
      where organization_id in (${firstOrganizationId}, ${secondOrganizationId})
    `;
    await ownerDatabase`
      delete from maintainflow_organizations
      where id in (${firstOrganizationId}, ${secondOrganizationId})
    `;
    await runtimeDatabase.end({ timeout: 5 });
    await ownerDatabase.end({ timeout: 5 });
  });

  it("runs the real single-organization claim, retry, finalize, webhook, and cancellation queries", async () => {
    const firstRequestId = await seedRequest(firstOrganizationId, requesterId);
    const secondRequestId = await seedRequest(secondOrganizationId, requesterId);
    const [firstDeliveryId] = await enqueueReview(
      firstOrganizationId,
      firstRequestId,
    );
    const [secondDeliveryId] = await enqueueReview(
      secondOrganizationId,
      secondRequestId,
    );
    expect(firstDeliveryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondDeliveryId).toMatch(/^[0-9a-f-]{36}$/);

    const firstBatch = await claimApprovalNotificationDeliveries({ limit: 25 });
    expect(firstBatch.deliveries).toHaveLength(1);
    expect(firstBatch.recovery).toEqual({
      cancelledIneligible: 0,
      retryScheduledAfterLeaseExpiry: 0,
      permanentFailuresAfterLeaseExpiry: 0,
      permanentFailuresAfterIdempotencyExpiry: 0,
      permanentFailuresAfterConfirmationTimeout: 0,
    });
    const firstClaim = firstBatch.deliveries[0]!;
    expect(
      [firstOrganizationId, secondOrganizationId],
    ).toContain(firstClaim.organizationId);
    expect(
      await isApprovalNotificationClaimEligible({
        deliveryId: firstClaim.id,
        claimId: firstClaim.claimId,
      }),
    ).toBe(true);

    expect(
      await finalizeApprovalNotificationDelivery({
        deliveryId: firstClaim.id,
        claimId: firstClaim.claimId,
        outcome: { kind: "retry", failureCode: "provider_unavailable" },
      }),
    ).toBe(true);
    const [retryClaim] = (
      await claimApprovalNotificationDeliveries({
      deliveryIds: [firstClaim.id],
      now: new Date(Date.now() + 2 * 60 * 1_000),
      })
    ).deliveries;
    expect(retryClaim?.attemptCount).toBe(2);
    expect(
      await finalizeApprovalNotificationDelivery({
        deliveryId: retryClaim!.id,
        claimId: retryClaim!.claimId,
        outcome: { kind: "accepted", providerMessageId: `email_${randomUUID()}` },
      }),
    ).toBe(true);
    const [accepted] = await ownerDatabase<
      {
        status: string;
        provider_message_id: string;
        last_failure_code: string;
        last_failed_at: Date;
      }[]
    >`
      select status, provider_message_id, last_failure_code, last_failed_at
      from maintainflow_approval_notification_deliveries
      where id = ${firstClaim.id}
    `;
    expect(accepted).toMatchObject({
      status: "provider_accepted",
      last_failure_code: "provider_unavailable",
    });

    expect(
      await recordApprovalNotificationProviderEvent({
        providerMessageId: accepted!.provider_message_id,
        eventType: "email.failed",
        eventAt: new Date(Date.now() + 10_000),
      }),
    ).toBe("updated");
    const [failed] = await ownerDatabase<
      { status: string; last_failure_code: string }[]
    >`
      select status, last_failure_code
      from maintainflow_approval_notification_deliveries
      where id = ${firstClaim.id}
    `;
    expect(failed).toEqual({
      status: "permanent_failure",
      last_failure_code: "provider_rejected",
    });

    const remainingClaim = (
      await claimApprovalNotificationDeliveries({ limit: 25 })
    ).deliveries[0]!;
    expect(remainingClaim.organizationId).not.toBe(firstClaim.organizationId);
    await ownerDatabase`
      update maintainflow_organization_memberships set role = 'analyst'
      where organization_id = ${remainingClaim.organizationId}
        and clerk_user_id = ${remainingClaim.recipientOperatorId}
    `;
    expect(
      await isApprovalNotificationClaimEligible({
        deliveryId: remainingClaim.id,
        claimId: remainingClaim.claimId,
      }),
    ).toBe(false);
    expect(
      await finalizeApprovalNotificationDelivery({
        deliveryId: remainingClaim.id,
        claimId: remainingClaim.claimId,
        outcome: {
          kind: "cancelled",
          cancellationCode: "recipient_ineligible",
        },
      }),
    ).toBe(true);
    const [cancelled] = await ownerDatabase<
      { status: string; cancellation_code: string }[]
    >`
      select status, cancellation_code
      from maintainflow_approval_notification_deliveries
      where id = ${remainingClaim.id}
    `;
    expect(cancelled).toEqual({
      status: "cancelled",
      cancellation_code: "recipient_ineligible",
    });

    expect(
      await resolveApprovalNotificationDeepLink({
        deliveryId: remainingClaim.id,
        operatorId: remainingClaim.recipientOperatorId,
      }),
    ).toMatchObject({ organizationId: remainingClaim.organizationId });
    expect(
      await resolveApprovalNotificationDeepLink({
        deliveryId: remainingClaim.id,
        operatorId: "user_wrong_recipient",
      }),
    ).toBeNull();
    await ownerDatabase`
      update maintainflow_organization_memberships set role = ${
        remainingClaim.organizationId === firstOrganizationId ? "admin" : "owner"
      }
      where organization_id = ${remainingClaim.organizationId}
        and clerk_user_id = ${remainingClaim.recipientOperatorId}
    `;
  }, 20_000);

  it("rejects cross-organization targets before mutation and scopes recovery to the requested tenant", async () => {
    const firstRequestId = await seedRequest(firstOrganizationId, requesterId);
    const secondRequestId = await seedRequest(secondOrganizationId, requesterId);
    const [firstDeliveryId] = await enqueueReview(
      firstOrganizationId,
      firstRequestId,
    );
    const [secondDeliveryId] = await enqueueReview(
      secondOrganizationId,
      secondRequestId,
    );
    const firstClaimBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [firstDeliveryId!],
    });
    expect(firstClaimBatch.deliveries).toHaveLength(1);

    await expect(
      claimApprovalNotificationDeliveries({
        deliveryIds: [firstDeliveryId!, secondDeliveryId!],
        now: new Date(Date.now() + 5 * 60 * 1_000),
      }),
    ).rejects.toBeInstanceOf(ApprovalNotificationStoreUnavailableError);

    const secondClaimBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [secondDeliveryId!],
      now: new Date(Date.now() + 5 * 60 * 1_000),
    });
    expect(secondClaimBatch.deliveries).toHaveLength(1);
    expect(secondClaimBatch.deliveries[0]?.organizationId).toBe(
      secondOrganizationId,
    );
    expect(secondClaimBatch.recovery).toEqual({
      cancelledIneligible: 0,
      retryScheduledAfterLeaseExpiry: 0,
      permanentFailuresAfterLeaseExpiry: 0,
      permanentFailuresAfterIdempotencyExpiry: 0,
      permanentFailuresAfterConfirmationTimeout: 0,
    });

    const [firstDelivery] = await ownerDatabase<
      { status: string; claim_id: string | null; attempt_count: number }[]
    >`
      select status, claim_id, attempt_count
      from maintainflow_approval_notification_deliveries
      where id = ${firstDeliveryId}
    `;
    expect(firstDelivery).toMatchObject({
      status: "sending",
      claim_id: firstClaimBatch.deliveries[0]?.claimId,
      attempt_count: 1,
    });
  }, 20_000);

  it("fails an expired ambiguous send closed after the provider idempotency window", async () => {
    const requestId = await seedRequest(firstOrganizationId, requesterId);
    const [deliveryId] = await enqueueReview(firstOrganizationId, requestId);
    const claimBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
    });
    expect(claimBatch.deliveries).toHaveLength(1);
    const [sending] = await ownerDatabase<{ claimed_at: Date }[]>`
      select claimed_at
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;

    const recoveryBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
      now: new Date(
        sending!.claimed_at.getTime() +
          APPROVAL_NOTIFICATION_IDEMPOTENCY_RECOVERY_MS +
          1,
      ),
    });
    expect(recoveryBatch.deliveries).toEqual([]);
    expect(recoveryBatch.recovery).toEqual({
      cancelledIneligible: 0,
      retryScheduledAfterLeaseExpiry: 0,
      permanentFailuresAfterLeaseExpiry: 1,
      permanentFailuresAfterIdempotencyExpiry: 0,
      permanentFailuresAfterConfirmationTimeout: 0,
    });
    const [failed] = await ownerDatabase<
      { status: string; last_failure_code: string }[]
    >`
      select status, last_failure_code
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(failed).toEqual({
      status: "permanent_failure",
      last_failure_code: "worker_lease_expired",
    });
  }, 20_000);

  it("does not let repeated ambiguous retries reset the original idempotency window", async () => {
    const requestId = await seedRequest(firstOrganizationId, requesterId);
    const [deliveryId] = await enqueueReview(firstOrganizationId, requestId);
    const firstClaimBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
    });
    expect(firstClaimBatch.deliveries).toHaveLength(1);
    const firstClaim = firstClaimBatch.deliveries[0]!;
    const [firstAttempt] = await ownerDatabase<
      { first_attempted_at: Date }[]
    >`
      select first_attempted_at
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(firstAttempt?.first_attempted_at).toBeInstanceOf(Date);

    expect(
      await finalizeApprovalNotificationDelivery({
        deliveryId: firstClaim.id,
        claimId: firstClaim.claimId,
        outcome: { kind: "retry", failureCode: "provider_timeout" },
      }),
    ).toBe(true);
    const retryClaimBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
      now: new Date(
        firstAttempt!.first_attempted_at.getTime() + 2 * 60 * 1_000,
      ),
    });
    const retryClaim = retryClaimBatch.deliveries[0]!;
    expect(retryClaim.attemptCount).toBe(2);
    expect(
      await finalizeApprovalNotificationDelivery({
        deliveryId: retryClaim.id,
        claimId: retryClaim.claimId,
        outcome: { kind: "retry", failureCode: "provider_timeout" },
      }),
    ).toBe(true);

    const [afterRetry] = await ownerDatabase<
      { first_attempted_at: Date; last_failed_at: Date }[]
    >`
      select first_attempted_at, last_failed_at
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(afterRetry?.first_attempted_at.getTime()).toBe(
      firstAttempt!.first_attempted_at.getTime(),
    );

    const recoveryBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
      now: new Date(
        firstAttempt!.first_attempted_at.getTime() +
          APPROVAL_NOTIFICATION_IDEMPOTENCY_RECOVERY_MS +
          1,
      ),
    });
    expect(recoveryBatch.deliveries).toEqual([]);
    expect(recoveryBatch.recovery).toEqual({
      cancelledIneligible: 0,
      retryScheduledAfterLeaseExpiry: 0,
      permanentFailuresAfterLeaseExpiry: 0,
      permanentFailuresAfterIdempotencyExpiry: 1,
      permanentFailuresAfterConfirmationTimeout: 0,
    });
    const [failed] = await ownerDatabase<
      {
        status: string;
        attempt_count: number;
        first_attempted_at: Date;
        last_failure_code: string;
      }[]
    >`
      select status, attempt_count, first_attempted_at, last_failure_code
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(failed).toMatchObject({
      status: "permanent_failure",
      attempt_count: 2,
      last_failure_code: "provider_timeout",
    });
    expect(failed?.first_attempted_at.getTime()).toBe(
      firstAttempt!.first_attempted_at.getTime(),
    );
  }, 20_000);

  it("reports confirmation recovery and applies an early signed terminal event later", async () => {
    const requestId = await seedRequest(firstOrganizationId, requesterId);
    const [deliveryId] = await enqueueReview(firstOrganizationId, requestId);
    const claimBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
    });
    const claim = claimBatch.deliveries[0]!;
    const providerMessageId = `email_${randomUUID()}`;
    expect(
      await finalizeApprovalNotificationDelivery({
        deliveryId: claim.id,
        claimId: claim.claimId,
        outcome: { kind: "accepted", providerMessageId },
      }),
    ).toBe(true);
    const [accepted] = await ownerDatabase<{ provider_accepted_at: Date }[]>`
      select provider_accepted_at
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;

    const recoveryBatch = await claimApprovalNotificationDeliveries({
      deliveryIds: [deliveryId!],
      now: new Date(
        accepted!.provider_accepted_at.getTime() +
          APPROVAL_NOTIFICATION_CONFIRMATION_RECOVERY_MS +
          1,
      ),
    });
    expect(recoveryBatch.deliveries).toEqual([]);
    expect(recoveryBatch.recovery).toEqual({
      cancelledIneligible: 0,
      retryScheduledAfterLeaseExpiry: 0,
      permanentFailuresAfterLeaseExpiry: 0,
      permanentFailuresAfterIdempotencyExpiry: 0,
      permanentFailuresAfterConfirmationTimeout: 1,
    });

    const earlyProviderEventAt = new Date(
      accepted!.provider_accepted_at.getTime() - 1_000,
    );
    expect(
      await recordApprovalNotificationProviderEvent({
        providerMessageId,
        eventType: "email.delivered",
        eventAt: earlyProviderEventAt,
      }),
    ).toBe("updated");
    const [delivered] = await ownerDatabase<
      {
        status: string;
        provider_event_at: Date;
        last_failure_code: string | null;
        last_failed_at: Date | null;
      }[]
    >`
      select status, provider_event_at, last_failure_code, last_failed_at
      from maintainflow_approval_notification_deliveries
      where id = ${deliveryId}
    `;
    expect(delivered).toMatchObject({
      status: "delivered",
      last_failure_code: null,
      last_failed_at: null,
    });
    expect(delivered?.provider_event_at.getTime()).toBe(
      earlyProviderEventAt.getTime(),
    );
  }, 20_000);

  it("enqueues private-beta review email only for an admitted reviewer", async () => {
    const originalMode = process.env.MAINTAINFLOW_ADMISSION_MODE;
    const originalPrivateBetaIds =
      process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS;
    const originalBootstrapIds = process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS;
    try {
      process.env.MAINTAINFLOW_ADMISSION_MODE = "private_beta";
      process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS = "";
      process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS = [
        requesterId,
        firstReviewerId,
      ].join(",");
      const admittedRequestId = await seedRequest(
        firstOrganizationId,
        requesterId,
      );
      await expect(
        enqueueReview(firstOrganizationId, admittedRequestId),
      ).resolves.toHaveLength(1);

      process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS = requesterId;
      const removedReviewerRequestId = await seedRequest(
        firstOrganizationId,
        requesterId,
      );
      await expect(
        enqueueReview(firstOrganizationId, removedReviewerRequestId),
      ).resolves.toEqual([]);
    } finally {
      if (originalMode === undefined) {
        delete process.env.MAINTAINFLOW_ADMISSION_MODE;
      } else {
        process.env.MAINTAINFLOW_ADMISSION_MODE = originalMode;
      }
      if (originalPrivateBetaIds === undefined) {
        delete process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS;
      } else {
        process.env.MAINTAINFLOW_PRIVATE_BETA_OPERATOR_IDS =
          originalPrivateBetaIds;
      }
      if (originalBootstrapIds === undefined) {
        delete process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS;
      } else {
        process.env.MAINTAINFLOW_BOOTSTRAP_OPERATOR_IDS = originalBootstrapIds;
      }
    }
  }, 20_000);
});
