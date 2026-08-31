import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { adsApiRequestMock } = vi.hoisted(() => ({
  adsApiRequestMock: vi.fn(),
}));

vi.mock("./client.server", () => ({
  adsApiRequest: adsApiRequestMock,
}));

import {
  fetchLiveWorkbenchData,
  LIVE_SYNC_PROVIDER_LIMITS,
} from "./data.server";
import type { AdAccount, AdGroup, Campaign } from "./schema";

const account: AdAccount = {
  id: "adacct_live",
  name: "Live account",
  url: "https://example.com",
  preview_url: null,
  status: "active",
  timezone: "Europe/Dublin",
  currency_code: "EUR",
  review: { status: "approved" },
};

const campaign: Campaign = {
  id: "cmpn_live",
  created_at: 1_735_689_600,
  updated_at: 1_735_776_000,
  name: "Live campaign",
  description: null,
  status: "active",
  product_feed_id: null,
  start_time: 1_735_689_600,
  end_time: null,
  budget: { lifetime_spend_limit_micros: 25_000_000_000 },
  bidding_type: "conversions",
  conversion_event_setting_ids: ["ces_purchase"],
};

const secondCampaign: Campaign = {
  ...campaign,
  id: "cmpn_second",
  name: "Second campaign",
  status: "paused",
};

const adGroup: AdGroup = {
  id: "adgrp_live",
  created_at: 1_735_689_700,
  updated_at: 1_735_776_100,
  name: "High intent",
  description: null,
  context_hints: ["buy modular storage"],
  status: "active",
  bidding_config: {
    billing_event_type: "click",
    max_bid_micros: 250_000_000,
  },
};

const ad = {
  id: "ad_live",
  name: "Live creative",
  created_at: 1_735_689_800,
  updated_at: 1_735_776_200,
  creative: {
    type: "chat_card" as const,
    title: "Organise small spaces",
    body: "Storage designed around the room you already have.",
    target_url: "https://example.com/storage",
    file_id: "file_901",
    image_url: "https://cdn.openai.com/ads/file_901.png",
  },
  status: "active" as const,
  review_status: "approved" as const,
  review: { status: "approved" as const },
};

describe("live workbench adapter", () => {
  beforeEach(() => {
    adsApiRequestMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses the verified account and consumes every campaign page", async () => {
    adsApiRequestMock.mockImplementation(
      async (
        path: string,
        _schema: unknown,
        init?: { body?: Record<string, unknown> },
      ) => {
        if (path === "/campaigns?limit=500") {
          return {
            object: "list",
            data: [campaign],
            has_more: true,
            last_id: campaign.id,
          };
        }
        if (path === `/campaigns?limit=500&after=${campaign.id}`) {
          return {
            object: "list",
            data: [secondCampaign],
            has_more: false,
          };
        }
        if (path === `/ad_groups?campaign_id=${campaign.id}&limit=500`) {
          return { object: "list", data: [adGroup], has_more: false };
        }
        if (path === `/ad_groups?campaign_id=${secondCampaign.id}&limit=500`) {
          return { object: "list", data: [], has_more: false };
        }
        if (path === `/ads?ad_group_id=${adGroup.id}&limit=500`) {
          return { object: "list", data: [ad], has_more: false };
        }
        if (path === "/conversions/event_settings?limit=500&order=desc") {
          return {
            object: "list",
            data: [
              {
                id: "ces_purchase",
                name: "Purchases",
                event_type: "order_created",
                custom_event_name: null,
                attribution_window_days: 30,
                ad_account_id: account.id,
                source_ids: ["clidsrc_web"],
                sources: [{ id: "clidsrc_web", name: "Web pixel" }],
                campaigns: [],
                archived: false,
                version: 1,
              },
            ],
            has_more: true,
            last_id: "ces_purchase",
          };
        }
        if (
          path ===
          "/conversions/event_settings?limit=500&order=desc&after=ces_purchase"
        ) {
          return {
            object: "list",
            data: [
              {
                id: "ces_archived",
                name: "Legacy lead",
                event_type: "lead",
                custom_event_name: null,
                attribution_window_days: 30,
                ad_account_id: account.id,
                source_ids: ["clidsrc_legacy"],
                sources: [{ id: "clidsrc_legacy", name: "Legacy pixel" }],
                campaigns: [],
                archived: true,
                version: 1,
              },
            ],
            has_more: false,
          };
        }
        if (path.startsWith("/ad_account/insights?")) {
          const level = new URL(path, "https://test.invalid").searchParams.get(
            "aggregation_level",
          );
          return level === "campaign"
            ? {
                object: "list",
                data: [
                  {
                    id: "campaign-insight",
                    start_time: 1,
                    end_time: 2,
                    campaign_id: campaign.id,
                    spend: 2_000,
                    impressions: 50_000,
                    clicks: 1_800,
                  },
                ],
                has_more: false,
              }
            : {
                object: "list",
                data: [
                  {
                    id: "ad-group-insight",
                    start_time: 1,
                    end_time: 2,
                    ad_group_id: adGroup.id,
                    spend: 1_250,
                    impressions: 25_000,
                    clicks: 900,
                  },
                ],
                has_more: false,
              };
        }
        if (path === "/conversions/insights") {
          const level = init?.body?.aggregation_level;
          return {
            object: "list",
            count: 1,
            data: [
              {
                entity_id: level === "campaign" ? campaign.id : adGroup.id,
                conversions: level === "campaign" ? 7 : 4,
                click_through_conversions: level === "campaign" ? 7 : 4,
                view_through_conversions: 2,
              },
            ],
          };
        }
        throw new Error(`Unexpected request: ${path}`);
      },
    );

    const result = await fetchLiveWorkbenchData(account);

    expect(result.account).toBe(account);
    expect(result.campaigns.map((item) => item.id)).toEqual([
      campaign.id,
      secondCampaign.id,
    ]);
    expect(result.ads).toEqual([{ ...ad, ad_group_id: adGroup.id }]);
    expect(result.recommendations).toHaveLength(1);
    expect(result.conversionMeasurement).toMatchObject({
      status: "ready",
      healthyCampaigns: 1,
      eventSettingCount: 2,
    });
    expect(result.recommendations[0]).toMatchObject({
      id: `live_bid_${adGroup.id}`,
      entityId: adGroup.id,
      source: "live",
    });
    const deliveryCall = adsApiRequestMock.mock.calls.find(([path]) => {
      if (typeof path !== "string" || !path.startsWith("/ad_account/insights?")) {
        return false;
      }
      return (
        new URL(path, "https://test.invalid").searchParams.get(
          "aggregation_level",
        ) === "ad_group"
      );
    });
    const conversionCall = adsApiRequestMock.mock.calls.find(
      ([path, , init]) =>
        path === "/conversions/insights" &&
        init?.body?.aggregation_level === "ad_group",
    );
    const deliveryRange = JSON.parse(
      new URL(deliveryCall![0], "https://test.invalid").searchParams.get(
        "time_ranges[]",
      )!,
    );
    const conversionRange = JSON.parse(
      conversionCall![2].body.time_ranges[0],
    );
    expect({
      start: Number(conversionRange.start),
      end: Number(conversionRange.end),
    }).toEqual({ start: deliveryRange.start, end: deliveryRange.end });
    expect(deliveryRange.end - deliveryRange.start).toBe(7 * 24 * 3_600);
    expect(result.recommendations[0].monitoringPlan?.baseline).toMatchObject({
      rangeStart: deliveryRange.start,
      rangeEnd: deliveryRange.end,
      spend: 1_250,
      clickAttributedConversions: 4,
    });
    expect(
      adsApiRequestMock.mock.calls.some(([path]) => path === "/ad_account"),
    ).toBe(false);
  });

  it("rejects an incomplete campaign page instead of returning partial data", async () => {
    adsApiRequestMock.mockResolvedValue({
      object: "list",
      data: [campaign],
      has_more: true,
    });

    await expect(fetchLiveWorkbenchData(account)).rejects.toThrow(
      "Campaign pagination returned an invalid cursor",
    );
  });

  it("aborts the complete provider sync at one wall-clock deadline", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    adsApiRequestMock.mockImplementation(
      (
        _path: string,
        _schema: unknown,
        init?: { providerBudget?: { signal: AbortSignal } },
      ) =>
        new Promise((_resolve, reject) => {
          providerSignal = init?.providerBudget?.signal;
          const signal = providerSignal;
          if (!signal) return;
          const rejectFromAbort = () => reject(signal.reason);
          if (signal.aborted) rejectFromAbort();
          else signal.addEventListener("abort", rejectFromAbort, { once: true });
        }),
    );

    const sync = fetchLiveWorkbenchData(account);
    const rejection = expect(sync).rejects.toThrow(
      `wall-clock deadline of ${LIVE_SYNC_PROVIDER_LIMITS.maxDurationMs}ms`,
    );
    await vi.advanceTimersByTimeAsync(
      LIVE_SYNC_PROVIDER_LIMITS.maxDurationMs - 1,
    );
    expect(providerSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await rejection;
    expect(providerSignal?.aborted).toBe(true);
  });
});
