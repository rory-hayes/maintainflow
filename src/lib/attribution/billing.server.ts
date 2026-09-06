import "server-only";
import Stripe from "stripe";
import {
  AttributionError,
  mutateWorkspace,
  readWorkspace,
} from "./store.server";
export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key)
    throw new AttributionError(
      503,
      "Stripe is not configured for MaintainCode. No payment was initiated.",
    );
  if (process.env.NODE_ENV !== "production" && key.startsWith("sk_live_"))
    throw new AttributionError(
      403,
      "Live charges are disabled in development. Use a Stripe test key.",
    );
  return new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 });
}
export function billingOrigin() {
  const origin = process.env.MAINTAINCODE_APP_ORIGIN;
  if (!origin)
    throw new AttributionError(
      503,
      "Configure the new MaintainCode application origin before opening billing.",
    );
  const url = new URL(origin);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:")
    throw new AttributionError(
      503,
      "Billing requires an HTTPS application origin.",
    );
  return url.origin;
}
export async function billingSession(
  id: string,
  action: "checkout" | "portal",
  plan: "starter" | "agency",
  interval: "month" | "year",
) {
  const stripe = stripeClient();
  const w = await readWorkspace(id);
  const origin = billingOrigin();
  if (action === "portal") {
    if (!w.billing.customerId)
      throw new AttributionError(
        409,
        "No Stripe customer is connected to this workspace yet.",
      );
    return stripe.billingPortal.sessions.create({
      customer: w.billing.customerId,
      return_url: `${origin}/app?mode=live&workspace=${id}&view=Workspace+%26+billing`,
    });
  }
  if (
    w.billing.subscriptionId &&
    ["active", "trialing", "past_due"].includes(w.billing.status)
  )
    throw new AttributionError(
      409,
      "Manage the existing subscription in the billing portal.",
    );
  const price =
    process.env[`STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`];
  if (!price)
    throw new AttributionError(
      503,
      "The selected subscription price is not configured. No payment was initiated.",
    );
  const configuredPrice = await stripe.prices.retrieve(price);
  const expectedAmount =
    (plan === "agency" ? 14900 : 4900) * (interval === "year" ? 10 : 1);
  if (
    !configuredPrice.active ||
    configuredPrice.currency !== "eur" ||
    configuredPrice.unit_amount !== expectedAmount ||
    configuredPrice.recurring?.interval !== interval ||
    configuredPrice.recurring.interval_count !== 1
  )
    throw new AttributionError(
      503,
      "The configured price does not match the displayed plan. No payment was initiated.",
    );
  const session = await stripe.checkout.sessions.create(
    {
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      ...(w.billing.customerId ? { customer: w.billing.customerId } : {}),
      client_reference_id: id,
      metadata: { workspaceId: id, plan },
      subscription_data: { metadata: { workspaceId: id, plan } },
      success_url: `${origin}/app?mode=live&workspace=${id}&view=Workspace+%26+billing`,
      cancel_url: `${origin}/app?mode=live&workspace=${id}&view=Workspace+%26+billing`,
    },
    {
      idempotencyKey: `maintaincode-checkout:${id}:${plan}:${interval}:${Math.floor(Date.now() / 1800000)}`,
    },
  );
  return session;
}
export async function applySubscription(subscription: Stripe.Subscription) {
  const id = subscription.metadata.workspaceId;
  if (!id) return;
  const customer =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const price = subscription.items.data[0]?.price.id;
  const plan = (["starter", "agency"] as const).find((p) =>
    ["month", "year"].some(
      (interval) =>
        process.env[
          `STRIPE_PRICE_${p.toUpperCase()}_${interval.toUpperCase()}`
        ] === price,
    ),
  );
  if (!plan || subscription.items.data.length !== 1)
    throw new AttributionError(
      409,
      "Subscription price is not a configured MaintainCode plan.",
    );
  await mutateWorkspace(id, (w) => {
    if (w.billing.customerId && w.billing.customerId !== customer)
      throw new AttributionError(
        409,
        "Subscription customer does not match workspace.",
      );
    if (
      w.billing.subscriptionId &&
      w.billing.subscriptionId !== subscription.id &&
      (["active", "trialing", "past_due"].includes(w.billing.status) ||
        !["active", "trialing"].includes(subscription.status))
    )
      return; // An older subscription event cannot cancel a newer subscription.
    w.billing = {
      ...w.billing,
      status: subscription.status,
      customerId: customer,
      subscriptionId: subscription.id,
      plan,
    };
  });
}
