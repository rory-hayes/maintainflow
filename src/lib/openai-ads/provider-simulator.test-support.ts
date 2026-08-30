import { ZodError } from "zod";

import {
  adAccountSchema,
  adGroupListResponseSchema,
  adGroupSchema,
  adListResponseSchema,
  adSchema,
  campaignListResponseSchema,
  campaignSchema,
  conversionEventSettingSchema,
  conversionEventSettingListResponseSchema,
  conversionInsightResponseSchema,
  conversionInsightRowSchema,
  createAdGroupInputSchema,
  createAdInputSchema,
  createCampaignInputSchema,
  insightListResponseSchema,
  insightRowSchema,
  updateAdGroupInputSchema,
  updateAdInputSchema,
  updateCampaignInputSchema,
  type Ad,
  type AdAccount,
  type AdGroup,
  type Campaign,
  type ConversionEventSetting,
  type ConversionInsightRow,
  type InsightRow,
} from "./schema";

/**
 * Test support only. This simulator intercepts requests made to the canonical
 * OpenAI Ads origin; it does not expose or configure an alternate production
 * base URL. Runtime construction is refused when NODE_ENV is `production`.
 */
const OPENAI_ADS_ORIGIN = "https://api.ads.openai.com";
const OPENAI_ADS_PREFIX = "/v1";
const DEFAULT_TEST_TOKEN = "ads-simulator-test-key";
const DEFAULT_NOW = 1_788_652_800;

type ScopedAdGroup = AdGroup & { campaign_id: string };
type ScopedAd = Ad & { ad_group_id: string };

export type OpenAIAdsSimulatorScenario =
  | "healthy"
  | "overspending"
  | "creative_review"
  | "empty";

export type OpenAIAdsReviewTransition = Pick<
  Ad,
  "review_status" | "review"
> &
  Partial<Pick<Ad, "status" | "appeal" | "serving_issues">>;

export type OpenAIAdsSimulatorSeed = {
  account: AdAccount;
  campaigns: Campaign[];
  adGroups: ScopedAdGroup[];
  ads: ScopedAd[];
  insights: InsightRow[];
  conversionInsights: ConversionInsightRow[];
  conversionEventSettings: ConversionEventSetting[];
  reviewTransitions?: Record<string, OpenAIAdsReviewTransition[]>;
  pageSize?: number;
  now?: number;
};

export type OpenAIAdsSimulatorFault =
  | {
      kind: "http";
      status: 401 | 403 | 429 | 500;
      method?: string;
      path?: string | RegExp;
      times?: number;
      retryAfter?: string;
    }
  | {
      kind: "timeout";
      method?: string;
      path?: string | RegExp;
      times?: number;
      delayMs?: number;
    }
  | {
      kind: "ambiguous_write";
      method?: string;
      path?: string | RegExp;
      times?: number;
      delayMs?: number;
    };

export type OpenAIAdsSimulatorRequest = {
  sequence: number;
  method: string;
  path: string;
  adAccountId: string | null;
  idempotencyKey: string | null;
  outcome:
    | "response"
    | "idempotent_replay"
    | "fault"
    | "timeout"
    | "ambiguous_write";
  status: number | null;
};

export type OpenAIAdsSimulatorSnapshot = Omit<
  OpenAIAdsSimulatorSeed,
  "reviewTransitions" | "pageSize" | "now"
> & {
  reviewTransitions: Record<string, OpenAIAdsReviewTransition[]>;
  pageSize: number;
  now: number;
};

export type OpenAIAdsProviderSimulator = {
  fetch: typeof globalThis.fetch;
  requests: OpenAIAdsSimulatorRequest[];
  snapshot(): OpenAIAdsSimulatorSnapshot;
  reset(seed?: OpenAIAdsSimulatorSeed): void;
  enqueueFault(fault: OpenAIAdsSimulatorFault): void;
  advanceReview(adId: string): Ad;
  transitionReview(adId: string, transition: OpenAIAdsReviewTransition): Ad;
};

type SimulatorOptions = {
  scenario?: OpenAIAdsSimulatorScenario;
  seed?: OpenAIAdsSimulatorSeed;
  acceptedBearerTokens?: readonly string[];
  faults?: readonly OpenAIAdsSimulatorFault[];
  pageSize?: number;
};

type StoredFault = OpenAIAdsSimulatorFault & { remaining: number };
type StoredResponse = {
  fingerprint: string;
  status: number;
  headers: [string, string][];
  body: string;
};

class SimulatorRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers?: HeadersInit,
  ) {
    super(message);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: HeadersInit = {},
) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

function errorResponse(
  status: number,
  message: string,
  headers: HeadersInit = {},
) {
  return jsonResponse(
    {
      error: {
        type: "simulator_error",
        message,
      },
    },
    status,
    headers,
  );
}

function baseAccount(): AdAccount {
  return {
    id: "adacct_sim_001",
    name: "Northstar Home",
    url: "https://northstar-home.example",
    preview_url: null,
    status: "active",
    timezone: "Europe/Dublin",
    currency_code: "EUR",
    review: { status: "approved" },
  };
}

function baseCampaigns(): Campaign[] {
  return [
    {
      id: "cmpn_sim_001",
      created_at: 1_776_038_400,
      updated_at: 1_788_048_000,
      name: "Storage outcomes",
      description: "Conversion campaign for modular storage.",
      status: "active",
      mode: null,
      product_feed_id: null,
      start_time: 1_776_038_400,
      end_time: null,
      budget: { daily_spend_limit_micros: 500_000_000 },
      bidding_type: "conversions",
      conversion_event_setting_ids: ["ces_sim_purchase"],
    },
    {
      id: "cmpn_sim_002",
      created_at: 1_776_038_500,
      updated_at: 1_788_048_100,
      name: "Small-space discovery",
      description: "Click campaign for compact rooms.",
      status: "active",
      mode: null,
      product_feed_id: null,
      start_time: 1_776_038_500,
      end_time: null,
      budget: { lifetime_spend_limit_micros: 8_000_000_000 },
      bidding_type: "clicks",
      conversion_event_setting_ids: [],
    },
    {
      id: "cmpn_sim_003",
      created_at: 1_776_038_600,
      updated_at: 1_788_048_200,
      name: "Seasonal clearance",
      description: "Paused campaign retained for rollback testing.",
      status: "paused",
      mode: "product_feed",
      product_feed_id: "feed_sim_001",
      start_time: 1_776_038_600,
      end_time: null,
      budget: { lifetime_spend_limit_micros: 4_000_000_000 },
      bidding_type: "clicks",
      conversion_event_setting_ids: [],
    },
  ];
}

function baseAdGroups(): ScopedAdGroup[] {
  return [
    {
      id: "adgrp_sim_001",
      campaign_id: "cmpn_sim_001",
      created_at: 1_776_038_700,
      updated_at: 1_788_048_300,
      name: "High-intent storage",
      description: "Purchase-focused context.",
      context_hints: ["buy modular storage", "storage for a small room"],
      status: "active",
      bidding_config: {
        billing_event_type: "click",
        strategy: "fixed_bid",
        max_bid_micros: 20_000_000,
      },
    },
    {
      id: "adgrp_sim_002",
      campaign_id: "cmpn_sim_002",
      created_at: 1_776_038_800,
      updated_at: 1_788_048_400,
      name: "Apartment inspiration",
      description: null,
      context_hints: ["ideas for a small apartment"],
      status: "active",
      bidding_config: {
        billing_event_type: "click",
        strategy: "maximize_clicks",
        max_bid_micros: 8_000_000,
      },
    },
    {
      id: "adgrp_sim_003",
      campaign_id: "cmpn_sim_003",
      created_at: 1_776_038_900,
      updated_at: 1_788_048_500,
      name: "Clearance feed",
      description: "Paused with its parent campaign.",
      context_hints: [],
      status: "paused",
      bidding_config: {
        billing_event_type: "click",
        strategy: "fixed_bid",
        max_bid_micros: 5_000_000,
      },
      product_set: {
        product_feed_id: "feed_sim_001",
        filters: [],
      },
    },
  ];
}

function baseAds(): ScopedAd[] {
  return [
    {
      id: "ad_sim_001",
      ad_group_id: "adgrp_sim_001",
      name: "Modular storage card",
      created_at: 1_776_039_000,
      updated_at: 1_788_048_600,
      creative: {
        type: "chat_card",
        title: "Make every metre work",
        body: "Modular storage designed around the room you already have.",
        target_url: "https://northstar-home.example/storage",
        file_id: "file_sim_001",
        image_url: "https://cdn.openai.com/ads/file_sim_001.png",
      },
      status: "active",
      review_status: "approved",
      review: { status: "approved" },
    },
    {
      id: "ad_sim_002",
      ad_group_id: "adgrp_sim_001",
      name: "Storage planner card",
      created_at: 1_776_039_100,
      updated_at: 1_788_048_700,
      creative: {
        type: "chat_card",
        title: "Plan storage around your room",
        body: "See a flexible system for awkward spaces.",
        target_url: "https://northstar-home.example/planner",
        file_id: "file_sim_002",
        image_url: "https://cdn.openai.com/ads/file_sim_002.png",
      },
      status: "active",
      review_status: "approved",
      review: { status: "approved" },
    },
    {
      id: "ad_sim_review",
      ad_group_id: "adgrp_sim_002",
      name: "Compact room card",
      created_at: 1_776_039_200,
      updated_at: 1_788_048_800,
      creative: {
        type: "chat_card",
        title: "A calmer compact room",
        body: "Furniture and storage selected for smaller homes.",
        target_url: "https://northstar-home.example/compact",
        file_id: "file_sim_review",
        image_url: "https://cdn.openai.com/ads/file_sim_review.png",
      },
      status: "paused",
      review_status: "in_review",
      review: { status: "in_review" },
      serving_issues: [{ code: "ad_in_review" }],
    },
    {
      id: "ad_sim_004",
      ad_group_id: "adgrp_sim_003",
      name: "Clearance product template",
      created_at: 1_776_039_300,
      updated_at: 1_788_048_900,
      creative: {
        type: "product_ad_template",
        title: "Last pieces for compact homes",
        body: "See remaining stock that fits your room.",
        price: "{{product.price}}",
        target_url: null,
      },
      status: "paused",
      review_status: "approved",
      review: { status: "approved" },
    },
  ];
}

function baseInsights(): InsightRow[] {
  const start = 1_788_048_000;
  const end = 1_788_652_800;
  return [
    {
      id: "ins_campaign_001",
      start_time: start,
      end_time: end,
      campaign_id: "cmpn_sim_001",
      campaign_name: "Storage outcomes",
      impressions: 48_000,
      clicks: 1_600,
      spend: 1_200,
    },
    {
      id: "ins_campaign_002",
      start_time: start,
      end_time: end,
      campaign_id: "cmpn_sim_002",
      campaign_name: "Small-space discovery",
      impressions: 31_000,
      clicks: 1_050,
      spend: 540,
    },
    {
      id: "ins_campaign_003",
      start_time: start,
      end_time: end,
      campaign_id: "cmpn_sim_003",
      campaign_name: "Seasonal clearance",
      impressions: 4_000,
      clicks: 90,
      spend: 35,
    },
    {
      id: "ins_adgroup_001",
      start_time: start,
      end_time: end,
      ad_group_id: "adgrp_sim_001",
      impressions: 48_000,
      clicks: 1_600,
      spend: 1_200,
    },
    {
      id: "ins_adgroup_002",
      start_time: start,
      end_time: end,
      ad_group_id: "adgrp_sim_002",
      impressions: 31_000,
      clicks: 1_050,
      spend: 540,
    },
    {
      id: "ins_adgroup_003",
      start_time: start,
      end_time: end,
      ad_group_id: "adgrp_sim_003",
      impressions: 4_000,
      clicks: 90,
      spend: 35,
    },
    {
      id: "ins_ad_001",
      start_time: start,
      end_time: end,
      ad_id: "ad_sim_001",
      impressions: 26_000,
      clicks: 900,
      spend: 700,
    },
  ];
}

function baseConversionInsights(): ConversionInsightRow[] {
  return [
    {
      entity_id: "cmpn_sim_001",
      conversions: 24,
      click_through_conversions: 24,
      view_through_conversions: 3,
    },
    {
      entity_id: "cmpn_sim_002",
      conversions: 8,
      click_through_conversions: 8,
      view_through_conversions: 1,
    },
    {
      entity_id: "cmpn_sim_003",
      conversions: 1,
      click_through_conversions: 1,
      view_through_conversions: 0,
    },
    {
      entity_id: "adgrp_sim_001",
      conversions: 24,
      click_through_conversions: 24,
      view_through_conversions: 3,
    },
    {
      entity_id: "adgrp_sim_002",
      conversions: 8,
      click_through_conversions: 8,
      view_through_conversions: 1,
    },
    {
      entity_id: "adgrp_sim_003",
      conversions: 1,
      click_through_conversions: 1,
      view_through_conversions: 0,
    },
  ];
}

function baseEventSettings(accountId: string): ConversionEventSetting[] {
  return [
    {
      id: "ces_sim_purchase",
      name: "Purchases",
      event_type: "order_created",
      custom_event_name: null,
      attribution_window_days: 30,
      ad_account_id: accountId,
      source_ids: ["clidsrc_sim_web"],
      sources: [{ id: "clidsrc_sim_web", name: "Website" }],
      campaigns: [],
      archived: false,
      version: 1,
    },
  ];
}

function baseReviewTransitions(): Record<string, OpenAIAdsReviewTransition[]> {
  return {
    ad_sim_review: [
      {
        status: "paused",
        review_status: "rejected",
        review: {
          status: "rejected",
          reason: "robots_txt",
          screenshot_url:
            "https://cdn.openai.com/ads/reviews/ad_sim_review.png",
        },
        serving_issues: [{ code: "landing_page_crawl_issue" }],
      },
      {
        status: "paused",
        review_status: "in_review",
        review: { status: "in_review" },
        appeal: {
          status: "requested",
          requested_at: DEFAULT_NOW + 2,
          resolved_at: null,
        },
        serving_issues: [{ code: "ad_in_review" }],
      },
      {
        status: "active",
        review_status: "approved",
        review: { status: "approved" },
        appeal: {
          status: "approved",
          requested_at: DEFAULT_NOW + 2,
          resolved_at: DEFAULT_NOW + 3,
        },
        serving_issues: [],
      },
    ],
  };
}

export function createOpenAIAdsSimulatorSeed(
  scenario: OpenAIAdsSimulatorScenario = "overspending",
): OpenAIAdsSimulatorSeed {
  const account = baseAccount();
  if (scenario === "empty") {
    return {
      account,
      campaigns: [],
      adGroups: [],
      ads: [],
      insights: [],
      conversionInsights: [],
      conversionEventSettings: [],
      reviewTransitions: {},
      pageSize: 2,
      now: DEFAULT_NOW,
    };
  }

  const campaigns = baseCampaigns();
  const adGroups = baseAdGroups();
  const ads = baseAds();
  const insights = baseInsights();
  const conversionInsights = baseConversionInsights();

  if (scenario === "healthy") {
    adGroups[0] = {
      ...adGroups[0],
      bidding_config: {
        ...adGroups[0].bidding_config,
        max_bid_micros: 75_000_000,
      },
    };
    ads[2] = {
      ...ads[2],
      status: "active",
      review_status: "approved",
      review: { status: "approved" },
      serving_issues: [],
    };
  }

  if (scenario === "creative_review") {
    const campaign = campaigns[1];
    const adGroup = adGroups[1];
    return {
      account,
      campaigns: [campaign],
      adGroups: [adGroup],
      ads: [ads[2]],
      insights: insights.filter(
        (row) =>
          row.campaign_id === campaign.id || row.ad_group_id === adGroup.id,
      ),
      conversionInsights: conversionInsights.filter(
        (row) => row.entity_id === campaign.id || row.entity_id === adGroup.id,
      ),
      conversionEventSettings: [],
      reviewTransitions: baseReviewTransitions(),
      pageSize: 2,
      now: DEFAULT_NOW,
    };
  }

  return {
    account,
    campaigns,
    adGroups,
    ads,
    insights,
    conversionInsights,
    conversionEventSettings: baseEventSettings(account.id),
    reviewTransitions:
      scenario === "overspending" ? baseReviewTransitions() : {},
    pageSize: 2,
    now: DEFAULT_NOW,
  };
}

function validatedSeed(seed: OpenAIAdsSimulatorSeed): OpenAIAdsSimulatorSeed {
  const parsed = {
    account: adAccountSchema.parse(seed.account),
    campaigns: seed.campaigns.map((item) => campaignSchema.parse(item)),
    adGroups: seed.adGroups.map((item) => ({
      ...adGroupSchema.parse(item),
      campaign_id: item.campaign_id,
    })),
    ads: seed.ads.map((item) => ({
      ...adSchema.parse(item),
      ad_group_id: item.ad_group_id,
    })),
    insights: seed.insights.map((item) => insightRowSchema.parse(item)),
    conversionInsights: seed.conversionInsights.map((item) =>
      conversionInsightRowSchema.parse(item),
    ),
    conversionEventSettings: seed.conversionEventSettings.map((item) =>
      conversionEventSettingSchema.parse(item),
    ),
    reviewTransitions: clone(seed.reviewTransitions ?? {}),
    pageSize: seed.pageSize,
    now: seed.now,
  };

  const campaignIds = new Set(parsed.campaigns.map((item) => item.id));
  const adGroupIds = new Set(parsed.adGroups.map((item) => item.id));
  for (const adGroup of parsed.adGroups) {
    if (!campaignIds.has(adGroup.campaign_id)) {
      throw new Error(
        `Simulator ad group ${adGroup.id} refers to a missing campaign.`,
      );
    }
  }
  for (const ad of parsed.ads) {
    if (!adGroupIds.has(ad.ad_group_id)) {
      throw new Error(`Simulator ad ${ad.id} refers to a missing ad group.`);
    }
  }
  for (const [adId, transitions] of Object.entries(parsed.reviewTransitions)) {
    if (!parsed.ads.some((ad) => ad.id === adId)) {
      throw new Error(`Review transitions refer to missing ad ${adId}.`);
    }
    for (const transition of transitions) {
      const current = parsed.ads.find((ad) => ad.id === adId)!;
      adSchema.parse({ ...current, ...transition });
    }
  }
  return parsed;
}

function matchesFault(
  fault: StoredFault,
  method: string,
  pathname: string,
) {
  if (fault.remaining < 1) return false;
  if (fault.method && fault.method.toUpperCase() !== method) return false;
  if (!fault.path) return true;
  if (typeof fault.path === "string") return fault.path === pathname;
  fault.path.lastIndex = 0;
  return fault.path.test(pathname);
}

function storedFault(fault: OpenAIAdsSimulatorFault): StoredFault {
  return {
    ...fault,
    remaining: Math.max(1, fault.times ?? 1),
  };
}

function isMutation(method: string) {
  return method !== "GET" && method !== "HEAD";
}

function requestFingerprint(request: Request, rawBody: string) {
  const url = new URL(request.url);
  return `${request.method.toUpperCase()} ${url.pathname}${url.search}\n${rawBody}`;
}

function timeoutFailure(signal: AbortSignal, delayMs: number): Promise<never> {
  return new Promise<never>((_, reject) => {
    const rejectTimeout = () => {
      signal.removeEventListener("abort", rejectAbort);
      reject(new DOMException("The simulated request timed out.", "TimeoutError"));
    };
    const rejectAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(rejectTimeout, Math.max(0, delayMs));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
}

function requireObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SimulatorRequestError(400, "A JSON object body is required.");
  }
  return value;
}

function strictPositiveInteger(value: string | null, fallback: number) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) {
    throw new SimulatorRequestError(400, "limit must be a positive integer.");
  }
  return Number(value);
}

function paginate<T extends { id: string }>(
  items: T[],
  params: URLSearchParams,
  pageSize: number,
) {
  const requestedLimit = strictPositiveInteger(params.get("limit"), pageSize);
  const effectiveLimit = Math.min(requestedLimit, pageSize);
  const ordered = params.get("order") === "desc" ? [...items].reverse() : items;
  const after = params.get("after");
  let offset = 0;
  if (after) {
    const cursorIndex = ordered.findIndex((item) => item.id === after);
    if (cursorIndex < 0) {
      throw new SimulatorRequestError(400, "The pagination cursor is invalid.");
    }
    offset = cursorIndex + 1;
  }
  const data = ordered.slice(offset, offset + effectiveLimit);
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data.at(-1)?.id ?? null,
    has_more: offset + data.length < ordered.length,
  };
}

function nextIdentifier(prefix: string, ids: readonly string[]) {
  let index = ids.length + 1;
  while (ids.includes(`${prefix}${index.toString().padStart(3, "0")}`)) {
    index += 1;
  }
  return `${prefix}${index.toString().padStart(3, "0")}`;
}

export function createOpenAIAdsProviderSimulator(
  options: SimulatorOptions = {},
): OpenAIAdsProviderSimulator {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The OpenAI Ads provider simulator is test-only.");
  }
  if (options.seed && options.scenario) {
    throw new Error("Provide a simulator seed or a named scenario, not both.");
  }

  const acceptedTokens = new Set(
    options.acceptedBearerTokens ?? [DEFAULT_TEST_TOKEN],
  );
  const requests: OpenAIAdsSimulatorRequest[] = [];
  const faults: StoredFault[] = (options.faults ?? []).map(storedFault);
  const idempotency = new Map<string, StoredResponse>();
  let seed = validatedSeed(
    clone(options.seed ?? createOpenAIAdsSimulatorSeed(options.scenario)),
  );
  let state = toSnapshot(seed, options.pageSize);
  let sequence = 0;

  function toSnapshot(
    nextSeed: OpenAIAdsSimulatorSeed,
    pageSizeOverride?: number,
  ): OpenAIAdsSimulatorSnapshot {
    const pageSize = pageSizeOverride ?? nextSeed.pageSize ?? 100;
    if (!Number.isInteger(pageSize) || pageSize < 1) {
      throw new Error("Simulator pageSize must be a positive integer.");
    }
    return {
      account: clone(nextSeed.account),
      campaigns: clone(nextSeed.campaigns),
      adGroups: clone(nextSeed.adGroups),
      ads: clone(nextSeed.ads),
      insights: clone(nextSeed.insights),
      conversionInsights: clone(nextSeed.conversionInsights),
      conversionEventSettings: clone(nextSeed.conversionEventSettings),
      reviewTransitions: clone(nextSeed.reviewTransitions ?? {}),
      pageSize,
      now: nextSeed.now ?? DEFAULT_NOW,
    };
  }

  function tick() {
    state.now += 1;
    return state.now;
  }

  function findCampaign(id: string) {
    const item = state.campaigns.find((candidate) => candidate.id === id);
    if (!item) throw new SimulatorRequestError(404, "Campaign not found.");
    return item;
  }

  function findAdGroup(id: string) {
    const item = state.adGroups.find((candidate) => candidate.id === id);
    if (!item) throw new SimulatorRequestError(404, "Ad group not found.");
    return item;
  }

  function findAd(id: string) {
    const item = state.ads.find((candidate) => candidate.id === id);
    if (!item) throw new SimulatorRequestError(404, "Ad not found.");
    return item;
  }

  function enforceReversibleStatus(status: unknown) {
    if (status === "archived") {
      throw new SimulatorRequestError(
        400,
        "The test adapter only enables reversible active and paused states.",
      );
    }
  }

  function replaceCampaign(id: string, item: Campaign) {
    state.campaigns = state.campaigns.map((candidate) =>
      candidate.id === id ? item : candidate,
    );
  }

  function replaceAdGroup(id: string, item: ScopedAdGroup) {
    state.adGroups = state.adGroups.map((candidate) =>
      candidate.id === id ? item : candidate,
    );
  }

  function replaceAd(id: string, item: ScopedAd) {
    state.ads = state.ads.map((candidate) =>
      candidate.id === id ? item : candidate,
    );
  }

  function entityInsights(
    entity: "campaign" | "ad_group" | "ad",
    id?: string,
  ) {
    const key = `${entity}_id` as "campaign_id" | "ad_group_id" | "ad_id";
    return state.insights.filter((row) =>
      id ? row[key] === id : Boolean(row[key]),
    );
  }

  async function routeRequest(
    request: Request,
    url: URL,
    rawBody: string,
  ): Promise<Response> {
    const method = request.method.toUpperCase();
    const path = url.pathname.slice(OPENAI_ADS_PREFIX.length) || "/";
    const body: unknown = rawBody ? JSON.parse(rawBody) : undefined;

    if (method === "GET" && path === "/ad_account") {
      return jsonResponse(adAccountSchema.parse(state.account));
    }

    if (method === "GET" && path === "/campaigns") {
      return jsonResponse(
        campaignListResponseSchema.parse(
          paginate(state.campaigns, url.searchParams, state.pageSize),
        ),
      );
    }
    const campaignMatch = path.match(/^\/campaigns\/([^/]+)$/);
    if (method === "GET" && campaignMatch) {
      return jsonResponse(campaignSchema.parse(findCampaign(campaignMatch[1])));
    }
    if (method === "POST" && path === "/campaigns") {
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (!idempotencyKey) {
        throw new SimulatorRequestError(
          400,
          "Idempotency-Key is required for campaign creation.",
        );
      }
      const input = createCampaignInputSchema.parse(requireObject(body));
      const id = nextIdentifier(
        "cmpn_sim_",
        state.campaigns.map((item) => item.id),
      );
      const campaign = campaignSchema.parse({
        ...input,
        id,
        created_at: tick(),
        updated_at: state.now,
        description: input.description ?? null,
        mode: input.mode ?? null,
        product_feed_id: input.product_feed_id ?? null,
        business_agent_id: input.business_agent_id,
        start_time: input.start_time ?? null,
        end_time: input.end_time ?? null,
        bidding_type:
          input.bidding_type ??
          (input.objective === "reach" ? "impressions" : input.objective) ??
          "clicks",
        conversion_event_setting_ids: input.conversion_event_setting_ids ?? [],
      });
      state.campaigns.push(campaign);
      return jsonResponse(campaign);
    }
    if (method === "POST" && campaignMatch) {
      const current = findCampaign(campaignMatch[1]);
      const input = updateCampaignInputSchema.parse(requireObject(body));
      enforceReversibleStatus(input.status);
      const updated = campaignSchema.parse({
        ...current,
        ...input,
        updated_at: tick(),
      });
      replaceCampaign(current.id, updated);
      return jsonResponse(updated);
    }
    const campaignActionMatch = path.match(
      /^\/campaigns\/([^/]+)\/(activate|pause)$/,
    );
    if (method === "POST" && campaignActionMatch) {
      const current = findCampaign(campaignActionMatch[1]);
      const updated = campaignSchema.parse({
        ...current,
        status: campaignActionMatch[2] === "activate" ? "active" : "paused",
        updated_at: tick(),
      });
      replaceCampaign(current.id, updated);
      return jsonResponse(updated);
    }

    if (method === "GET" && path === "/ad_groups") {
      const campaignId = url.searchParams.get("campaign_id");
      const items = campaignId
        ? state.adGroups.filter((item) => item.campaign_id === campaignId)
        : state.adGroups;
      return jsonResponse(
        adGroupListResponseSchema.parse(
          paginate(items, url.searchParams, state.pageSize),
        ),
      );
    }
    const adGroupMatch = path.match(/^\/ad_groups\/([^/]+)$/);
    if (method === "GET" && adGroupMatch) {
      return jsonResponse(adGroupSchema.parse(findAdGroup(adGroupMatch[1])));
    }
    if (method === "POST" && path === "/ad_groups") {
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (!idempotencyKey) {
        throw new SimulatorRequestError(
          400,
          "Idempotency-Key is required for ad-group creation.",
        );
      }
      const input = createAdGroupInputSchema.parse(requireObject(body));
      findCampaign(input.campaign_id);
      const id = nextIdentifier(
        "adgrp_sim_",
        state.adGroups.map((item) => item.id),
      );
      const adGroup: ScopedAdGroup = {
        ...adGroupSchema.parse({
          ...input,
          id,
          created_at: tick(),
          updated_at: state.now,
          description: input.description ?? null,
          context_hints: input.context_hints ?? [],
        }),
        campaign_id: input.campaign_id,
      };
      state.adGroups.push(adGroup);
      return jsonResponse(adGroup);
    }
    if (method === "POST" && adGroupMatch) {
      const current = findAdGroup(adGroupMatch[1]);
      const input = updateAdGroupInputSchema.parse(requireObject(body));
      enforceReversibleStatus(input.status);
      const updated: ScopedAdGroup = {
        ...adGroupSchema.parse({
          ...current,
          ...input,
          updated_at: tick(),
        }),
        campaign_id: current.campaign_id,
      };
      replaceAdGroup(current.id, updated);
      return jsonResponse(updated);
    }
    const adGroupActionMatch = path.match(
      /^\/ad_groups\/([^/]+)\/(activate|pause)$/,
    );
    if (method === "POST" && adGroupActionMatch) {
      const current = findAdGroup(adGroupActionMatch[1]);
      const updated: ScopedAdGroup = {
        ...adGroupSchema.parse({
          ...current,
          status: adGroupActionMatch[2] === "activate" ? "active" : "paused",
          updated_at: tick(),
        }),
        campaign_id: current.campaign_id,
      };
      replaceAdGroup(current.id, updated);
      return jsonResponse(updated);
    }

    if (method === "GET" && path === "/ads") {
      const adGroupId = url.searchParams.get("ad_group_id");
      const items = adGroupId
        ? state.ads.filter((item) => item.ad_group_id === adGroupId)
        : state.ads;
      return jsonResponse(
        adListResponseSchema.parse(
          paginate(items, url.searchParams, state.pageSize),
        ),
      );
    }
    const adMatch = path.match(/^\/ads\/([^/]+)$/);
    if (method === "GET" && adMatch) {
      return jsonResponse(adSchema.parse(findAd(adMatch[1])));
    }
    if (method === "POST" && path === "/ads") {
      const idempotencyKey = request.headers.get("Idempotency-Key");
      if (!idempotencyKey) {
        throw new SimulatorRequestError(
          400,
          "Idempotency-Key is required for ad creation.",
        );
      }
      const input = createAdInputSchema.parse(requireObject(body));
      findAdGroup(input.ad_group_id);
      const id = nextIdentifier(
        "ad_sim_",
        state.ads.map((item) => item.id),
      );
      const ad: ScopedAd = {
        ...adSchema.parse({
          ...input,
          id,
          created_at: tick(),
          updated_at: state.now,
          creative: {
            ...input.creative,
            target_url: input.creative.target_url ?? null,
          },
          review_status: "in_review",
          review: { status: "in_review" },
          serving_issues: [{ code: "ad_in_review" }],
        }),
        ad_group_id: input.ad_group_id,
      };
      state.ads.push(ad);
      return jsonResponse(ad);
    }
    if (method === "POST" && adMatch) {
      const current = findAd(adMatch[1]);
      const input = updateAdInputSchema.parse(requireObject(body));
      enforceReversibleStatus(input.status);
      const updated: ScopedAd = {
        ...adSchema.parse({
          ...current,
          ...input,
          updated_at: tick(),
          ...(input.creative
            ? {
                review_status: "in_review",
                review: { status: "in_review" },
                serving_issues: [{ code: "ad_in_review" }],
              }
            : {}),
        }),
        ad_group_id: current.ad_group_id,
      };
      replaceAd(current.id, updated);
      return jsonResponse(updated);
    }
    const adActionMatch = path.match(/^\/ads\/([^/]+)\/(activate|pause)$/);
    if (method === "POST" && adActionMatch) {
      const current = findAd(adActionMatch[1]);
      const updated: ScopedAd = {
        ...adSchema.parse({
          ...current,
          status: adActionMatch[2] === "activate" ? "active" : "paused",
          updated_at: tick(),
        }),
        ad_group_id: current.ad_group_id,
      };
      replaceAd(current.id, updated);
      return jsonResponse(updated);
    }

    if (method === "GET" && path === "/ad_account/insights") {
      const level = url.searchParams.get("aggregation_level");
      if (level !== "campaign" && level !== "ad_group" && level !== "ad") {
        throw new SimulatorRequestError(
          400,
          "aggregation_level must be campaign, ad_group, or ad.",
        );
      }
      const page = paginate(
        entityInsights(level),
        url.searchParams,
        state.pageSize,
      );
      return jsonResponse(
        insightListResponseSchema.parse({ ...page, count: page.data.length }),
      );
    }
    const entityInsightMatch = path.match(
      /^\/(campaigns|ad_groups|ads)\/([^/]+)\/insights$/,
    );
    if (method === "GET" && entityInsightMatch) {
      const entity =
        entityInsightMatch[1] === "campaigns"
          ? "campaign"
          : entityInsightMatch[1] === "ad_groups"
            ? "ad_group"
            : "ad";
      if (entity === "campaign") findCampaign(entityInsightMatch[2]);
      if (entity === "ad_group") findAdGroup(entityInsightMatch[2]);
      if (entity === "ad") findAd(entityInsightMatch[2]);
      const page = paginate(
        entityInsights(entity, entityInsightMatch[2]),
        url.searchParams,
        state.pageSize,
      );
      return jsonResponse(
        insightListResponseSchema.parse({ ...page, count: page.data.length }),
      );
    }

    if (method === "POST" && path === "/conversions/insights") {
      const input = requireObject(body) as {
        aggregation_level?: unknown;
        entity_ids?: unknown;
      };
      if (
        input.aggregation_level !== "campaign" &&
        input.aggregation_level !== "ad_group"
      ) {
        throw new SimulatorRequestError(
          400,
          "A supported conversion aggregation_level is required.",
        );
      }
      if (
        !Array.isArray(input.entity_ids) ||
        !input.entity_ids.every((id) => typeof id === "string")
      ) {
        throw new SimulatorRequestError(
          400,
          "conversion entity_ids must be an array of strings.",
        );
      }
      const ids = new Set(input.entity_ids as string[]);
      const data = state.conversionInsights.filter((row) => ids.has(row.entity_id));
      return jsonResponse(
        conversionInsightResponseSchema.parse({
          object: "list",
          count: data.length,
          data,
        }),
      );
    }

    if (method === "GET" && path === "/conversions/event_settings") {
      return jsonResponse(
        conversionEventSettingListResponseSchema.parse(
          paginate(
            state.conversionEventSettings,
            url.searchParams,
            state.pageSize,
          ),
        ),
      );
    }

    throw new SimulatorRequestError(
      404,
      `The simulator does not implement ${method} ${path}.`,
    );
  }

  const simulatorFetch: typeof globalThis.fetch = async (input, init) => {
    let request: Request;
    try {
      request = new Request(input, init);
    } catch {
      return errorResponse(400, "The simulator received an invalid request.");
    }
    const method = request.method.toUpperCase();
    const url = new URL(request.url);
    sequence += 1;

    if (url.origin !== OPENAI_ADS_ORIGIN || !url.pathname.startsWith(`${OPENAI_ADS_PREFIX}/`)) {
      throw new Error(
        "The test simulator only intercepts the canonical https://api.ads.openai.com/v1 origin.",
      );
    }

    const recordBase = {
      sequence,
      method,
      path: `${url.pathname}${url.search}`,
      adAccountId: request.headers.get("OpenAI-Ad-Account"),
      idempotencyKey: request.headers.get("Idempotency-Key"),
    };
    const authorization = request.headers.get("Authorization");
    const bearer = authorization?.match(/^Bearer (.+)$/)?.[1];
    if (!bearer || !acceptedTokens.has(bearer)) {
      const response = errorResponse(401, "The test credential is invalid.");
      requests.push({
        ...recordBase,
        outcome: "response",
        status: response.status,
      });
      return response;
    }
    if (
      recordBase.adAccountId &&
      recordBase.adAccountId !== state.account.id
    ) {
      const response = errorResponse(
        403,
        "The credential cannot access this advertiser account.",
      );
      requests.push({
        ...recordBase,
        outcome: "response",
        status: response.status,
      });
      return response;
    }

    let rawBody = "";
    try {
      rawBody = isMutation(method) ? await request.text() : "";
    } catch {
      const response = errorResponse(400, "The request body could not be read.");
      requests.push({ ...recordBase, outcome: "response", status: 400 });
      return response;
    }
    const idempotencyKey = recordBase.idempotencyKey;
    if (
      idempotencyKey !== null &&
      (idempotencyKey.length < 1 ||
        idempotencyKey.length > 255 ||
        !/\S/.test(idempotencyKey))
    ) {
      const response = errorResponse(
        400,
        "Idempotency-Key must be 1-255 non-whitespace characters.",
      );
      requests.push({ ...recordBase, outcome: "response", status: 400 });
      return response;
    }
    const fingerprint = requestFingerprint(request, rawBody);
    if (idempotencyKey && idempotency.has(idempotencyKey)) {
      const stored = idempotency.get(idempotencyKey)!;
      if (stored.fingerprint !== fingerprint) {
        const response = errorResponse(
          409,
          "Idempotency-Key was already used for a different request.",
        );
        requests.push({ ...recordBase, outcome: "response", status: 409 });
        return response;
      }
      requests.push({
        ...recordBase,
        outcome: "idempotent_replay",
        status: stored.status,
      });
      return new Response(stored.body, {
        status: stored.status,
        headers: stored.headers,
      });
    }

    const pathname = url.pathname.slice(OPENAI_ADS_PREFIX.length) || "/";
    const fault = faults.find((item) => matchesFault(item, method, pathname));
    if (fault) fault.remaining -= 1;
    if (fault?.kind === "http") {
      const response = errorResponse(
        fault.status,
        `Simulated HTTP ${fault.status} response.`,
        fault.status === 429
          ? { "Retry-After": fault.retryAfter ?? "30" }
          : {},
      );
      requests.push({
        ...recordBase,
        outcome: "fault",
        status: response.status,
      });
      return response;
    }
    if (fault?.kind === "timeout") {
      requests.push({
        ...recordBase,
        outcome: "timeout",
        status: null,
      });
      return timeoutFailure(request.signal, fault.delayMs ?? 5);
    }

    let response: Response;
    try {
      response = await routeRequest(request, url, rawBody);
    } catch (error) {
      if (error instanceof SimulatorRequestError) {
        response = errorResponse(error.status, error.message, error.headers);
      } else if (error instanceof ZodError) {
        response = errorResponse(400, "The request did not match the Ads schema.");
      } else if (error instanceof SyntaxError) {
        response = errorResponse(400, "The request body is not valid JSON.");
      } else {
        throw error;
      }
    }

    if (idempotencyKey && isMutation(method) && response.ok) {
      const body = await response.clone().text();
      idempotency.set(idempotencyKey, {
        fingerprint,
        status: response.status,
        headers: [...response.headers.entries()],
        body,
      });
    }

    if (fault?.kind === "ambiguous_write") {
      if (!isMutation(method) || !response.ok) {
        throw new Error(
          "ambiguous_write faults must target a successful mutation route.",
        );
      }
      requests.push({
        ...recordBase,
        outcome: "ambiguous_write",
        status: null,
      });
      return timeoutFailure(request.signal, fault.delayMs ?? 5);
    }

    requests.push({
      ...recordBase,
      outcome: "response",
      status: response.status,
    });
    return response;
  };

  return {
    fetch: simulatorFetch,
    requests,
    snapshot: () => clone(state),
    reset(nextSeed = seed) {
      seed = validatedSeed(clone(nextSeed));
      state = toSnapshot(seed, options.pageSize);
      requests.splice(0, requests.length);
      faults.splice(0, faults.length, ...(options.faults ?? []).map(storedFault));
      idempotency.clear();
      sequence = 0;
    },
    enqueueFault(fault) {
      faults.push(storedFault(fault));
    },
    advanceReview(adId) {
      const transitions = state.reviewTransitions[adId] ?? [];
      const transition = transitions.shift();
      if (!transition) {
        throw new Error(`No queued review transition remains for ${adId}.`);
      }
      return this.transitionReview(adId, transition);
    },
    transitionReview(adId, transition) {
      const current = findAd(adId);
      const updated: ScopedAd = {
        ...adSchema.parse({
          ...current,
          ...clone(transition),
          updated_at: tick(),
        }),
        ad_group_id: current.ad_group_id,
      };
      replaceAd(current.id, updated);
      return clone(updated);
    },
  };
}

export const OPENAI_ADS_SIMULATOR_TEST_TOKEN = DEFAULT_TEST_TOKEN;
