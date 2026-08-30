import { z } from "zod";

import type { Campaign, ConversionEventSetting } from "./schema";

export const conversionMeasurementCheckSchema = z.object({
  campaignId: z.string(),
  campaignName: z.string(),
  status: z.enum(["pass", "warning", "fail"]),
  eventSettingIds: z.array(z.string()),
  title: z.string(),
  detail: z.string(),
});

export const conversionMeasurementReadinessSchema = z.object({
  source: z.enum(["demo", "live"]),
  status: z.enum([
    "ready",
    "needs_attention",
    "not_applicable",
    "unavailable",
  ]),
  checkedAt: z.string().datetime(),
  activeConversionCampaigns: z.number().int().nonnegative(),
  healthyCampaigns: z.number().int().nonnegative(),
  eventSettingCount: z.number().int().nonnegative(),
  checks: z.array(conversionMeasurementCheckSchema),
  message: z.string(),
});

export type ConversionMeasurementReadiness = z.infer<
  typeof conversionMeasurementReadinessSchema
>;

export function unavailableConversionMeasurement(options: {
  source: "demo" | "live";
  checkedAt?: string;
  message: string;
}): ConversionMeasurementReadiness {
  return conversionMeasurementReadinessSchema.parse({
    source: options.source,
    status: "unavailable",
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    activeConversionCampaigns: 0,
    healthyCampaigns: 0,
    eventSettingCount: 0,
    checks: [],
    message: options.message,
  });
}

export function buildConversionMeasurementReadiness(options: {
  campaigns: Campaign[];
  eventSettings: ConversionEventSetting[];
  checkedAt?: string;
}): ConversionMeasurementReadiness {
  const activeConversionCampaigns = options.campaigns.filter(
    (campaign) =>
      campaign.status === "active" && campaign.bidding_type === "conversions",
  );
  const settingById = new Map(
    options.eventSettings.map((setting) => [setting.id, setting]),
  );
  const checks = activeConversionCampaigns.map((campaign) => {
    const settingIds = campaign.conversion_event_setting_ids;
    const referenced = settingIds.flatMap((id) => {
      const setting = settingById.get(id);
      return setting ? [setting] : [];
    });
    const missingIds = settingIds.filter((id) => !settingById.has(id));
    const archived = referenced.filter((setting) => setting.archived);
    const invalidAttribution = referenced.filter(
      (setting) => setting.attribution_window_days !== 30,
    );
    const invalidSources = referenced.filter(
      (setting) =>
        setting.source_ids.length !== 1 || setting.sources.length !== 1,
    );

    if (settingIds.length === 0) {
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        status: "fail" as const,
        eventSettingIds: settingIds,
        title: "No conversion event setting",
        detail:
          "This active conversion campaign does not reference a conversion definition.",
      };
    }
    if (missingIds.length > 0) {
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        status: "fail" as const,
        eventSettingIds: settingIds,
        title: "Referenced setting is missing",
        detail: `The account did not return ${missingIds.join(", ")}.`,
      };
    }
    if (archived.length > 0) {
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        status: "fail" as const,
        eventSettingIds: settingIds,
        title: "Conversion setting is archived",
        detail: `Archived: ${archived.map((setting) => setting.name).join(", ")}.`,
      };
    }
    if (invalidAttribution.length > 0) {
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        status: "warning" as const,
        eventSettingIds: settingIds,
        title: "Attribution contract differs",
        detail:
          "The current OpenAI schema requires a 30-day attribution window; verify this setting in Ads Manager.",
      };
    }
    if (invalidSources.length > 0) {
      return {
        campaignId: campaign.id,
        campaignName: campaign.name,
        status: "fail" as const,
        eventSettingIds: settingIds,
        title: "Conversion source is incomplete",
        detail:
          "Each current event setting must resolve to exactly one conversion source.",
      };
    }
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: "pass" as const,
      eventSettingIds: settingIds,
      title: "Conversion definition connected",
      detail: `${referenced.map((setting) => setting.name).join(", ")} · 30-day attribution · one source.`,
    };
  });
  const healthyCampaigns = checks.filter(
    (check) => check.status === "pass",
  ).length;
  const status =
    checks.length === 0
      ? "not_applicable"
      : healthyCampaigns === checks.length
        ? "ready"
        : "needs_attention";

  return conversionMeasurementReadinessSchema.parse({
    source: "live",
    status,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    activeConversionCampaigns: checks.length,
    healthyCampaigns,
    eventSettingCount: options.eventSettings.length,
    checks,
    message:
      status === "ready"
        ? "Every active conversion campaign references a current event setting."
        : status === "not_applicable"
          ? "No active conversion-bid campaign requires this check."
          : "One or more active conversion campaigns need measurement review before optimization.",
  });
}

export function measurementReadyCampaignIds(
  readiness: ConversionMeasurementReadiness,
) {
  return new Set(
    readiness.checks
      .filter((check) => check.status === "pass")
      .map((check) => check.campaignId),
  );
}
