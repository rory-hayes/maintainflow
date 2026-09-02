import { describe, expect, it } from "vitest";

import {
  ATTRIBUTION_NAMING_CONVENTION_NOTE,
  buildCampaignAttributionReadiness,
  SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE,
} from "./attribution-readiness";
import type { Campaign } from "./schema";

function campaign(
  id: string,
  options: {
    status?: Campaign["status"];
    template?: string | null;
    includeConfiguration?: boolean;
  } = {},
): Campaign {
  const value: Campaign = {
    id,
    created_at: 1_735_689_600,
    updated_at: 1_735_776_000,
    name: `Campaign ${id}`,
    description: null,
    status: options.status ?? "active",
    product_feed_id: null,
    start_time: 1_735_689_600,
    end_time: null,
    budget: { daily_spend_limit_micros: 10_000_000 },
    bidding_type: "clicks",
    conversion_event_setting_ids: [],
  };

  if (options.includeConfiguration !== false) {
    value.landing_page_configuration = {
      query_string_template: options.template ?? null,
    };
  }
  return value;
}

function issueCodes(
  readiness: ReturnType<typeof buildCampaignAttributionReadiness>,
  campaignId: string,
) {
  return (
    readiness.checks.find((check) => check.campaignId === campaignId)?.issues ??
    []
  ).map((issue) => issue.code);
}

describe("campaign attribution readiness", () => {
  it("recognizes the official dynamic macros without mandating UTM values", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [
        campaign("ready", {
          template:
            "utm_source=openai&utm_medium=sponsored&utm_campaign=launch-{campaign_id}&utm_content={ad_group_id}&account={ad_account_id}",
        }),
      ],
    });

    expect(readiness).toMatchObject({
      status: "ready",
      counts: {
        totalCampaigns: 1,
        activeCampaigns: 1,
        readyCampaigns: 1,
        needsAttentionCampaigns: 0,
        notApplicableCampaigns: 0,
        actionableChecks: 0,
      },
    });
    expect(readiness.supportedMacros).toEqual([
      "{campaign_id}",
      "{ad_group_id}",
      "{ad_id}",
      "{ad_account_id}",
    ]);
    expect(readiness.namingConventionNote).toBe(
      ATTRIBUTION_NAMING_CONVENTION_NOTE,
    );
    expect(readiness.namingConventionNote).toContain("does not mandate");
  });

  it("reports missing configuration while leaving paused and archived campaigns not applicable", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [
        campaign("missing", { includeConfiguration: false }),
        campaign("paused", { status: "paused" }),
        campaign("archived", {
          status: "archived",
          template: "oppref=manual",
        }),
      ],
    });

    expect(readiness).toMatchObject({
      status: "needs_attention",
      counts: {
        totalCampaigns: 3,
        activeCampaigns: 1,
        readyCampaigns: 0,
        needsAttentionCampaigns: 1,
        notApplicableCampaigns: 2,
        actionableChecks: 1,
      },
    });
    expect(issueCodes(readiness, "missing")).toEqual([
      "missing_configuration",
    ]);
    expect(readiness.checks[0]?.recommendedTemplate).toBe(
      SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE,
    );
    expect(readiness.checks.slice(1).map((check) => check.status)).toEqual([
      "not_applicable",
      "not_applicable",
    ]);
    expect(readiness.actionableChecks.map((check) => check.campaignId)).toEqual([
      "missing",
    ]);
  });

  it("flags every missing attribution dimension and removes advertiser-supplied oppref", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [
        campaign("gaps", {
          template: "utm_source=&provider_click=abc&oppref=manual",
        }),
      ],
    });

    expect(issueCodes(readiness, "gaps")).toEqual([
      "reserved_oppref",
      "missing_utm_source",
      "missing_utm_medium",
      "missing_dynamic_campaign_id",
      "missing_dynamic_ad_or_ad_group_id",
    ]);
    expect(readiness.checks[0]?.recommendedTemplate).toBe(
      `${SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE}&provider_click=abc`,
    );
    expect(readiness.checks[0]?.recommendedTemplate).not.toContain("oppref");
  });

  it("flags malformed syntax and unsupported brace macros", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [
        campaign("invalid", {
          template:
            "utm_source=chatgpt&&utm_medium=paid&utm_campaign={campaign_name}&utm_content={ad_id",
        }),
      ],
    });

    expect(issueCodes(readiness, "invalid")).toEqual([
      "malformed_query",
      "unsupported_macro",
      "missing_dynamic_campaign_id",
      "missing_dynamic_ad_or_ad_group_id",
    ]);
    expect(readiness.actionableChecks[0]).toMatchObject({
      campaignId: "invalid",
      code: "malformed_query",
      priority: 2,
    });
    expect(readiness.actionableChecks[1]).toMatchObject({
      code: "unsupported_macro",
      priority: 2,
    });
    expect(readiness.checks[0]?.recommendedTemplate).toBe(
      SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE,
    );
  });

  it("preserves safe unknown provider parameters in the recommendation", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [
        campaign("provider-params", {
          template:
            "?provider_click=abc%2F123&utm_term=storage&utm_source=custom&utm_medium=cpc&utm_campaign=sale-{campaign_id}&utm_content={ad_id}&account={ad_account_id}",
        }),
      ],
    });

    expect(readiness.status).toBe("ready");
    expect(readiness.checks[0]?.recommendedTemplate).toBe(
      "utm_source=custom&utm_medium=cpc&utm_campaign=sale-{campaign_id}&utm_content={ad_id}&provider_click=abc%2F123&utm_term=storage&account={ad_account_id}",
    );
  });

  it("sorts actionable checks by urgency across active campaigns", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [
        campaign("missing-source", {
          template:
            "utm_medium=paid&utm_campaign={campaign_id}&utm_content={ad_id}",
        }),
        campaign("reserved", {
          template:
            "utm_source=chatgpt&utm_medium=paid&utm_campaign={campaign_id}&utm_content={ad_id}&oppref=manual",
        }),
      ],
    });

    expect(readiness.actionableChecks.map((check) => check.code)).toEqual([
      "reserved_oppref",
      "missing_utm_source",
    ]);
  });

  it("returns not applicable when there are no active campaigns", () => {
    const readiness = buildCampaignAttributionReadiness({
      campaigns: [campaign("paused", { status: "paused" })],
    });

    expect(readiness).toMatchObject({
      status: "not_applicable",
      counts: {
        activeCampaigns: 0,
        notApplicableCampaigns: 1,
        actionableChecks: 0,
      },
    });
  });
});
