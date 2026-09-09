import "server-only";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import { siteLimitRestriction, type Workspace } from "./model";
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

const CHECKOUT_LEASE_MS = 90_000;
// Stripe may discard idempotency keys after 24 hours. An unresolved create
// must be reviewed before then, rather than risking a second subscription.
const CHECKOUT_RETRY_MS = 23 * 60 * 60 * 1000;
type CheckoutAttempt = NonNullable<Workspace["billing"]["checkout"]>;
const terminalSubscription = (status: string) =>
  status === "canceled" || status === "incomplete_expired";

function requireCheckoutAllowed(w: Workspace, plan: "starter" | "agency") {
  if (w.billing.subscriptionId && !terminalSubscription(w.billing.status))
    throw new AttributionError(
      409,
      "Manage the existing subscription in the billing portal.",
    );
  const restriction = siteLimitRestriction(w, plan);
  if (restriction)
    throw new AttributionError(409, `${restriction} No payment was initiated.`);
}

function ownedAttempt(w: Workspace, attempt: CheckoutAttempt, token: string) {
  const current = w.billing.checkout;
  if (current?.id !== attempt.id || current.leaseToken !== token)
    throw new AttributionError(
      503,
      "Another billing request is checking this checkout. Refresh and retry.",
    );
  current.leaseUntil = Date.now() + CHECKOUT_LEASE_MS;
  return current;
}

function verifySession(
  session: Stripe.Checkout.Session,
  workspaceId: string,
  attempt: CheckoutAttempt,
) {
  const customer =
    typeof session.customer === "string"
      ? session.customer
      : session.customer?.id;
  if (
    !session.id ||
    (attempt.sessionId && session.id !== attempt.sessionId) ||
    session.mode !== "subscription" ||
    session.client_reference_id !== workspaceId ||
    session.metadata?.workspaceId !== workspaceId ||
    session.metadata?.billingAttemptId !== attempt.id ||
    (attempt.customerId && customer !== attempt.customerId)
  )
    throw new AttributionError(
      503,
      "The checkout identity could not be verified.",
    );
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
      ...(process.env.MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID
        ? {
            configuration:
              process.env.MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID,
          }
        : {}),
      return_url: `${origin}/app?mode=live&workspace=${id}&view=Workspace+%26+billing`,
    });
  }
  requireCheckoutAllowed(w, plan);
  // At most one expired/completed attempt is retired in this request. All
  // provider I/O stays outside the short synchronous workspace transactions.
  for (let pass = 0; pass < 2; pass++) {
    const token = randomUUID();
    const attempt = await mutateWorkspace(id, (state) => {
      requireCheckoutAllowed(state, plan);
      if ((state.billing.checkout?.leaseUntil ?? 0) > Date.now())
        throw new AttributionError(
          409,
          "Checkout is being checked. Wait a moment and retry.",
        );
      if (!state.billing.checkout) {
        const priceId =
          process.env[
            `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`
          ];
        if (!priceId)
          throw new AttributionError(
            503,
            "The selected subscription price is not configured. No payment was initiated.",
          );
        state.billing.checkout = {
          id: randomUUID(),
          plan,
          interval,
          priceId,
          customerId: state.billing.customerId,
          returnUrl: `${origin}/app?mode=live&workspace=${id}&view=Workspace+%26+billing`,
          requestedAt: Date.now(),
        };
      }
      const current = state.billing.checkout;
      current.leaseToken = token;
      current.leaseUntil = Date.now() + CHECKOUT_LEASE_MS;
      return structuredClone(current);
    });
    try {
      if (!attempt.sessionId) {
        if (Date.now() - attempt.requestedAt >= CHECKOUT_RETRY_MS)
          throw new AttributionError(
            409,
            "This checkout could not be confirmed safely. Contact support before starting another payment.",
          );
        // A different selection cannot change an unresolved request's payload.
        if (attempt.plan !== plan || attempt.interval !== interval)
          throw new AttributionError(
            409,
            "A checkout for another plan is pending. Retry that plan before changing your selection.",
          );
        if (!attempt.createStartedAt) {
          const price = await stripe.prices.retrieve(attempt.priceId);
          const amount =
            (attempt.plan === "agency" ? 14900 : 4900) *
            (attempt.interval === "year" ? 10 : 1);
          if (
            !price.active ||
            price.currency !== "eur" ||
            price.unit_amount !== amount ||
            price.recurring?.interval !== attempt.interval ||
            price.recurring.interval_count !== 1
          )
            throw new AttributionError(
              503,
              "The configured price does not match the displayed plan. No payment was initiated.",
            );
          await mutateWorkspace(id, (state) => {
            const current = ownedAttempt(state, attempt, token);
            requireCheckoutAllowed(state, plan);
            current.createStartedAt = Date.now();
          });
        } else {
          await mutateWorkspace(id, (state) => {
            ownedAttempt(state, attempt, token);
            requireCheckoutAllowed(state, plan);
          });
        }
        const created = await stripe.checkout.sessions.create(
          {
            mode: "subscription",
            line_items: [{ price: attempt.priceId, quantity: 1 }],
            ...(attempt.customerId ? { customer: attempt.customerId } : {}),
            client_reference_id: id,
            metadata: {
              workspaceId: id,
              plan: attempt.plan,
              billingAttemptId: attempt.id,
            },
            subscription_data: {
              metadata: {
                workspaceId: id,
                plan: attempt.plan,
                billingAttemptId: attempt.id,
              },
            },
            success_url: attempt.returnUrl,
            cancel_url: attempt.returnUrl,
          },
          { idempotencyKey: `maintaincode-checkout:${id}:${attempt.id}` },
        );
        verifySession(created, id, attempt);
        await mutateWorkspace(id, (state) => {
          ownedAttempt(state, attempt, token).sessionId = created.id;
        });
        attempt.sessionId = created.id;
      }
      // A cached create response can describe a session that is now completed.
      let session = await stripe.checkout.sessions.retrieve(attempt.sessionId);
      verifySession(session, id, attempt);
      if (
        session.status === "open" &&
        (attempt.plan !== plan || attempt.interval !== interval)
      ) {
        // Choosing another plan explicitly abandons this owned Checkout, but
        // the customer may have completed it in another tab in the meantime.
        await mutateWorkspace(id, (state) => {
          ownedAttempt(state, attempt, token);
          requireCheckoutAllowed(state, plan);
        });
        await stripe.checkout.sessions.expire(session.id).catch(() => {});
        // A timeout or "already completed" response is ambiguous. Only this
        // fresh canonical read may establish whether replacement is safe.
        session = await stripe.checkout.sessions.retrieve(attempt.sessionId);
        verifySession(session, id, attempt);
        if (session.status === "open")
          throw new AttributionError(
            409,
            "The previous checkout is still open. Retry to confirm it is closed before changing plans.",
          );
      }
      if (session.status === "open") {
        if (!session.url)
          throw new AttributionError(
            503,
            "Checkout is not ready. Refresh and retry.",
          );
        await mutateWorkspace(id, (state) => {
          ownedAttempt(state, attempt, token);
          requireCheckoutAllowed(state, plan);
        });
        return session;
      }
      if (session.status === "complete") {
        const subscriptionId =
          typeof session.subscription === "string"
            ? session.subscription
            : session.subscription?.id;
        if (!subscriptionId)
          throw new AttributionError(
            503,
            "Payment is being confirmed. Refresh and retry before starting another checkout.",
          );
        await refreshSubscription(id, subscriptionId, stripe, attempt.id);
      } else if (session.status !== "expired") {
        throw new AttributionError(
          503,
          "Checkout status could not be confirmed. Refresh and retry.",
        );
      }
      await mutateWorkspace(id, (state) => {
        ownedAttempt(state, attempt, token);
        requireCheckoutAllowed(state, plan);
        delete state.billing.checkout;
      });
    } finally {
      // An interrupted worker leaves a reclaimable lease. A stale worker must
      // not release another worker's lease or discard its immutable request.
      await mutateWorkspace(id, (state) => {
        const current = state.billing.checkout;
        if (current?.id !== attempt.id || current.leaseToken !== token) return;
        if (!current.createStartedAt && !current.sessionId)
          delete state.billing.checkout;
        else {
          delete current.leaseToken;
          delete current.leaseUntil;
        }
      }).catch(() => {});
    }
  }
  throw new AttributionError(
    503,
    "Billing changed while checking out. Refresh and retry.",
  );
}

export async function refreshSubscription(
  id: string,
  subscriptionId: string,
  stripe = stripeClient(),
  expectedAttemptId?: string,
) {
  const generation = randomUUID();
  await mutateWorkspace(id, (state) => {
    state.billing.refreshGeneration = generation;
  });
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  if (
    subscription.id !== subscriptionId ||
    subscription.metadata.workspaceId !== id ||
    (expectedAttemptId &&
      subscription.metadata.billingAttemptId !== expectedAttemptId)
  )
    throw new AttributionError(
      409,
      "Subscription identity does not match workspace.",
    );
  await applySubscription(subscription, generation);
}

export async function applySubscription(
  subscription: Stripe.Subscription,
  generation?: string,
) {
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
    if (generation && w.billing.refreshGeneration !== generation)
      throw new AttributionError(
        503,
        "A newer billing refresh replaced this request. Retry to confirm the current subscription.",
      );
    if (w.billing.customerId && w.billing.customerId !== customer)
      throw new AttributionError(
        409,
        "Subscription customer does not match workspace.",
      );
    if (
      w.billing.subscriptionId &&
      w.billing.subscriptionId !== subscription.id &&
      (!terminalSubscription(w.billing.status) ||
        (!["active", "trialing"].includes(subscription.status) &&
          !(
            w.billing.checkout &&
            subscription.metadata.billingAttemptId === w.billing.checkout.id
          )))
    )
      return; // An older subscription event cannot cancel a newer subscription.
    // Reflect the provider's actual plan without deleting sites or changing the
    // owner's pause choices. Loader/collector enforce any excess active sites.
    w.billing = {
      ...w.billing,
      status: subscription.status,
      customerId: customer,
      subscriptionId: subscription.id,
      plan,
    };
  });
}
