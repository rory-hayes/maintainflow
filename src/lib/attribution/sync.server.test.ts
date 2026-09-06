import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyWorkspace, type Workspace } from "./model";
const fixture = vi.hoisted(() => ({
  state: null as unknown as Workspace,
  read: vi.fn(),
  credential: vi.fn(),
  sync: vi.fn(),
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
  syncOpenAI: vi.fn(),
}));
import { syncWorkspaceProvider } from "./sync.server";
beforeEach(() => {
  vi.clearAllMocks();
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
