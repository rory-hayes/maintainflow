import { timingSafeEqual } from "node:crypto";

import { deliverApprovalNotifications } from "@/lib/approvals/notification-delivery.server";
import { createServerLogger } from "@/lib/observability/logger.server";

export const runtime = "nodejs";
export const maxDuration = 60;

function hasAuthorizedCronHeader(request: Request, secret: string) {
  const supplied = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export async function GET(request: Request) {
  const startedAt = Date.now();
  const log = createServerLogger("api.approval_notifications.cron");
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) {
    log.error("approval_notifications.run.unconfigured", { status: 503 });
    return Response.json(
      { ok: false, error: "Approval notification delivery is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!hasAuthorizedCronHeader(request, secret)) {
    return Response.json(
      { ok: false, error: "Unauthorized." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const summary = await deliverApprovalNotifications({ limit: 25 });
    const hasPermanentRecoveryFailures =
      summary.recovery.permanentFailuresAfterLeaseExpiry > 0 ||
      summary.recovery.permanentFailuresAfterIdempotencyExpiry > 0 ||
      summary.recovery.permanentFailuresAfterConfirmationTimeout > 0;
    const hasRecoveryActivity =
      summary.recovery.cancelledIneligible > 0 ||
      summary.recovery.retryScheduledAfterLeaseExpiry > 0 ||
      hasPermanentRecoveryFailures;
    const hasFailures =
      summary.retryScheduled > 0 ||
      summary.permanentlyFailed > 0 ||
      summary.lostClaims > 0 ||
      hasRecoveryActivity;
    const fields = {
      status: hasFailures ? 503 : 200,
      durationMs: Date.now() - startedAt,
      counts: {
        notificationClaimed: summary.claimed,
        notificationAccepted: summary.accepted,
        notificationRetryScheduled: summary.retryScheduled,
        notificationPermanentlyFailed: summary.permanentlyFailed,
        notificationCancelled: summary.cancelled,
        notificationLostClaims: summary.lostClaims,
        notificationRecoveryCancelledIneligible:
          summary.recovery.cancelledIneligible,
        notificationRecoveryRetryScheduledAfterLeaseExpiry:
          summary.recovery.retryScheduledAfterLeaseExpiry,
        notificationRecoveryPermanentFailuresAfterLeaseExpiry:
          summary.recovery.permanentFailuresAfterLeaseExpiry,
        notificationRecoveryPermanentFailuresAfterIdempotencyExpiry:
          summary.recovery.permanentFailuresAfterIdempotencyExpiry,
        notificationRecoveryPermanentFailuresAfterConfirmationTimeout:
          summary.recovery.permanentFailuresAfterConfirmationTimeout,
      },
    };
    if (hasFailures) {
      log.error("approval_notifications.run.completed_with_failures", fields);
    } else {
      log.info("approval_notifications.run.completed", fields);
    }
    return Response.json(
      { ok: !hasFailures, ...summary },
      {
        status: hasFailures ? 503 : 200,
        headers: {
          "Cache-Control": "no-store",
          ...(hasFailures ? { "Retry-After": "300" } : {}),
        },
      },
    );
  } catch (error) {
    log.error("approval_notifications.run.failed", {
      error,
      status: 500,
      durationMs: Date.now() - startedAt,
    });
    return Response.json(
      { ok: false, error: "Approval notifications could not be delivered." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store", "Retry-After": "300" },
      },
    );
  }
}
