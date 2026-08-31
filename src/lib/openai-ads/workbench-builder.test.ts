import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { fetchLiveWorkbenchData } from "./data.server";
import {
  createOpenAIAdsProviderSimulator,
  createOpenAIAdsSimulatorSeed,
  OPENAI_ADS_SIMULATOR_TEST_TOKEN,
  type OpenAIAdsSimulatorSeed,
} from "./provider-simulator.test-support";
import {
  buildWorkbenchDataFromProviderSnapshot,
  type ProviderWorkbenchSnapshot,
} from "./workbench-builder";

const originalFetch = globalThis.fetch;
const SYNCED_AT = "2026-08-31T00:00:00.000Z";
const RECOMMENDATION_WINDOW = {
  start: 1_788_048_000,
  end: 1_788_652_800,
};

function builderInput(
  seed: OpenAIAdsSimulatorSeed,
  options: {
    syncedAt?: string;
    recommendationWindow?: { start: number; end: number };
    budgetGuardEvidence?: ProviderWorkbenchSnapshot["budgetGuardEvidence"];
  } = {},
): ProviderWorkbenchSnapshot {
  const campaignIds = new Set(seed.campaigns.map((campaign) => campaign.id));
  const adGroupIds = new Set(seed.adGroups.map((adGroup) => adGroup.id));

  return {
    account: seed.account,
    campaigns: seed.campaigns,
    adGroups: seed.adGroups,
    ads: seed.ads,
    campaignInsights: seed.insights.filter((row) => Boolean(row.campaign_id)),
    adGroupInsights: seed.insights.filter((row) => Boolean(row.ad_group_id)),
    campaignConversions: seed.conversionInsights.filter((row) =>
      campaignIds.has(row.entity_id),
    ),
    adGroupConversions: seed.conversionInsights.filter((row) =>
      adGroupIds.has(row.entity_id),
    ),
    eventSettings: seed.conversionEventSettings,
    recommendationWindow:
      options.recommendationWindow ?? RECOMMENDATION_WINDOW,
    budgetGuardEvidence: options.budgetGuardEvidence,
    syncedAt: options.syncedAt ?? SYNCED_AT,
  };
}

beforeEach(() => {
  vi.stubEnv("OPENAI_ADS_DATA_MODE", "live");
  vi.stubEnv("MAINTAINFLOW_RELEASE_STAGE", "private_read");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
});

describe("provider workbench builder", () => {
  it("produces the same workbench as the live adapter for one provider snapshot", async () => {
    const simulator = createOpenAIAdsProviderSimulator({
      scenario: "overspending",
      pageSize: 1,
    });
    globalThis.fetch = simulator.fetch;

    const live = await fetchLiveWorkbenchData(undefined, {
      kind: "account_api_key",
      secret: OPENAI_ADS_SIMULATOR_TEST_TOKEN,
      expectedAccountId: "adacct_sim_001",
    });
    const monitoringBaseline = live.recommendations[0]?.monitoringPlan?.baseline;
    expect(monitoringBaseline).toBeDefined();

    const direct = buildWorkbenchDataFromProviderSnapshot(
      builderInput(simulator.snapshot(), {
        syncedAt: live.syncedAt,
        recommendationWindow: {
          start: monitoringBaseline!.rangeStart,
          end: monitoringBaseline!.rangeEnd,
        },
        budgetGuardEvidence: live.budgetGuardEvidence,
      }),
    );

    expect(direct).toEqual(live);
  });

  it("keeps click-through and view-through conversions separate without mutating input", () => {
    const seed = createOpenAIAdsSimulatorSeed("overspending");
    const input = builderInput(seed);
    const before = structuredClone(input);

    const result = buildWorkbenchDataFromProviderSnapshot(input);

    expect(input).toEqual(before);
    expect(result.performance[0]).toEqual({
      campaignId: "cmpn_sim_001",
      spend: 1_200,
      impressions: 48_000,
      clicks: 1_600,
      conversions: 24,
      viewThroughConversions: 3,
      trend: "Month to date",
    });
    expect(result.conversionMeasurement).toMatchObject({
      source: "live",
      status: "ready",
      healthyCampaigns: 1,
    });
    expect(result.recommendations).toContainEqual(
      expect.objectContaining({
        id: "live_bid_adgrp_sim_001",
        monitoringPlan: expect.objectContaining({
          baseline: expect.objectContaining({
            clickAttributedConversions: 24,
          }),
        }),
      }),
    );
  });

  it("returns a complete empty-account model without consulting ambient state", () => {
    const input = builderInput(createOpenAIAdsSimulatorSeed("empty"));

    expect(buildWorkbenchDataFromProviderSnapshot(input)).toEqual({
      account: input.account,
      campaigns: [],
      ads: [],
      performance: [],
      recommendations: [],
      budgetGuardEvidence: [],
      conversionMeasurement: expect.objectContaining({
        source: "live",
        status: "not_applicable",
        checkedAt: SYNCED_AT,
      }),
      syncedAt: SYNCED_AT,
    });
  });
});
