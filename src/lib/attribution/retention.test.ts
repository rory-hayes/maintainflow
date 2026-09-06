import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceEvidence,
  captureTouch,
  defaultMapping,
  emptyWorkspace,
  workspaceRetentionDays,
  type Site,
  type Workspace,
} from "./model";

const fixture = vi.hoisted(() => ({ workspace: null as unknown as Workspace }));
vi.mock("./store.server", () => ({
  AttributionError: class extends Error {
    constructor(public status: number, message: string) { super(message); }
  },
  authorize: async () => ({ membershipRole: "owner" }),
  sameOrigin: () => {},
  publicWorkspace: (w: Workspace) => w,
  readWorkspace: async () => structuredClone(fixture.workspace),
  mutateWorkspace: async (_id: string, operation: (w: Workspace) => void) => {
    const next = structuredClone(fixture.workspace);
    operation(next);
    // Round-trip the persisted JSON representation, including an empty sites array.
    fixture.workspace = JSON.parse(JSON.stringify(next));
  },
}));
vi.mock("./sync.server", () => ({ syncWorkspaceProvider: vi.fn() }));
import { GET, POST } from "@/app/api/attribution/workspaces/[id]/route";

const id = "22222222-2222-4222-8222-222222222222";
const siteId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
const url = `https://app.test/api/attribution/workspaces/${id}`;
const siteInput = {
  action: "site", name: "Website", origin: "https://example.test",
  consent: "required", adapter: "html", formSelector: "form",
};
function site(retentionDays: number): Site {
  return {
    id: siteId, name: "Existing", origin: "https://existing.test",
    consent: "required", adapter: "html", formSelector: "form",
    mapping: defaultMapping, paused: false, retentionDays,
  };
}
function settings(retentionDays: number) {
  return {
    action: "settings", name: "Test", timezone: "Europe/Dublin",
    qualifiedStages: ["lead"], wonStages: ["closedwon"], retentionDays,
    submissionProperty: "mc_submission_id", primaryContactProperty: "mc_primary_contact_id",
  };
}
function post(body: unknown) {
  return POST(new Request(url, {
    method: "POST", headers: { origin: "https://app.test", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), context);
}
beforeEach(() => {
  fixture.workspace = emptyWorkspace(id, "Test");
  fixture.workspace.billing.plan = "agency";
});

describe("workspace retention persistence and website inheritance", () => {
  it("initializes and resolves the default for a new empty workspace", () => {
    expect(fixture.workspace.retentionDays).toBe(90);
    expect(workspaceRetentionDays(fixture.workspace)).toBe(90);
  });

  it("saves a default without websites and uses it after a reload when adding one", async () => {
    expect((await post(settings(7))).status).toBe(200);
    const loaded = await (await GET(new Request(url), context)).json();
    expect(loaded.state).toMatchObject({ retentionDays: 7, sites: [] });
    expect((await post(siteInput)).status).toBe(200);
    expect(fixture.workspace.sites[0].retentionDays).toBe(7);
  });

  it("prefers the saved workspace default over an older website value", async () => {
    fixture.workspace.retentionDays = 10;
    fixture.workspace.sites = [site(90)];
    expect(workspaceRetentionDays(fixture.workspace)).toBe(10);
    expect((await post(siteInput)).status).toBe(200);
    expect(fixture.workspace.sites[1].retentionDays).toBe(10);
  });

  it("inherits and persists the prior site setting for legacy workspace JSON", async () => {
    delete fixture.workspace.retentionDays;
    fixture.workspace.sites = [site(14)];
    expect(workspaceRetentionDays(fixture.workspace)).toBe(14);
    expect((await post(siteInput)).status).toBe(200);
    expect(fixture.workspace.retentionDays).toBe(14);
    expect(fixture.workspace.sites[1].retentionDays).toBe(14);
  });

  it("keeps the legacy default after deleting the final website", async () => {
    delete fixture.workspace.retentionDays;
    fixture.workspace.sites = [site(14)];
    expect((await post({ action: "delete_site", siteId })).status).toBe(200);
    expect(fixture.workspace).toMatchObject({ retentionDays: 14, sites: [] });
    expect((await post(siteInput)).status).toBe(200);
    expect(fixture.workspace.sites[0].retentionDays).toBe(14);
  });

  it("uses 90 days for legacy JSON with neither a default nor a website", async () => {
    delete fixture.workspace.retentionDays;
    expect(workspaceRetentionDays(fixture.workspace)).toBe(90);
    expect((await post(siteInput)).status).toBe(200);
    expect(fixture.workspace).toMatchObject({ retentionDays: 90 });
    expect(fixture.workspace.sites[0].retentionDays).toBe(90);
  });

  it("updates all existing sites and caps evidence without resurrecting expired data", async () => {
    const now = Date.now();
    fixture.workspace.sites = [site(90), { ...site(14), id: "33333333-3333-4333-8333-333333333333" }];
    fixture.workspace.submissions = [2, 8].map((age) => {
      const at = new Date(now - age * 86400000).toISOString();
      return {
        id: `submission-${age}`, siteId, formId: "form", at, test: false,
        status: "confirmed" as const,
        evidence: advanceEvidence(null, captureTouch("https://example.test", "", new Date(at)), 90),
      };
    });
    expect((await post(settings(7))).status).toBe(200);
    expect(fixture.workspace.retentionDays).toBe(7);
    expect(fixture.workspace.sites.map((s) => s.retentionDays)).toEqual([7, 7]);
    expect(fixture.workspace.submissions.map((s) => s.id)).toEqual(["submission-2"]);
    const expiry = fixture.workspace.submissions[0].evidence.expiresAt;
    expect(Date.parse(expiry)).toBe(now + 5 * 86400000);
    expect((await post(settings(30))).status).toBe(200);
    expect(fixture.workspace.submissions[0].evidence.expiresAt).toBe(expiry);
    expect(fixture.workspace.submissions).toHaveLength(1);
    expect(fixture.workspace.sites.map((s) => s.retentionDays)).toEqual([30, 30]);
  });

  it.each([0, 91])("rejects an out-of-range %i-day setting without changing the saved default", async (days) => {
    fixture.workspace.retentionDays = 7;
    expect((await post(settings(days))).status).toBe(400);
    expect(fixture.workspace.retentionDays).toBe(7);
  });
});
