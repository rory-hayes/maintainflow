import type {
  CampaignPerformance,
  Recommendation,
} from "./demo-data";
import { buildAdsResourcePath } from "./resource-path";
import type { AdGroup, Campaign } from "./schema";

export type ScopedAdGroup = AdGroup & { campaign_id: string };

type RecommendationInput = {
  campaigns: Campaign[];
  adGroups: ScopedAdGroup[];
  performance: CampaignPerformance[];
  adGroupPerformance: CampaignPerformance[];
  currencyCode: string;
  measurementWindow: AdsMeasurementWindow;
  measurementReadyCampaignIds?: ReadonlySet<string>;
};

export type AdsMeasurementWindow = {
  start: number;
  end: number;
};

function money(value: number, currencyCode: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 0,
  }).format(value);
}

function confidenceFor(overageRatio: number, conversions: number) {
  const signal = Math.min(12, Math.round((overageRatio - 1) * 20));
  const volume = Math.min(8, Math.floor(conversions / 5));
  return Math.min(96, 76 + signal + volume);
}

/**
 * The first live rule is intentionally narrow and deterministic. OpenAI defines
 * max_bid_micros as the CPA bid for conversion campaigns, so MaintainFlow only
 * proposes a reduction when click-attributed CPA is materially above that bid.
 */
export function buildLiveRecommendations({
  campaigns,
  adGroups,
  performance,
  adGroupPerformance,
  currencyCode,
  measurementWindow,
  measurementReadyCampaignIds,
}: RecommendationInput): Recommendation[] {
  const campaignById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const campaignPerformanceById = new Map(
    performance.map((item) => [item.campaignId, item]),
  );
  const adGroupPerformanceById = new Map(
    adGroupPerformance.map((item) => [item.campaignId, item]),
  );

  return adGroups.flatMap((adGroup) => {
    const campaign = campaignById.get(adGroup.campaign_id);
    const metrics = adGroupPerformanceById.get(adGroup.id);
    const maxBidMicros = adGroup.bidding_config.max_bid_micros;

    if (
      !campaign ||
      !metrics ||
      campaign.status !== "active" ||
      campaign.bidding_type !== "conversions" ||
      campaign.conversion_event_setting_ids.length === 0 ||
      (measurementReadyCampaignIds !== undefined &&
        !measurementReadyCampaignIds.has(campaign.id)) ||
      adGroup.status !== "active" ||
      adGroup.bidding_config.billing_event_type !== "click" ||
      maxBidMicros === undefined ||
      maxBidMicros <= 0 ||
      metrics.conversions < 3
    ) {
      return [];
    }

    const currentBid = maxBidMicros / 1_000_000;
    const actualCpa = metrics.spend / metrics.conversions;
    const overageRatio = actualCpa / currentBid;

    if (!Number.isFinite(overageRatio) || overageRatio < 1.2) {
      return [];
    }

    const proposedBidMicros = Math.max(
      1,
      Math.round(maxBidMicros * 0.8),
    );
    const proposedBid = proposedBidMicros / 1_000_000;
    const campaignMetrics = campaignPerformanceById.get(campaign.id);

    return [
      {
        id: `live_bid_${adGroup.id}`,
        source: "live" as const,
        title: "Lower the CPA bid by 20%",
        summary: `${campaign.name} is paying materially above its configured CPA bid.`,
        rationale:
          "Click-attributed CPA is at least 20% above the ad group’s configured CPA bid with sufficient conversion volume. A controlled reduction lowers the bidding ceiling without changing creative, targeting, or campaign eligibility.",
        priority: overageRatio >= 1.4 ? "high" : "medium",
        confidence: confidenceFor(overageRatio, metrics.conversions),
        status: "ready" as const,
        entityLabel: `${campaign.name} · ${adGroup.name}`,
        entityId: adGroup.id,
        currentValue: `${money(currentBid, currencyCode)} CPA bid`,
        proposedValue: `${money(proposedBid, currencyCode)} CPA bid`,
        estimatedImpact:
          "A 20% lower CPA ceiling, subject to the seven-day conversion safeguard",
        safeguard:
          "Restore the previous bid if click-attributed conversions fall more than 15% after seven days.",
        nextStep:
          "After approval, MaintainFlow stores the rollback request and starts a seven-day monitoring window.",
        monitoringPlan: {
          kind: "click_attributed_conversion_guardrail" as const,
          windowDays: 7,
          baseline: {
            rangeStart: measurementWindow.start,
            rangeEnd: measurementWindow.end,
            spend: metrics.spend,
            clickAttributedConversions: metrics.conversions,
            cpa: actualCpa,
            configuredBidMicros: maxBidMicros,
            currencyCode,
          },
          rollbackRule: {
            metric: "click_attributed_conversions" as const,
            comparison: "decrease_percent_greater_than" as const,
            thresholdPercent: 15,
          },
        },
        evidence: [
          {
            label: "Actual CPA",
            value: money(actualCpa, currencyCode),
            detail: `${Math.round((overageRatio - 1) * 100)}% above bid`,
          },
          {
            label: "Configured bid",
            value: money(currentBid, currencyCode),
            detail: "Current max_bid_micros",
          },
          {
            label: "Period spend",
            value: money(metrics.spend, currencyCode),
            detail: `${metrics.conversions} click-attributed conversions${
              campaignMetrics ? ` · ${money(campaignMetrics.spend, currencyCode)} campaign spend` : ""
            }`,
          },
        ],
        mutation: {
          method: "POST" as const,
          path: buildAdsResourcePath("ad_groups", adGroup.id),
          body: {
            bidding_config: {
              ...adGroup.bidding_config,
              max_bid_micros: proposedBidMicros,
            },
          },
        },
        rollback: {
          method: "POST" as const,
          path: buildAdsResourcePath("ad_groups", adGroup.id),
          body: {
            bidding_config: adGroup.bidding_config,
          },
        },
      },
    ];
  });
}
