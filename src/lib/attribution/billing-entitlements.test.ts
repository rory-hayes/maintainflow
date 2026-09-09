import type Stripe from "stripe";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  advanceEvidence,
  captureTouch,
  defaultMapping,
  emptyWorkspace,
  type Workspace,
} from "./model";

const state = vi.hoisted(() => ({
  workspace: null as unknown as Workspace,
  price: vi.fn(),
  checkout: vi.fn(),
  retrieve: vi.fn(),
  portal: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("stripe", () => ({
  default: class {
    prices = { retrieve: state.price };
    checkout = {
      sessions: { create: state.checkout, retrieve: state.retrieve },
    };
    billingPortal = { sessions: { create: state.portal } };
  },
}));
vi.mock("./store.server", () => ({
  AttributionError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  authorize: async () => ({ membershipRole: "owner" }),
  sameOrigin: () => {},
  publicWorkspace: (w: Workspace) => w,
  siteOwner: async () => ({
    organizationId: state.workspace.id,
    origin: "https://example.test",
  }),
  readWorkspace: async () => structuredClone(state.workspace),
  mutateWorkspace: async (_id: string, change: (w: Workspace) => void) => {
    const next = structuredClone(state.workspace);
    const result = change(next);
    state.workspace = next;
    return result;
  },
}));
vi.mock("./sync.server", () => ({ syncWorkspaceProvider: vi.fn() }));
import { applySubscription, billingSession } from "./billing.server";
import { POST as collect } from "@/app/api/attribution/collect/route";
import { POST as workspacePost } from "@/app/api/attribution/workspaces/[id]/route";
import { GET as loader } from "@/app/t/[siteId]/route";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const extraSiteId = "33333333-3333-4333-8333-333333333333";
const submissionId = "44444444-4444-4444-8444-444444444444";
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_local_mock");
  vi.stubEnv("STRIPE_PRICE_STARTER_MONTH", "price_starter");
  vi.stubEnv("STRIPE_PRICE_AGENCY_MONTH", "price_agency");
  vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://maintainflow.io");
  state.price.mockResolvedValue({
    active: true,
    currency: "eur",
    unit_amount: 4900,
    recurring: { interval: "month", interval_count: 1 },
  });
  state.checkout.mockImplementation(async (params) => ({
    id: "cs_entitlement_test",
    mode: "subscription",
    status: "open",
    client_reference_id: params.client_reference_id,
    metadata: params.metadata,
    customer: params.customer ?? null,
    url: "https://checkout.stripe.test/mock",
  }));
  state.retrieve.mockImplementation(
    async () => state.checkout.mock.results[0].value,
  );
  state.workspace = emptyWorkspace(workspaceId, "Agency client");
  state.workspace.billing.plan = "agency";
  state.workspace.sites = [siteId, extraSiteId].map((id) => ({
    id,
    name: id === siteId ? "Main website" : "Other website",
    origin: "https://example.test",
    consent: "required",
    retentionDays: 90,
    formSelector: "form",
    adapter: "html",
    mapping: defaultMapping,
    paused: false,
  }));
});
afterEach(() => vi.unstubAllEnvs());
function subscription(plan = "starter") {
  return {
    id: "sub_test",
    customer: "cus_test",
    status: "active",
    metadata: { workspaceId },
    items: { data: [{ price: { id: `price_${plan}` } }] },
  } as unknown as Stripe.Subscription;
}
function event(id = submissionId, test = false) {
  return {
    id,
    siteId,
    formId: "test-form",
    status: "confirmed",
    test,
    at: new Date().toISOString(),
    evidence: advanceEvidence(
      null,
      captureTouch("https://example.test/?utm_source=google&utm_medium=cpc"),
    ),
  };
}
function capture(id = submissionId, test = false) {
  return collect(
    new Request("https://maintainflow.io/api/attribution/collect", {
      method: "POST",
      headers: {
        origin: "https://example.test",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event(id, test)),
    }),
  );
}
function pause(id: string, paused: boolean) {
  return workspacePost(
    new Request(
      `https://maintainflow.io/api/attribution/workspaces/${workspaceId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pause", siteId: id, paused }),
      },
    ),
    { params: Promise.resolve({ id: workspaceId }) },
  );
}
function load() {
  return loader(new Request(`https://maintainflow.io/t/${siteId}`), {
    params: Promise.resolve({ siteId }),
  });
}

it("refuses Starter checkout before provider calls until extra active websites are paused", async () => {
  await expect(
    billingSession(workspaceId, "checkout", "starter", "month"),
  ).rejects.toThrow(/Pause.*website/i);
  expect(state.price).not.toHaveBeenCalled();
  expect(state.checkout).not.toHaveBeenCalled();
  expect((await pause(extraSiteId, true)).status).toBe(200);
  await expect(
    billingSession(workspaceId, "checkout", "starter", "month"),
  ).resolves.toHaveProperty("url");
  expect(state.checkout).toHaveBeenCalledOnce();
  expect(state.workspace.sites).toHaveLength(2);
});

it("preserves data on an external downgrade, blocks new tracking and resumes after pausing extra sites", async () => {
  expect((await capture()).status).toBe(202);
  const before = structuredClone(state.workspace);
  await applySubscription(subscription());
  expect(state.workspace.billing).toMatchObject({
    plan: "starter",
    status: "active",
  });
  expect(state.workspace.sites).toEqual(before.sites);
  expect(state.workspace.submissions).toEqual(before.submissions);
  const body = await (await load()).text();
  expect(body).toContain("Tracking paused");
  expect(body).not.toContain("MaintainCodeConfig");
  for (const diagnostic of [false, true]) {
    const response = await capture(
      "55555555-5555-4555-8555-555555555555",
      diagnostic,
    );
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/Pause.*website/i);
  }
  expect(state.workspace.submissions).toEqual(before.submissions);
  expect((await capture()).status).toBe(202); // Same recorded ID keeps retry acknowledgement.
  expect(state.workspace.submissions).toHaveLength(1);
  expect((await pause(extraSiteId, true)).status).toBe(200);
  expect(await (await load()).text()).toContain("MaintainCodeConfig");
  expect((await capture("55555555-5555-4555-8555-555555555555")).status).toBe(
    202,
  );
  expect(state.workspace.submissions).toHaveLength(2);
  expect(state.workspace.sites).toHaveLength(2);
});

it("rejects resuming an extra Starter site, allows switching the active site and preserves manual pauses on upgrade", async () => {
  state.workspace.sites[1].paused = true;
  await applySubscription(subscription());
  expect((await pause(extraSiteId, false)).status).toBe(409);
  expect(state.workspace.sites[1].paused).toBe(true);
  expect((await pause(siteId, true)).status).toBe(200);
  expect((await pause(extraSiteId, false)).status).toBe(200);
  await applySubscription(subscription("agency"));
  expect(state.workspace.sites.map((s) => s.paused)).toEqual([true, false]);
  expect((await pause(siteId, false)).status).toBe(200);
  expect(await (await load()).text()).toContain("MaintainCodeConfig");
});

it("an Agency upgrade removes the downgrade restriction without changing stored records or pauses", async () => {
  await applySubscription(subscription());
  expect(await (await load()).text()).not.toContain("MaintainCodeConfig");
  const sites = structuredClone(state.workspace.sites);
  await applySubscription(subscription("agency"));
  expect(await (await load()).text()).toContain("MaintainCodeConfig");
  expect(state.workspace.sites).toEqual(sites);
  expect((await capture()).status).toBe(202);
});

it("allows five active Agency sites and excludes paused sites from its active limit", async () => {
  const main = state.workspace.sites[0];
  state.workspace.sites = [
    main,
    ...[3, 4, 5, 6, 7].map((digit) => ({
      ...main,
      id: `${digit}${"0".repeat(7)}-0000-4000-8000-000000000000`,
      paused: digit === 7,
    })),
  ];
  expect(await (await load()).text()).toContain("MaintainCodeConfig");
  expect((await pause(state.workspace.sites[5].id, false)).status).toBe(409);
  expect(state.workspace.sites[5].paused).toBe(true);
  expect((await capture()).status).toBe(202);
});

it("keeps a paused Starter website and its history when creating one active replacement, then rejects a second active site", async () => {
  expect((await capture()).status).toBe(202);
  state.workspace.sites = [state.workspace.sites[0]];
  state.workspace.sites[0].paused = true;
  await applySubscription(subscription());
  const retained = structuredClone(state.workspace);
  const create = (name: string) =>
    workspacePost(
      new Request(
        `https://maintainflow.io/api/attribution/workspaces/${workspaceId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "site",
            name,
            origin: "https://replacement.test",
            consent: "required",
            adapter: "html",
            formSelector: "form",
          }),
        },
      ),
      { params: Promise.resolve({ id: workspaceId }) },
    );
  expect((await create("Replacement website")).status).toBe(200);
  expect(state.workspace.sites).toHaveLength(2);
  expect(state.workspace.sites[0]).toEqual(retained.sites[0]);
  expect(state.workspace.sites[1]).toMatchObject({
    name: "Replacement website",
    paused: false,
  });
  expect(state.workspace.submissions).toEqual(retained.submissions);
  const afterReplacement = structuredClone(state.workspace);
  const rejected = await create("Excess website");
  expect(rejected.status).toBe(409);
  expect((await rejected.json()).error).toContain("Pause another website");
  expect(state.workspace).toEqual(afterReplacement);
});
