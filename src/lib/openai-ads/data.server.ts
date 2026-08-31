import "server-only";

import {
  adsApiRequest,
  type AdsApiCredential,
  type AdsProviderRequestBudget,
} from "./client.server";
import type { AdsMeasurementWindow, ScopedAdGroup } from "./recommendations";
import {
  adAccountSchema,
  adListResponseSchema,
  adGroupListResponseSchema,
  campaignListResponseSchema,
  conversionInsightResponseSchema,
  conversionEventSettingListResponseSchema,
  insightListResponseSchema,
  type AdAccount,
  type Campaign,
  type ConversionEventSetting,
  type InsightRow,
  type ScopedAd,
} from "./schema";
import {
  buildWorkbenchDataFromProviderSnapshot,
  type LiveWorkbenchData,
} from "./workbench-builder";

export type { LiveWorkbenchData } from "./workbench-builder";

const MAX_LIST_PAGES = 100;
const AD_GROUP_FETCH_BATCH_SIZE = 5;
const AD_FETCH_BATCH_SIZE = 5;

export const LIVE_SYNC_PROVIDER_LIMITS = Object.freeze({
  maxRequests: 256,
  maxResources: 10_000,
  maxConcurrency: 5,
});

export class AdsProviderBudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AdsProviderBudgetExceededError";
  }
}

type BudgetWaiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
};

class LiveSyncProviderBudget implements AdsProviderRequestBudget {
  readonly #controller = new AbortController();
  readonly #waiters: BudgetWaiter[] = [];
  #activeRequests = 0;
  #requestCount: number;
  #resourceCount = 0;
  #failureReason: unknown;

  constructor(initialRequests: number) {
    this.#requestCount = initialRequests;
  }

  get signal() {
    return this.#controller.signal;
  }

  get failureReason() {
    return this.#failureReason;
  }

  abort(reason: unknown) {
    if (this.signal.aborted) return;
    this.#failureReason = reason;
    this.#controller.abort(reason);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(reason);
  }

  recordResources(count: number, resource: string) {
    if (!Number.isSafeInteger(count) || count < 0) {
      const error = new AdsProviderBudgetExceededError(
        `The live Ads sync returned an invalid ${resource} count, so no partial data was accepted.`,
      );
      this.abort(error);
      throw error;
    }
    if (this.#resourceCount + count > LIVE_SYNC_PROVIDER_LIMITS.maxResources) {
      const error = new AdsProviderBudgetExceededError(
        `The live Ads sync exceeded its total resource budget of ${LIVE_SYNC_PROVIDER_LIMITS.maxResources}, so no partial data was accepted.`,
      );
      this.abort(error);
      throw error;
    }
    this.#resourceCount += count;
  }

  async runRequest<T>(request: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      if (this.signal.aborted) throw this.#failureReason;
      if (this.#requestCount >= LIVE_SYNC_PROVIDER_LIMITS.maxRequests) {
        const error = new AdsProviderBudgetExceededError(
          `The live Ads sync exceeded its total provider request budget of ${LIVE_SYNC_PROVIDER_LIMITS.maxRequests}, so no partial data was accepted.`,
        );
        this.abort(error);
        throw error;
      }
      this.#requestCount += 1;
      return await request();
    } finally {
      this.#release();
    }
  }

  async #acquire() {
    if (this.signal.aborted) throw this.#failureReason;
    if (this.#activeRequests < LIVE_SYNC_PROVIDER_LIMITS.maxConcurrency) {
      this.#activeRequests += 1;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  #release() {
    this.#activeRequests -= 1;
    const waiter = this.#waiters.shift();
    if (!waiter) return;
    if (this.signal.aborted) {
      waiter.reject(this.#failureReason);
      return;
    }
    this.#activeRequests += 1;
    waiter.resolve();
  }
}

async function allOrAbort<T extends readonly unknown[]>(
  budget: LiveSyncProviderBudget,
  tasks: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const guarded = tasks.map((task) =>
    Promise.resolve(task).catch((error: unknown) => {
      budget.abort(error);
      throw error;
    }),
  );
  const settled = await Promise.allSettled(guarded);
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected) throw budget.failureReason ?? rejected.reason;
  return settled.map((result) =>
    (result as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}

export function fetchLiveAdAccount(
  credential?: AdsApiCredential,
  providerBudget?: AdsProviderRequestBudget,
) {
  return adsApiRequest(
    "/ad_account",
    adAccountSchema,
    { providerBudget },
    credential,
  );
}

function currentMonthRange() {
  const now = new Date();
  const start = Math.floor(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000,
  );
  const currentFullHour = Math.floor(now.getTime() / 3_600_000) * 3_600;

  return {
    type: "unix_range" as const,
    start: Math.min(start, currentFullHour - 3_600),
    end: currentFullHour,
  };
}

function trailingFullDaysRange(days: number): AdsMeasurementWindow {
  const end = Math.floor(Date.now() / 3_600_000) * 3_600;
  return { start: end - days * 24 * 3_600, end };
}

function insightsPath(
  aggregationLevel: "campaign" | "ad_group",
  fields: string[],
  range: AdsMeasurementWindow,
  after?: string,
) {
  const params = new URLSearchParams({
    time_granularity: "none",
    aggregation_level: aggregationLevel,
    limit: "2000",
  });

  params.append("time_ranges[]", JSON.stringify({ type: "unix_range", ...range }));
  for (const field of fields) params.append("fields[]", field);
  if (after) params.set("after", after);

  return `/ad_account/insights?${params.toString()}`;
}

async function listCampaigns(
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const campaigns: Campaign[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const params = new URLSearchParams({ limit: "500" });
    if (after) params.set("after", after);

    const page = await adsApiRequest(
      `/campaigns?${params.toString()}`,
      campaignListResponseSchema,
      { providerBudget },
      credential,
    );
    providerBudget.recordResources(page.data.length, "campaign");
    campaigns.push(
      ...page.data.map((campaign) => ({
        ...campaign,
        conversion_event_setting_ids:
          campaign.conversion_event_setting_ids ?? [],
      })),
    );
    if (!page.has_more) return campaigns;
    if (!page.last_id || seenCursors.has(page.last_id)) {
      throw new Error(
        "Campaign pagination returned an invalid cursor, so partial data was discarded.",
      );
    }
    seenCursors.add(page.last_id);
    after = page.last_id;
  }

  throw new Error(
    "Campaign pagination exceeded the safety limit, so partial data was discarded.",
  );
}

async function listConversionEventSettings(
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const settings: ConversionEventSetting[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const params = new URLSearchParams({ limit: "500", order: "desc" });
    if (after) params.set("after", after);
    const page = await adsApiRequest(
      `/conversions/event_settings?${params.toString()}`,
      conversionEventSettingListResponseSchema,
      { providerBudget },
      credential,
    );
    providerBudget.recordResources(
      page.data.length,
      "conversion event-setting",
    );
    settings.push(
      ...page.data.map((setting) => ({
        ...setting,
        campaigns: setting.campaigns ?? [],
      })),
    );
    if (!page.has_more) return settings;
    if (!page.last_id || seenCursors.has(page.last_id)) {
      throw new Error(
        "Conversion event-setting pagination returned an invalid cursor, so measurement readiness was not inferred.",
      );
    }
    seenCursors.add(page.last_id);
    after = page.last_id;
  }

  throw new Error(
    "Conversion event-setting pagination exceeded the safety limit, so measurement readiness was not inferred.",
  );
}

async function listCampaignAdGroups(
  campaign: Campaign,
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const adGroups: ScopedAdGroup[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const params = new URLSearchParams({
      campaign_id: campaign.id,
      limit: "500",
    });
    if (after) params.set("after", after);

    const page = await adsApiRequest(
      `/ad_groups?${params.toString()}`,
      adGroupListResponseSchema,
      { providerBudget },
      credential,
    );
    providerBudget.recordResources(page.data.length, "ad-group");
    adGroups.push(
      ...page.data.map((adGroup) => ({
        ...adGroup,
        campaign_id: campaign.id,
      })),
    );
    if (!page.has_more) return adGroups;
    if (!page.last_id || seenCursors.has(page.last_id)) {
      throw new Error(
        `Ad-group pagination for ${campaign.id} returned an invalid cursor, so partial data was discarded.`,
      );
    }
    seenCursors.add(page.last_id);
    after = page.last_id;
  }

  throw new Error(
    `Ad-group pagination for ${campaign.id} exceeded the safety limit, so partial data was discarded.`,
  );
}

async function listAdGroups(
  campaigns: Campaign[],
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const results: ScopedAdGroup[] = [];
  for (
    let index = 0;
    index < campaigns.length;
    index += AD_GROUP_FETCH_BATCH_SIZE
  ) {
    const batch = campaigns.slice(index, index + AD_GROUP_FETCH_BATCH_SIZE);
    const batchResults = await allOrAbort(
      providerBudget,
      batch.map((campaign) =>
        listCampaignAdGroups(campaign, credential, providerBudget),
      ),
    );
    results.push(...batchResults.flat());
  }
  return results;
}

async function listAdGroupAds(
  adGroup: ScopedAdGroup,
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const ads: ScopedAd[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const params = new URLSearchParams({
      ad_group_id: adGroup.id,
      limit: "500",
    });
    if (after) params.set("after", after);

    const page = await adsApiRequest(
      `/ads?${params.toString()}`,
      adListResponseSchema,
      { providerBudget },
      credential,
    );
    providerBudget.recordResources(page.data.length, "ad");
    ads.push(
      ...page.data.map((ad) => ({
        ...ad,
        ad_group_id: adGroup.id,
      })),
    );
    if (!page.has_more) return ads;
    if (!page.last_id || seenCursors.has(page.last_id)) {
      throw new Error(
        `Ad pagination for ${adGroup.id} returned an invalid cursor, so partial data was discarded.`,
      );
    }
    seenCursors.add(page.last_id);
    after = page.last_id;
  }

  throw new Error(
    `Ad pagination for ${adGroup.id} exceeded the safety limit, so partial data was discarded.`,
  );
}

async function listAds(
  adGroups: ScopedAdGroup[],
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const results: ScopedAd[] = [];
  for (
    let index = 0;
    index < adGroups.length;
    index += AD_FETCH_BATCH_SIZE
  ) {
    const batch = adGroups.slice(index, index + AD_FETCH_BATCH_SIZE);
    const batchResults = await allOrAbort(
      providerBudget,
      batch.map((adGroup) =>
        listAdGroupAds(adGroup, credential, providerBudget),
      ),
    );
    results.push(...batchResults.flat());
  }
  return results;
}

async function getInsights(
  level: "campaign" | "ad_group",
  range: AdsMeasurementWindow,
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  const prefix = level === "campaign" ? "campaign" : "ad_group";
  const fields = [
    `${prefix}.id`,
    `${prefix}.name`,
    `${prefix}.impressions`,
    `${prefix}.clicks`,
    `${prefix}.spend`,
  ];
  const rows: InsightRow[] = [];
  const seenCursors = new Set<string>();
  let after: string | undefined;

  for (let pageNumber = 0; pageNumber < MAX_LIST_PAGES; pageNumber += 1) {
    const response = await adsApiRequest(
      insightsPath(level, fields, range, after),
      insightListResponseSchema,
      { providerBudget },
      credential,
    );
    providerBudget.recordResources(response.data.length, `${level} insight`);
    rows.push(...response.data);
    if (!response.has_more) return rows;
    if (!response.last_id || seenCursors.has(response.last_id)) {
      throw new Error(
        `${level} insights returned an invalid cursor, so partial data was discarded.`,
      );
    }
    seenCursors.add(response.last_id);
    after = response.last_id;
  }

  throw new Error(
    `${level} insights exceeded the safety limit, so partial data was discarded.`,
  );
}

async function getConversionInsights(
  level: "campaign" | "ad_group",
  entityIds: string[],
  range: AdsMeasurementWindow,
  credential: AdsApiCredential | undefined,
  providerBudget: LiveSyncProviderBudget,
) {
  if (entityIds.length === 0) return [];

  const response = await adsApiRequest(
    "/conversions/insights",
    conversionInsightResponseSchema,
    {
      method: "POST",
      body: {
        aggregation_level: level,
        // The conversion-insights example documents Unix bounds as strings
        // inside the already JSON-encoded time-range string.
        time_ranges: [
          JSON.stringify({
            type: "unix_range",
            ...range,
            start: String(range.start),
            end: String(range.end),
          }),
        ],
        entity_ids: entityIds,
      },
      providerBudget,
      retryOnRateLimit: true,
    },
    credential,
  );

  providerBudget.recordResources(
    response.data.length,
    `${level} conversion insight`,
  );
  return response.data;
}

export async function fetchLiveWorkbenchData(
  prefetchedAccount?: AdAccount,
  credential?: AdsApiCredential,
): Promise<LiveWorkbenchData> {
  // A supplied account was already fetched and schema-verified by the caller.
  // Count that request conservatively so authenticated routes cannot split one
  // logical sync into an unbudgeted identity check plus a budgeted hierarchy.
  const providerBudget = new LiveSyncProviderBudget(prefetchedAccount ? 1 : 0);

  try {
    const [account, campaigns] = await allOrAbort(
      providerBudget,
      [
        prefetchedAccount
          ? Promise.resolve(prefetchedAccount)
          : fetchLiveAdAccount(credential, providerBudget),
        listCampaigns(credential, providerBudget),
      ] as const,
    );
    providerBudget.recordResources(1, "advertiser account");

    const [adGroups, eventSettings] = await allOrAbort(
      providerBudget,
      [
        listAdGroups(campaigns, credential, providerBudget),
        listConversionEventSettings(credential, providerBudget),
      ] as const,
    );
    const dashboardWindow = currentMonthRange();
    const recommendationWindow = trailingFullDaysRange(7);

    const [
      ads,
      campaignRows,
      adGroupRows,
      campaignConversions,
      adGroupConversions,
    ] = await allOrAbort(
      providerBudget,
      [
        listAds(adGroups, credential, providerBudget),
        getInsights(
          "campaign",
          dashboardWindow,
          credential,
          providerBudget,
        ),
        getInsights(
          "ad_group",
          recommendationWindow,
          credential,
          providerBudget,
        ),
        getConversionInsights(
          "campaign",
          campaigns.map((campaign) => campaign.id),
          dashboardWindow,
          credential,
          providerBudget,
        ),
        getConversionInsights(
          "ad_group",
          adGroups.map((adGroup) => adGroup.id),
          recommendationWindow,
          credential,
          providerBudget,
        ),
      ] as const,
    );

    const syncedAt = new Date().toISOString();
    return buildWorkbenchDataFromProviderSnapshot({
      account,
      campaigns,
      adGroups,
      ads,
      campaignInsights: campaignRows,
      adGroupInsights: adGroupRows,
      campaignConversions,
      adGroupConversions,
      eventSettings,
      recommendationWindow,
      syncedAt,
    });
  } catch (error) {
    providerBudget.abort(error);
    throw providerBudget.failureReason ?? error;
  }
}
