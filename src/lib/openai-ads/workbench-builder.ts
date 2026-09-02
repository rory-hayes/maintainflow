import type { CampaignPerformance, Recommendation } from "./demo-data";
import type { BudgetGuardEvidence } from "./budget-guard";
import {
  buildConversionMeasurementReadiness,
  measurementReadyCampaignIds,
  type ConversionMeasurementReadiness,
} from "./measurement-readiness";
import {
  buildLiveRecommendations,
  type AdsMeasurementWindow,
  type ScopedAdGroup,
} from "./recommendations";
import type {
  AdAccount,
  Campaign,
  ConversionEventSetting,
  ConversionInsightRow,
  InsightRow,
  ScopedAd,
} from "./schema";

export type LiveWorkbenchData = {
  account: AdAccount;
  campaigns: Campaign[];
  ads: ScopedAd[];
  performance: CampaignPerformance[];
  budgetGuardEvidence: BudgetGuardEvidence[];
  recommendations: Recommendation[];
  conversionMeasurement: ConversionMeasurementReadiness;
  syncedAt: string;
};

export type ProviderWorkbenchSnapshot = {
  account: AdAccount;
  campaigns: Campaign[];
  adGroups: ScopedAdGroup[];
  ads: ScopedAd[];
  campaignInsights: InsightRow[];
  adGroupInsights: InsightRow[];
  campaignConversions: ConversionInsightRow[];
  adGroupConversions: ConversionInsightRow[];
  eventSettings: ConversionEventSetting[];
  recommendationWindow: AdsMeasurementWindow;
  budgetGuardEvidence?: BudgetGuardEvidence[];
  syncedAt: string;
};

function combinePerformance(
  rows: InsightRow[],
  conversions: ConversionInsightRow[],
  idField: "campaign_id" | "ad_group_id",
): CampaignPerformance[] {
  const conversionsById = new Map(
    conversions.map((row) => [row.entity_id, row]),
  );

  return rows.flatMap((row) => {
    const entityId = row[idField];
    if (!entityId) return [];

    const conversion = conversionsById.get(entityId);
    return [
      {
        campaignId: entityId,
        spend: row.spend ?? 0,
        impressions: row.impressions ?? 0,
        clicks: row.clicks ?? 0,
        conversions:
          conversion?.click_through_conversions ?? conversion?.conversions ?? 0,
        viewThroughConversions: conversion?.view_through_conversions ?? 0,
        trend: "Month to date",
      },
    ];
  });
}

/**
 * Converts already schema-validated provider datasets into the shared
 * MaintainFlow workbench model. Network access, clocks, pagination, retries,
 * persistence, and release gates deliberately stay outside this pure boundary.
 */
export function buildWorkbenchDataFromProviderSnapshot({
  account,
  campaigns,
  adGroups,
  ads,
  campaignInsights,
  adGroupInsights,
  campaignConversions,
  adGroupConversions,
  eventSettings,
  recommendationWindow,
  budgetGuardEvidence = [],
  syncedAt,
}: ProviderWorkbenchSnapshot): LiveWorkbenchData {
  const performance = combinePerformance(
    campaignInsights,
    campaignConversions,
    "campaign_id",
  );
  const adGroupPerformance = combinePerformance(
    adGroupInsights,
    adGroupConversions,
    "ad_group_id",
  );
  const conversionMeasurement = buildConversionMeasurementReadiness({
    campaigns,
    eventSettings,
    checkedAt: syncedAt,
  });
  const recommendations = buildLiveRecommendations({
    campaigns,
    adGroups,
    performance,
    adGroupPerformance,
    currencyCode: account.currency_code,
    measurementWindow: recommendationWindow,
    measurementReadyCampaignIds: measurementReadyCampaignIds(
      conversionMeasurement,
    ),
  });

  return {
    account,
    campaigns,
    ads,
    performance,
    budgetGuardEvidence,
    recommendations,
    conversionMeasurement,
    syncedAt,
  };
}
