import { describe, expect, it } from "vitest";

import { evaluateMonitoringObservation, type MonitoringPlan } from "./monitoring";

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

function evaluate(clickAttributedConversions: number | null, spend = 1_680) {
  return evaluateMonitoringObservation({
    plan,
    rangeStart: 1_788_048_000,
    rangeEnd: 1_788_652_800,
    spend,
    clickAttributedConversions,
  });
}

describe("monitoring safeguard evaluation", () => {
  it("triggers human rollback review only beyond the strict threshold", () => {
    expect(evaluate(84)).toMatchObject({
      outcome: "safeguard_triggered",
      observation: {
        conversionChangePercent: -16,
        cpa: 20,
        evidenceState: "complete",
      },
    });
    expect(evaluate(85)).toMatchObject({
      outcome: "within_safeguard",
      observation: { conversionChangePercent: -15 },
    });
  });

  it("keeps improved conversion performance within the safeguard", () => {
    expect(evaluate(110, 1_980)).toMatchObject({
      outcome: "within_safeguard",
      observation: { conversionChangePercent: 10, cpa: 18 },
    });
  });

  it("does not turn a missing provider row into zero conversions", () => {
    expect(evaluate(null)).toMatchObject({
      outcome: "insufficient_evidence",
      observation: {
        clickAttributedConversions: null,
        conversionChangePercent: null,
        evidenceState: "missing_conversion_insight",
      },
    });
  });

  it("does not evaluate a baseline below the live rule's evidence floor", () => {
    expect(
      evaluateMonitoringObservation({
        plan: {
          ...plan,
          baseline: { ...plan.baseline, clickAttributedConversions: 2 },
        },
        rangeStart: 1_788_048_000,
        rangeEnd: 1_788_652_800,
        spend: 100,
        clickAttributedConversions: 0,
      }),
    ).toMatchObject({
      outcome: "insufficient_evidence",
      observation: { evidenceState: "insufficient_baseline" },
    });
  });
});
