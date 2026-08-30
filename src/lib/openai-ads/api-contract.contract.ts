import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchLiveWorkbenchData } from "./data.server";
import { validateAdsMutation } from "./client.server";
import { evaluateLiveMonitoringWindow } from "./monitoring.server";
import type { MonitoringPlan } from "./monitoring";

const originalFetch = globalThis.fetch;

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function expectUnixRange(value: string, stringBounds: boolean) {
  const range = JSON.parse(value) as {
    type?: unknown;
    start?: unknown;
    end?: unknown;
  };

  expect(range.type).toBe("unix_range");
  expect(typeof range.start).toBe(stringBounds ? "string" : "number");
  expect(typeof range.end).toBe(stringBounds ? "string" : "number");

  const start = Number(range.start);
  const end = Number(range.end);
  expect(Number.isInteger(start)).toBe(true);
  expect(Number.isInteger(end)).toBe(true);
  expect(start).toBeLessThan(end);
  expect(start % 3_600).toBe(0);
  expect(end % 3_600).toBe(0);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI Ads live-read wire contract", () => {
  it("syncs the full documented hierarchy through a strict local simulator", async () => {
    const campaign = {
      id: "cmpn_101",
      created_at: 1_735_689_600,
      updated_at: 1_735_776_000,
      name: "Spring launch",
      description: "Promote the new productivity bundle.",
      status: "active",
      product_feed_id: null,
      start_time: 1_735_689_600,
      end_time: null,
      budget: { lifetime_spend_limit_micros: 25_000_000_000 },
      bidding_type: "conversions",
      conversion_event_setting_ids: ["ces_purchase"],
    } as const;
    const adGroup = {
      id: "adgrp_301",
      created_at: 1_735_689_700,
      updated_at: 1_735_776_100,
      name: "High intent",
      description: "Primary purchase audience.",
      context_hints: ["buy modular storage"],
      status: "active",
      bidding_config: {
        billing_event_type: "click",
        max_bid_micros: 250_000_000,
      },
    } as const;
    const ad = {
      id: "ad_501",
      name: "Storage launch card",
      created_at: 1_735_689_800,
      updated_at: 1_735_776_200,
      creative: {
        type: "chat_card",
        title: "Organise small spaces",
        body: "Storage designed around the room you already have.",
        file_id: "file_901",
        image_url: "https://cdn.openai.com/ads/file_901.png",
        target_url: "https://example.com/storage",
      },
      status: "active",
      review_status: "approved",
      review: { status: "approved" },
    } as const;
    const productAd = {
      id: "ad_502",
      name: "Storage product template",
      created_at: 1_735_689_900,
      updated_at: 1_735_776_300,
      creative: {
        type: "product_ad_template",
        title: "Storage for every room",
        body: "See the right fit for the space you have.",
        price: "{{product.price}}",
        target_url: null,
      },
      status: "paused",
      review_status: "in_review",
      review: { status: "in_review" },
    } as const;
    const observed = new Set<string>();
    const adPageCursors: Array<string | null> = [];

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const route = `${method} ${url.pathname}`;

      expect(url.origin).toBe("https://api.ads.openai.com");
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("Authorization")).toBe("Bearer ads-contract-key");
      expect(headers.get("OpenAI-Ad-Account")).toBe("adacct_123");
      observed.add(route);

      if (method === "POST") {
        expect(headers.get("Content-Type")).toBe("application/json");
        expect(typeof init?.body).toBe("string");
      } else {
        expect(init?.body).toBeUndefined();
      }

      if (route === "GET /v1/ad_account") {
        expect(url.search).toBe("");
        return json({
          id: "adacct_123",
          name: "Acme Ads",
          url: "https://www.acme.example",
          preview_url: null,
          status: "active",
          timezone: "UTC",
          currency_code: "USD",
          review: { status: "approved" },
        });
      }

      if (route === "GET /v1/campaigns") {
        expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "500" });
        return json({
          object: "list",
          data: [campaign],
          first_id: campaign.id,
          last_id: campaign.id,
          has_more: false,
        });
      }

      if (route === "GET /v1/ad_groups") {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          campaign_id: campaign.id,
          limit: "500",
        });
        return json({
          object: "list",
          data: [adGroup],
          first_id: adGroup.id,
          last_id: adGroup.id,
          has_more: false,
        });
      }

      if (route === "GET /v1/conversions/event_settings") {
        expect(Object.fromEntries(url.searchParams)).toEqual({
          limit: "500",
          order: "desc",
        });
        return json({
          object: "list",
          data: [
            {
              id: "ces_purchase",
              name: "Purchases",
              event_type: "order_created",
              custom_event_name: null,
              attribution_window_days: 30,
              ad_account_id: "adacct_123",
              source_ids: ["clidsrc_web"],
              sources: [{ id: "clidsrc_web", name: "Web pixel" }],
              campaigns: [],
              archived: false,
              version: 1,
            },
          ],
          first_id: "ces_purchase",
          last_id: "ces_purchase",
          has_more: false,
        });
      }

      if (route === "GET /v1/ads") {
        const after = url.searchParams.get("after");
        adPageCursors.push(after);
        expect(Object.fromEntries(url.searchParams)).toEqual({
          ad_group_id: adGroup.id,
          limit: "500",
          ...(after ? { after } : {}),
        });
        if (after === ad.id) {
          return json({
            object: "list",
            data: [productAd],
            first_id: productAd.id,
            last_id: productAd.id,
            has_more: false,
          });
        }
        expect(after).toBeNull();
        return json({
          object: "list",
          data: [ad],
          first_id: ad.id,
          last_id: ad.id,
          has_more: true,
        });
      }

      if (route === "GET /v1/ad_account/insights") {
        const level = url.searchParams.get("aggregation_level");
        const prefix = level === "campaign" ? "campaign" : "ad_group";

        expect(["campaign", "ad_group"]).toContain(level);
        expect(url.searchParams.get("time_granularity")).toBe("none");
        expect(url.searchParams.get("limit")).toBe("2000");
        expect(url.searchParams.get("after")).toBeNull();
        expect(url.searchParams.getAll("fields[]")).toEqual([
          `${prefix}.id`,
          `${prefix}.name`,
          `${prefix}.impressions`,
          `${prefix}.clicks`,
          `${prefix}.spend`,
        ]);
        const ranges = url.searchParams.getAll("time_ranges[]");
        expect(ranges).toHaveLength(1);
        expectUnixRange(ranges[0], false);

        const entityId = level === "campaign" ? campaign.id : adGroup.id;
        const entityKey =
          level === "campaign" ? "campaign_id" : "ad_group_id";
        return json({
          object: "list",
          data: [
            {
              id: `month-to-date:${entityId}`,
              start_time: 1_777_075_200,
              end_time: 1_777_161_600,
              [entityKey]: entityId,
              impressions: level === "campaign" ? 50_000 : 25_000,
              clicks: level === "campaign" ? 1_800 : 900,
              spend: level === "campaign" ? 2_000 : 1_250,
            },
          ],
          count: 1,
          first_id: `month-to-date:${entityId}`,
          last_id: `month-to-date:${entityId}`,
          has_more: false,
        });
      }

      if (route === "POST /v1/conversions/insights") {
        const body = JSON.parse(String(init?.body)) as {
          aggregation_level: "campaign" | "ad_group";
          time_ranges: string[];
          entity_ids: string[];
        };
        const entityId =
          body.aggregation_level === "campaign" ? campaign.id : adGroup.id;

        expect(body.entity_ids).toEqual([entityId]);
        expect(body.time_ranges).toHaveLength(1);
        expectUnixRange(body.time_ranges[0], true);
        return json({
          object: "list",
          data: [
            {
              entity_id: entityId,
              conversions: body.aggregation_level === "campaign" ? 7 : 4,
              click_through_conversions:
                body.aggregation_level === "campaign" ? 7 : 4,
              view_through_conversions: 2,
            },
          ],
          count: 1,
        });
      }

      return json({ error: `Unexpected contract route: ${route}` }, 404);
    });

    const result = await fetchLiveWorkbenchData(undefined, {
      kind: "account_api_key",
      secret: "ads-contract-key",
      expectedAccountId: "adacct_123",
    });

    expect(observed).toEqual(
      new Set([
        "GET /v1/ad_account",
        "GET /v1/campaigns",
        "GET /v1/ad_groups",
        "GET /v1/ads",
        "GET /v1/conversions/event_settings",
        "GET /v1/ad_account/insights",
        "POST /v1/conversions/insights",
      ]),
    );
    expect(result.account.id).toBe("adacct_123");
    expect(result.campaigns.map((item) => item.id)).toEqual([campaign.id]);
    expect(adPageCursors).toEqual([null, ad.id]);
    expect(result.ads).toEqual([
      { ...ad, ad_group_id: adGroup.id },
      { ...productAd, ad_group_id: adGroup.id },
    ]);
    expect(result.performance[0]).toMatchObject({
      campaignId: campaign.id,
      conversions: 7,
      viewThroughConversions: 2,
    });
    expect(result.recommendations[0]).toMatchObject({
      id: `live_bid_${adGroup.id}`,
      source: "live",
      mutation: { path: `/ad_groups/${adGroup.id}` },
    });
    expect(result.conversionMeasurement).toMatchObject({
      status: "ready",
      healthyCampaigns: 1,
    });
  });

  it("reads a completed ad-group window without using view-through conversions", async () => {
    const start = 1_788_048_000;
    const end = 1_788_652_800;
    const plan: MonitoringPlan = {
      kind: "click_attributed_conversion_guardrail",
      windowDays: 7,
      baseline: {
        rangeStart: 1_787_356_800,
        rangeEnd: 1_787_961_600,
        spend: 2_000,
        clickAttributedConversions: 100,
        cpa: 20,
        configuredBidMicros: 25_000_000,
        currencyCode: "USD",
      },
      rollbackRule: {
        metric: "click_attributed_conversions",
        comparison: "decrease_percent_greater_than",
        thresholdPercent: 15,
      },
    };

    globalThis.fetch = vi.fn(async (input, init) => {
      const url = new URL(
        typeof input === "string" || input instanceof URL
          ? input.toString()
          : input.url,
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer ads-contract-key");
      expect(headers.get("OpenAI-Ad-Account")).toBe("adacct_123");

      if (url.pathname === "/v1/ad_groups/adgrp_301/insights") {
        expect(init?.method).toBe("GET");
        expect(url.searchParams.get("time_granularity")).toBe("none");
        expect(url.searchParams.get("aggregation_level")).toBe("ad_group");
        expect(url.searchParams.get("limit")).toBe("1");
        expect(url.searchParams.getAll("fields[]")).toEqual([
          "ad_group.id",
          "ad_group.impressions",
          "ad_group.clicks",
          "ad_group.spend",
        ]);
        expect(JSON.parse(url.searchParams.get("time_ranges[]")!)).toEqual({
          type: "unix_range",
          start,
          end,
        });
        return json({
          object: "list",
          count: 1,
          first_id: "completed-window",
          last_id: "completed-window",
          has_more: false,
          data: [
            {
              id: "completed-window",
              start_time: start,
              end_time: end,
              ad_group_id: "adgrp_301",
              impressions: 30_000,
              clicks: 800,
              spend: 1_680,
            },
          ],
        });
      }

      expect(url.pathname).toBe("/v1/conversions/insights");
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({
        aggregation_level: "ad_group",
        time_ranges: [
          JSON.stringify({
            type: "unix_range",
            start: String(start),
            end: String(end),
          }),
        ],
        entity_ids: ["adgrp_301"],
      });
      return json({
        object: "list",
        count: 1,
        data: [
          {
            entity_id: "adgrp_301",
            conversions: 84,
            click_through_conversions: 84,
            view_through_conversions: 999,
          },
        ],
      });
    });

    await expect(
      evaluateLiveMonitoringWindow({
        entityId: "adgrp_301",
        plan,
        startedAt: new Date(start * 1_000),
        endsAt: new Date(end * 1_000),
        credential: {
          kind: "account_api_key",
          secret: "ads-contract-key",
          expectedAccountId: "adacct_123",
        },
      }),
    ).resolves.toMatchObject({
      outcome: "safeguard_triggered",
      observation: {
        clickAttributedConversions: 84,
        conversionChangePercent: -16,
      },
    });
  });

  it("locks the deliberately reversible MVP mutation surface", () => {
    expect(
      validateAdsMutation({
        method: "POST",
        path: "/campaigns/cmpn_101",
        body: {
          description: "Updated launch window and budget.",
          status: "paused",
          budget: { lifetime_spend_limit_micros: 30_000_000 },
        },
      }),
    ).toEqual({
      description: "Updated launch window and budget.",
      status: "paused",
      budget: { lifetime_spend_limit_micros: 30_000_000 },
    });

    expect(
      validateAdsMutation({
        method: "POST",
        path: "/ad_groups/adgrp_301",
        body: {
          context_hints: ["productivity", "workflow automation"],
          bidding_config: {
            billing_event_type: "click",
            max_bid_micros: 75_000_000,
          },
        },
      }),
    ).toMatchObject({
      bidding_config: {
        billing_event_type: "click",
        max_bid_micros: 75_000_000,
      },
    });

    expect(
      validateAdsMutation({
        method: "POST",
        path: "/ads/ad_501",
        body: {
          name: "Planner launch card v2",
          creative: {
            type: "chat_card",
            title: "Plan work faster",
            body: "Bring tasks, docs, and meetings together.",
            target_url: "https://example.com/workspace-planner",
            file_id: "file_901",
          },
        },
      }),
    ).toMatchObject({ creative: { type: "chat_card" } });

    expect(
      validateAdsMutation({
        method: "POST",
        path: "/ads/ad_501/pause",
        body: null,
      }),
    ).toBeNull();
    expect(() =>
      validateAdsMutation({
        method: "POST",
        path: "/ads/ad_501/archive",
        body: null,
      }),
    ).toThrow("not enabled");
  });
});
