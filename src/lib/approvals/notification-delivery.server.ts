import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { Resend, type ErrorResponse } from "resend";

import { isWorkspaceAdmissionAllowed } from "../auth/config";
import {
  getApprovalEmailProviderConfiguration,
  isApprovalEmailEnabledForOrganization,
} from "./notification-config.server";
import {
  claimApprovalNotificationDeliveries,
  finalizeApprovalNotificationDelivery,
  isApprovalNotificationClaimEligible,
  type ApprovalNotificationRecoverySummary,
  type ApprovalNotificationFailureCode,
  type ClaimedApprovalNotificationDelivery,
} from "./notification-delivery-store.server";
import { buildApprovalNotificationEmail } from "./notification-email";

const PROVIDER_TIMEOUT_MS = 8_000;
const SEND_CONCURRENCY = 5;
const MAX_DELIVERY_ATTEMPTS = 5;

type ClerkDeliveryUser = {
  id: string;
  banned: boolean;
  locked: boolean;
  primaryEmailAddress: {
    emailAddress: string;
    verification: { status: string } | null;
  } | null;
};

type EmailSendResult =
  | { data: { id: string }; error: null }
  | { data: null; error: Pick<ErrorResponse, "name" | "statusCode"> };

type DeliveryDependencies = {
  claim: typeof claimApprovalNotificationDeliveries;
  isEligible: typeof isApprovalNotificationClaimEligible;
  isAdmitted: (operatorId: string) => boolean;
  finalize: typeof finalizeApprovalNotificationDelivery;
  listUsers: (operatorIds: string[]) => Promise<ClerkDeliveryUser[]>;
  sendEmail: (options: {
    apiKey: string;
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
    deliveryId: string;
    eventType: ClaimedApprovalNotificationDelivery["eventType"];
  }) => Promise<EmailSendResult>;
};

const defaultDependencies: DeliveryDependencies = {
  claim: claimApprovalNotificationDeliveries,
  isEligible: isApprovalNotificationClaimEligible,
  isAdmitted: isWorkspaceAdmissionAllowed,
  finalize: finalizeApprovalNotificationDelivery,
  async listUsers(operatorIds) {
    const client = await clerkClient();
    const result = await client.users.getUserList({
      userId: operatorIds,
      limit: Math.min(100, operatorIds.length),
    });
    return result.data;
  },
  async sendEmail(options) {
    const resend = new Resend(options.apiKey);
    return resend.emails.send(
      {
        from: options.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
        tags: [
          { name: "maintainflow_notification_id", value: options.deliveryId },
          { name: "maintainflow_event", value: options.eventType },
        ],
      },
      { idempotencyKey: options.idempotencyKey },
    );
  },
};

export function verifiedPrimaryEmail(user: ClerkDeliveryUser | undefined) {
  if (user?.banned || user?.locked) return null;
  const primary = user?.primaryEmailAddress;
  if (!primary || primary.verification?.status !== "verified") return null;
  return primary.emailAddress;
}

export function classifyApprovalEmailProviderError(
  error: Pick<ErrorResponse, "name" | "statusCode">,
): { kind: "retry" | "permanent_failure"; code: ApprovalNotificationFailureCode } {
  if (
    error.name === "rate_limit_exceeded" ||
    error.name === "daily_quota_exceeded" ||
    error.name === "concurrent_idempotent_requests" ||
    error.statusCode === 429
  ) {
    return { kind: "retry", code: "provider_rate_limited" };
  }
  if (
    error.name === "internal_server_error" ||
    error.name === "application_error" ||
    (typeof error.statusCode === "number" && error.statusCode >= 500)
  ) {
    return { kind: "retry", code: "provider_unavailable" };
  }
  if (
    error.name === "missing_api_key" ||
    error.name === "restricted_api_key" ||
    error.name === "invalid_api_key" ||
    error.name === "monthly_quota_exceeded" ||
    error.name === "invalid_from_address"
  ) {
    return { kind: "permanent_failure", code: "provider_configuration" };
  }
  return { kind: "permanent_failure", code: "provider_rejected" };
}

function applyDeliveryAttemptLimit(
  attemptCount: number,
  outcome: {
    kind: "retry" | "permanent_failure";
    code: ApprovalNotificationFailureCode;
  },
) {
  return outcome.kind === "retry" && attemptCount >= MAX_DELIVERY_ATTEMPTS
    ? ({ kind: "permanent_failure", code: outcome.code } as const)
    : outcome;
}

async function withProviderTimeout<T>(promise: Promise<T>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("Approval email provider timed out.");
          error.name = "ApprovalEmailProviderTimeoutError";
          reject(error);
        }, PROVIDER_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await task(item);
      }
    }),
  );
}

export type ApprovalNotificationDeliverySummary = {
  enabled: boolean;
  claimed: number;
  accepted: number;
  retryScheduled: number;
  permanentlyFailed: number;
  cancelled: number;
  lostClaims: number;
  recovery: ApprovalNotificationRecoverySummary;
};

export async function deliverApprovalNotifications(
  options: { deliveryIds?: readonly string[]; limit?: number; now?: Date } = {},
  dependencies: DeliveryDependencies = defaultDependencies,
): Promise<ApprovalNotificationDeliverySummary> {
  if (process.env.MAINTAINFLOW_APPROVAL_EMAIL_ENABLED !== "true") {
    return {
      enabled: false,
      claimed: 0,
      accepted: 0,
      retryScheduled: 0,
      permanentlyFailed: 0,
      cancelled: 0,
      lostClaims: 0,
      recovery: {
        cancelledIneligible: 0,
        retryScheduledAfterLeaseExpiry: 0,
        permanentFailuresAfterLeaseExpiry: 0,
        permanentFailuresAfterIdempotencyExpiry: 0,
        permanentFailuresAfterConfirmationTimeout: 0,
      },
    };
  }
  const configuration = getApprovalEmailProviderConfiguration();
  const claimBatch = await dependencies.claim(options);
  const claims = claimBatch.deliveries;
  const summary: ApprovalNotificationDeliverySummary = {
    enabled: true,
    claimed: claims.length,
    accepted: 0,
    retryScheduled: 0,
    permanentlyFailed: 0,
    cancelled: 0,
    lostClaims: 0,
    recovery: claimBatch.recovery,
  };
  if (claims.length === 0) return summary;

  const admittedClaims: ClaimedApprovalNotificationDelivery[] = [];
  for (const claim of claims) {
    if (dependencies.isAdmitted(claim.recipientOperatorId)) {
      admittedClaims.push(claim);
      continue;
    }
    const finalized = await dependencies.finalize({
      deliveryId: claim.id,
      claimId: claim.claimId,
      outcome: { kind: "cancelled", cancellationCode: "recipient_ineligible" },
    });
    if (finalized) summary.cancelled += 1;
    else summary.lostClaims += 1;
  }
  if (admittedClaims.length === 0) return summary;

  let users: ClerkDeliveryUser[];
  try {
    users = await dependencies.listUsers([
      ...new Set(admittedClaims.map((claim) => claim.recipientOperatorId)),
    ]);
  } catch {
    await mapWithConcurrency(admittedClaims, SEND_CONCURRENCY, async (claim) => {
      const outcome = applyDeliveryAttemptLimit(claim.attemptCount, {
        kind: "retry",
        code: "identity_provider_unavailable",
      });
      const finalized = await dependencies.finalize({
        deliveryId: claim.id,
        claimId: claim.claimId,
        outcome: {
          kind: outcome.kind,
          failureCode: outcome.code,
        },
      });
      if (!finalized) summary.lostClaims += 1;
      else if (outcome.kind === "retry") summary.retryScheduled += 1;
      else summary.permanentlyFailed += 1;
    });
    return summary;
  }
  const usersById = new Map(users.map((user) => [user.id, user]));

  await mapWithConcurrency(admittedClaims, SEND_CONCURRENCY, async (claim) => {
    if (!isApprovalEmailEnabledForOrganization(claim.organizationId)) {
      const finalized = await dependencies.finalize({
        deliveryId: claim.id,
        claimId: claim.claimId,
        outcome: { kind: "cancelled", cancellationCode: "recipient_ineligible" },
      });
      if (finalized) summary.cancelled += 1;
      else summary.lostClaims += 1;
      return;
    }
    const recipient = verifiedPrimaryEmail(usersById.get(claim.recipientOperatorId));
    if (!recipient) {
      const finalized = await dependencies.finalize({
        deliveryId: claim.id,
        claimId: claim.claimId,
        outcome: {
          kind: "permanent_failure",
          failureCode: "recipient_unavailable",
        },
      });
      if (finalized) summary.permanentlyFailed += 1;
      else summary.lostClaims += 1;
      return;
    }
    if (
      !(await dependencies.isEligible({
        deliveryId: claim.id,
        claimId: claim.claimId,
      }))
    ) {
      const finalized = await dependencies.finalize({
        deliveryId: claim.id,
        claimId: claim.claimId,
        outcome: { kind: "cancelled", cancellationCode: "recipient_ineligible" },
      });
      if (finalized) summary.cancelled += 1;
      else summary.lostClaims += 1;
      return;
    }

    const deepLink = `${configuration.appOrigin}/approvals/open/${claim.id}`;
    const email = buildApprovalNotificationEmail({
      eventType: claim.eventType,
      deepLink,
    });
    let result: EmailSendResult;
    try {
      result = await withProviderTimeout(
        dependencies.sendEmail({
          apiKey: configuration.apiKey,
          from: configuration.from,
          to: recipient,
          ...email,
          idempotencyKey: `maintainflow-approval-v1-${claim.id}`,
          deliveryId: claim.id,
          eventType: claim.eventType,
        }),
      );
    } catch (error) {
      const outcome = applyDeliveryAttemptLimit(claim.attemptCount, {
        kind: "retry",
        code:
          error instanceof Error &&
          error.name === "ApprovalEmailProviderTimeoutError"
            ? "provider_timeout"
            : "provider_unavailable",
      });
      const finalized = await dependencies.finalize({
        deliveryId: claim.id,
        claimId: claim.claimId,
        outcome: {
          kind: outcome.kind,
          failureCode: outcome.code,
        },
      });
      if (!finalized) summary.lostClaims += 1;
      else if (outcome.kind === "retry") summary.retryScheduled += 1;
      else summary.permanentlyFailed += 1;
      return;
    }

    const outcome = result.error
      ? applyDeliveryAttemptLimit(
          claim.attemptCount,
          classifyApprovalEmailProviderError(result.error),
        )
      : { kind: "accepted" as const, providerMessageId: result.data.id };
    const finalized = await dependencies.finalize({
      deliveryId: claim.id,
      claimId: claim.claimId,
      outcome:
        outcome.kind === "accepted"
          ? outcome
          : { kind: outcome.kind, failureCode: outcome.code },
    });
    if (!finalized) summary.lostClaims += 1;
    else if (outcome.kind === "accepted") summary.accepted += 1;
    else if (outcome.kind === "retry") summary.retryScheduled += 1;
    else summary.permanentlyFailed += 1;
  });

  return summary;
}
