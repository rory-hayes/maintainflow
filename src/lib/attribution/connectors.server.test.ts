import { afterEach, describe, expect, it, vi } from "vitest";
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
}));
import { syncHubspot } from "./connectors.server";
import { defaultMapping, emptyWorkspace } from "./model";
afterEach(() => vi.unstubAllGlobals());
describe("HubSpot read-only adapter", () => {
  it("reads only mapped attribution fields and separates current references from history", async () => {
    const w = emptyWorkspace("w", "Test");
    w.sites = [
      {
        id: "s",
        name: "Site",
        origin: "https://example.test",
        consent: "required",
        retentionDays: 90,
        adapter: "html",
        formSelector: "form",
        mapping: {
          submission_id: defaultMapping.submission_id,
          first_source: "custom_first_source",
          latest_source: "custom_latest_source",
          oppref: "protected_click_ref",
        },
        paused: false,
      },
    ];
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        paths.push(url);
        if (url.includes("/properties/"))
          return Response.json({ name: w.submissionProperty });
        if (url.includes("/objects/deals"))
          return Response.json({ results: [] });
        return Response.json({
          results: [
            {
              id: "c",
              properties: {
                mc_submission_id: "current",
                lifecyclestage: "lead",
                custom_first_source: "google",
                protected_click_ref: "opaque",
                email: "not-selected@example.test",
              },
              propertiesWithHistory: { mc_submission_id: [{ value: "old" }] },
              updatedAt: "2026-09-06T00:00:00Z",
            },
          ],
        });
      }),
    );
    const result = await syncHubspot(w, "test-token");
    const query = new URL(
      paths.find((url) => url.includes("/objects/contacts"))!,
    ).searchParams;
    expect(query.get("properties")!.split(",")).toEqual([
      "mc_submission_id",
      "lifecyclestage",
      "custom_first_source",
      "custom_latest_source",
      "protected_click_ref",
    ]);
    expect(result.contacts[0].currentSubmissions).toEqual(["current"]);
    expect(result.contacts[0].submissions).toEqual(["current", "old"]);
    expect(result.contacts[0].fieldValues).toEqual({
      mc_submission_id: "current",
      custom_first_source: "google",
      custom_latest_source: null,
      protected_click_ref: "opaque",
    });
    expect(JSON.stringify(result)).not.toContain("not-selected");
  });
  it("rejects invalid CRM close dates before they can break reporting", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/properties/"))
          return Response.json({ name: "mc_submission_id" });
        if (url.includes("/objects/contacts"))
          return Response.json({ results: [] });
        return Response.json({
          results: [
            {
              id: "d",
              properties: { amount: "10", closedate: "not-a-date" },
              updatedAt: "2026-09-06T00:00:00Z",
            },
          ],
        });
      }),
    );
    await expect(
      syncHubspot(emptyWorkspace("w", "Test"), "test-token"),
    ).rejects.toThrow("invalid close date");
  });
  it("retains submission property history and asks for no personal contact fields", async () => {
    const paths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, options: RequestInit) => {
        paths.push(url);
        expect(options.method ?? "GET").toBe("GET");
        if (url.includes("/properties/"))
          return Response.json({ name: "mc_submission_id" });
        if (url.includes("/objects/contacts"))
          return Response.json({
            results: [
              {
                id: "c1",
                properties: {
                  mc_submission_id: "second",
                  lifecyclestage: "customer",
                },
                propertiesWithHistory: {
                  mc_submission_id: [{ value: "first" }],
                },
                updatedAt: "2026-09-06T00:00:00Z",
              },
            ],
          });
        return Response.json({
          results: [
            {
              id: "d1",
              properties: {
                mc_primary_contact_id: "c1",
                amount: "100.25",
                dealstage: "closedwon",
                deal_currency_code: "EUR",
                closedate: "2026-09-06T00:00:00Z",
              },
              associations: {
                contacts: { results: [{ id: "c1" }, { id: "c2" }] },
              },
              updatedAt: "2026-09-06T00:00:00Z",
            },
          ],
        });
      }),
    );
    const result = await syncHubspot(emptyWorkspace("w", "Test"), "test-token");
    expect(result.contacts[0].submissions).toEqual(["second", "first"]);
    expect(result.deals[0].amount).toBe(100.25);
    expect(result.deals[0].contacts).toEqual(["c1", "c2"]);
    expect(paths.join(" ")).not.toMatch(/email|firstname|lastname|phone/);
  });
  it("rejects missing permissions with a redacted recovery error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("sensitive provider error", { status: 403 }),
      ),
    );
    await expect(
      syncHubspot(emptyWorkspace("w", "Test"), "secret-token"),
    ).rejects.toThrow("permissions");
  });
  it("discards repeated pagination instead of accepting partial CRM data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("/properties/")
          ? Response.json({ name: "mc_submission_id" })
          : Response.json({ results: [], paging: { next: { after: "same" } } }),
      ),
    );
    await expect(
      syncHubspot(emptyWorkspace("w", "Test"), "test-token"),
    ).rejects.toThrow("No partial snapshot");
  });
});
