import "server-only";

import {
  deliverApprovalNotifications,
  type ApprovalNotificationDeliverySummary,
} from "./notification-delivery.server";

export type ApprovalNotificationAttempt = {
  queued: number;
  summary: ApprovalNotificationDeliverySummary | null;
  operatorAttentionRequired: boolean;
};

export async function attemptApprovalNotificationDelivery(
  deliveryIds: readonly string[] | undefined,
): Promise<ApprovalNotificationAttempt> {
  const ids = deliveryIds ?? [];
  if (ids.length === 0) {
    return { queued: 0, summary: null, operatorAttentionRequired: false };
  }
  try {
    const summary = await deliverApprovalNotifications({
      deliveryIds: ids,
      limit: Math.min(5, ids.length),
    });
    return {
      queued: ids.length,
      summary,
      operatorAttentionRequired:
        summary.permanentlyFailed > 0 ||
        summary.lostClaims > 0 ||
        summary.recovery.permanentFailuresAfterLeaseExpiry > 0 ||
        summary.recovery.permanentFailuresAfterIdempotencyExpiry > 0 ||
        summary.recovery.permanentFailuresAfterConfirmationTimeout > 0,
    };
  } catch {
    return { queued: ids.length, summary: null, operatorAttentionRequired: true };
  }
}

export function approvalNotificationAttemptMessage(
  attempt: ApprovalNotificationAttempt,
  recipientLabel: "reviewer" | "requester",
) {
  if (attempt.queued === 0) {
    return recipientLabel === "reviewer"
      ? "Approval email is not enabled for this workspace."
      : "No approval email was queued.";
  }
  if (!attempt.summary) {
    return "The approval was saved, but email delivery needs operator attention.";
  }
  if (!attempt.summary.enabled) {
    return `${attempt.queued} ${recipientLabel} email${attempt.queued === 1 ? " was" : "s were"} queued, but email delivery is currently disabled.`;
  }

  const summary = attempt.summary;
  const recoveryHandled =
    summary.recovery.cancelledIneligible +
    summary.recovery.retryScheduledAfterLeaseExpiry +
    summary.recovery.permanentFailuresAfterLeaseExpiry +
    summary.recovery.permanentFailuresAfterIdempotencyExpiry +
    summary.recovery.permanentFailuresAfterConfirmationTimeout;
  const unclaimed = Math.max(
    0,
    attempt.queued - summary.claimed - recoveryHandled,
  );
  const clauses: string[] = [];
  const noun = (count: number) =>
    `${count} ${recipientLabel} email${count === 1 ? "" : "s"}`;
  if (summary.accepted > 0) {
    clauses.push(
      `${noun(summary.accepted)} ${summary.accepted === 1 ? "was" : "were"} accepted for delivery`,
    );
  }
  if (summary.retryScheduled > 0) {
    clauses.push(
      `${noun(summary.retryScheduled)} ${summary.retryScheduled === 1 ? "was" : "were"} scheduled for retry`,
    );
  }
  if (summary.cancelled > 0) {
    clauses.push(
      `${noun(summary.cancelled)} ${summary.cancelled === 1 ? "was" : "were"} cancelled because the recipient is no longer eligible`,
    );
  }
  if (summary.permanentlyFailed > 0) {
    clauses.push(
      `${noun(summary.permanentlyFailed)} failed permanently and ${summary.permanentlyFailed === 1 ? "needs" : "need"} operator attention`,
    );
  }
  if (summary.lostClaims > 0) {
    clauses.push(
      `${noun(summary.lostClaims)} could not be safely finalized and ${summary.lostClaims === 1 ? "needs" : "need"} operator attention`,
    );
  }
  if (summary.recovery.cancelledIneligible > 0) {
    clauses.push(
      `${noun(summary.recovery.cancelledIneligible)} ${summary.recovery.cancelledIneligible === 1 ? "was" : "were"} cancelled during recovery because the recipient is no longer eligible`,
    );
  }
  if (summary.recovery.retryScheduledAfterLeaseExpiry > 0) {
    clauses.push(
      `${noun(summary.recovery.retryScheduledAfterLeaseExpiry)} ${summary.recovery.retryScheduledAfterLeaseExpiry === 1 ? "was" : "were"} recovered from an expired worker lease and scheduled for retry`,
    );
  }
  const recoveredPermanent =
    summary.recovery.permanentFailuresAfterLeaseExpiry +
    summary.recovery.permanentFailuresAfterIdempotencyExpiry +
    summary.recovery.permanentFailuresAfterConfirmationTimeout;
  if (recoveredPermanent > 0) {
    clauses.push(
      `${noun(recoveredPermanent)} failed closed during recovery and ${recoveredPermanent === 1 ? "needs" : "need"} operator attention`,
    );
  }
  if (unclaimed > 0) {
    clauses.push(
      `${noun(unclaimed)} ${unclaimed === 1 ? "remains" : "remain"} queued for the background worker`,
    );
  }

  return clauses.length > 0
    ? `${clauses.join("; ")}.`
    : "The approval was saved, but no queued email was claimed.";
}
