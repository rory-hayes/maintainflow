import "server-only";

import { adsApiRequest, type AdsApiCredential } from "./client.server";
import {
  evaluateMonitoringObservation,
  type MonitoringPlan,
} from "./monitoring";
import {
  conversionInsightResponseSchema,
  insightListResponseSchema,
} from "./schema";

export type MonitoringRange = {
  start: number;
  end: number;
};

export function monitoringRangeFromDates(
  startedAt: Date,
  endsAt: Date,
): MonitoringRange {
  const rawStart = Math.floor(startedAt.getTime() / 1_000);
  const rawEnd = Math.floor(endsAt.getTime() / 1_000);
  const start = Math.ceil(rawStart / 3_600) * 3_600;
  const end = Math.floor(rawEnd / 3_600) * 3_600;

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new Error("The stored monitoring window has no complete Insights hours.");
  }
  return { start, end };
}

function deliveryInsightsPath(entityId: string, range: MonitoringRange) {
  const params = new URLSearchParams({
    time_granularity: "none",
    aggregation_level: "ad_group",
    limit: "1",
  });
  for (const field of [
    "ad_group.id",
    "ad_group.impressions",
    "ad_group.clicks",
    "ad_group.spend",
  ]) {
    params.append("fields[]", field);
  }
  params.append(
    "time_ranges[]",
    JSON.stringify({ type: "unix_range", ...range }),
  );
  return `/ad_groups/${encodeURIComponent(entityId)}/insights?${params.toString()}`;
}

export async function evaluateLiveMonitoringWindow(options: {
  entityId: string;
  plan: MonitoringPlan;
  startedAt: Date;
  endsAt: Date;
  credential: AdsApiCredential;
}) {
  const range = monitoringRangeFromDates(options.startedAt, options.endsAt);
  const [deliveryResponse, conversionResponse] = await Promise.all([
    adsApiRequest(
      deliveryInsightsPath(options.entityId, range),
      insightListResponseSchema,
      {},
      options.credential,
    ),
    adsApiRequest(
      "/conversions/insights",
      conversionInsightResponseSchema,
      {
        method: "POST",
        body: {
          aggregation_level: "ad_group",
          time_ranges: [
            JSON.stringify({
              type: "unix_range",
              start: String(range.start),
              end: String(range.end),
            }),
          ],
          entity_ids: [options.entityId],
        },
      },
      options.credential,
    ),
  ]);
  const delivery = deliveryResponse.data.find(
    (row) =>
      row.ad_group_id === options.entityId &&
      row.start_time === range.start &&
      row.end_time === range.end &&
      row.spend !== undefined,
  );
  const conversion = conversionResponse.data.find(
    (row) => row.entity_id === options.entityId,
  );

  return evaluateMonitoringObservation({
    plan: options.plan,
    rangeStart: range.start,
    rangeEnd: range.end,
    spend: delivery?.spend ?? null,
    clickAttributedConversions:
      conversion?.click_through_conversions ?? null,
  });
}
