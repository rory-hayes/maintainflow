import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  classifyApprovalEmailProviderError,
  deliverApprovalNotifications,
  verifiedPrimaryEmail,
} from "./notification-delivery.server";

const organizationId = "00000000-0000-4000-8000-000000000101";
const deliveryId = "00000000-0000-4000-8000-000000000102";
const claim = {
  id: deliveryId,
  approvalRequestId: "00000000-0000-4000-8000-000000000103",
  organizationId,
  eventType: "review_requested" as const,
  recipientOperatorId: "user_reviewer",
  approvalRequestVersion: 1,
  claimId: "00000000-0000-4000-8000-000000000104",
  attemptCount: 1,
};
const emptyRecovery = {
  cancelledIneligible: 0,
  retryScheduledAfterLeaseExpiry: 0,
  permanentFailuresAfterLeaseExpiry: 0,
  permanentFailuresAfterIdempotencyExpiry: 0,
  permanentFailuresAfterConfirmationTimeout: 0,
};

function configuredEnvironment() {
  vi.stubEnv("MAINTAINFLOW_APPROVAL_EMAIL_ENABLED", "true");
  vi.stubEnv("MAINTAINFLOW_APPROVAL_EMAIL_ORGANIZATION_IDS", organizationId);
  vi.stubEnv("RESEND_API_KEY", `re_${"a".repeat(32)}`);
  vi.stubEnv("RESEND_WEBHOOK_SECRET", `whsec_${"b".repeat(32)}`);
  vi.stubEnv("MAINTAINFLOW_APPROVAL_FROM_EMAIL", "approvals@maintainflow.io");
  vi.stubEnv("MAINTAINFLOW_APP_ORIGIN", "https://maintainflow.io");
}

function dependencies() {
  return {
    claim: vi.fn().mockResolvedValue({
      deliveries: [claim],
      recovery: emptyRecovery,
    }),
    isEligible: vi.fn().mockResolvedValue(true),
    isAdmitted: vi.fn().mockReturnValue(true),
    finalize: vi.fn().mockResolvedValue(true),
    listUsers: vi.fn().mockResolvedValue([
      {
        id: "user_reviewer",
        banned: false,
        locked: false,
        primaryEmailAddress: {
          emailAddress: "reviewer@example.test",
          verification: { status: "verified" },
        },
      },
    ]),
    sendEmail: vi.fn().mockResolvedValue({
      data: { id: "provider-message-1" },
      error: null,
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("approval notification delivery", () => {
  it("sends only after a fresh eligibility check and finalizes by claim", async () => {
    configuredEnvironment();
    const deps = dependencies();

    const summary = await deliverApprovalNotifications(
      { deliveryIds: [deliveryId] },
      deps,
    );

    expect(deps.isEligible).toHaveBeenCalledWith({
      deliveryId,
      claimId: claim.claimId,
    });
    expect(deps.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "reviewer@example.test",
        deliveryId,
        idempotencyKey: `maintainflow-approval-v1-${deliveryId}`,
      }),
    );
    expect(deps.finalize).toHaveBeenCalledWith({
      deliveryId,
      claimId: claim.claimId,
      outcome: { kind: "accepted", providerMessageId: "provider-message-1" },
    });
    expect(summary.accepted).toBe(1);
  });

  it("does not send when the recipient is no longer eligible", async () => {
    configuredEnvironment();
    const deps = dependencies();
    deps.isEligible.mockResolvedValue(false);

    const summary = await deliverApprovalNotifications({}, deps);

    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: {
          kind: "cancelled",
          cancellationCode: "recipient_ineligible",
        },
      }),
    );
    expect(summary.cancelled).toBe(1);
  });

  it("cancels a removed private-beta recipient before resolving their email", async () => {
    configuredEnvironment();
    const deps = dependencies();
    deps.isAdmitted.mockReturnValue(false);

    const summary = await deliverApprovalNotifications({}, deps);

    expect(deps.listUsers).not.toHaveBeenCalled();
    expect(deps.isEligible).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
    expect(deps.finalize).toHaveBeenCalledWith({
      deliveryId,
      claimId: claim.claimId,
      outcome: {
        kind: "cancelled",
        cancellationCode: "recipient_ineligible",
      },
    });
    expect(summary).toMatchObject({ cancelled: 1, lostClaims: 0 });
  });

  it("does not retain or send an unverified primary address", () => {
    expect(
      verifiedPrimaryEmail({
        id: "user_reviewer",
        banned: false,
        locked: false,
        primaryEmailAddress: {
          emailAddress: "unverified@example.test",
          verification: { status: "unverified" },
        },
      }),
    ).toBeNull();
  });

  it("preserves aggregate recovery outcomes when no new delivery is claimed", async () => {
    configuredEnvironment();
    const deps = dependencies();
    const recovery = {
      cancelledIneligible: 2,
      retryScheduledAfterLeaseExpiry: 3,
      permanentFailuresAfterLeaseExpiry: 1,
      permanentFailuresAfterIdempotencyExpiry: 5,
      permanentFailuresAfterConfirmationTimeout: 4,
    };
    deps.claim.mockResolvedValue({ deliveries: [], recovery });

    const summary = await deliverApprovalNotifications({}, deps);

    expect(summary).toMatchObject({ claimed: 0, recovery });
    expect(deps.listUsers).not.toHaveBeenCalled();
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it("classifies transient provider failures without persisting raw messages", () => {
    expect(
      classifyApprovalEmailProviderError({
        name: "rate_limit_exceeded",
        statusCode: 429,
      }),
    ).toEqual({ kind: "retry", code: "provider_rate_limited" });
    expect(
      classifyApprovalEmailProviderError({
        name: "invalid_api_key",
        statusCode: 401,
      }),
    ).toEqual({ kind: "permanent_failure", code: "provider_configuration" });
  });

  it("makes an identity-provider failure terminal on the fifth attempt", async () => {
    configuredEnvironment();
    const deps = dependencies();
    deps.claim.mockResolvedValue({
      deliveries: [{ ...claim, attemptCount: 5 }],
      recovery: emptyRecovery,
    });
    deps.listUsers.mockRejectedValue(new Error("private Clerk detail"));

    const summary = await deliverApprovalNotifications({}, deps);

    expect(deps.finalize).toHaveBeenCalledWith({
      deliveryId,
      claimId: claim.claimId,
      outcome: {
        kind: "permanent_failure",
        failureCode: "identity_provider_unavailable",
      },
    });
    expect(summary).toMatchObject({
      retryScheduled: 0,
      permanentlyFailed: 1,
    });
  });

  it("makes a provider timeout terminal on the fifth attempt", async () => {
    configuredEnvironment();
    vi.useFakeTimers();
    const deps = dependencies();
    deps.claim.mockResolvedValue({
      deliveries: [{ ...claim, attemptCount: 5 }],
      recovery: emptyRecovery,
    });
    deps.sendEmail.mockImplementation(() => new Promise(() => {}));

    const delivery = deliverApprovalNotifications({}, deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.sendEmail).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_000);
    const summary = await delivery;

    expect(deps.finalize).toHaveBeenCalledWith({
      deliveryId,
      claimId: claim.claimId,
      outcome: {
        kind: "permanent_failure",
        failureCode: "provider_timeout",
      },
    });
    expect(summary).toMatchObject({
      retryScheduled: 0,
      permanentlyFailed: 1,
    });
  });

  it("makes a retryable provider response terminal on the fifth attempt", async () => {
    configuredEnvironment();
    const deps = dependencies();
    deps.claim.mockResolvedValue({
      deliveries: [{ ...claim, attemptCount: 5 }],
      recovery: emptyRecovery,
    });
    deps.sendEmail.mockResolvedValue({
      data: null,
      error: { name: "rate_limit_exceeded", statusCode: 429 },
    });

    const summary = await deliverApprovalNotifications({}, deps);

    expect(deps.finalize).toHaveBeenCalledWith({
      deliveryId,
      claimId: claim.claimId,
      outcome: {
        kind: "permanent_failure",
        failureCode: "provider_rate_limited",
      },
    });
    expect(summary).toMatchObject({
      retryScheduled: 0,
      permanentlyFailed: 1,
    });
  });
});
