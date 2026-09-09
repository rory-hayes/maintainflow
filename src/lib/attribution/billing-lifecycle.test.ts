import type Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyWorkspace, type Workspace } from "./model";

const f = vi.hoisted(() => ({
  workspace: null as unknown as Workspace,
  locked: false,
  price: vi.fn(),
  create: vi.fn(),
  session: vi.fn(),
  expire: vi.fn(),
  subscription: vi.fn(),
  portal: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./store.server", () => ({
  AttributionError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  readWorkspace: async () => structuredClone(f.workspace),
  mutateWorkspace: async (_id: string, change: (w: Workspace) => unknown) => {
    expect(f.locked).toBe(false);
    f.locked = true;
    try {
      const next = structuredClone(f.workspace);
      const result = change(next);
      // Production mutateWorkspace accepts synchronous callbacks, not I/O.
      expect(result).not.toBeInstanceOf(Promise);
      f.workspace = next;
      return result;
    } finally {
      f.locked = false;
    }
  },
}));
vi.mock("stripe", () => {
  const outsideTransaction = (
    fn: (...args: unknown[]) => unknown,
    ...args: unknown[]
  ) => {
    expect(f.locked, "Stripe I/O must not run under the workspace lock").toBe(
      false,
    );
    return fn(...args);
  };
  return {
    default: class {
      prices = {
        retrieve: (...args: unknown[]) => outsideTransaction(f.price, ...args),
      };
      checkout = {
        sessions: {
          create: (...args: unknown[]) => outsideTransaction(f.create, ...args),
          retrieve: (...args: unknown[]) =>
            outsideTransaction(f.session, ...args),
          expire: (...args: unknown[]) => outsideTransaction(f.expire, ...args),
        },
      };
      subscriptions = {
        retrieve: (...args: unknown[]) =>
          outsideTransaction(f.subscription, ...args),
      };
      billingPortal = {
        sessions: {
          create: (...args: unknown[]) => outsideTransaction(f.portal, ...args),
        },
      };
      webhooks = { constructEvent: (body: string) => JSON.parse(body) };
    },
  };
});
import {
  applySubscription,
  billingSession,
  refreshSubscription,
} from "./billing.server";
import { POST } from "@/app/api/attribution/billing/webhook/route";

const id = "11111111-1111-4111-8111-111111111111";
let sessions: Map<string, Stripe.Checkout.Session>;
let requests: Map<
  string,
  {
    payload: Stripe.Checkout.SessionCreateParams;
    response: Stripe.Checkout.Session;
  }
>;
function snapshot(status = "active", subscriptionId = "sub_current") {
  return {
    id: subscriptionId,
    customer: "cus_owned",
    status,
    metadata: {
      workspaceId: id,
      ...(f.workspace.billing.checkout
        ? { billingAttemptId: f.workspace.billing.checkout.id }
        : {}),
    },
    items: { data: [{ price: { id: "price_starter" } }] },
  } as unknown as Stripe.Subscription;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const checkout = (
  plan: "starter" | "agency" = "starter",
  interval: "month" | "year" = "month",
) => billingSession(id, "checkout", plan, interval);
function webhook(eventId = "evt_owned", subscriptionId = "sub_current") {
  return new Request(
    "https://maintainflow.io/api/attribution/billing/webhook",
    {
      method: "POST",
      headers: { "stripe-signature": "mocked-verified-signature" },
      body: JSON.stringify({
        id: eventId,
        type: "customer.subscription.updated",
        data: { object: { id: subscriptionId, metadata: { workspaceId: id } } },
      }),
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T12:00:00Z"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("No real provider calls in billing tests");
    }),
  );
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_local_mock");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_local_mock");
  vi.stubEnv("STRIPE_PRICE_STARTER_MONTH", "price_starter");
  vi.stubEnv("STRIPE_PRICE_AGENCY_MONTH", "price_agency");
  vi.stubEnv("STRIPE_PRICE_STARTER_YEAR", "price_starter_year");
  vi.stubEnv("STRIPE_PRICE_AGENCY_YEAR", "price_agency_year");
  vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://maintainflow.io");
  vi.stubEnv("MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID", "");
  f.workspace = emptyWorkspace(id, "Owned billing fixture");
  f.locked = false;
  sessions = new Map();
  requests = new Map();
  f.price.mockImplementation(async (price: string) => ({
    active: true,
    currency: "eur",
    unit_amount:
      (price.includes("agency") ? 14900 : 4900) *
      (price.endsWith("year") ? 10 : 1),
    recurring: {
      interval: price.endsWith("year") ? "year" : "month",
      interval_count: 1,
    },
  }));
  f.create.mockImplementation(
    async (
      payload: Stripe.Checkout.SessionCreateParams,
      options: Stripe.RequestOptions,
    ) => {
      const key = options.idempotencyKey!;
      const prior = requests.get(key);
      if (prior) {
        expect(payload).toEqual(prior.payload); // Immutable Stripe retry contract.
        return structuredClone(prior.response);
      }
      const response = {
        id: `cs_owned_${requests.size + 1}`,
        status: "open",
        mode: "subscription",
        client_reference_id: payload.client_reference_id,
        metadata: payload.metadata,
        customer: payload.customer ?? null,
        subscription: null,
        url: `https://checkout.stripe.test/${requests.size + 1}`,
        expires_at: Math.floor(Date.now() / 1000) + 86400,
      } as Stripe.Checkout.Session;
      requests.set(key, {
        payload: structuredClone(payload),
        response: structuredClone(response),
      });
      sessions.set(response.id, structuredClone(response));
      return response;
    },
  );
  f.session.mockImplementation(async (sessionId: string) =>
    structuredClone(sessions.get(sessionId)),
  );
  f.expire.mockImplementation(async (sessionId: string) => {
    const session = sessions.get(sessionId)!;
    if (session.status !== "open") throw new Error("Session is no longer open");
    session.status = "expired";
    return structuredClone(session);
  });
  f.subscription.mockImplementation(async () => snapshot());
  f.portal.mockResolvedValue({ url: "https://billing.stripe.test/owned" });
});
afterEach(() => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("subscription refresh ordering", () => {
  it("rejects an older in-flight canonical snapshot after a newer cancellation commits", async () => {
    await applySubscription(snapshot());
    const old = deferred<Stripe.Subscription>();
    const started = deferred<void>();
    f.subscription.mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    });
    f.subscription.mockResolvedValueOnce(snapshot("canceled"));
    const first = POST(webhook("evt_old"));
    await started.promise;
    expect((await POST(webhook("evt_new"))).status).toBe(200);
    expect(f.workspace.billing.status).toBe("canceled");
    old.resolve(snapshot("active"));
    expect((await first).status).toBe(503);
    expect(f.workspace.billing.status).toBe("canceled");
  });
  it("keeps a failed newer claim fenced and a fresh retry can converge", async () => {
    await applySubscription(snapshot("past_due"));
    const old = deferred<Stripe.Subscription>(),
      started = deferred<void>();
    f.subscription.mockImplementationOnce(() => {
      started.resolve();
      return old.promise;
    });
    f.subscription.mockRejectedValueOnce(new Error("Provider unavailable"));
    const first = POST(webhook("evt_old"));
    await started.promise;
    expect((await POST(webhook("evt_new"))).status).toBe(503);
    old.resolve(snapshot("active"));
    expect((await first).status).toBe(503);
    expect(f.workspace.billing.status).toBe("past_due");
    f.subscription.mockResolvedValueOnce(snapshot("canceled"));
    expect((await POST(webhook("evt_new"))).status).toBe(200);
    expect(f.workspace.billing.status).toBe("canceled");
  });
  it("accepts legitimate active recovery and repeated events without duplicate entitlements", async () => {
    await applySubscription(snapshot("past_due"));
    expect((await POST(webhook())).status).toBe(200);
    expect((await POST(webhook())).status).toBe(200);
    expect(f.workspace.billing).toMatchObject({
      status: "active",
      customerId: "cus_owned",
      subscriptionId: "sub_current",
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("an old different canceled subscription cannot cancel the newer active one", async () => {
    await applySubscription(snapshot("active", "sub_new"));
    f.subscription.mockResolvedValue(snapshot("canceled", "sub_old"));
    expect((await POST(webhook("evt_old", "sub_old"))).status).toBe(200);
    expect(f.workspace.billing).toMatchObject({
      status: "active",
      subscriptionId: "sub_new",
    });
  });
  it.each(["workspace", "subscription"])(
    "rejects canonical %s identity mismatch",
    async (field) => {
      const value = snapshot();
      if (field === "workspace")
        value.metadata.workspaceId = "foreign-workspace";
      else value.id = "sub_foreign";
      f.subscription.mockResolvedValue(value);
      await expect(
        refreshSubscription(id, "sub_current"),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.workspace.billing.subscriptionId).toBeUndefined();
      expect(f.workspace.billing.status).toBe("trialing");
    },
  );
});

describe("durable Checkout attempts", () => {
  it("reuses the open session across the former 30-minute boundary", async () => {
    vi.setSystemTime(new Date("2026-09-09T12:29:59.999Z"));
    const first = await checkout();
    vi.setSystemTime(new Date("2026-09-09T12:30:00.001Z"));
    expect((await checkout()).id).toBe(first.id);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.session).toHaveBeenCalledTimes(2);
    expect(f.workspace.billing.checkout?.leaseToken).toBeUndefined();
  });
  it("a double-click cannot issue a second create while the first is in flight", async () => {
    const create = f.create.getMockImplementation()!;
    const gate = deferred<void>(),
      started = deferred<void>();
    f.create.mockImplementationOnce(async (...args) => {
      const result = await create(...args);
      started.resolve();
      await gate.promise;
      return result;
    });
    const first = checkout();
    await started.promise;
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(f.create).toHaveBeenCalledOnce();
    gate.resolve();
    await expect(first).resolves.toHaveProperty("id", "cs_owned_1");
  });
  it.each(["agency", "year"])(
    "confirms expiry of the owned open session before changing to %s",
    async (selection) => {
      await checkout();
      const attempt = f.workspace.billing.checkout?.id;
      await expect(
        selection === "agency"
          ? checkout("agency")
          : checkout("starter", "year"),
      ).resolves.toHaveProperty("id", "cs_owned_2");
      expect(f.expire).toHaveBeenCalledExactlyOnceWith("cs_owned_1");
      expect(sessions.get("cs_owned_1")?.status).toBe("expired");
      expect(f.create).toHaveBeenCalledTimes(2);
      expect(f.workspace.billing.checkout?.id).not.toBe(attempt);
    },
  );
  it("retires a confirmed expired session and permits a different plan with a new key", async () => {
    const first = await checkout();
    sessions.get(first.id)!.status = "expired";
    const second = await checkout("agency");
    expect(second.id).not.toBe(first.id);
    expect(requests.size).toBe(2);
    expect(f.workspace.billing.checkout?.plan).toBe("agency");
    expect(f.create.mock.calls[0][1].idempotencyKey).not.toBe(
      f.create.mock.calls[1][1].idempotencyKey,
    );
  });
  it("a plan switch racing completed payment reconciles it instead of opening a second subscription", async () => {
    const first = await checkout();
    const paid = snapshot("active");
    f.expire.mockImplementationOnce(async () => {
      Object.assign(sessions.get(first.id)!, {
        status: "complete",
        subscription: "sub_current",
        customer: "cus_owned",
      });
      throw new Error("Checkout already completed");
    });
    f.subscription.mockResolvedValue(paid);
    await expect(checkout("agency")).rejects.toThrow("billing portal");
    expect(f.workspace.billing).toMatchObject({
      status: "active",
      subscriptionId: "sub_current",
      customerId: "cus_owned",
    });
    expect(f.create).toHaveBeenCalledOnce();
  });
  it("a lost expiry response is resolved by canonical status before replacement", async () => {
    const first = await checkout();
    f.expire.mockImplementationOnce(async () => {
      sessions.get(first.id)!.status = "expired";
      throw new Error("Expiry response lost");
    });
    await expect(checkout("agency")).resolves.toHaveProperty(
      "id",
      "cs_owned_2",
    );
    expect(f.create).toHaveBeenCalledTimes(2);
  });
  it("an unconfirmed expiry preserves the open attempt and cannot create a different plan", async () => {
    const first = await checkout();
    f.expire.mockRejectedValueOnce(new Error("Expiry unavailable"));
    await expect(checkout("agency")).rejects.toThrow(
      "previous checkout is still open",
    );
    expect(f.workspace.billing.checkout?.sessionId).toBe(first.id);
    expect(f.create).toHaveBeenCalledOnce();
  });
  it("an ambiguous create cannot change plans before its original session is recovered", async () => {
    f.create.mockRejectedValueOnce(new Error("Unknown create outcome"));
    await expect(checkout()).rejects.toThrow("Unknown create");
    const attempt = f.workspace.billing.checkout?.id;
    await expect(checkout("agency")).rejects.toThrow("Retry that plan");
    expect(f.workspace.billing.checkout?.id).toBe(attempt);
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.expire).not.toHaveBeenCalled();
  });
  it("a completed session cannot retire the attempt using another subscription attempt's metadata", async () => {
    const first = await checkout();
    Object.assign(sessions.get(first.id)!, {
      status: "complete",
      subscription: "sub_current",
      customer: "cus_owned",
    });
    const foreignAttempt = snapshot("incomplete");
    foreignAttempt.metadata.billingAttemptId = "attempt_other";
    f.subscription.mockResolvedValue(foreignAttempt);
    await expect(checkout()).rejects.toThrow("identity does not match");
    expect(f.workspace.billing.checkout?.sessionId).toBe(first.id);
    expect(f.create).toHaveBeenCalledOnce();
  });
  it.each([false, true])(
    "resubscribes after a completed/canceled checkout (existing customer: %s)",
    async (existingCustomer) => {
      if (existingCustomer)
        await applySubscription(snapshot("canceled", "sub_prior"));
      const first = await checkout();
      const active = snapshot("active", "sub_paid");
      await applySubscription(active);
      await applySubscription({ ...active, status: "canceled" });
      Object.assign(sessions.get(first.id)!, {
        status: "complete",
        subscription: "sub_paid",
        customer: "cus_owned",
      });
      f.subscription.mockResolvedValue({ ...active, status: "canceled" });
      const second = await checkout();
      expect(second.id).not.toBe(first.id);
      expect(requests.size).toBe(2);
      expect(f.create.mock.calls[1][0].customer).toBe("cus_owned");
      expect(f.create.mock.calls[0][1].idempotencyKey).not.toBe(
        f.create.mock.calls[1][1].idempotencyKey,
      );
    },
  );
  it.each(["active", "incomplete", "past_due"])(
    "reconciles completed Checkout during webhook lag (%s) and opens the correct portal",
    async (status) => {
      const first = await checkout();
      Object.assign(sessions.get(first.id)!, {
        status: "complete",
        subscription: "sub_current",
        customer: "cus_owned",
      });
      f.subscription.mockResolvedValue(snapshot(status));
      await expect(checkout()).rejects.toMatchObject({ status: 409 });
      expect(f.workspace.billing).toMatchObject({
        status,
        customerId: "cus_owned",
        subscriptionId: "sub_current",
      });
      expect(f.create).toHaveBeenCalledOnce();
      await expect(
        billingSession(id, "portal", "starter", "month"),
      ).resolves.toHaveProperty("url");
      expect(f.portal.mock.calls[0][0].customer).toBe("cus_owned");
    },
  );
  it("records a new incomplete resubscription over the canceled prior one so payment recovery uses its portal", async () => {
    await applySubscription(snapshot("canceled", "sub_prior"));
    const first = await checkout();
    Object.assign(sessions.get(first.id)!, {
      status: "complete",
      subscription: "sub_new",
      customer: "cus_owned",
    });
    f.subscription.mockResolvedValue(snapshot("incomplete", "sub_new"));
    await expect(checkout()).rejects.toMatchObject({ status: 409 });
    expect(f.workspace.billing).toMatchObject({
      status: "incomplete",
      subscriptionId: "sub_new",
    });
    expect(f.create).toHaveBeenCalledOnce();
  });
  it("ambiguous creation retries the identical key, price, customer and URLs", async () => {
    await applySubscription(snapshot("canceled", "sub_prior"));
    const create = f.create.getMockImplementation()!;
    f.create.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("Response lost after creation");
    });
    await expect(checkout()).rejects.toThrow("Response lost");
    expect(f.workspace.billing.checkout?.sessionId).toBeUndefined();
    expect(f.workspace.billing.checkout?.createStartedAt).toBeTypeOf("number");
    vi.stubEnv("STRIPE_PRICE_STARTER_MONTH", "price_changed_config");
    vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://changed.example");
    expect((await checkout()).id).toBe("cs_owned_1");
    expect(f.create.mock.calls[0]).toEqual(f.create.mock.calls[1]);
    expect(requests.size).toBe(1);
  });
  it("does not create another session when an unresolved request outlives the safe key window", async () => {
    f.create.mockRejectedValueOnce(new Error("Ambiguous timeout"));
    await expect(checkout()).rejects.toThrow("Ambiguous");
    const attempt = f.workspace.billing.checkout?.id;
    vi.setSystemTime(new Date(Date.now() + 23 * 3600000));
    await expect(checkout()).rejects.toThrow("Contact support");
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.workspace.billing.checkout?.id).toBe(attempt);
  });
  it("a reclaimed lease reuses an ambiguous request and the stale worker cannot clear it", async () => {
    const create = f.create.getMockImplementation()!;
    const gate = deferred<void>(),
      started = deferred<void>();
    f.create.mockImplementationOnce(async (...args) => {
      const result = await create(...args);
      started.resolve();
      await gate.promise;
      return result;
    });
    const old = checkout();
    await started.promise;
    vi.setSystemTime(new Date(Date.now() + 90_001));
    const current = await checkout();
    gate.resolve();
    await expect(old).rejects.toMatchObject({ status: 503 });
    expect(f.workspace.billing.checkout?.sessionId).toBe(current.id);
    expect(requests.size).toBe(1);
    expect(f.create.mock.calls[0]).toEqual(f.create.mock.calls[1]);
  });
  it("discards only a definitively uncreated attempt after price validation fails", async () => {
    f.price.mockResolvedValueOnce({
      active: true,
      currency: "usd",
      unit_amount: 4900,
      recurring: { interval: "month", interval_count: 1 },
    });
    await expect(checkout()).rejects.toMatchObject({ status: 503 });
    expect(f.workspace.billing.checkout).toBeUndefined();
    expect(f.create).not.toHaveBeenCalled();
    await expect(checkout()).resolves.toHaveProperty("id");
  });
  it("fails closed on a session identity mismatch without discarding the pending attempt", async () => {
    const first = await checkout();
    sessions.get(first.id)!.metadata!.workspaceId = "other";
    await expect(checkout()).rejects.toMatchObject({ status: 503 });
    expect(f.workspace.billing.checkout?.sessionId).toBe(first.id);
    expect(f.create).toHaveBeenCalledOnce();
  });
  it.each(["active", "trialing", "past_due", "unpaid", "paused", "incomplete"])(
    "does not open another subscription when the existing status is %s",
    async (status) => {
      await applySubscription(snapshot(status));
      await expect(checkout()).rejects.toMatchObject({ status: 409 });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.price).not.toHaveBeenCalled();
    },
  );
});

describe("customer portal", () => {
  it("uses the dedicated configuration when set, otherwise leaves the default untouched", async () => {
    await applySubscription(snapshot());
    await billingSession(id, "portal", "starter", "month");
    expect(f.portal.mock.calls[0][0]).not.toHaveProperty("configuration");
    vi.stubEnv(
      "MAINTAINCODE_STRIPE_PORTAL_CONFIGURATION_ID",
      "bpc_maintaincode_test",
    );
    await billingSession(id, "portal", "starter", "month");
    expect(f.portal.mock.calls[1][0]).toMatchObject({
      customer: "cus_owned",
      configuration: "bpc_maintaincode_test",
    });
    expect(f.create).not.toHaveBeenCalled();
  });
  it("does not create a portal session for a workspace without a customer", async () => {
    await expect(
      billingSession(id, "portal", "starter", "month"),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.portal).not.toHaveBeenCalled();
  });
});
