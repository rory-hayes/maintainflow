import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkspace,
  advanceEvidence,
  captureTouch,
  defaultMapping,
  attributionFields,
  type Workspace,
} from "./model";
const fixture = vi.hoisted(() => ({
  state: null as unknown as Workspace,
  read: vi.fn(),
  credential: vi.fn(),
  sync: vi.fn(),
  openai: vi.fn(),
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
  readWorkspace: fixture.read,
  credential: fixture.credential,
  mutateWorkspace: async (
    _id: string,
    op: (w: Workspace) => void,
    change?: { operationId?: string },
  ) => {
    if (
      change?.operationId &&
      fixture.state.connectors[0]?.operationId !== change.operationId
    )
      throw new Error("Newer operation");
    op(fixture.state);
  },
}));
vi.mock("./connectors.server", () => ({
  syncHubspot: fixture.sync,
  syncOpenAI: fixture.openai,
}));
import { syncWorkspaceProvider } from "./sync.server";
beforeEach(() => {
  vi.resetAllMocks();
  fixture.state = emptyWorkspace("workspace", "Test");
  fixture.state.connectors = [
    {
      provider: "hubspot",
      accountId: "portal",
      status: "connected",
      operationId: "original",
      syncedAt: "2026-09-01T00:00:00Z",
    },
  ];
  fixture.read.mockImplementation(async () => structuredClone(fixture.state));
  fixture.credential.mockResolvedValue("secret");
  fixture.sync.mockResolvedValue({ contacts: [], deals: [] });
});
describe("connector recovery and ordering", () => {
  it.each([false, true])(
    "allows a corrected account after a failed first connection (disconnected=%s)",
    async (disconnected) => {
      fixture.state.connectors = [];
      fixture.openai.mockRejectedValueOnce(new Error("Account does not match"));
      const connect = (accountId: string) =>
        syncWorkspaceProvider("workspace", {
          action: "connect",
          provider: "openai",
          accountId,
          token: "synthetic-token",
        });
      await expect(connect("mistyped-account")).rejects.toThrow(
        "Account does not match",
      );
      expect(fixture.state.connectors[0].syncedAt).toBeUndefined();
      if (disconnected) {
        fixture.state.connectors[0].status = "revoked";
        fixture.state.connectors[0].operationId = undefined;
      }
      fixture.openai.mockResolvedValueOnce({
        account: { id: "correct-account", timezone: "UTC" },
        inventory: {
          accountId: "correct-account",
          campaigns: [],
          groups: [],
          ads: [],
        },
        costs: [],
        costWindow: { from: "2026-09-01", to: "2026-09-02" },
        coverage: "complete day",
      });
      await expect(connect("correct-account")).resolves.toBeUndefined();
      expect(fixture.state.connectors[0]).toMatchObject({
        accountId: "correct-account",
        status: "connected",
      });
      expect(fixture.openai).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["error", "revoked"] as const)(
    "keeps a previously verified account pinned when %s",
    async (status) => {
      fixture.state.connectors[0].status = status;
      await expect(
        syncWorkspaceProvider("workspace", {
          action: "connect",
          provider: "hubspot",
          token: "synthetic-token",
          accountId: "other-portal",
        }),
      ).rejects.toThrow("separate workspace");
      expect(fixture.sync).not.toHaveBeenCalled();
    },
  );
  it("does not replace an account with retained CRM history even if its success timestamp is absent", async () => {
    fixture.state.connectors[0].status = "error";
    delete fixture.state.connectors[0].syncedAt;
    fixture.state.contacts = [
      {
        id: "existing-contact",
        stage: "lead",
        submissions: [],
        updatedAt: "2026-09-01T00:00:00Z",
      },
    ];
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "connect",
        provider: "hubspot",
        token: "synthetic-token",
        accountId: "other-portal",
      }),
    ).rejects.toThrow("separate workspace");
    expect(fixture.sync).not.toHaveBeenCalled();
  });
  it.each(["inventory", "native costs"])(
    "does not replace an account with retained %s without a success timestamp",
    async (history) => {
      fixture.state.connectors = [
        { provider: "openai", accountId: "original-account", status: "error" },
      ];
      if (history === "inventory")
        fixture.state.adInventory = {
          accountId: "original-account",
          campaigns: [],
          groups: [],
          ads: [],
        };
      else
        fixture.state.costs = [
          {
            id: "cost",
            source: "openai",
            campaignId: "campaign",
            campaign: "Campaign",
            channel: "ChatGPT Ads",
            currency: "EUR",
            date: "2026-09-01",
            amount: 1,
          },
        ];
      await expect(
        syncWorkspaceProvider("workspace", {
          action: "connect",
          provider: "openai",
          token: "synthetic-token",
          accountId: "other-account",
        }),
      ).rejects.toThrow("separate workspace");
      expect(fixture.openai).not.toHaveBeenCalled();
    },
  );
  it("preserves last success on provider failure", async () => {
    fixture.sync.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "sync",
        provider: "hubspot",
      }),
    ).rejects.toThrow();
    expect(fixture.state.connectors[0]).toMatchObject({
      status: "error",
      syncedAt: "2026-09-01T00:00:00Z",
    });
  });
  it("does not resurrect a connection revoked while credentials were being read", async () => {
    fixture.credential.mockImplementationOnce(async () => {
      fixture.state.connectors[0].status = "revoked";
      fixture.state.connectors[0].operationId = undefined;
      return "secret";
    });
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "sync",
        provider: "hubspot",
      }),
    ).rejects.toThrow("newer connector action");
    expect(fixture.sync).not.toHaveBeenCalled();
    expect(fixture.state.connectors[0].status).toBe("revoked");
  });
  it("does not overwrite a revocation that occurs during the provider request", async () => {
    fixture.sync.mockImplementationOnce(async () => {
      fixture.state.connectors[0].status = "revoked";
      fixture.state.connectors[0].operationId = undefined;
      return { contacts: [], deals: [] };
    });
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "sync",
        provider: "hubspot",
      }),
    ).rejects.toThrow();
    expect(fixture.state.connectors[0].status).toBe("revoked");
  });
  it("prevents a different client account from blending with an existing history", async () => {
    await expect(
      syncWorkspaceProvider("workspace", {
        action: "connect",
        provider: "hubspot",
        token: "new-token",
        accountId: "another-portal",
      }),
    ).rejects.toThrow("separate workspace");
    expect(fixture.sync).not.toHaveBeenCalled();
  });
});

describe("scheduled sync cancellation and correction", () => {
  it("does not persist a provider snapshot completed after its budget was canceled", async () => {
    const controller = new AbortController();
    fixture.sync.mockImplementationOnce(async () => {
      controller.abort();
      return {
        contacts: [
          {
            id: "late",
            stage: "lead",
            submissions: [],
            updatedAt: "2026-09-01T00:00:00Z",
          },
        ],
        deals: [],
      };
    });
    await expect(
      syncWorkspaceProvider(
        "workspace",
        { action: "sync", provider: "hubspot" },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fixture.state.contacts).toEqual([]);
    expect(fixture.state.connectors[0].status).toBe("error");
  });
  it("replaces the complete provider cost window and matching CSV rows without keeping corrected-to-zero native costs", async () => {
    fixture.state.connectors = [
      {
        provider: "openai",
        accountId: "account",
        status: "connected",
        operationId: "original",
      },
    ];
    const cost = {
      date: "2026-09-01",
      campaignId: "campaign",
      campaign: "Campaign",
      channel: "ChatGPT Ads" as const,
      currency: "EUR",
      amount: 8,
    };
    fixture.state.costs = [
      { ...cost, id: "old-native", source: "openai" },
      { ...cost, id: "incoming", source: "csv" },
      { ...cost, id: "older", source: "openai", date: "2026-07-01" },
    ];
    fixture.openai.mockResolvedValue({
      account: { id: "account", timezone: "UTC" },
      inventory: { accountId: "account", campaigns: [], groups: [], ads: [] },
      costs: [{ ...cost, id: "incoming", source: "openai", amount: 12 }],
      costWindow: { from: "2026-08-07", to: "2026-09-06" },
      coverage: "complete days",
    });
    await syncWorkspaceProvider("workspace", {
      action: "sync",
      provider: "openai",
    });
    expect(fixture.state.costs.map((c) => c.id)).toEqual(["older", "incoming"]);
    expect(fixture.state.costs.find((c) => c.id === "incoming")?.amount).toBe(
      12,
    );
  });
});

describe("CRM installation verification", () => {
  it.each([false, true])(
    "only verifies the website when CRM field values match: %s",
    async (matchingFields) => {
      const now = new Date();
      fixture.state.sites = [
        {
          id: "site",
          name: "Site",
          origin: "https://example.com",
          adapter: "html",
          consent: "required",
          retentionDays: 90,
          formSelector: "form",
          mapping: defaultMapping,
          paused: false,
        },
      ];
      const evidence = advanceEvidence(
        null,
        captureTouch(
          "https://example.com/?utm_source=google&utm_medium=cpc",
          "",
          now,
        ),
      );
      fixture.state.submissions = [
        {
          id: "test-submission",
          siteId: "site",
          formId: "form",
          at: now.toISOString(),
          evidence,
          test: true,
          status: "confirmed",
        },
      ];
      const fields = attributionFields(evidence, "test-submission");
      fixture.sync.mockResolvedValueOnce({
        contacts: [
          {
            id: "contact",
            stage: "lead",
            submissions: ["test-submission"],
            currentSubmissions: ["test-submission"],
            fieldValues: matchingFields
              ? Object.fromEntries(
                  Object.entries(defaultMapping).map(([key, property]) => [
                    property,
                    fields[key as keyof typeof fields] ?? "",
                  ]),
                )
              : {},
            updatedAt: now.toISOString(),
          },
        ],
        deals: [],
      });
      await syncWorkspaceProvider("workspace", {
        action: "sync",
        provider: "hubspot",
      });
      expect(Boolean(fixture.state.submissions[0].crmVerifiedAt)).toBe(true);
      expect(Boolean(fixture.state.sites[0].verifiedAt)).toBe(matchingFields);
      if (matchingFields) {
        // A later successful read can prove that the formerly working handoff
        // no longer matches. The site-level badge must reflect that result.
        fixture.sync.mockResolvedValueOnce({
          contacts: [
            {
              id: "contact",
              stage: "lead",
              submissions: ["test-submission"],
              currentSubmissions: ["test-submission"],
              fieldValues: {},
              updatedAt: now.toISOString(),
            },
          ],
          deals: [],
        });
        await syncWorkspaceProvider("workspace", {
          action: "sync",
          provider: "hubspot",
        });
        expect(
          fixture.state.submissions[0].crmFieldsVerifiedAt,
        ).toBeUndefined();
        expect(fixture.state.submissions[0].crmFieldDiagnostics?.status).toBe(
          "missing",
        );
        expect(fixture.state.sites[0].verifiedAt).toBeUndefined();
        // Re-verify, then remove the contact altogether in the next completed
        // snapshot. Losing the identity match must also revoke the site badge.
        fixture.sync.mockResolvedValueOnce({
          contacts: [
            {
              id: "contact",
              stage: "lead",
              submissions: ["test-submission"],
              currentSubmissions: ["test-submission"],
              fieldValues: Object.fromEntries(
                Object.entries(defaultMapping).map(([key, property]) => [
                  property,
                  fields[key as keyof typeof fields] ?? "",
                ]),
              ),
              updatedAt: now.toISOString(),
            },
          ],
          deals: [],
        });
        await syncWorkspaceProvider("workspace", {
          action: "sync",
          provider: "hubspot",
        });
        expect(fixture.state.sites[0].verifiedAt).toBeDefined();
        fixture.sync.mockRejectedValueOnce(
          new Error("Provider temporarily unavailable"),
        );
        await expect(
          syncWorkspaceProvider("workspace", {
            action: "sync",
            provider: "hubspot",
          }),
        ).rejects.toThrow();
        expect(fixture.state.sites[0].verifiedAt).toBeDefined();
        fixture.sync.mockResolvedValueOnce({ contacts: [], deals: [] });
        await syncWorkspaceProvider("workspace", {
          action: "sync",
          provider: "hubspot",
        });
        expect(
          fixture.state.submissions[0].crmFieldsVerifiedAt,
        ).toBeUndefined();
        expect(fixture.state.sites[0].verifiedAt).toBeUndefined();
      }
    },
  );
});
