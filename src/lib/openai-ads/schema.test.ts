import { describe, expect, it } from "vitest";

import {
  adAccountSchema,
  adGroupUpdateSchema,
  adListResponseSchema,
  adGroupListResponseSchema,
  campaignListResponseSchema,
  createAdCreativeInputSchema,
  conversionInsightResponseSchema,
  insightListResponseSchema,
  updateAdCreativeInputSchema,
} from "./schema";
import { demoAds } from "./demo-data";

describe("OpenAI Ads response schemas", () => {
  it("keeps every demo creative inside the documented ad schema", () => {
    const result = adListResponseSchema.parse({
      object: "list",
      data: demoAds,
      first_id: demoAds[0].id,
      last_id: demoAds.at(-1)!.id,
      has_more: false,
    });

    expect(result.data).toHaveLength(5);
    expect(result.data.map((ad) => ad.review_status)).toEqual([
      "approved",
      "approved",
      "in_review",
      "approved",
      "rejected",
    ]);
  });

  it("accepts the documented campaign list shape", () => {
    const result = campaignListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "cmpn_101",
          created_at: 1_735_689_600,
          updated_at: 1_735_776_000,
          name: "Spring launch",
          description: "Promote the new productivity bundle.",
          status: "active",
          product_feed_id: null,
          start_time: 1_735_689_600,
          end_time: 1_738_368_000,
          budget: { lifetime_spend_limit_micros: 25_000_000 },
          bidding_type: "impressions",
          mode: null,
        },
      ],
      first_id: "cmpn_101",
      last_id: "cmpn_101",
      has_more: false,
    });

    expect(result.data[0].conversion_event_setting_ids).toEqual([]);
    expect(result.data[0].mode).toBeNull();
  });

  it("retains the documented product-feed campaign linkage", () => {
    const result = campaignListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "cmpn_feed_1",
          created_at: 1_735_689_600,
          updated_at: 1_735_776_000,
          name: "Catalog campaign",
          description: null,
          status: "paused",
          start_time: null,
          end_time: null,
          budget: { lifetime_spend_limit_micros: 25_000_000 },
          bidding_type: "clicks",
          conversion_event_setting_ids: [],
          mode: "product_feed",
          product_feed_id: "product_feed_123",
        },
      ],
      first_id: "cmpn_feed_1",
      last_id: "cmpn_feed_1",
      has_more: false,
    });

    expect(result.data[0]).toMatchObject({
      mode: "product_feed",
      product_feed_id: "product_feed_123",
    });
  });

  it("accepts ad-group list rows that omit the parent campaign id", () => {
    const result = adGroupListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "adgrp_301",
          created_at: 1_735_689_700,
          updated_at: 1_735_776_100,
          name: "US English",
          description: "Primary English-speaking audience.",
          context_hints: ["productivity", "team collaboration"],
          status: "active",
          bidding_config: {
            billing_event_type: "impression",
            max_bid_micros: 60_000,
          },
        },
      ],
      first_id: "adgrp_301",
      last_id: "adgrp_301",
      has_more: false,
    });

    expect(result.data[0].campaign_id).toBeUndefined();
  });

  it("accepts the documented ad creative list shape", () => {
    const result = adListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "ad_501",
          name: "Planner launch card",
          created_at: 1_735_689_800,
          updated_at: 1_735_776_200,
          creative: {
            type: "chat_card",
            title: "Try the new workspace planner",
            body: "Coordinate tasks, docs, and meetings in one place.",
            file_id: "file_901",
            image_url: "https://cdn.openai.com/ads/file_901.png",
            target_url: "https://example.com/workspace-planner",
          },
          status: "active",
          review_status: "approved",
          review: { status: "approved" },
        },
      ],
      first_id: "ad_501",
      last_id: "ad_501",
      has_more: false,
    });

    expect(result.data[0]).toMatchObject({
      id: "ad_501",
      review_status: "approved",
      creative: { type: "chat_card" },
    });
  });

  it("keeps custom audience multipliers in a complete bidding config", () => {
    const result = adGroupUpdateSchema.parse({
      bidding_config: {
        billing_event_type: "click",
        max_bid_micros: 60_000_000,
        custom_audience_bid_multipliers: [
          {
            custom_audience_id: "ca_123",
            bid_multiplier_micros: 1_250_000,
          },
        ],
      },
    });

    expect(result.bidding_config?.custom_audience_bid_multipliers).toHaveLength(1);
  });

  it("rejects irreversible archive status in MVP update requests", () => {
    expect(() => adGroupUpdateSchema.parse({ status: "archived" })).toThrow();
  });

  it("accepts flat insight keys and keeps view-through conversions separate", () => {
    const insight = insightListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "start=1777075200:end=1777161600:entity_id=cmpn_101",
          start_time: 1_777_075_200,
          end_time: 1_777_161_600,
          readable_time: "2026-04-25",
          campaign_id: "cmpn_101",
          campaign_name: "Spring launch",
          impressions: 1_200,
          clicks: 36,
          spend: 18.42,
        },
      ],
      count: 1,
      first_id: "start=1777075200:end=1777161600:entity_id=cmpn_101",
      last_id: "start=1777075200:end=1777161600:entity_id=cmpn_101",
      has_more: false,
    });
    const conversions = conversionInsightResponseSchema.parse({
      object: "list",
      data: [
        {
          entity_id: "cmpn_101",
          conversions: 7,
          click_through_conversions: 7,
          view_through_conversions: 3,
        },
      ],
      count: 1,
    });

    expect(insight.data[0].campaign_id).toBe("cmpn_101");
    expect(conversions.data[0]).toMatchObject({
      conversions: 7,
      click_through_conversions: 7,
      view_through_conversions: 3,
    });
    expect(() =>
      conversionInsightResponseSchema.parse({
        object: "list",
        count: 1,
        data: [
          {
            entity_id: "cmpn_101",
            conversions: 10,
            click_through_conversions: 7,
            view_through_conversions: 3,
          },
        ],
      }),
    ).toThrow("conversions as equal to click-through conversions");
  });

  it("accepts an account without optional status", () => {
    expect(
      adAccountSchema.parse({
        id: "adacct_123",
        name: "Acme",
        url: "https://example.com",
        preview_url: null,
        timezone: "Europe/Dublin",
        currency_code: "EUR",
        review: { status: "approved" },
      }).status,
    ).toBeUndefined();
  });

  it("accepts daily-only budgets, business agents, and bid configs without a max bid", () => {
    const result = campaignListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "cmpn_agent_1",
          created_at: 1_735_689_600,
          updated_at: 1_735_776_000,
          name: "Business agent campaign",
          description: null,
          status: "paused",
          mode: "business_agent",
          product_feed_id: null,
          business_agent_id: "agent_123",
          start_time: null,
          end_time: null,
          budget: { daily_spend_limit_micros: 5_000_000 },
          bidding_type: "clicks",
        },
      ],
      first_id: "cmpn_agent_1",
      last_id: "cmpn_agent_1",
      has_more: false,
    });
    const adGroup = adGroupListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "adgrp_auto",
          created_at: 1,
          updated_at: 2,
          name: "Automated bidding",
          description: null,
          context_hints: [],
          status: "active",
          bidding_config: {
            billing_event_type: "click",
            strategy: "automated_bid",
          },
        },
      ],
      first_id: "adgrp_auto",
      last_id: "adgrp_auto",
      has_more: false,
    });

    expect(result.data[0]).toMatchObject({
      mode: "business_agent",
      budget: { daily_spend_limit_micros: 5_000_000 },
    });
    expect(adGroup.data[0].bidding_config.max_bid_micros).toBeUndefined();
  });

  it("keeps nullable creative URLs and provider review diagnostics", () => {
    const result = adListResponseSchema.parse({
      object: "list",
      data: [
        {
          id: "ad_product_1",
          name: "Catalog template",
          created_at: 1,
          updated_at: 2,
          creative: {
            type: "product_ad_template",
            title: "Catalog result",
            body: "A matching product",
            target_url: null,
            image_url: null,
          },
          status: "paused",
          review_status: "rejected",
          review: {
            status: "rejected",
            reason: "provider_added_reason",
            screenshot_url: "https://example.com/evidence.png",
          },
          serving_issues: [{ code: "target_url_invalid" }],
        },
      ],
      first_id: "ad_product_1",
      last_id: "ad_product_1",
      has_more: false,
    });

    expect(result.data[0]).toMatchObject({
      creative: { target_url: null, image_url: null },
      review: { reason: "provider_added_reason" },
      serving_issues: [{ code: "target_url_invalid" }],
    });
  });

  it("keeps create and update creative title constraints separate", () => {
    const base = {
      type: "chat_card" as const,
      body: "A complete body",
      target_url: "https://example.com",
    };

    expect(() =>
      createAdCreativeInputSchema.parse({ ...base, title: "A" }),
    ).toThrow();
    expect(
      updateAdCreativeInputSchema.parse({ ...base, title: "A" }).title,
    ).toBe("A");
  });

  it("accepts the OpenAPI-minimal conversion row but checks equality when supplied", () => {
    expect(
      conversionInsightResponseSchema.parse({
        object: "list",
        count: 1,
        data: [{ entity_id: "cmpn_101", conversions: 7 }],
      }).data[0],
    ).toEqual({ entity_id: "cmpn_101", conversions: 7 });
  });

  it("rejects a malformed standard list envelope instead of silently truncating", () => {
    expect(() =>
      campaignListResponseSchema.parse({
        object: "list",
        data: [],
        has_more: false,
      }),
    ).toThrow();
  });
});
