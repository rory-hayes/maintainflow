import { describe, expect, it } from "vitest";

import {
  buildConversionMeasurementReadiness,
  measurementReadyCampaignIds,
} from "./measurement-readiness";
import type { Campaign, ConversionEventSetting } from "./schema";

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

const setting: ConversionEventSetting = {
  id: "ces_purchase",
  name: "Purchases",
  event_type: "order_created",
  custom_event_name: null,
  attribution_window_days: 30,
  ad_account_id: "adacct_live",
  source_ids: ["clidsrc_web"],
  sources: [{ id: "clidsrc_web", name: "Web pixel" }],
  campaigns: [],
  archived: false,
  version: 1,
};

describe("conversion measurement readiness", () => {
  it("allows recommendations only for campaigns with a current setting", () => {
    const readiness = buildConversionMeasurementReadiness({
      campaigns: [campaign],
      eventSettings: [setting],
      checkedAt: "2026-08-30T12:00:00.000Z",
    });

    expect(readiness).toMatchObject({
      status: "ready",
      activeConversionCampaigns: 1,
      healthyCampaigns: 1,
      checks: [{ status: "pass", campaignId: campaign.id }],
    });
    expect(measurementReadyCampaignIds(readiness)).toEqual(
      new Set([campaign.id]),
    );
  });

  it("fails closed when a referenced setting is absent or archived", () => {
    const missing = buildConversionMeasurementReadiness({
      campaigns: [campaign],
      eventSettings: [],
    });
    const archived = buildConversionMeasurementReadiness({
      campaigns: [campaign],
      eventSettings: [{ ...setting, archived: true }],
    });

    expect(missing.checks[0]).toMatchObject({
      status: "fail",
      title: "Referenced setting is missing",
    });
    expect(archived.checks[0]).toMatchObject({
      status: "fail",
      title: "Conversion setting is archived",
    });
    expect(measurementReadyCampaignIds(missing)).toEqual(new Set());
  });

  it("flags schema drift in attribution rather than declaring readiness", () => {
    expect(
      buildConversionMeasurementReadiness({
        campaigns: [campaign],
        eventSettings: [{ ...setting, attribution_window_days: 7 }],
      }).checks[0],
    ).toMatchObject({
      status: "warning",
      title: "Attribution contract differs",
    });
  });
});
