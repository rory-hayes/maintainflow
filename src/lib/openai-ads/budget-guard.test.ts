import { describe, expect, it } from "vitest";

import {
  evaluateBudgetGuard,
  evaluateBudgetGuards,
  OPENAI_BUDGET_POLICY_VERSION,
  type BudgetGuardDailySpendEvidence,
  type BudgetGuardEvidence,
} from "./budget-guard";
import type { Campaign } from "./schema";

const AUGUST_1 = Date.parse("2026-08-01T00:00:00.000Z") / 1_000;
const WEEK_START = Date.parse("2026-08-24T00:00:00.000Z") / 1_000;
const RANGE_END = Date.parse("2026-08-29T00:00:00.000Z") / 1_000;
const WEEK_END = Date.parse("2026-08-31T00:00:00.000Z") / 1_000;
const SEPTEMBER_1 = Date.parse("2026-09-01T00:00:00.000Z") / 1_000;

const dailyCampaign: Campaign = {
  id: "cmpn_daily",
  created_at: AUGUST_1,
  updated_at: AUGUST_1,
  name: "Average daily budget",
  description: null,
  status: "active",
  mode: null,
  product_feed_id: null,
  start_time: AUGUST_1,
  end_time: null,
  budget: { daily_spend_limit_micros: 100_000_000 },
  bidding_type: "clicks",
  conversion_event_setting_ids: [],
};

const lifetimeCampaign: Campaign = {
  ...dailyCampaign,
  id: "cmpn_lifetime",
  name: "Lifetime budget",
  end_time: SEPTEMBER_1,
  budget: { lifetime_spend_limit_micros: 3_100_000_000 },
};

function evidence(
  spendMicros = 600_000_000,
  overrides: Partial<BudgetGuardEvidence> = {},
): BudgetGuardEvidence {
  return {
    campaignId: dailyCampaign.id,
    source: "live",
    policyVersion: OPENAI_BUDGET_POLICY_VERSION,
    rangeStart: WEEK_START,
    rangeEnd: RANGE_END,
    periodStart: WEEK_START,
    periodEnd: WEEK_END,
    calculatedAt: "2026-08-29T00:30:00.000Z",
    accountTimeZone: "UTC",
    isComplete: true,
    budgetHistoryConfirmed: true,
    spendMicros,
    applicableSpendLimitMicros: 700_000_000,
    ...overrides,
  };
}

function evaluateDaily(
  spendMicros: number,
  evidenceOverrides: Partial<BudgetGuardEvidence> = {},
) {
  return evaluateBudgetGuard({
    campaign: dailyCampaign,
    evidence: evidence(spendMicros, evidenceOverrides),
    now: "2026-08-29T01:00:00.000Z",
  });
}

describe("evaluateBudgetGuard seven-day average budgets", () => {
  it.each([
    {
      spendMicros: 600_000_000,
      status: "critical_overspend",
      projectedSpendMicros: 840_000_000,
    },
    {
      spendMicros: 550_000_000,
      status: "overspend",
      projectedSpendMicros: 770_000_000,
    },
    {
      spendMicros: 400_000_000,
      status: "underpacing",
      projectedSpendMicros: 560_000_000,
    },
    {
      spendMicros: 475_000_000,
      status: "on_track",
      projectedSpendMicros: 665_000_000,
    },
  ] as const)(
    "classifies a stable five-day prefix as $status",
    ({ spendMicros, status, projectedSpendMicros }) => {
      const result = evaluateDaily(spendMicros);

      expect(result).toMatchObject({
        campaignId: dailyCampaign.id,
        source: "live",
        status,
        reason: null,
        isStale: false,
        budgetBasis: "average_daily_seven_day_limit",
        spendMicros,
        applicableSpendLimitMicros: 700_000_000,
        projectedSpendMicros,
        evidence: {
          rangeStart: WEEK_START,
          rangeEnd: RANGE_END,
          periodStart: WEEK_START,
          periodEnd: WEEK_END,
          observedCompleteDays: 5,
          periodDays: 7,
          budgetHistoryConfirmed: true,
        },
      });
      expect(result.paceRatio).toBeCloseTo(
        projectedSpendMicros / 700_000_000,
      );
      expect(result.exposureMicros).toBe(
        Math.max(0, projectedSpendMicros - 700_000_000),
      );
      expect(result.shortfallMicros).toBe(
        Math.max(0, 700_000_000 - projectedSpendMicros),
      );
    },
  );

  it("requires a stable full seven-day budget period and exact 7x limit", () => {
    const unconfirmed = evaluateDaily(500_000_000, {
      budgetHistoryConfirmed: false,
    });
    const prorated = evaluateDaily(500_000_000, {
      periodStart: WEEK_START + 24 * 60 * 60,
    });
    const wrongLimit = evaluateDaily(500_000_000, {
      applicableSpendLimitMicros: 650_000_000,
    });

    expect(unconfirmed.reason).toBe("unconfirmed_budget_history");
    expect(prorated.reason).toBe("mismatched_period");
    expect(wrongLimit.reason).toBe("invalid_applicable_limit");
  });

  it("uses account-local calendar days across daylight saving", () => {
    const periodStart = Date.parse("2026-03-23T00:00:00.000Z") / 1_000;
    const rangeEnd = Date.parse("2026-03-28T00:00:00.000Z") / 1_000;
    const periodEnd = Date.parse("2026-03-29T23:00:00.000Z") / 1_000;
    const result = evaluateBudgetGuard({
      campaign: { ...dailyCampaign, start_time: AUGUST_1 - 20_000_000 },
      evidence: evidence(500_000_000, {
        rangeStart: periodStart,
        rangeEnd,
        periodStart,
        periodEnd,
        calculatedAt: "2026-03-28T00:30:00.000Z",
        accountTimeZone: "Europe/Dublin",
      }),
      now: "2026-03-28T01:00:00.000Z",
    });

    expect(periodEnd - periodStart).toBe(167 * 60 * 60);
    expect(result).toMatchObject({
      status: "on_track",
      evidence: { observedCompleteDays: 5, periodDays: 7 },
    });
  });

  it("allows safe threshold overrides and rejects invalid ordering", () => {
    const classified = evaluateBudgetGuard({
      campaign: dailyCampaign,
      evidence: evidence(525_000_000),
      now: "2026-08-29T01:00:00.000Z",
      thresholds: { overspendRatio: 1.05 },
    });
    const rejected = evaluateBudgetGuard({
      campaign: dailyCampaign,
      evidence: evidence(525_000_000),
      now: "2026-08-29T01:00:00.000Z",
      thresholds: { overspendRatio: 0.7 },
    });

    expect(classified.status).toBe("overspend");
    expect(rejected.reason).toBe("invalid_thresholds");
  });
});

describe("evaluateBudgetGuard lifetime caps", () => {
  it("evaluates a lifetime cap only for the exact complete campaign range", () => {
    const result = evaluateBudgetGuard({
      campaign: lifetimeCampaign,
      evidence: evidence(3_410_000_000, {
        campaignId: lifetimeCampaign.id,
        rangeStart: AUGUST_1,
        rangeEnd: SEPTEMBER_1,
        periodStart: AUGUST_1,
        periodEnd: SEPTEMBER_1,
        calculatedAt: "2026-09-01T00:30:00.000Z",
        applicableSpendLimitMicros: 3_100_000_000,
      }),
      now: "2026-09-01T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "overspend",
      budgetBasis: "lifetime_campaign_cap",
      spendMicros: 3_410_000_000,
      applicableSpendLimitMicros: 3_100_000_000,
      projectedSpendMicros: 3_410_000_000,
      exposureMicros: 310_000_000,
      shortfallMicros: 0,
      evidence: { observedCompleteDays: 31, periodDays: 31 },
    });
  });

  it("never compares a partial range with a lifetime cap", () => {
    const result = evaluateBudgetGuard({
      campaign: lifetimeCampaign,
      evidence: evidence(1_200_000_000, {
        campaignId: lifetimeCampaign.id,
        applicableSpendLimitMicros: 3_100_000_000,
      }),
      now: "2026-08-29T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "insufficient_evidence",
      reason: "lifetime_range_mismatch",
      budgetBasis: null,
      paceRatio: null,
      exposureMicros: null,
    });
  });
});

describe("evaluateBudgetGuard evidence gates", () => {
  it.each(["paused", "archived"] as const)(
    "returns inactive for a %s campaign without calculating money",
    (status) => {
      const result = evaluateBudgetGuard({
        campaign: { ...dailyCampaign, status },
        evidence: evidence(),
      });

      expect(result).toMatchObject({
        status: "inactive",
        reason: "campaign_inactive",
        spendMicros: null,
        paceRatio: null,
        exposureMicros: null,
      });
    },
  );

  it("marks old evidence stale and suppresses its calculations", () => {
    const result = evaluateBudgetGuard({
      campaign: dailyCampaign,
      evidence: evidence(),
      now: "2026-08-31T00:31:00.000Z",
    });

    expect(result).toMatchObject({
      status: "insufficient_evidence",
      reason: "stale_evidence",
      isStale: true,
      budgetBasis: null,
      projectedSpendMicros: null,
    });
  });

  it("rejects incomplete, partial-day, too-short, and mismatched evidence", () => {
    const incomplete = evaluateDaily(500_000_000, { isComplete: false });
    const partial = evaluateDaily(500_000_000, {
      rangeStart: WEEK_START + 12 * 60 * 60,
    });
    const tooShort = evaluateDaily(200_000_000, {
      rangeEnd: WEEK_START + 2 * 24 * 60 * 60,
      calculatedAt: "2026-08-28T00:30:00.000Z",
    });
    const mismatched = evaluateBudgetGuard({
      campaign: dailyCampaign,
      evidence: evidence(500_000_000, { campaignId: "cmpn_other" }),
    });

    expect(incomplete.reason).toBe("incomplete_evidence");
    expect(partial.reason).toBe("partial_account_local_day");
    expect(tooShort.reason).toBe("too_few_complete_days");
    expect(mismatched.reason).toBe("campaign_mismatch");
  });

  it("rejects malformed clocks, ranges, zones, spend, and limits", () => {
    expect(evaluateDaily(500_000_000, { rangeEnd: WEEK_START }).reason).toBe(
      "invalid_evidence_range",
    );
    expect(
      evaluateDaily(500_000_000, { accountTimeZone: "Mars/Olympus_Mons" })
        .reason,
    ).toBe("invalid_time_zone");
    expect(
      evaluateDaily(500_000_000, {
        calculatedAt: "2026-08-28T23:59:59.000Z",
      }).reason,
    ).toBe("invalid_calculated_at");
    expect(evaluateDaily(Number.NaN).reason).toBe("invalid_spend_evidence");
    expect(
      evaluateDaily(500_000_000, { applicableSpendLimitMicros: 0 }).reason,
    ).toBe("invalid_applicable_limit");
  });

  it("rejects evidence evaluated under an unknown budget policy", () => {
    const result = evaluateBudgetGuard({
      campaign: dailyCampaign,
      evidence: {
        ...evidence(),
        policyVersion: "openai_budget_rules_future" as never,
      },
      now: "2026-08-29T01:00:00.000Z",
    });

    expect(result.reason).toBe("unsupported_policy_version");
  });

  it("rejects missing, ambiguous, non-positive, and overflowing campaign budgets", () => {
    const missing = evaluateBudgetGuard({
      campaign: { ...dailyCampaign, budget: {} },
      evidence: evidence(),
    });
    const ambiguous = evaluateBudgetGuard({
      campaign: {
        ...dailyCampaign,
        budget: {
          daily_spend_limit_micros: 100_000_000,
          lifetime_spend_limit_micros: 700_000_000,
        },
      },
      evidence: evidence(),
    });
    const nonPositive = evaluateBudgetGuard({
      campaign: {
        ...dailyCampaign,
        budget: { daily_spend_limit_micros: 0 },
      },
      evidence: evidence(),
    });
    const overflowing = evaluateBudgetGuard({
      campaign: {
        ...dailyCampaign,
        budget: { daily_spend_limit_micros: Number.MAX_SAFE_INTEGER },
      },
      evidence: evidence(),
      now: "2026-08-29T01:00:00.000Z",
    });

    expect(missing.reason).toBe("missing_budget");
    expect(ambiguous.reason).toBe("invalid_budget");
    expect(nonPositive.reason).toBe("invalid_budget");
    expect(overflowing.reason).toBe("invalid_applicable_limit");
  });
});

function completeDailyRows(): BudgetGuardDailySpendEvidence[] {
  const spends = [210_000_000, 100_000_000, 100_000_000, 90_000_000, 100_000_000];
  return spends.map((spendMicros, index) => ({
    accountLocalDate: `2026-08-${(index + 24).toString().padStart(2, "0")}`,
    spendMicros,
    maximumDailySpendMicros: 200_000_000,
    isComplete: true,
  }));
}

describe("evaluateBudgetGuard daily maximum evidence", () => {
  it("surfaces a day above OpenAI's 2x maximum separately from weekly pace", () => {
    const result = evaluateDaily(600_000_000, {
      dailySpend: completeDailyRows(),
    });

    expect(result.status).toBe("critical_overspend");
    expect(result.dailyAnomaly).toEqual({
      accountLocalDate: "2026-08-24",
      status: "overspend",
      spendMicros: 210_000_000,
      maximumDailySpendMicros: 200_000_000,
      paceRatio: 1.05,
      exposureMicros: 10_000_000,
    });
  });

  it.each([
    { name: "missing date", rows: completeDailyRows().slice(1) },
    {
      name: "partial date",
      rows: completeDailyRows().map((row, index) =>
        index === 0 ? { ...row, isComplete: false } : row,
      ),
    },
    {
      name: "aggregate mismatch",
      rows: completeDailyRows().map((row, index) =>
        index === 0 ? { ...row, spendMicros: row.spendMicros + 1 } : row,
      ),
    },
    {
      name: "wrong documented maximum",
      rows: completeDailyRows().map((row, index) =>
        index === 0
          ? { ...row, maximumDailySpendMicros: 100_000_000 }
          : row,
      ),
    },
  ])("rejects $name daily evidence", ({ rows }) => {
    const result = evaluateDaily(600_000_000, { dailySpend: rows });

    expect(result).toMatchObject({
      status: "insufficient_evidence",
      reason: "invalid_daily_evidence",
      dailyAnomaly: null,
    });
  });
});

describe("evaluateBudgetGuards", () => {
  it("maps campaign-scoped evidence in campaign order", () => {
    const inactive = {
      ...dailyCampaign,
      id: "cmpn_paused",
      status: "paused" as const,
    };

    const results = evaluateBudgetGuards({
      campaigns: [dailyCampaign, inactive],
      evidence: [evidence(600_000_000, { source: "demo" })],
      now: "2026-08-29T01:00:00.000Z",
    });

    expect(results.map(({ campaignId, source, status }) => ({
      campaignId,
      source,
      status,
    }))).toEqual([
      {
        campaignId: dailyCampaign.id,
        source: "demo",
        status: "critical_overspend",
      },
      { campaignId: inactive.id, source: null, status: "inactive" },
    ]);
  });

  it("fails closed instead of choosing duplicate campaign evidence", () => {
    const item = evidence(500_000_000);
    const [result] = evaluateBudgetGuards({
      campaigns: [dailyCampaign],
      evidence: [item, { ...item }],
      now: "2026-08-29T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "insufficient_evidence",
      reason: "missing_evidence",
    });
  });
});
