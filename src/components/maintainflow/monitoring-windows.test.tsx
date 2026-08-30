import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { MonitoringWindowDto } from "@/lib/openai-ads/monitoring";

import { MonitoringWindows } from "./monitoring-windows";

const triggeredWindow: MonitoringWindowDto = {
  approvalId: "00000000-0000-4000-8000-000000000001",
  accountId: "adacct_live",
  recommendationId: "live_bid_adgrp_live",
  recommendationTitle: "Lower the CPA bid by 20%",
  entityId: "adgrp_live",
  safeguard:
    "Restore the previous bid if click-attributed conversions fall more than 15% after seven days.",
  status: "safeguard_triggered",
  startedAt: "2026-08-20T00:00:00.000Z",
  endsAt: "2026-08-27T00:00:00.000Z",
  progress: 100,
  plan: {
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
  },
  outcome: "safeguard_triggered",
  observation: {
    rangeStart: 1_788_048_000,
    rangeEnd: 1_788_652_800,
    spend: 1_680,
    clickAttributedConversions: 84,
    cpa: 20,
    conversionChangePercent: -16,
    baselineClickAttributedConversions: 100,
    thresholdPercent: 15,
    evidenceState: "complete",
  },
  evaluatedAt: "2026-08-27T01:00:00.000Z",
};

describe("monitoring outcome card", () => {
  it("shows observed evidence and a human-only rollback review", () => {
    const html = renderToStaticMarkup(
      <MonitoringWindows
        dataSource="live"
        windows={[triggeredWindow]}
        recommendations={[]}
      />,
    );

    expect(html).toContain("Rollback review");
    expect(html).toContain("Observed result");
    expect(html).toContain("-16%");
    expect(html).toContain("Human rollback review is recommended");
    expect(html).toContain("No rollback was sent");
    expect(html).not.toContain("Automatic rollback");
  });
});
