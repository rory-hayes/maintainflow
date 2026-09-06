import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkspace,
  defaultMapping,
  captureTouch,
  advanceEvidence,
  type Workspace,
} from "./model";
const state = vi.hoisted(() => ({
  workspace: null as unknown as Workspace,
  mutations: 0,
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
  siteOwner: async () => ({
    organizationId: "workspace",
    origin: "https://example.test",
  }),
  mutateWorkspace: async (_id: string, operation: (w: Workspace) => void) => {
    state.mutations++;
    operation(state.workspace);
  },
}));
import { POST } from "@/app/api/attribution/collect/route";
const siteId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
beforeEach(() => {
  state.mutations = 0;
  state.workspace = emptyWorkspace("workspace", "Test");
  state.workspace.sites = [
    {
      id: siteId,
      name: "Site",
      origin: "https://example.test",
      consent: "required",
      retentionDays: 90,
      formSelector: "form",
      adapter: "html",
      mapping: defaultMapping,
      paused: false,
    },
  ];
});
function event(status: "attempted" | "confirmed" = "confirmed", test = false) {
  return {
    id,
    siteId,
    formId: "demo",
    status,
    test,
    at: new Date().toISOString(),
    evidence: advanceEvidence(
      null,
      captureTouch("https://example.test/?utm_source=google&utm_medium=cpc"),
    ),
  };
}
function request(data: unknown, origin = "https://example.test") {
  return new Request("https://app.test/api/attribution/collect", {
    method: "POST",
    headers: { origin, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}
describe("collection contract without database persistence", () => {
  it("rejects an unrelated origin before mutating a workspace", async () => {
    expect((await POST(request(event(), "https://other.test"))).status).toBe(
      403,
    );
    expect(state.mutations).toBe(0);
  });
  it("upgrades attempts once and preserves diagnostic status across retries", async () => {
    expect((await POST(request(event("attempted", true)))).status).toBe(202);
    expect((await POST(request(event("confirmed", false)))).status).toBe(202);
    expect(state.workspace.submissions).toHaveLength(1);
    expect(state.workspace.submissions[0]).toMatchObject({
      status: "confirmed",
      test: true,
    });
  });
  it("reclassifies channel evidence instead of trusting a client total", async () => {
    const data = event();
    data.evidence.first.channel = "ChatGPT Ads";
    expect((await POST(request(data))).status).toBe(202);
    expect(state.workspace.submissions[0].evidence.first.channel).toBe(
      "Paid search",
    );
  });
  it("rejects a full URL containing unapproved query values", async () => {
    const data = event();
    data.evidence.first.landing = "https://example.test/?email=private";
    expect((await POST(request(data))).status).toBe(400);
    expect(state.workspace.submissions).toHaveLength(0);
  });
  it("refuses new records while the website is paused", async () => {
    state.workspace.sites[0].paused = true;
    expect((await POST(request(event()))).status).toBe(409);
    expect(state.workspace.submissions).toHaveLength(0);
  });
});
