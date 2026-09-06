import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  authorize: vi.fn(),
  batch: vi.fn(),
  claim: vi.fn(),
  finish: vi.fn(),
  maintain: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/attribution/store.server", () => ({
  AttributionError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/attribution/http.server", () => ({
  failure: (error: { status?: number; message: string }) =>
    Response.json({ error: error.message }, { status: error.status ?? 500 }),
}));
vi.mock("@/lib/attribution/maintenance.server", () => ({
  authorizeMaintenance: fixture.authorize,
  runMaintenanceBatch: fixture.batch,
  maintenanceQueue: { claim: fixture.claim, finish: fixture.finish },
  maintainWorkspace: fixture.maintain,
  MAINTENANCE_LIMITS: { runBudgetMs: 1000 },
}));
import { GET, POST } from "./route";
const id = "00000000-0000-4000-8000-000000000001";
beforeEach(() => {
  vi.clearAllMocks();
  fixture.authorize.mockImplementation(() => {});
  vi.stubEnv("CRON_SECRET", "cron-secret");
  vi.stubEnv("MAINTAINCODE_MAINTENANCE_SECRET", "manual-secret");
});
afterEach(() => vi.unstubAllEnvs());
describe("maintenance HTTP boundary", () => {
  it("authenticates GET with the cron secret before processing a bounded batch", async () => {
    fixture.batch.mockResolvedValue({ ok: true, processed: 0 });
    const request = new Request(
      "https://maintainflow.io/api/attribution/maintenance",
    );
    const response = await GET(request);
    expect(fixture.authorize).toHaveBeenCalledWith(request, "cron-secret");
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
  it("returns explicit partial status for failures or remaining backlog", async () => {
    fixture.batch.mockResolvedValue({ ok: false, backlog: { due: 4 } });
    expect(
      (
        await GET(
          new Request("https://maintainflow.io/api/attribution/maintenance"),
        )
      ).status,
    ).toBe(207);
  });
  it("does not claim work when authorization fails", async () => {
    fixture.authorize.mockImplementation(() => {
      throw { status: 401, message: "Unauthorized" };
    });
    expect(
      (
        await GET(
          new Request("https://maintainflow.io/api/attribution/maintenance"),
        )
      ).status,
    ).toBe(401);
    expect(fixture.batch).not.toHaveBeenCalled();
  });
  it("keeps manual workspace runs behind their separate secret and lease", async () => {
    fixture.claim.mockResolvedValue({ organizationId: id, token: "lease" });
    fixture.maintain.mockResolvedValue({ retention: "applied", providers: [] });
    fixture.finish.mockResolvedValue(true);
    const request = new Request(
      `https://maintainflow.io/api/attribution/maintenance?workspace=${id}`,
      { method: "POST" },
    );
    expect((await POST(request)).status).toBe(200);
    expect(fixture.authorize).toHaveBeenCalledWith(request, "manual-secret");
    expect(fixture.claim).toHaveBeenCalledWith(id);
    expect(fixture.finish).toHaveBeenCalledWith(
      { organizationId: id, token: "lease" },
      "complete",
    );
  });
});
