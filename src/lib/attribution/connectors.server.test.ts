import { afterEach, describe, expect, it, vi } from "vitest";
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
}));
import { syncHubspot, syncOpenAI } from "./connectors.server";
import { defaultMapping, emptyWorkspace } from "./model";
import { adsApiRequest } from "@/lib/openai-ads/client.server";
import {
  fetchLiveAdAccount,
  fetchLiveAttributionInventory,
} from "@/lib/openai-ads/data.server";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetAllMocks();
});
describe("HubSpot read-only adapter", () => {
  it("does not start a provider request after cancellation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      syncHubspot(
        emptyWorkspace("w", "Test"),
        "test-token",
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("cancels a rate-limit wait without another provider request", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 429, headers: { "retry-after": "3" } }),
      ),
    );
    const result = syncHubspot(
      emptyWorkspace("w", "Test"),
      "test-token",
      controller.signal,
    );
    const assertion = expect(result).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
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

describe("OpenAI completed-day costs", () => {
  function provider(timezone = "Europe/Dublin") {
    vi.mocked(fetchLiveAdAccount).mockResolvedValue({
      id: "account",
      name: "Test",
      url: "https://example.test",
      preview_url: null,
      timezone,
      currency_code: "EUR",
      review: { status: "approved" },
    });
    vi.mocked(fetchLiveAttributionInventory).mockResolvedValue({
      accountId: "account",
      campaigns: [],
      groups: [],
      ads: [],
    });
    vi.mocked(adsApiRequest).mockImplementation(async () => ({
      data: [],
      has_more: false,
    }));
  }
  it.each([
    [
      "Europe/Dublin",
      "2026-09-06T12:00:00Z",
      "2026-08-06T23:00:00.000Z",
      "2026-09-05T23:00:00.000Z",
    ],
    [
      "America/New_York",
      "2026-11-03T12:00:00Z",
      "2026-10-04T04:00:00.000Z",
      "2026-11-03T05:00:00.000Z",
    ],
  ])(
    "requests complete account days including DST in %s",
    async (timezone, now, first, end) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      provider(timezone);
      const result = await syncOpenAI("test-token", "account");
      const query = new URL(
        vi.mocked(adsApiRequest).mock.calls[0][0],
        "https://api.example.test",
      ).searchParams;
      const range = JSON.parse(query.get("time_ranges[]")!);
      expect(query.get("time_granularity")).toBe("daily");
      expect(query.get("aggregation_level")).toBe("campaign");
      expect(new Date(range.start * 1000).toISOString()).toBe(first);
      expect(new Date(range.end * 1000).toISOString()).toBe(end);
      expect(result.coverage).toContain("30 complete days");
    },
  );
  it("rejects partial and contradictory daily costs instead of silently replacing complete values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
    provider();
    const start = Date.parse("2026-09-04T23:00:00Z") / 1000;
    const row = {
      id: "row",
      campaign_id: "c",
      spend: 20,
      start_time: start,
      end_time: start + 86400,
    };
    vi.mocked(adsApiRequest).mockResolvedValueOnce({
      data: [{ ...row, start_time: start + 3600 }],
      has_more: false,
    });
    await expect(syncOpenAI("test-token", "account")).rejects.toThrow(
      "incomplete account-day",
    );
    vi.mocked(adsApiRequest).mockResolvedValueOnce({
      data: [row, { ...row, spend: 30 }],
      has_more: false,
    });
    await expect(syncOpenAI("test-token", "account")).rejects.toThrow(
      "conflicting daily",
    );
    vi.mocked(adsApiRequest).mockResolvedValueOnce({
      data: [row, row],
      has_more: false,
    });
    const result = await syncOpenAI("test-token", "account");
    expect(result.costs).toHaveLength(1);
    expect(result.costs[0].amount).toBe(20);
  });
});
