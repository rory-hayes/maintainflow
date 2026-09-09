import {
  stripeClient,
  refreshSubscription,
} from "@/lib/attribution/billing.server";
import { AttributionError } from "@/lib/attribution/store.server";
import { failure } from "@/lib/attribution/http.server";
export async function POST(request: Request) {
  try {
    const stripe = stripeClient();
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret)
      throw new AttributionError(503, "Billing webhook is not configured.");
    const body = await request.text();
    if (body.length > 1000000)
      throw new AttributionError(413, "Webhook is too large.");
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        body,
        request.headers.get("stripe-signature") ?? "",
        secret,
      );
    } catch {
      throw new AttributionError(400, "Invalid webhook signature.");
    }
    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const workspaceId = event.data.object.metadata.workspaceId;
      if (workspaceId)
        await refreshSubscription(workspaceId, event.data.object.id, stripe);
    }
    return Response.json({ received: true });
  } catch (e) {
    return failure(e);
  }
}
