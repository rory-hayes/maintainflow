import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { adsApiRequestMock } = vi.hoisted(() => ({
  adsApiRequestMock: vi.fn(),
}));

vi.mock("./client.server", () => ({
  adsApiRequest: adsApiRequestMock,
}));

import { evaluateLiveMonitoringWindow } from "./monitoring.server";
import type { MonitoringPlan } from "./monitoring";

const start = 1_788_048_000;
const end = 1_788_652_800;
const plan: MonitoringPlan = {
  kind: "click_attributed_conversion_guardrail",
  windowDays: 7,
  baseline: {
    rangeStart: 1_787_356_800,
    rangeEnd: 1_787_961_600,
    spend: 2_000,
    clickAttributedConversions: 100,
    cpa: 20,
    configuredBidMicros: 25_000_000,
    currencyCode: "EUR",
  },
  rollbackRule: {
    metric: "click_attributed_conversions",
    comparison: "decrease_percent_greater_than",
    thresholdPercent: 15,
  },
};

describe("live monitoring adapter", () => {
  beforeEach(() => {
    adsApiRequestMock.mockReset();
  });

  it("uses one exact full-hour range for scoped delivery and conversion reads", async () => {
    adsApiRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/ad_groups/adgrp_live/insights?")) {
        return {
          object: "list",
          count: 1,
          has_more: false,
          data: [
            {
              id: "observed-ad-group",
              start_time: start,
              end_time: end,
              ad_group_id: "adgrp_live",
              spend: 1_680,
              impressions: 30_000,
              clicks: 800,
            },
          ],
        };
      }
      return {
        object: "list",
        count: 1,
        data: [
          {
            entity_id: "adgrp_live",
            conversions: 84,
            click_through_conversions: 84,
            view_through_conversions: 40,
          },
        ],
      };
    });

    const result = await evaluateLiveMonitoringWindow({
      entityId: "adgrp_live",
      plan,
      startedAt: new Date(start * 1_000),
      endsAt: new Date(end * 1_000),
      credential: { apiKey: "ads-test-key" },
    });

    const deliveryPath = adsApiRequestMock.mock.calls[0][0] as string;
    const deliveryUrl = new URL(deliveryPath, "https://test.invalid");
    expect(deliveryUrl.pathname).toBe("/ad_groups/adgrp_live/insights");
    expect(deliveryUrl.searchParams.get("aggregation_level")).toBe("ad_group");
    expect(deliveryUrl.searchParams.getAll("fields[]")).toEqual([
      "ad_group.id",
      "ad_group.impressions",
      "ad_group.clicks",
      "ad_group.spend",
    ]);
    expect(JSON.parse(deliveryUrl.searchParams.get("time_ranges[]")!)).toEqual({
      type: "unix_range",
      start,
      end,
    });
    expect(JSON.parse(adsApiRequestMock.mock.calls[1][2].body.time_ranges[0])).toEqual({
      type: "unix_range",
      start: String(start),
      end: String(end),
    });
    expect(adsApiRequestMock.mock.calls[1][2]).toMatchObject({
      method: "POST",
      retryOnRateLimit: true,
    });
    expect(result).toMatchObject({
      outcome: "safeguard_triggered",
      observation: {
        clickAttributedConversions: 84,
        conversionChangePercent: -16,
      },
    });
  });

  it("falls back to total conversions when click-through conversions are absent", async () => {
    adsApiRequestMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/ad_groups/adgrp_live/insights?")) {
        return {
          object: "list",
          count: 1,
          has_more: false,
          data: [
            {
              id: "observed-ad-group",
              start_time: start,
              end_time: end,
              ad_group_id: "adgrp_live",
              spend: 1_680,
            },
          ],
        };
      }
      return {
        object: "list",
        count: 1,
        data: [
          {
            entity_id: "adgrp_live",
            conversions: 84,
          },
        ],
      };
    });

    const result = await evaluateLiveMonitoringWindow({
      entityId: "adgrp_live",
      plan,
      startedAt: new Date(start * 1_000),
      endsAt: new Date(end * 1_000),
      credential: { apiKey: "ads-test-key" },
    });

    expect(result).toMatchObject({
      outcome: "safeguard_triggered",
      observation: {
        clickAttributedConversions: 84,
        conversionChangePercent: -16,
        evidenceState: "complete",
      },
    });
  });
});
