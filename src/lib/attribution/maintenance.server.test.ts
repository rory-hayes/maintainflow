import { beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  sync: vi.fn(),
  sql: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./store.server", () => ({
  database: () => fixture.sql,
  readWorkspace: fixture.read,
  mutateWorkspace: fixture.mutate,
  AttributionError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./sync.server", () => ({ syncWorkspaceProvider: fixture.sync }));
import {
  authorizeMaintenance,
  maintainWorkspace,
  MAINTENANCE_LIMITS,
  runMaintenanceBatch,
} from "./maintenance.server";
import { emptyWorkspace } from "./model";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.sync.mockResolvedValue(undefined);
});
describe("bounded daily maintenance", () => {
  it("requires an exact configured secret", () => {
    const request = new Request(
      "https://maintainflow.io/api/attribution/maintenance",
      { headers: { authorization: "Bearer " + "p".repeat(32) } },
    );
    expect(() => authorizeMaintenance(request, "p".repeat(32))).not.toThrow();
    expect(() => authorizeMaintenance(request, "x".repeat(32))).toThrow(
      "Unauthorized",
    );
    expect(() => authorizeMaintenance(request, undefined)).toThrow(
      "not configured",
    );
  });
  it("prunes expired subscriptions without contacting their providers", async () => {
    const state = emptyWorkspace("id", "Test");
    state.billing.status = "canceled";
    fixture.read.mockResolvedValue(state);
    const result = await maintainWorkspace("id", new AbortController().signal);
    expect(fixture.mutate).toHaveBeenCalled();
    expect(fixture.sync).not.toHaveBeenCalled();
    expect(result.syncSkipped).toBe("inactive_subscription");
  });
  it("keeps each provider outcome and supplies an abortable request budget", async () => {
    const state = emptyWorkspace("id", "Test");
    state.billing.status = "active";
    state.connectors = [
      { provider: "hubspot", accountId: "hs", status: "connected" },
      { provider: "openai", accountId: "oa", status: "connected" },
    ];
    fixture.read.mockResolvedValue(state);
    fixture.sync.mockRejectedValueOnce(new Error("private-provider-detail"));
    const result = await maintainWorkspace("id", new AbortController().signal);
    expect(result.providers.map((p) => p.status)).toEqual(["failed", "synced"]);
    expect(JSON.stringify(result)).not.toContain("private-provider-detail");
    expect(
      fixture.sync.mock.calls.every((call) => call[2] instanceof AbortSignal),
    ).toBe(true);
  });
  it("does no work after cancellation", async () => {
    await expect(
      maintainWorkspace("id", AbortSignal.abort()),
    ).rejects.toThrow();
    expect(fixture.mutate).not.toHaveBeenCalled();
  });
  it("caps a large queue and reports durable backlog without claiming completion", async () => {
    let claimed = 0;
    const queue = {
      claim: vi.fn(async () => ({
        organizationId: String(++claimed),
        token: "token",
      })),
      finish: vi
        .fn<
          (
            claim: { organizationId: string; token: string },
            status: "complete" | "partial" | "failed",
          ) => Promise<boolean>
        >()
        .mockResolvedValue(true),
      backlog: vi.fn(async () => ({ due: 9, leased: 0, failed: 0 })),
    };
    const result = await runMaintenanceBatch({
      queue,
      now: () => 0,
      maintain: async () => ({ retention: "applied" as const, providers: [] }),
    });
    expect(result.processed).toBe(MAINTENANCE_LIMITS.maxWorkspaces);
    expect(result.ok).toBe(false);
    expect(queue.finish).toHaveBeenCalledTimes(8);
  });
  it("continues past a workspace failure and persists the failure outcome", async () => {
    const queue = {
      claim: vi
        .fn()
        .mockResolvedValueOnce({ organizationId: "bad", token: "one" })
        .mockResolvedValueOnce({ organizationId: "good", token: "two" })
        .mockResolvedValue(null),
      finish: vi
        .fn<
          (
            claim: { organizationId: string; token: string },
            status: "complete" | "partial" | "failed",
          ) => Promise<boolean>
        >()
        .mockResolvedValue(true),
      backlog: vi.fn(async () => ({ due: 0, leased: 0, failed: 1 })),
    };
    const maintain = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret"))
      .mockResolvedValue({ retention: "applied", providers: [] });
    const result = await runMaintenanceBatch({ queue, now: () => 0, maintain });
    expect(queue.finish.mock.calls.map((call) => call[1])).toEqual([
      "failed",
      "complete",
    ]);
    expect(result.processed).toBe(2);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it("stops claiming near the deadline and detects an expired lease fence", async () => {
    let now = 0;
    const queue = {
      claim: vi.fn(async () => ({ organizationId: "id", token: "token" })),
      finish: vi
        .fn<
          (
            claim: { organizationId: string; token: string },
            status: "complete" | "partial" | "failed",
          ) => Promise<boolean>
        >()
        .mockResolvedValue(false),
      backlog: vi.fn(async () => ({ due: 1, leased: 0, failed: 0 })),
    };
    const result = await runMaintenanceBatch({
      queue,
      now: () => now,
      maintain: async () => {
        now = MAINTENANCE_LIMITS.runBudgetMs;
        return { retention: "applied" as const, providers: [] };
      },
    });
    expect(result.results[0].status).toBe("lease_lost");
    expect(queue.claim).toHaveBeenCalledTimes(1);
    expect(result.deadlineReached).toBe(true);
  });
});
