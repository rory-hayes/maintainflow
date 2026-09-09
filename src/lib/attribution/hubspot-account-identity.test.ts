import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyWorkspace, type Workspace } from "./model";

const fixture = vi.hoisted(() => ({
  state: null as unknown as Workspace,
  secret: "synthetic-existing-token",
  secretWrites: [] as string[],
  portalId: 456,
  requests: [] as { path: string; method: string }[],
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/openai-ads/client.server", () => ({ adsApiRequest: vi.fn() }));
vi.mock("@/lib/openai-ads/data.server", () => ({
  fetchLiveAdAccount: vi.fn(),
  fetchLiveAttributionInventory: vi.fn(),
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
  readWorkspace: async () => structuredClone(fixture.state),
  credential: async () => fixture.secret,
  mutateWorkspace: async (
    _id: string,
    operation: (w: Workspace) => void,
    change?: { provider: string; operationId?: string; secret?: string },
  ) => {
    const next = structuredClone(fixture.state);
    if (
      change?.operationId &&
      next.connectors.find((c) => c.provider === change.provider)
        ?.operationId !== change.operationId
    )
      throw new Error("Newer connector operation");
    operation(next);
    if (change?.secret) {
      fixture.secretWrites.push(change.secret);
      fixture.secret = change.secret;
    }
    fixture.state = next;
  },
}));
import { syncWorkspaceProvider } from "./sync.server";
import { syncHubspot } from "./connectors.server";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.state = emptyWorkspace("workspace", "Owned client");
  fixture.secret = "synthetic-existing-token";
  fixture.secretWrites = [];
  fixture.portalId = 456;
  fixture.requests = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, options?: RequestInit) => {
      const url = new URL(input);
      fixture.requests.push({
        path: url.pathname,
        method: options?.method ?? "GET",
      });
      expect(url.origin).toBe("https://api.hubapi.com");
      expect(url.href).not.toContain("synthetic-");
      if (url.pathname === "/oauth/v2/private-apps/get/access-token-info") {
        expect(options).toMatchObject({
          method: "POST",
          redirect: "error",
          cache: "no-store",
        });
        expect(options?.signal).toBeInstanceOf(AbortSignal);
        const token = JSON.parse(options?.body as string).tokenKey;
        expect(token).toMatch(/^synthetic-/);
        expect(options?.headers).toMatchObject({
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        });
        expect(url.search).toBe("");
        return Response.json({ hubId: fixture.portalId });
      }
      if (url.pathname.startsWith("/crm/v3/properties/"))
        return Response.json({ name: "mc_submission_id" });
      if (url.pathname === "/crm/v3/objects/contacts")
        return Response.json({
          results: [
            {
              id: "foreign-contact",
              properties: { lifecyclestage: "customer" },
              updatedAt: "2026-09-09T00:00:00Z",
            },
          ],
        });
      if (url.pathname === "/crm/v3/objects/deals")
        return Response.json({ results: [] });
      throw new Error("Unexpected mocked provider path");
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const connect = (accountId: string) =>
  syncWorkspaceProvider("workspace", {
    action: "connect",
    provider: "hubspot",
    accountId,
    token: "synthetic-new-token",
  });
const crmReads = () =>
  fixture.requests.filter((r) => r.path.startsWith("/crm/"));
const savedData = () => ({ ...fixture.state, connectors: undefined });

describe("HubSpot account identity across workspace sync", () => {
  it("rejects an initial wrong portal before CRM reads or saving a credential", async () => {
    const before = structuredClone(savedData());
    let failure: unknown;
    try {
      await connect("123");
    } catch (error) {
      failure = error;
    }
    expect.soft(failure).toBeInstanceOf(Error);
    expect
      .soft((failure as Error | undefined)?.message)
      .toMatch(/different HubSpot account/);
    expect.soft(crmReads()).toEqual([]);
    expect.soft(fixture.secretWrites).toEqual([]);
    expect.soft(savedData()).toEqual(before);
    expect
      .soft(fixture.state.connectors[0])
      .toMatchObject({ accountId: "123", status: "error" });
  });

  it("rejects a replacement token from another portal without mixing history or replacing the saved token", async () => {
    fixture.state.connectors = [
      {
        provider: "hubspot",
        accountId: "123",
        status: "connected",
        operationId: "prior-operation",
        syncedAt: "2026-09-08T00:00:00Z",
      },
    ];
    fixture.state.contacts = [
      {
        id: "owned-contact",
        stage: "lead",
        submissions: [],
        updatedAt: "2026-09-08T00:00:00Z",
      },
    ];
    fixture.state.deals = [
      {
        id: "owned-deal",
        contacts: ["owned-contact"],
        stage: "qualified",
        amount: 99,
        currency: "EUR",
        closedAt: null,
        updatedAt: "2026-09-08T00:00:00Z",
        history: [
          { at: "2026-09-08T00:00:00Z", stage: "qualified", amount: 99 },
        ],
      },
    ];
    const before = structuredClone(savedData());
    let failure: unknown;
    try {
      await connect("123");
    } catch (error) {
      failure = error;
    }
    expect
      .soft((failure as Error | undefined)?.message)
      .toMatch(/different HubSpot account/);
    expect.soft(crmReads()).toEqual([]);
    expect.soft(fixture.secretWrites).toEqual([]);
    expect.soft(fixture.secret).toBe("synthetic-existing-token");
    expect.soft(savedData()).toEqual(before);
    expect.soft(fixture.state.connectors[0]).toMatchObject({
      accountId: "123",
      status: "error",
      syncedAt: "2026-09-08T00:00:00Z",
    });
  });

  it.each([false, true])(
    "verifies corrected initial input instead of the stale workspace account (revoked=%s)",
    async (revoked) => {
      await expect(connect("123")).rejects.toThrow("different HubSpot account");
      expect(crmReads()).toEqual([]);
      expect(fixture.secretWrites).toEqual([]);
      if (revoked) {
        fixture.state.connectors[0].status = "revoked";
        delete fixture.state.connectors[0].operationId;
      }
      fixture.requests = [];
      await expect(connect("456")).resolves.toBeUndefined();
      expect(fixture.requests[0]).toEqual({
        path: "/oauth/v2/private-apps/get/access-token-info",
        method: "POST",
      });
      expect(crmReads()).toHaveLength(3);
      expect(fixture.state.connectors[0]).toMatchObject({
        accountId: "456",
        status: "connected",
      });
      expect(fixture.secretWrites).toEqual(["synthetic-new-token"]);
    },
  );

  it("checks the stored account and saved credential during an ordinary sync", async () => {
    fixture.state.connectors = [
      { provider: "hubspot", accountId: "123", status: "connected" },
    ];
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "sync",
        provider: "hubspot",
      }),
    ).rejects.toThrow("different HubSpot account");
    expect(crmReads()).toEqual([]);
    expect(fixture.secretWrites).toEqual([]);
    fixture.portalId = 123;
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "sync",
        provider: "hubspot",
      }),
    ).resolves.toBeUndefined();
    expect(crmReads()).toHaveLength(3);
    expect(fixture.secretWrites).toEqual([]);
  });

  it.each([undefined, "", "portal", "0123", "123.5", "9007199254740992"])(
    "rejects missing or invalid expected account %s before any request",
    async (accountId) => {
      await expect(
        syncHubspot(fixture.state, "synthetic-token", accountId as string),
      ).rejects.toThrow("numeric HubSpot account ID");
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    {},
    { hubId: null },
    { hubId: "123" },
    { hubId: 0 },
    { hubId: -1 },
    { hubId: 123.5 },
    { hubId: Number.MAX_SAFE_INTEGER + 1 },
  ])("fails closed for malformed token metadata %j", async (metadata) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json(metadata));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      syncHubspot(fixture.state, "synthetic-token", "123"),
    ).rejects.toThrow("account identity could not be verified");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.hubapi.com/oauth/v2/private-apps/get/access-token-info",
    );
  });

  it("redacts malformed metadata response content and never attempts CRM reads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("synthetic-sensitive-provider-body")),
    );
    const result = syncHubspot(fixture.state, "synthetic-token", "123");
    await expect(result).rejects.toThrow(
      "HubSpot returned an invalid response",
    );
    await expect(result).rejects.not.toThrow("synthetic-sensitive");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("stops after token inspection if the request budget is cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        controller.abort();
        return Response.json({ hubId: 123 });
      }),
    );
    await expect(
      syncHubspot(fixture.state, "synthetic-token", "123", controller.signal),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
