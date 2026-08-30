import type { AdAccount, Campaign, ScopedAd } from "./schema";
import type { CreativeReviewEvent } from "./creative-history";
import type { MonitoringPlan } from "./monitoring";

export type RecommendationStatus =
  | "ready"
  | "monitoring"
  | "dismissed";

export type RecommendationPriority = "high" | "medium";

export type AdsMutation = {
  method: "POST";
  path: string;
  body: Record<string, unknown> | null;
};

export type Recommendation = {
  id: string;
  source: "demo" | "live";
  title: string;
  summary: string;
  rationale: string;
  priority: RecommendationPriority;
  confidence: number;
  status: RecommendationStatus;
  entityLabel: string;
  entityId: string;
  currentValue: string;
  proposedValue: string;
  estimatedImpact: string;
  safeguard: string;
  nextStep: string;
  evidence: Array<{ label: string; value: string; detail: string }>;
  monitoringPlan?: MonitoringPlan;
  dismissal?: {
    reason: string;
    dismissedAt: string;
  };
  mutation: AdsMutation;
  rollback: AdsMutation;
};

export type CampaignPerformance = {
  campaignId: string;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  viewThroughConversions?: number;
  trend: string;
};

export const demoAccount: AdAccount = {
  id: "adacct_123",
  name: "Harbour Home",
  url: "https://harbourhome.example",
  preview_url: null,
  status: "active",
  timezone: "America/New_York",
  currency_code: "USD",
  review: { status: "approved" },
};

export const demoCampaigns: Campaign[] = [
  {
    id: "cmpn_101",
    created_at: 1776038400,
    updated_at: 1787875200,
    name: "Summer storage",
    description: "Conversion campaign for modular storage products.",
    status: "active",
    start_time: 1776038400,
    end_time: 1788134400,
    budget: { lifetime_spend_limit_micros: 40_000_000_000 },
    bidding_type: "conversions",
    conversion_event_setting_ids: ["ces_purchase"],
    mode: null,
    product_feed_id: null,
  },
  {
    id: "cmpn_102",
    created_at: 1776038400,
    updated_at: 1787875200,
    name: "Small-space living",
    description: "Click campaign for apartment-friendly furniture.",
    status: "active",
    start_time: 1776038400,
    end_time: 1788134400,
    budget: { lifetime_spend_limit_micros: 24_000_000_000 },
    bidding_type: "clicks",
    conversion_event_setting_ids: [],
    mode: null,
    product_feed_id: null,
  },
  {
    id: "cmpn_103",
    created_at: 1776038400,
    updated_at: 1787875200,
    name: "Clearance feed",
    description: "Product-feed campaign for end-of-line inventory.",
    status: "paused",
    start_time: 1776038400,
    end_time: 1788134400,
    budget: { lifetime_spend_limit_micros: 12_000_000_000 },
    bidding_type: "clicks",
    conversion_event_setting_ids: [],
    mode: "product_feed",
    product_feed_id: "product_feed_harbour_clearance",
  },
];

export const demoCampaignPerformance: CampaignPerformance[] = [
  {
    campaignId: "cmpn_101",
    spend: 12_480,
    impressions: 288_400,
    clicks: 8_942,
    conversions: 40,
    trend: "+18.2% CPA",
  },
  {
    campaignId: "cmpn_102",
    spend: 5_920,
    impressions: 184_120,
    clicks: 6_018,
    conversions: 31,
    trend: "-7.4% CPA",
  },
  {
    campaignId: "cmpn_103",
    spend: 1_410,
    impressions: 52_340,
    clicks: 1_321,
    conversions: 6,
    trend: "Paused",
  },
];

export const demoAds: ScopedAd[] = [
  {
    id: "ad_501",
    ad_group_id: "adgrp_301",
    name: "Storage outcome card",
    created_at: 1_776_038_400,
    updated_at: 1_787_875_200,
    creative: {
      type: "chat_card",
      title: "Make every metre work",
      body: "Modular storage designed around the room you already have.",
      target_url: "https://harbourhome.example/modular-storage",
      file_id: "file_901",
      image_url: "https://cdn.openai.com/ads/file_901.png",
    },
    status: "active",
    review_status: "approved",
    review: { status: "approved" },
  },
  {
    id: "ad_502",
    ad_group_id: "adgrp_302",
    name: "Modular shelf card",
    created_at: 1_776_038_500,
    updated_at: 1_787_875_300,
    creative: {
      type: "chat_card",
      title: "Storage that adapts to your home",
      body: "Build a storage system that changes when your space does.",
      target_url: "https://harbourhome.example/modular-storage",
      file_id: "file_902",
      image_url: "https://cdn.openai.com/ads/file_902.png",
    },
    status: "active",
    review_status: "approved",
    review: { status: "approved" },
  },
  {
    id: "ad_503",
    ad_group_id: "adgrp_303",
    name: "Small-space product template",
    created_at: 1_776_038_600,
    updated_at: 1_787_875_400,
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
    serving_issues: [{ code: "ad_in_review" }],
  },
  {
    id: "ad_504",
    ad_group_id: "adgrp_304",
    name: "Oak bench card",
    created_at: 1_776_038_700,
    updated_at: 1_787_875_500,
    creative: {
      type: "chat_card",
      title: "A bench with room inside",
      body: "Seating and hidden storage in one compact piece.",
      target_url: "https://harbourhome.example/clearance/oak-bench",
      file_id: "file_904",
      image_url: "https://cdn.openai.com/ads/file_904.png",
    },
    status: "active",
    review_status: "approved",
    review: { status: "approved" },
  },
  {
    id: "ad_505",
    ad_group_id: "adgrp_304",
    name: "Clearance price card",
    created_at: 1_776_038_800,
    updated_at: 1_787_875_600,
    creative: {
      type: "chat_card",
      title: "Last chance storage",
      body: "Limited clearance pieces for compact homes.",
      target_url: "https://harbourhome.example/clearance",
      file_id: "file_905",
      image_url: "https://cdn.openai.com/ads/file_905.png",
    },
    status: "paused",
    review_status: "rejected",
    review: {
      status: "rejected",
      reason: "robots_txt",
      screenshot_url: "https://cdn.openai.com/ads/reviews/ad_505.png",
    },
    serving_issues: [{ code: "landing_page_crawl_issue" }],
  },
];

export const demoCreativeReviewEvents: CreativeReviewEvent[] = [
  {
    id: "demo_creative_event_2",
    accountId: demoAccount.id,
    adId: "ad_505",
    adGroupId: "adgrp_304",
    adName: "Clearance price card",
    eventType: "review_status_changed",
    previousReviewStatus: "in_review",
    reviewStatus: "rejected",
    previousDeliveryStatus: "paused",
    deliveryStatus: "paused",
    providerUpdatedAt: 1_787_875_600,
    detectedAt: "2026-08-29T14:20:00.000Z",
  },
  {
    id: "demo_creative_event_1",
    accountId: demoAccount.id,
    adId: "ad_503",
    adGroupId: "adgrp_303",
    adName: "Small-space product template",
    eventType: "review_and_delivery_changed",
    previousReviewStatus: "approved",
    reviewStatus: "in_review",
    previousDeliveryStatus: "active",
    deliveryStatus: "paused",
    providerUpdatedAt: 1_787_875_400,
    detectedAt: "2026-08-28T09:45:00.000Z",
  },
];

export const demoRecommendations: Recommendation[] = [
  {
    id: "rec_bid_20",
    source: "demo",
    title: "Lower the CPA bid by 20%",
    summary: "Summer storage is paying above the account target.",
    rationale:
      "Click-attributed conversions held flat while spend increased for six consecutive days. A controlled bid reduction should protect efficiency without changing creative, targeting, or campaign eligibility.",
    priority: "high",
    confidence: 92,
    status: "ready",
    entityLabel: "Summer storage · High-intent storage",
    entityId: "adgrp_301",
    currentValue: "$270 CPA bid",
    proposedValue: "$216 CPA bid",
    estimatedImpact: "$2.1k–$3.0k less monthly spend at the current delivery rate",
    safeguard:
      "Revert to $270 if click-attributed conversions fall more than 15% after seven days.",
    nextStep:
      "After approval, MaintainFlow records the change and starts a seven-day monitoring window.",
    monitoringPlan: {
      kind: "click_attributed_conversion_guardrail",
      windowDays: 7,
      baseline: {
        rangeStart: 1_787_356_800,
        rangeEnd: 1_787_961_600,
        spend: 4_822,
        clickAttributedConversions: 15,
        cpa: 321.4667,
        configuredBidMicros: 270_000_000,
        currencyCode: "USD",
      },
      rollbackRule: {
        metric: "click_attributed_conversions",
        comparison: "decrease_percent_greater_than",
        thresholdPercent: 15,
      },
    },
    evidence: [
      { label: "Current CPA", value: "$312", detail: "+30% above target" },
      { label: "Target CPA", value: "$240", detail: "Account goal" },
      { label: "7-day spend", value: "$4,822", detail: "+21% week over week" },
    ],
    mutation: {
      method: "POST",
      path: "/ad_groups/adgrp_301",
      body: {
        bidding_config: {
          billing_event_type: "click",
          max_bid_micros: 216_000_000,
        },
      },
    },
    rollback: {
      method: "POST",
      path: "/ad_groups/adgrp_301",
      body: {
        bidding_config: {
          billing_event_type: "click",
          max_bid_micros: 270_000_000,
        },
      },
    },
  },
  {
    id: "rec_creative_test",
    source: "demo",
    title: "Test a space-saving benefit",
    summary: "The leading ad has strong reach but below-average CTR.",
    rationale:
      "The current creative describes the product category but does not lead with the strongest customer outcome. A concise small-space benefit is the cleanest isolated test.",
    priority: "high",
    confidence: 84,
    status: "ready",
    entityLabel: "Small-space living · Modular shelf card",
    entityId: "ad_502",
    currentValue: "Storage that adapts to your home",
    proposedValue: "Make more room without moving",
    estimatedImpact: "Potential 8–14% lift in qualified clicks",
    safeguard:
      "Keep the current creative snapshot and revert if CTR trails baseline after 5,000 impressions.",
    nextStep:
      "The edited ad will return to review. MaintainFlow will watch review_status before judging performance.",
    evidence: [
      { label: "CTR", value: "2.4%", detail: "Account median 3.1%" },
      { label: "Impressions", value: "48.2k", detail: "Enough test volume" },
      { label: "Review status", value: "Approved", detail: "Current version" },
    ],
    mutation: {
      method: "POST",
      path: "/ads/ad_502",
      body: {
        status: "active",
        creative: {
          type: "chat_card",
          title: "Make more room without moving",
          body: "Flexible storage designed for the space you already have.",
          target_url: "https://harbourhome.example/modular-storage",
          file_id: "file_902",
        },
      },
    },
    rollback: {
      method: "POST",
      path: "/ads/ad_502",
      body: {
        status: "active",
        creative: {
          type: "chat_card",
          title: "Storage that adapts to your home",
          body: "Build a storage system that changes when your space does.",
          target_url: "https://harbourhome.example/modular-storage",
          file_id: "file_902",
        },
      },
    },
  },
  {
    id: "rec_context_hints",
    source: "demo",
    title: "Tighten overlapping context hints",
    summary: "Two ad groups are competing on nearly identical intent.",
    rationale:
      "The ad group contains broad and duplicated context descriptions. Consolidating them creates a clearer signal while preserving the same campaign and conversion goal.",
    priority: "medium",
    confidence: 76,
    status: "ready",
    entityLabel: "Summer storage · Apartment organisers",
    entityId: "adgrp_303",
    currentValue: "8 overlapping hints",
    proposedValue: "4 distinct hints",
    estimatedImpact: "Cleaner intent coverage and easier experiment attribution",
    safeguard:
      "Restore the original hint list if impressions decline more than 20% over seven days.",
    nextStep:
      "MaintainFlow will compare delivery by ad group before and after the context update.",
    evidence: [
      { label: "Overlap", value: "63%", detail: "Across two ad groups" },
      { label: "Spend share", value: "34%", detail: "On duplicate intent" },
      { label: "Window", value: "14 days", detail: "Daily insight rows" },
    ],
    mutation: {
      method: "POST",
      path: "/ad_groups/adgrp_303",
      body: {
        context_hints: [
          "small apartment storage",
          "modular shelving",
          "renter-friendly organisation",
          "space-saving furniture",
        ],
      },
    },
    rollback: {
      method: "POST",
      path: "/ad_groups/adgrp_303",
      body: {
        context_hints: [
          "small space",
          "small apartment",
          "apartment storage",
          "storage for apartments",
          "modular shelving",
          "shelves for renters",
          "space-saving furniture",
          "home organisation",
        ],
      },
    },
  },
  {
    id: "rec_pause_ad",
    source: "demo",
    title: "Pause an unavailable destination",
    summary: "One active ad currently resolves to an out-of-stock collection.",
    rationale:
      "The destination audit returned an unavailable product state. Pausing the ad prevents avoidable clicks while leaving its parent campaign and ad group untouched.",
    priority: "high",
    confidence: 97,
    status: "ready",
    entityLabel: "Clearance feed · Oak bench card",
    entityId: "ad_504",
    currentValue: "Active",
    proposedValue: "Paused",
    estimatedImpact: "Avoids spend on a non-converting destination",
    safeguard:
      "Reactivate only after the product is available and the destination passes a fresh audit.",
    nextStep:
      "MaintainFlow will retain the ad and use the reversible pause action, never archive it.",
    evidence: [
      { label: "Destination", value: "Unavailable", detail: "Latest audit" },
      { label: "7-day clicks", value: "184", detail: "$326 spend" },
      { label: "Conversions", value: "0", detail: "Click-attributed" },
    ],
    mutation: {
      method: "POST",
      path: "/ads/ad_504/pause",
      body: null,
    },
    rollback: {
      method: "POST",
      path: "/ads/ad_504/activate",
      body: null,
    },
  },
];

export function getDemoRecommendation(id: string) {
  return demoRecommendations.find((recommendation) => recommendation.id === id);
}
