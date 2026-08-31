import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { adsApiRequest } from "./client.server";
import {
  AdsProviderBudgetExceededError,
  fetchLiveWorkbenchData,
  LIVE_SYNC_PROVIDER_LIMITS,
} from "./data.server";
import {
  adGroupSchema,
  adListResponseSchema,
  adSchema,
  campaignSchema,
  conversionInsightResponseSchema,
  insightListResponseSchema,
} from "./schema";
import {
  createOpenAIAdsProviderSimulator,
  createOpenAIAdsSimulatorSeed,
  OPENAI_ADS_SIMULATOR_TEST_TOKEN,
  type OpenAIAdsProviderSimulator,
} from "./provider-simulator.test-support";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.stubEnv("OPENAI_ADS_DATA_MODE", "live");
  vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "private_read");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function simulatorHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${OPENAI_ADS_SIMULATOR_TEST_TOKEN}`,
    "OpenAI-Ad-Account": "adacct_sim_001",
    ...extra,
  };
}

function providerRequest(
  simulator: OpenAIAdsProviderSimulator,
  path: string,
  init: RequestInit = {},
) {
  return simulator.fetch(`https://api.ads.openai.com/v1${path}`, {
    ...init,
    headers: {
      ...simulatorHeaders(),
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

async function responseJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const simulatorCredential = {
  kind: "account_api_key" as const,
  secret: OPENAI_ADS_SIMULATOR_TEST_TOKEN,
  expectedAccountId: "adacct_sim_001",
};

function largeCampaignSeed(count: number, pageSize: number) {
  const empty = createOpenAIAdsSimulatorSeed("empty");
  const template = createOpenAIAdsSimulatorSeed("overspending").campaigns[0];
  return {
    ...empty,
    campaigns: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `cmpn_large_${index.toString().padStart(5, "0")}`,
      name: `Large account campaign ${index + 1}`,
      conversion_event_setting_ids: [],
    })),
    pageSize,
  };
}

describe("OpenAI Ads provider simulator scenarios", () => {
  it("provides independent, schema-valid healthy, overspending, review, and empty seeds", () => {
    const overspending = createOpenAIAdsSimulatorSeed("overspending");
    const healthy = createOpenAIAdsSimulatorSeed("healthy");
    const creativeReview = createOpenAIAdsSimulatorSeed("creative_review");
    const empty = createOpenAIAdsSimulatorSeed("empty");

    expect(overspending.campaigns.map((item) => campaignSchema.parse(item)))
      .toHaveLength(3);
    expect(healthy.adGroups.map((item) => adGroupSchema.parse(item)))
      .toHaveLength(3);
    expect(creativeReview.ads.map((item) => adSchema.parse(item))).toHaveLength(
      1,
    );
    expect(creativeReview.reviewTransitions?.ad_sim_review).toHaveLength(3);
    expect(empty).toMatchObject({ campaigns: [], adGroups: [], ads: [] });

    overspending.campaigns[0].name = "Changed only in this fixture";
    expect(createOpenAIAdsSimulatorSeed("overspending").campaigns[0].name).toBe(
      "Storage outcomes",
    );
  });

  it("rejects invalid cross-resource seeds before serving a request", () => {
    const seed = createOpenAIAdsSimulatorSeed("healthy");
    seed.adGroups[0].campaign_id = "cmpn_missing";

    expect(() => createOpenAIAdsProviderSimulator({ seed })).toThrow(
      "refers to a missing campaign",
    );
  });
});

describe("OpenAI Ads provider simulator integration", () => {
  it("drives the production read adapter across every paginated hierarchy", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
      pageSize: 1,
    });
    globalThis.fetch = simulator.fetch;

    const result = await fetchLiveWorkbenchData(undefined, {
      kind: "account_api_key",
      secret: OPENAI_ADS_SIMULATOR_TEST_TOKEN,
      expectedAccountId: "adacct_sim_001",
    });

    expect(result.account.id).toBe("adacct_sim_001");
    expect(result.campaigns).toHaveLength(3);
    expect(result.ads).toHaveLength(4);
    expect(result.performance).toHaveLength(3);
    expect(result.conversionMeasurement.status).toBe("ready");
    expect(result.recommendations).toContainEqual(
      expect.objectContaining({
        id: "live_bid_adgrp_sim_001",
        source: "live",
        mutation: expect.objectContaining({ path: "/ad_groups/adgrp_sim_001" }),
      }),
    );

    const campaignCalls = simulator.requests.filter((request) =>
      request.path.startsWith("/v1/campaigns?"),
    );
    expect(campaignCalls).toHaveLength(3);
    expect(campaignCalls[1].path).toContain("after=cmpn_sim_001");
    expect(
      simulator.requests.some((request) =>
        request.path.startsWith("/v1/ad_account/insights?"),
      ),
    ).toBe(true);
    expect(
      simulator.requests.some(
        (request) => request.path === "/v1/conversions/insights",
      ),
    ).toBe(true);
    expect(JSON.stringify(simulator.requests)).not.toContain(
      OPENAI_ADS_SIMULATOR_TEST_TOKEN,
    );
  });

  it("serves account-scoped detail reads, entity insights, and conversion insights", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
    });

    const campaign = await responseJson(
      await providerRequest(simulator, "/campaigns/cmpn_sim_001"),
    );
    expect(campaignSchema.parse(campaign).id).toBe("cmpn_sim_001");

    const adGroup = await responseJson(
      await providerRequest(simulator, "/ad_groups/adgrp_sim_001"),
    );
    expect(adGroupSchema.parse(adGroup).id).toBe("adgrp_sim_001");

    const ad = await responseJson(
      await providerRequest(simulator, "/ads/ad_sim_001"),
    );
    expect(adSchema.parse(ad).id).toBe("ad_sim_001");

    const adPage = await responseJson(
      await providerRequest(
        simulator,
        "/ads?ad_group_id=adgrp_sim_001&limit=1",
      ),
    );
    expect(adListResponseSchema.parse(adPage)).toMatchObject({
      first_id: "ad_sim_001",
      last_id: "ad_sim_001",
      has_more: true,
    });

    const insights = await responseJson(
      await providerRequest(
        simulator,
        "/ad_groups/adgrp_sim_001/insights?limit=10",
      ),
    );
    expect(insightListResponseSchema.parse(insights).data[0]).toMatchObject({
      ad_group_id: "adgrp_sim_001",
      spend: 1_200,
    });

    const conversions = await responseJson(
      await providerRequest(simulator, "/conversions/insights", {
        method: "POST",
        body: JSON.stringify({
          aggregation_level: "ad_group",
          entity_ids: ["adgrp_sim_001"],
          time_ranges: [],
        }),
      }),
    );
    expect(conversionInsightResponseSchema.parse(conversions).data[0]).toEqual(
      expect.objectContaining({
        entity_id: "adgrp_sim_001",
        click_through_conversions: 24,
      }),
    );
  });

  it("keeps bid and lifecycle writes reversible and refuses archival state", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
    });
    const initial = simulator.snapshot().adGroups[0].bidding_config;

    const changed = await responseJson(
      await providerRequest(simulator, "/ad_groups/adgrp_sim_001", {
        method: "POST",
        body: JSON.stringify({
          bidding_config: {
            billing_event_type: "click",
            strategy: "fixed_bid",
            max_bid_micros: 16_000_000,
          },
        }),
      }),
    );
    expect(adGroupSchema.parse(changed).bidding_config.max_bid_micros).toBe(
      16_000_000,
    );

    await providerRequest(simulator, "/ad_groups/adgrp_sim_001", {
      method: "POST",
      body: JSON.stringify({ bidding_config: initial }),
    });
    expect(
      simulator.snapshot().adGroups[0].bidding_config.max_bid_micros,
    ).toBe(20_000_000);

    await providerRequest(simulator, "/campaigns/cmpn_sim_001/pause", {
      method: "POST",
    });
    expect(simulator.snapshot().campaigns[0].status).toBe("paused");
    await providerRequest(simulator, "/campaigns/cmpn_sim_001/activate", {
      method: "POST",
    });
    expect(simulator.snapshot().campaigns[0].status).toBe("active");

    const archive = await providerRequest(
      simulator,
      "/campaigns/cmpn_sim_001",
      {
        method: "POST",
        body: JSON.stringify({ status: "archived" }),
      },
    );
    expect(archive.status).toBe(400);
    expect(simulator.snapshot().campaigns[0].status).toBe("active");
  });

  it("creates campaigns, ad groups, and ads with official input schemas and idempotency", async () => {
    const simulator = createOpenAIAdsProviderSimulator({ scenario: "empty" });
    const campaignBody = {
      name: "New Ireland launch",
      description: "Prepared before advertiser access.",
      status: "paused",
      budget: { daily_spend_limit_micros: 25_000_000 },
      bidding_type: "clicks",
    };
    const campaignInit = {
      method: "POST",
      headers: { "Idempotency-Key": "create-campaign-001" },
      body: JSON.stringify(campaignBody),
    } satisfies RequestInit;

    const firstCampaignResponse = await providerRequest(
      simulator,
      "/campaigns",
      campaignInit,
    );
    const firstCampaign = campaignSchema.parse(
      await firstCampaignResponse.json(),
    );
    const replay = campaignSchema.parse(
      await (
        await providerRequest(simulator, "/campaigns", campaignInit)
      ).json(),
    );
    expect(replay.id).toBe(firstCampaign.id);
    expect(simulator.snapshot().campaigns).toHaveLength(1);
    expect(simulator.requests.at(-1)?.outcome).toBe("idempotent_replay");

    const conflict = await providerRequest(simulator, "/campaigns", {
      ...campaignInit,
      body: JSON.stringify({ ...campaignBody, name: "Different campaign" }),
    });
    expect(conflict.status).toBe(409);

    const adGroup = adGroupSchema.parse(
      await (
        await providerRequest(simulator, "/ad_groups", {
          method: "POST",
          headers: { "Idempotency-Key": "create-ad-group-001" },
          body: JSON.stringify({
            campaign_id: firstCampaign.id,
            name: "Launch audience",
            status: "paused",
            context_hints: ["find storage for my home"],
            bidding_config: {
              billing_event_type: "click",
              strategy: "fixed_bid",
              max_bid_micros: 5_000_000,
            },
          }),
        })
      ).json(),
    );

    const ad = adSchema.parse(
      await (
        await providerRequest(simulator, "/ads", {
          method: "POST",
          headers: { "Idempotency-Key": "create-ad-001" },
          body: JSON.stringify({
            ad_group_id: adGroup.id,
            name: "Ireland storage card",
            status: "paused",
            creative: {
              type: "chat_card",
              title: "Storage made for your room",
              body: "Find a practical fit for the space you have.",
              target_url: "https://northstar-home.example/ireland",
              file_id: "file_sim_new",
            },
          }),
        })
      ).json(),
    );
    expect(ad).toMatchObject({
      ad_group_id: adGroup.id,
      review_status: "in_review",
      review: { status: "in_review" },
    });
    expect(simulator.snapshot()).toMatchObject({
      campaigns: [expect.objectContaining({ id: firstCampaign.id })],
      adGroups: [expect.objectContaining({ id: adGroup.id })],
      ads: [expect.objectContaining({ id: ad.id })],
    });
  });

  it("advances deterministic rejected, appealed, and approved review states", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "creative_review",
    });

    expect(simulator.advanceReview("ad_sim_review")).toMatchObject({
      review_status: "rejected",
      review: {
        status: "rejected",
        reason: "robots_txt",
        screenshot_url:
          "https://cdn.openai.com/ads/reviews/ad_sim_review.png",
      },
      serving_issues: [{ code: "landing_page_crawl_issue" }],
    });
    expect(simulator.advanceReview("ad_sim_review")).toMatchObject({
      review_status: "in_review",
      appeal: { status: "requested", resolved_at: null },
    });
    expect(simulator.advanceReview("ad_sim_review")).toMatchObject({
      status: "active",
      review_status: "approved",
      appeal: { status: "approved" },
      serving_issues: [],
    });
    expect(() => simulator.advanceReview("ad_sim_review")).toThrow(
      "No queued review transition",
    );

    const fetched = adSchema.parse(
      await (
        await providerRequest(simulator, "/ads/ad_sim_review")
      ).json(),
    );
    expect(fetched.review_status).toBe("approved");
  });
});

describe("OpenAI Ads provider simulator failure contracts", () => {
  it("caps full-sync concurrency across hierarchy and insight reads", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
    });
    let activeRequests = 0;
    let maxActiveRequests = 0;
    globalThis.fetch = async (input, init) => {
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setTimeout(resolve, 2));
      try {
        return await simulator.fetch(input, init);
      } finally {
        activeRequests -= 1;
      }
    };

    await expect(
      fetchLiveWorkbenchData(undefined, simulatorCredential),
    ).resolves.toMatchObject({ account: { id: "adacct_sim_001" } });
    expect(maxActiveRequests).toBe(LIVE_SYNC_PROVIDER_LIMITS.maxConcurrency);
  });

  it("retries a safe paginated read after a bounded 429", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
      faults: [
        {
          kind: "http",
          status: 429,
          method: "GET",
          path: "/campaigns",
          retryAfter: "0",
        },
      ],
    });
    globalThis.fetch = simulator.fetch;

    const result = await fetchLiveWorkbenchData(undefined, simulatorCredential);

    expect(result.campaigns).toHaveLength(3);
    expect(
      simulator.requests.filter((request) =>
        request.path.startsWith("/v1/campaigns?"),
      ).map((request) => request.outcome),
    ).toEqual(["fault", "response", "response"]);
  });

  it("keeps one deadline across successful pages and bounded 429 retries", async () => {
    vi.useFakeTimers();
    const simulator = createOpenAIAdsProviderSimulator({
      seed: largeCampaignSeed(30, 1),
    });
    const delayedCampaignPages = new Set<string>();
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const page = `${url.pathname}${url.search}`;
      if (
        url.pathname === "/v1/campaigns" &&
        !delayedCampaignPages.has(page)
      ) {
        delayedCampaignPages.add(page);
        simulator.enqueueFault({
          kind: "http",
          status: 429,
          method: "GET",
          path: "/campaigns",
          retryAfter: "2",
        });
      }
      return simulator.fetch(request);
    };

    let settled = false;
    const outcome = fetchLiveWorkbenchData(
      undefined,
      simulatorCredential,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });

    await vi.advanceTimersByTimeAsync(
      LIVE_SYNC_PROVIDER_LIMITS.maxDurationMs - 1,
    );
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(AdsProviderBudgetExceededError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(
        `wall-clock deadline of ${LIVE_SYNC_PROVIDER_LIMITS.maxDurationMs}ms`,
      ),
    );
    const requestsAtDeadline = simulator.requests.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(simulator.requests).toHaveLength(requestsAtDeadline);
  });

  it("discards a first page when the next page times out", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
      pageSize: 1,
    });
    let faultQueued = false;
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        !faultQueued &&
        url.pathname === "/v1/campaigns" &&
        url.searchParams.has("after")
      ) {
        faultQueued = true;
        simulator.enqueueFault({
          kind: "timeout",
          method: "GET",
          path: "/campaigns",
          delayMs: 1,
        });
      }
      return simulator.fetch(request);
    };

    await expect(
      fetchLiveWorkbenchData(undefined, simulatorCredential),
    ).rejects.toThrow("No data was accepted");
    expect(
      simulator.requests.filter((request) =>
        request.path.startsWith("/v1/campaigns?"),
      ).map((request) => request.outcome),
    ).toEqual(["response", "timeout"]);
  });

  it("fails a heavily paginated account at the total request budget", async () => {
    const seed = largeCampaignSeed(100, 1);
    const adGroupTemplate = createOpenAIAdsSimulatorSeed("overspending")
      .adGroups[0];
    seed.adGroups = seed.campaigns.flatMap((campaign, campaignIndex) =>
      Array.from({ length: 2 }, (_, adGroupIndex) => ({
        ...adGroupTemplate,
        id: `adgrp_large_${campaignIndex.toString().padStart(3, "0")}_${adGroupIndex}`,
        campaign_id: campaign.id,
        name: `Large account ad group ${campaignIndex + 1}-${adGroupIndex + 1}`,
      })),
    );
    const simulator = createOpenAIAdsProviderSimulator({
      seed,
    });
    globalThis.fetch = simulator.fetch;

    await expect(
      fetchLiveWorkbenchData(undefined, simulatorCredential),
    ).rejects.toThrow(
      `total provider request budget of ${LIVE_SYNC_PROVIDER_LIMITS.maxRequests}`,
    );
    expect(simulator.requests.length).toBe(
      LIVE_SYNC_PROVIDER_LIMITS.maxRequests,
    );
  });

  it("fails a large account at the total resource budget", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      seed: largeCampaignSeed(
        LIVE_SYNC_PROVIDER_LIMITS.maxResources,
        500,
      ),
    });
    globalThis.fetch = simulator.fetch;

    await expect(
      fetchLiveWorkbenchData(undefined, simulatorCredential),
    ).rejects.toThrow(
      `total resource budget of ${LIVE_SYNC_PROVIDER_LIMITS.maxResources}`,
    );
    expect(simulator.requests.length).toBeLessThan(
      LIVE_SYNC_PROVIDER_LIMITS.maxRequests,
    );
  });

  it("enforces bearer authentication and advertiser-account isolation", async () => {
    const simulator = createOpenAIAdsProviderSimulator();
    const unauthorized = await simulator.fetch(
      "https://api.ads.openai.com/v1/ad_account",
    );
    expect(unauthorized.status).toBe(401);

    const forbidden = await simulator.fetch(
      "https://api.ads.openai.com/v1/ad_account",
      {
        headers: simulatorHeaders({
          "OpenAI-Ad-Account": "adacct_someone_else",
        }),
      },
    );
    expect(forbidden.status).toBe(403);
  });

  it.each([401, 403, 429, 500] as const)(
    "injects a one-shot %s response without mutating state",
    async (status) => {
      const simulator = createOpenAIAdsProviderSimulator();
      simulator.enqueueFault({
        kind: "http",
        status,
        method: "GET",
        path: "/ad_account",
        ...(status === 429 ? { retryAfter: "17" } : {}),
      });

      const failed = await providerRequest(simulator, "/ad_account");
      expect(failed.status).toBe(status);
      if (status === 429) expect(failed.headers.get("Retry-After")).toBe("17");
      expect((await providerRequest(simulator, "/ad_account")).status).toBe(
        200,
      );
    },
  );

  it("propagates 429 metadata through the production API error", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      faults: [
        {
          kind: "http",
          status: 429,
          path: "/ad_account",
          retryAfter: "45",
        },
      ],
    });
    globalThis.fetch = simulator.fetch;

    await expect(
      adsApiRequest(
        "/ad_account",
        campaignSchema,
        {},
        {
          kind: "account_api_key",
          secret: OPENAI_ADS_SIMULATOR_TEST_TOKEN,
          expectedAccountId: "adacct_sim_001",
        },
      ),
    ).rejects.toMatchObject({
      name: "OpenAIAdsApiError",
      status: 429,
      retryAfter: "45",
    });
  });

  it("models a timeout without changing provider state", async () => {
    const simulator = createOpenAIAdsProviderSimulator();
    const before = simulator.snapshot();
    simulator.enqueueFault({
      kind: "timeout",
      method: "GET",
      path: "/ad_account",
      delayMs: 1,
    });

    await expect(providerRequest(simulator, "/ad_account")).rejects.toMatchObject(
      { name: "TimeoutError" },
    );
    expect(simulator.snapshot()).toEqual(before);
    expect(simulator.requests.at(-1)?.outcome).toBe("timeout");
  });

  it("models an ambiguous write that commits before the response is lost", async () => {
    const simulator = createOpenAIAdsProviderSimulator();
    simulator.enqueueFault({
      kind: "ambiguous_write",
      method: "POST",
      path: "/ad_groups/adgrp_sim_001",
      delayMs: 1,
    });
    const init = {
      method: "POST",
      headers: { "Idempotency-Key": "ambiguous-bid-change-001" },
      body: JSON.stringify({
        bidding_config: {
          billing_event_type: "click",
          strategy: "fixed_bid",
          max_bid_micros: 14_000_000,
        },
      }),
    } satisfies RequestInit;

    await expect(
      providerRequest(simulator, "/ad_groups/adgrp_sim_001", init),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(
      simulator.snapshot().adGroups[0].bidding_config.max_bid_micros,
    ).toBe(14_000_000);
    expect(simulator.requests.at(-1)?.outcome).toBe("ambiguous_write");

    const reconciled = adGroupSchema.parse(
      await (
        await providerRequest(
          simulator,
          "/ad_groups/adgrp_sim_001",
          init,
        )
      ).json(),
    );
    expect(reconciled.bidding_config.max_bid_micros).toBe(14_000_000);
    expect(simulator.requests.at(-1)?.outcome).toBe("idempotent_replay");
  });

  it("cannot be used as a general fetch proxy or constructed in production", async () => {
    const simulator = createOpenAIAdsProviderSimulator();
    await expect(
      simulator.fetch("https://example.com/v1/ad_account", {
        headers: simulatorHeaders(),
      }),
    ).rejects.toThrow("only intercepts the canonical");

    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => createOpenAIAdsProviderSimulator()).toThrow("test-only");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
