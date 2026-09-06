import { Resend, type WebhookEventPayload } from "resend";

import {
  ApprovalNotificationConfigurationError,
  getApprovalEmailProviderConfiguration,
} from "@/lib/approvals/notification-config.server";
import {
  recordApprovalNotificationProviderEvent,
  type ApprovalNotificationProviderEvent,
} from "@/lib/approvals/notification-delivery-store.server";
import {
  readBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";

export const runtime = "nodejs";
export const maxDuration = 30;

const MAX_WEBHOOK_BYTES = 64 * 1_024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const observedEvents = new Set<ApprovalNotificationProviderEvent>([
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.complained",
  "email.suppressed",
  "email.failed",
]);

function isObservedEmailEvent(
  event: WebhookEventPayload,
): event is Extract<
  WebhookEventPayload,
  { type: ApprovalNotificationProviderEvent }
> {
  return observedEvents.has(event.type as ApprovalNotificationProviderEvent);
}

export async function POST(request: Request) {
  if (!(request.headers.get("content-type") ?? "").startsWith("application/json")) {
    return new Response("Invalid webhook.", {
      status: 415,
      headers: { "Cache-Control": "no-store" },
    });
  }
  const headers = {
    id: request.headers.get("svix-id") ?? "",
    timestamp: request.headers.get("svix-timestamp") ?? "",
    signature: request.headers.get("svix-signature") ?? "",
  };
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return new Response("Invalid webhook.", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  let payload: string;
  try {
    payload = await readBodyWithLimit(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    return new Response(
      error instanceof RequestBodyTooLargeError
        ? "Webhook too large."
        : "Invalid webhook.",
      {
        status: error instanceof RequestBodyTooLargeError ? 413 : 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  let event: WebhookEventPayload;
  try {
    const configuration = getApprovalEmailProviderConfiguration();
    event = new Resend(configuration.apiKey).webhooks.verify({
      payload,
      headers,
      webhookSecret: configuration.webhookSecret,
    });
  } catch (error) {
    const configurationUnavailable =
      error instanceof ApprovalNotificationConfigurationError;
    return new Response(
      configurationUnavailable ? "Webhook unavailable." : "Invalid webhook.",
      {
        status: configurationUnavailable ? 503 : 400,
        headers: {
          "Cache-Control": "no-store",
          ...(configurationUnavailable ? { "Retry-After": "300" } : {}),
        },
      },
    );
  }
  if (!isObservedEmailEvent(event)) {
    return Response.json(
      { received: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const eventAt = new Date(event.created_at);
  if (
    !Number.isFinite(eventAt.getTime()) ||
    typeof event.data.email_id !== "string" ||
    event.data.email_id.length < 1 ||
    event.data.email_id.length > 255
  ) {
    return new Response("Invalid webhook.", {
      status: 400,
      headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const result = await recordApprovalNotificationProviderEvent({
      providerMessageId: event.data.email_id,
      eventType: event.type,
      eventAt,
    });
    const taggedDeliveryId = event.data.tags?.maintainflow_notification_id;
    if (
      result === "unknown" &&
      typeof taggedDeliveryId === "string" &&
      UUID_PATTERN.test(taggedDeliveryId)
    ) {
      return Response.json(
        { received: false },
        {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "5" },
        },
      );
    }
    return Response.json(
      { received: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return new Response("Webhook persistence unavailable.", {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "30" },
    });
  }
}
