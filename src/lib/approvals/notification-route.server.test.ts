import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deliverApprovalNotifications = vi.hoisted(() => vi.fn());

vi.mock("./notification-delivery.server", () => ({
  deliverApprovalNotifications,
}));

import {
  approvalNotificationAttemptMessage,
  attemptApprovalNotificationDelivery,
} from "./notification-route.server";

describe("approval notification route helper", () => {
  beforeEach(() => {
    deliverApprovalNotifications.mockReset();
  });

  it("does not invoke the worker when no delivery was transactionally queued", async () => {
    await expect(attemptApprovalNotificationDelivery([])).resolves.toEqual({
      queued: 0,
      summary: null,
      operatorAttentionRequired: false,
    });
    expect(deliverApprovalNotifications).not.toHaveBeenCalled();
  });

  it("attempts only a bounded immediate batch and reports accepted delivery", async () => {
    deliverApprovalNotifications.mockResolvedValue({
      enabled: true,
      claimed: 5,
      accepted: 5,
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
    });
    const ids = Array.from({ length: 7 }, (_, index) => `delivery-${index}`);

    const result = await attemptApprovalNotificationDelivery(ids);

    expect(deliverApprovalNotifications).toHaveBeenCalledWith({
      deliveryIds: ids,
      limit: 5,
    });
    expect(result).toMatchObject({
      queued: 7,
      operatorAttentionRequired: false,
    });
    expect(approvalNotificationAttemptMessage(result, "reviewer")).toBe(
      "5 reviewer emails were accepted for delivery; 2 reviewer emails remain queued for the background worker.",
    );
  });

  it("distinguishes every immediate and deferred delivery outcome", () => {
    expect(
      approvalNotificationAttemptMessage(
        {
          queued: 7,
          operatorAttentionRequired: true,
          summary: {
            enabled: true,
            claimed: 6,
            accepted: 1,
            retryScheduled: 1,
            permanentlyFailed: 1,
            cancelled: 1,
            lostClaims: 2,
            recovery: {
              cancelledIneligible: 0,
              retryScheduledAfterLeaseExpiry: 0,
              permanentFailuresAfterLeaseExpiry: 0,
              permanentFailuresAfterIdempotencyExpiry: 0,
              permanentFailuresAfterConfirmationTimeout: 0,
            },
          },
        },
        "requester",
      ),
    ).toBe(
      "1 requester email was accepted for delivery; 1 requester email was scheduled for retry; 1 requester email was cancelled because the recipient is no longer eligible; 1 requester email failed permanently and needs operator attention; 2 requester emails could not be safely finalized and need operator attention; 1 requester email remains queued for the background worker.",
    );
  });

  it("does not double-count recovery outcomes as unclaimed work", async () => {
    deliverApprovalNotifications.mockResolvedValue({
      enabled: true,
      claimed: 0,
      accepted: 0,
      retryScheduled: 0,
      permanentlyFailed: 0,
      cancelled: 0,
      lostClaims: 0,
      recovery: {
        cancelledIneligible: 1,
        retryScheduledAfterLeaseExpiry: 1,
        permanentFailuresAfterLeaseExpiry: 1,
        permanentFailuresAfterIdempotencyExpiry: 1,
        permanentFailuresAfterConfirmationTimeout: 1,
      },
    });

    const result = await attemptApprovalNotificationDelivery([
      "delivery-1",
      "delivery-2",
      "delivery-3",
      "delivery-4",
    ]);

    expect(result.operatorAttentionRequired).toBe(true);
    expect(approvalNotificationAttemptMessage(result, "reviewer")).toBe(
      "1 reviewer email was cancelled during recovery because the recipient is no longer eligible; 1 reviewer email was recovered from an expired worker lease and scheduled for retry; 3 reviewer emails failed closed during recovery and need operator attention.",
    );
  });

  it("preserves the committed queue outcome when immediate delivery fails", async () => {
    deliverApprovalNotifications.mockRejectedValue(new Error("private detail"));

    const result = await attemptApprovalNotificationDelivery(["delivery-1"]);

    expect(result).toEqual({
      queued: 1,
      summary: null,
      operatorAttentionRequired: true,
    });
    expect(approvalNotificationAttemptMessage(result, "requester")).toBe(
      "The approval was saved, but email delivery needs operator attention.",
    );
  });
});
