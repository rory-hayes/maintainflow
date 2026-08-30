import { describe, expect, it } from "vitest";

import type { CampaignPerformance } from "./demo-data";
import {
  buildLiveRecommendations,
  type ScopedAdGroup,
} from "./recommendations";
import type { Campaign } from "./schema";

const campaign: Campaign = {
  id: "cmpn_live",
  created_at: 1_735_689_600,
  updated_at: 1_735_776_000,
  name: "Live conversion campaign",
  description: null,
  status: "active",
  product_feed_id: null,
  start_time: 1_735_689_600,
  end_time: null,
  budget: { lifetime_spend_limit_micros: 25_000_000_000 },
  bidding_type: "conversions",
  conversion_event_setting_ids: ["ces_purchase"],
};

const adGroup: ScopedAdGroup = {
  id: "adgrp_live",
  campaign_id: campaign.id,
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

const measurementWindow = {
  start: 1_787_356_800,
  end: 1_787_961_600,
};

function metrics(
  campaignId: string,
  spend: number,
  conversions: number,
): CampaignPerformance {
  return {
    campaignId,
    spend,
    impressions: 50_000,
    clicks: 1_800,
    conversions,
    viewThroughConversions: 40,
    trend: "Month to date",
  };
}

describe("buildLiveRecommendations", () => {
  it("prepares a complete reversible bid change from click-attributed CPA", () => {
    const recommendations = buildLiveRecommendations({
      campaigns: [campaign],
      adGroups: [adGroup],
      performance: [metrics(campaign.id, 2_000, 7)],
      adGroupPerformance: [metrics(adGroup.id, 1_250, 4)],
      currencyCode: "USD",
      measurementWindow,
    });

    expect(recommendations).toHaveLength(1);
    expect(recommendations[0]).toMatchObject({
      id: "live_bid_adgrp_live",
      source: "live",
      entityId: "adgrp_live",
      currentValue: "$250 CPA bid",
      proposedValue: "$200 CPA bid",
      mutation: {
        method: "POST",
        path: "/ad_groups/adgrp_live",
        body: {
          bidding_config: {
            billing_event_type: "click",
            max_bid_micros: 200_000_000,
          },
        },
      },
      rollback: {
        method: "POST",
        path: "/ad_groups/adgrp_live",
        body: {
          bidding_config: {
            billing_event_type: "click",
            max_bid_micros: 250_000_000,
          },
        },
      },
      monitoringPlan: {
        kind: "click_attributed_conversion_guardrail",
        windowDays: 7,
        baseline: {
          rangeStart: measurementWindow.start,
          rangeEnd: measurementWindow.end,
          spend: 1_250,
          clickAttributedConversions: 4,
          cpa: 312.5,
          configuredBidMicros: 250_000_000,
          currencyCode: "USD",
        },
        rollbackRule: {
          metric: "click_attributed_conversions",
          comparison: "decrease_percent_greater_than",
          thresholdPercent: 15,
        },
      },
    });
  });

  it("does not invent a change below the 20 percent CPA threshold", () => {
    const recommendations = buildLiveRecommendations({
      campaigns: [campaign],
      adGroups: [adGroup],
      performance: [metrics(campaign.id, 2_000, 7)],
      adGroupPerformance: [metrics(adGroup.id, 1_100, 4)],
      currencyCode: "USD",
      measurementWindow,
    });

    expect(recommendations).toEqual([]);
  });

  it("requires at least three click-attributed conversions", () => {
    const recommendations = buildLiveRecommendations({
      campaigns: [campaign],
      adGroups: [adGroup],
      performance: [metrics(campaign.id, 2_000, 7)],
      adGroupPerformance: [metrics(adGroup.id, 1_000, 2)],
      currencyCode: "USD",
      measurementWindow,
    });

    expect(recommendations).toEqual([]);
  });

  it("fails closed when live conversion measurement is not ready", () => {
    const recommendations = buildLiveRecommendations({
      campaigns: [campaign],
      adGroups: [adGroup],
      performance: [metrics(campaign.id, 2_000, 7)],
      adGroupPerformance: [metrics(adGroup.id, 1_250, 4)],
      currencyCode: "USD",
      measurementWindow,
      measurementReadyCampaignIds: new Set(),
    });

    expect(recommendations).toEqual([]);
  });

  it("preserves audience bid multipliers in the change and rollback", () => {
    const configuredAdGroup: ScopedAdGroup = {
      ...adGroup,
      bidding_config: {
        ...adGroup.bidding_config,
        custom_audience_bid_multipliers: [
          {
            custom_audience_id: "ca_high_value",
            bid_multiplier_micros: 1_500_000,
          },
        ],
      },
    };
    const [recommendation] = buildLiveRecommendations({
      campaigns: [campaign],
      adGroups: [configuredAdGroup],
      performance: [metrics(campaign.id, 2_000, 7)],
      adGroupPerformance: [metrics(configuredAdGroup.id, 1_250, 4)],
      currencyCode: "USD",
      measurementWindow,
    });

    expect(recommendation.mutation.body).toMatchObject({
      bidding_config: {
        custom_audience_bid_multipliers: [
          {
            custom_audience_id: "ca_high_value",
            bid_multiplier_micros: 1_500_000,
          },
        ],
      },
    });
    expect(recommendation.rollback.body).toEqual({
      bidding_config: configuredAdGroup.bidding_config,
    });
  });
});
