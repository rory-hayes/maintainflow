import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const testState = vi.hoisted(() => {
  class ApprovalNotificationConfigurationError extends Error {}
  return {
    ApprovalNotificationConfigurationError,
    getConfiguration: vi.fn(),
    verify: vi.fn(),
    recordEvent: vi.fn(),
  };
});

vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: testState.verify };
  },
}));

vi.mock("@/lib/approvals/notification-config.server", () => ({
  ApprovalNotificationConfigurationError:
    testState.ApprovalNotificationConfigurationError,
  getApprovalEmailProviderConfiguration: testState.getConfiguration,
}));

vi.mock("@/lib/approvals/notification-delivery-store.server", () => ({
  recordApprovalNotificationProviderEvent: testState.recordEvent,
}));

import { POST } from "./route";

const deliveryId = "00000000-0000-4000-8000-000000000401";
const eventAt = "2026-09-03T20:00:00.000Z";

function request(options: {
  body?: string;
  contentType?: string;
  includeSignature?: boolean;
} = {}) {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
  });
  if (options.includeSignature ?? true) {
    headers.set("svix-id", "msg_123");
    headers.set("svix-timestamp", "1788465600");
    headers.set("svix-signature", "v1,signature");
  }
  return new Request("https://maintainflow.io/api/webhooks/resend", {
    method: "POST",
    headers,
    body: options.body ?? "{}",
  });
}

function deliveredEvent(tags: Record<string, string> | undefined = undefined) {
  return {
    type: "email.delivered",
    created_at: eventAt,
    data: {
      email_id: "email_123",
      ...(tags ? { tags } : {}),
    },
  };
}

describe("Resend approval notification webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.getConfiguration.mockReturnValue({
      apiKey: "re_test_provider_key_123456789",
      webhookSecret: "whsec_test_secret_123456789",
      from: "MaintainFlow <approvals@maintainflow.io>",
      appOrigin: "https://maintainflow.io",
    });
    testState.verify.mockReturnValue(deliveredEvent());
    testState.recordEvent.mockResolvedValue("updated");
  });

  it("rejects non-JSON and unsigned requests before verification", async () => {
    const wrongType = await POST(request({ contentType: "text/plain" }));
    const unsigned = await POST(request({ includeSignature: false }));

    expect(wrongType.status).toBe(415);
    expect(unsigned.status).toBe(400);
    expect(testState.verify).not.toHaveBeenCalled();
  });

  it("bounds the signed raw request body", async () => {
    const response = await POST(request({ body: "x".repeat(64 * 1_024 + 1) }));

    expect(response.status).toBe(413);
    expect(testState.verify).not.toHaveBeenCalled();
  });

  it("verifies the raw payload and records an observed delivery event", async () => {
    const response = await POST(request({ body: '{"signed":true}' }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(testState.verify).toHaveBeenCalledWith({
      payload: '{"signed":true}',
      headers: {
        id: "msg_123",
        timestamp: "1788465600",
        signature: "v1,signature",
      },
      webhookSecret: "whsec_test_secret_123456789",
    });
    expect(testState.recordEvent).toHaveBeenCalledWith({
      providerMessageId: "email_123",
      eventType: "email.delivered",
      eventAt: new Date(eventAt),
    });
  });

  it("acknowledges signed event types that do not affect the outbox", async () => {
    testState.verify.mockReturnValue({
      type: "email.opened",
      created_at: eventAt,
      data: { email_id: "email_123" },
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(testState.recordEvent).not.toHaveBeenCalled();
  });

  it("asks Resend to retry an early tagged event until acceptance is stored", async () => {
    testState.verify.mockReturnValue(
      deliveredEvent({ maintainflow_notification_id: deliveryId }),
    );
    testState.recordEvent.mockResolvedValue("unknown");

    const response = await POST(request());

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
  });

  it("returns a retryable response when configuration or persistence is unavailable", async () => {
    testState.getConfiguration.mockImplementationOnce(() => {
      throw new testState.ApprovalNotificationConfigurationError();
    });
    const unconfigured = await POST(request());

    testState.recordEvent.mockRejectedValueOnce(new Error("private database detail"));
    const unavailable = await POST(request());

    expect(unconfigured.status).toBe(503);
    expect(unconfigured.headers.get("retry-after")).toBe("300");
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("retry-after")).toBe("30");
    expect(await unavailable.text()).not.toContain("private database detail");
  });

  it("rejects a bad signature without touching delivery state", async () => {
    testState.verify.mockImplementation(() => {
      throw new Error("bad signature");
    });

    const response = await POST(request());

    expect(response.status).toBe(400);
    expect(testState.recordEvent).not.toHaveBeenCalled();
  });
});
