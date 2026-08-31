import type { Campaign } from "./schema";

const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MILLISECONDS_PER_CALENDAR_DAY = 24 * 60 * 60 * 1_000;
const OPENAI_BUDGET_PERIOD_DAYS = 7;
const OPENAI_MAX_DAILY_MULTIPLIER = 2;
export const OPENAI_BUDGET_POLICY_VERSION =
  "openai_budget_rules_2026-08" as const;

export const DEFAULT_BUDGET_GUARD_THRESHOLDS = {
  criticalOverspendRatio: 1.2,
  overspendRatio: 1.1,
  underpacingRatio: 0.8,
  minimumCompleteDays: 3,
  staleAfterSeconds: 36 * 60 * 60,
} as const;

export type BudgetGuardStatus =
  | "critical_overspend"
  | "overspend"
  | "underpacing"
  | "on_track"
  | "insufficient_evidence"
  | "inactive";

export type BudgetGuardBudgetBasis =
  | "average_daily_seven_day_limit"
  | "lifetime_campaign_cap";

export type BudgetGuardReason =
  | "campaign_inactive"
  | "campaign_mismatch"
  | "missing_evidence"
  | "missing_budget"
  | "invalid_budget"
  | "invalid_thresholds"
  | "invalid_evidence_range"
  | "unsupported_policy_version"
  | "invalid_time_zone"
  | "incomplete_evidence"
  | "partial_account_local_day"
  | "too_few_complete_days"
  | "mismatched_period"
  | "lifetime_range_mismatch"
  | "invalid_calculated_at"
  | "stale_evidence"
  | "invalid_daily_evidence"
  | "unconfirmed_budget_history"
  | "invalid_spend_evidence"
  | "invalid_applicable_limit";

export type BudgetGuardThresholds = {
  criticalOverspendRatio: number;
  overspendRatio: number;
  underpacingRatio: number;
  minimumCompleteDays: number;
  staleAfterSeconds: number;
};

export type BudgetGuardDailySpendEvidence = {
  /** Account-local ISO calendar date (YYYY-MM-DD). */
  accountLocalDate: string;
  spendMicros: number;
  /** The documented maximum for this day, after accounting for budget history. */
  maximumDailySpendMicros: number;
  isComplete: boolean;
};

/**
 * Evidence for one campaign and one applicable provider budget window.
 *
 * OpenAI daily budgets are seven-day averages, not per-day hard caps. A live
 * caller must therefore prove that the average daily budget did not change in
 * the window before setting `budgetHistoryConfirmed=true`. A current campaign
 * object alone is not sufficient evidence because mid-week changes are
 * prorated and an individual day may spend up to twice the average daily value.
 */
export type BudgetGuardEvidence = {
  campaignId: string;
  source: "demo" | "live";
  /** Pins persisted evidence to the OpenAI budget rules it was evaluated under. */
  policyVersion: typeof OPENAI_BUDGET_POLICY_VERSION;
  /** Start of the observed spend window, as Unix seconds. */
  rangeStart: number;
  /** End-exclusive boundary of observed complete account-local days. */
  rangeEnd: number;
  /** Start of the applicable stable seven-day budget window. */
  periodStart: number;
  /** End-exclusive boundary of the applicable stable seven-day window. */
  periodEnd: number;
  calculatedAt: string;
  accountTimeZone: string;
  /** Confirms the aggregate contains every requested campaign spend row. */
  isComplete: boolean;
  /** Confirms no unobserved budget change can alter the applicable limit. */
  budgetHistoryConfirmed: boolean;
  spendMicros: number;
  /** Explicit provider-equivalent limit for this exact window. */
  applicableSpendLimitMicros: number;
  dailySpend?: readonly BudgetGuardDailySpendEvidence[];
};

export type BudgetGuardEvidenceSummary = Omit<
  BudgetGuardEvidence,
  "dailySpend" | "isComplete"
> & {
  observedCompleteDays: number;
  periodDays: number;
};

export type BudgetGuardDailyAnomaly = {
  accountLocalDate: string;
  status: "critical_overspend" | "overspend";
  spendMicros: number;
  maximumDailySpendMicros: number;
  paceRatio: number;
  exposureMicros: number;
};

export type BudgetGuardResult = {
  campaignId: string;
  source: BudgetGuardEvidence["source"] | null;
  status: BudgetGuardStatus;
  reason: BudgetGuardReason | null;
  isStale: boolean;
  budgetBasis: BudgetGuardBudgetBasis | null;
  spendMicros: number | null;
  applicableSpendLimitMicros: number | null;
  projectedSpendMicros: number | null;
  paceRatio: number | null;
  exposureMicros: number | null;
  shortfallMicros: number | null;
  evidence: BudgetGuardEvidenceSummary | null;
  dailyAnomaly: BudgetGuardDailyAnomaly | null;
};

export type EvaluateBudgetGuardInput = {
  campaign: Campaign;
  evidence?: BudgetGuardEvidence | null;
  now?: Date | string;
  thresholds?: Partial<BudgetGuardThresholds>;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type ValidatedRange = {
  observedDays: number;
  periodDays: number;
  observedStart: LocalDateTime;
};

function emptyResult(
  campaignId: string,
  source: BudgetGuardEvidence["source"] | null,
  status: Extract<BudgetGuardStatus, "insufficient_evidence" | "inactive">,
  reason: BudgetGuardReason,
  isStale = false,
): BudgetGuardResult {
  return {
    campaignId,
    source,
    status,
    reason,
    isStale,
    budgetBasis: null,
    spendMicros: null,
    applicableSpendLimitMicros: null,
    projectedSpendMicros: null,
    paceRatio: null,
    exposureMicros: null,
    shortfallMicros: null,
    evidence: null,
    dailyAnomaly: null,
  };
}

function isSafePositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeMultiply(left: number, right: number): number | null {
  const product = left * right;
  return Number.isSafeInteger(product) && product >= 0 ? product : null;
}

function parseClock(value: Date | string): number | null {
  const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function resolveThresholds(
  overrides: Partial<BudgetGuardThresholds> | undefined,
): BudgetGuardThresholds | null {
  const thresholds = {
    ...DEFAULT_BUDGET_GUARD_THRESHOLDS,
    ...overrides,
  };

  if (
    !Number.isFinite(thresholds.underpacingRatio) ||
    thresholds.underpacingRatio < 0 ||
    !Number.isFinite(thresholds.overspendRatio) ||
    thresholds.overspendRatio <= thresholds.underpacingRatio ||
    !Number.isFinite(thresholds.criticalOverspendRatio) ||
    thresholds.criticalOverspendRatio < thresholds.overspendRatio ||
    !Number.isSafeInteger(thresholds.minimumCompleteDays) ||
    thresholds.minimumCompleteDays < 1 ||
    thresholds.minimumCompleteDays > OPENAI_BUDGET_PERIOD_DAYS ||
    !Number.isSafeInteger(thresholds.staleAfterSeconds) ||
    thresholds.staleAfterSeconds < 1
  ) {
    return null;
  }

  return thresholds;
}

function localDateTime(
  timestampSeconds: number,
  accountTimeZone: string,
): LocalDateTime | null {
  try {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: accountTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const values = new Map(
      formatter
        .formatToParts(new Date(timestampSeconds * 1_000))
        .map((part) => [part.type, part.value]),
    );
    const result = {
      year: Number(values.get("year")),
      month: Number(values.get("month")),
      day: Number(values.get("day")),
      hour: Number(values.get("hour")),
      minute: Number(values.get("minute")),
      second: Number(values.get("second")),
    };

    return Object.values(result).every(Number.isInteger) ? result : null;
  } catch {
    return null;
  }
}

function isMidnight(value: LocalDateTime) {
  return value.hour === 0 && value.minute === 0 && value.second === 0;
}

function calendarOrdinal(value: LocalDateTime) {
  return Date.UTC(value.year, value.month - 1, value.day);
}

function calendarDayCount(start: LocalDateTime, end: LocalDateTime) {
  const difference = calendarOrdinal(end) - calendarOrdinal(start);
  const days = difference / MILLISECONDS_PER_CALENDAR_DAY;
  return Number.isSafeInteger(days) && days > 0 ? days : null;
}

function validateRange(
  evidence: BudgetGuardEvidence,
): { value: ValidatedRange | null; reason: BudgetGuardReason | null } {
  const timestamps = [
    evidence.rangeStart,
    evidence.rangeEnd,
    evidence.periodStart,
    evidence.periodEnd,
  ];
  if (
    timestamps.some((timestamp) => !isSafeNonNegativeInteger(timestamp)) ||
    evidence.rangeEnd <= evidence.rangeStart ||
    evidence.periodEnd <= evidence.periodStart
  ) {
    return { value: null, reason: "invalid_evidence_range" };
  }

  const rangeStart = localDateTime(
    evidence.rangeStart,
    evidence.accountTimeZone,
  );
  if (!rangeStart) return { value: null, reason: "invalid_time_zone" };
  const rangeEnd = localDateTime(evidence.rangeEnd, evidence.accountTimeZone);
  const periodStart = localDateTime(
    evidence.periodStart,
    evidence.accountTimeZone,
  );
  const periodEnd = localDateTime(evidence.periodEnd, evidence.accountTimeZone);
  if (!rangeEnd || !periodStart || !periodEnd) {
    return { value: null, reason: "invalid_time_zone" };
  }

  if (
    !isMidnight(rangeStart) ||
    !isMidnight(rangeEnd) ||
    !isMidnight(periodStart) ||
    !isMidnight(periodEnd)
  ) {
    return { value: null, reason: "partial_account_local_day" };
  }

  const observedDays = calendarDayCount(rangeStart, rangeEnd);
  const periodDays = calendarDayCount(periodStart, periodEnd);
  if (!observedDays || !periodDays) {
    return { value: null, reason: "invalid_evidence_range" };
  }

  return {
    value: { observedDays, periodDays, observedStart: rangeStart },
    reason: null,
  };
}

function localDateLabel(start: LocalDateTime, dayOffset: number) {
  const date = new Date(
    Date.UTC(start.year, start.month - 1, start.day + dayOffset),
  );
  return [
    date.getUTCFullYear().toString().padStart(4, "0"),
    (date.getUTCMonth() + 1).toString().padStart(2, "0"),
    date.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function dailyAnomaly(
  rows: readonly BudgetGuardDailySpendEvidence[] | undefined,
  range: ValidatedRange,
  totalSpendMicros: number,
  expectedMaximumDailySpendMicros: number,
): { anomaly: BudgetGuardDailyAnomaly | null; valid: boolean } {
  if (rows === undefined) return { anomaly: null, valid: true };
  if (rows.length !== range.observedDays) {
    return { anomaly: null, valid: false };
  }

  const byDate = new Map<string, BudgetGuardDailySpendEvidence>();
  let summedSpendMicros = 0;
  for (const row of rows) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.accountLocalDate) ||
      !row.isComplete ||
      !isSafeNonNegativeInteger(row.spendMicros) ||
      row.maximumDailySpendMicros !== expectedMaximumDailySpendMicros ||
      byDate.has(row.accountLocalDate)
    ) {
      return { anomaly: null, valid: false };
    }
    byDate.set(row.accountLocalDate, row);
    summedSpendMicros += row.spendMicros;
    if (!Number.isSafeInteger(summedSpendMicros)) {
      return { anomaly: null, valid: false };
    }
  }

  if (summedSpendMicros !== totalSpendMicros) {
    return { anomaly: null, valid: false };
  }

  let anomaly: BudgetGuardDailyAnomaly | null = null;
  for (let dayOffset = 0; dayOffset < range.observedDays; dayOffset += 1) {
    const accountLocalDate = localDateLabel(range.observedStart, dayOffset);
    const row = byDate.get(accountLocalDate);
    if (!row) return { anomaly: null, valid: false };

    const paceRatio = row.spendMicros / row.maximumDailySpendMicros;
    if (paceRatio > 1 && (!anomaly || paceRatio > anomaly.paceRatio)) {
      anomaly = {
        accountLocalDate,
        status:
          paceRatio >= DEFAULT_BUDGET_GUARD_THRESHOLDS.criticalOverspendRatio
            ? "critical_overspend"
            : "overspend",
        spendMicros: row.spendMicros,
        maximumDailySpendMicros: row.maximumDailySpendMicros,
        paceRatio,
        exposureMicros: row.spendMicros - row.maximumDailySpendMicros,
      };
    }
  }

  return { anomaly, valid: true };
}

function statusForRatio(
  ratio: number,
  thresholds: BudgetGuardThresholds,
): Exclude<BudgetGuardStatus, "insufficient_evidence" | "inactive"> {
  if (ratio >= thresholds.criticalOverspendRatio) {
    return "critical_overspend";
  }
  if (ratio >= thresholds.overspendRatio) return "overspend";
  if (ratio <= thresholds.underpacingRatio) return "underpacing";
  return "on_track";
}

/**
 * Evaluates one already-confirmed provider budget window. It deliberately does
 * not infer budget history from the campaign's current budget value.
 */
export function evaluateBudgetGuard({
  campaign,
  evidence,
  now = new Date(),
  thresholds: thresholdOverrides,
}: EvaluateBudgetGuardInput): BudgetGuardResult {
  const source = evidence?.source ?? null;

  if (campaign.status !== "active") {
    return emptyResult(campaign.id, source, "inactive", "campaign_inactive");
  }
  if (!evidence) {
    return emptyResult(
      campaign.id,
      null,
      "insufficient_evidence",
      "missing_evidence",
    );
  }
  if (evidence.campaignId !== campaign.id) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "campaign_mismatch",
    );
  }
  if (evidence.policyVersion !== OPENAI_BUDGET_POLICY_VERSION) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "unsupported_policy_version",
    );
  }

  const thresholds = resolveThresholds(thresholdOverrides);
  if (!thresholds) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "invalid_thresholds",
    );
  }

  const dailyLimit = campaign.budget.daily_spend_limit_micros;
  const lifetimeLimit = campaign.budget.lifetime_spend_limit_micros;
  if (
    (dailyLimit !== undefined && lifetimeLimit !== undefined) ||
    (dailyLimit !== undefined && !isSafePositiveInteger(dailyLimit)) ||
    (lifetimeLimit !== undefined && !isSafePositiveInteger(lifetimeLimit))
  ) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "invalid_budget",
    );
  }
  if (dailyLimit === undefined && lifetimeLimit === undefined) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "missing_budget",
    );
  }
  if (!evidence.isComplete) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "incomplete_evidence",
    );
  }
  if (!evidence.budgetHistoryConfirmed) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "unconfirmed_budget_history",
    );
  }
  if (!isSafeNonNegativeInteger(evidence.spendMicros)) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "invalid_spend_evidence",
    );
  }
  if (!isSafePositiveInteger(evidence.applicableSpendLimitMicros)) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "invalid_applicable_limit",
    );
  }

  const rangeValidation = validateRange(evidence);
  if (!rangeValidation.value) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      rangeValidation.reason!,
    );
  }
  const range = rangeValidation.value;

  const calculatedAt = parseClock(evidence.calculatedAt);
  const nowMilliseconds = parseClock(now);
  if (
    calculatedAt === null ||
    nowMilliseconds === null ||
    calculatedAt < evidence.rangeEnd * 1_000 ||
    calculatedAt > nowMilliseconds + MAX_FUTURE_CLOCK_SKEW_MS
  ) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "invalid_calculated_at",
    );
  }
  if (
    nowMilliseconds - calculatedAt >
    thresholds.staleAfterSeconds * 1_000
  ) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "stale_evidence",
      true,
    );
  }

  let budgetBasis: BudgetGuardBudgetBasis;
  let projectedSpendMicros: number;
  let anomaly: BudgetGuardDailyAnomaly | null = null;

  if (dailyLimit !== undefined) {
    const documentedWeeklyLimit = safeMultiply(
      dailyLimit,
      OPENAI_BUDGET_PERIOD_DAYS,
    );
    const documentedMaximumDailySpend = safeMultiply(
      dailyLimit,
      OPENAI_MAX_DAILY_MULTIPLIER,
    );
    if (
      documentedWeeklyLimit === null ||
      documentedMaximumDailySpend === null ||
      evidence.applicableSpendLimitMicros !== documentedWeeklyLimit
    ) {
      return emptyResult(
        campaign.id,
        source,
        "insufficient_evidence",
        "invalid_applicable_limit",
      );
    }
    if (
      evidence.rangeStart !== evidence.periodStart ||
      evidence.rangeEnd > evidence.periodEnd ||
      range.periodDays !== OPENAI_BUDGET_PERIOD_DAYS ||
      range.observedDays > range.periodDays ||
      (campaign.start_time !== null &&
        evidence.periodStart < campaign.start_time) ||
      (campaign.end_time !== null && evidence.periodEnd > campaign.end_time)
    ) {
      return emptyResult(
        campaign.id,
        source,
        "insufficient_evidence",
        "mismatched_period",
      );
    }
    if (range.observedDays < thresholds.minimumCompleteDays) {
      return emptyResult(
        campaign.id,
        source,
        "insufficient_evidence",
        "too_few_complete_days",
      );
    }

    projectedSpendMicros = Math.round(
      (evidence.spendMicros / range.observedDays) * range.periodDays,
    );
    if (!Number.isSafeInteger(projectedSpendMicros)) {
      return emptyResult(
        campaign.id,
        source,
        "insufficient_evidence",
        "invalid_spend_evidence",
      );
    }
    const daily = dailyAnomaly(
      evidence.dailySpend,
      range,
      evidence.spendMicros,
      documentedMaximumDailySpend,
    );
    if (!daily.valid) {
      return emptyResult(
        campaign.id,
        source,
        "insufficient_evidence",
        "invalid_daily_evidence",
      );
    }
    anomaly = daily.anomaly;
    budgetBasis = "average_daily_seven_day_limit";
  } else {
    if (
      campaign.start_time === null ||
      campaign.end_time === null ||
      evidence.rangeStart !== campaign.start_time ||
      evidence.rangeEnd !== campaign.end_time ||
      evidence.periodStart !== campaign.start_time ||
      evidence.periodEnd !== campaign.end_time ||
      evidence.applicableSpendLimitMicros !== lifetimeLimit
    ) {
      return emptyResult(
        campaign.id,
        source,
        "insufficient_evidence",
        "lifetime_range_mismatch",
      );
    }
    projectedSpendMicros = evidence.spendMicros;
    budgetBasis = "lifetime_campaign_cap";
  }

  const paceRatio =
    projectedSpendMicros / evidence.applicableSpendLimitMicros;
  if (!Number.isFinite(paceRatio)) {
    return emptyResult(
      campaign.id,
      source,
      "insufficient_evidence",
      "invalid_applicable_limit",
    );
  }

  return {
    campaignId: campaign.id,
    source,
    status: statusForRatio(paceRatio, thresholds),
    reason: null,
    isStale: false,
    budgetBasis,
    spendMicros: evidence.spendMicros,
    applicableSpendLimitMicros: evidence.applicableSpendLimitMicros,
    projectedSpendMicros,
    paceRatio,
    exposureMicros: Math.max(
      0,
      projectedSpendMicros - evidence.applicableSpendLimitMicros,
    ),
    shortfallMicros: Math.max(
      0,
      evidence.applicableSpendLimitMicros - projectedSpendMicros,
    ),
    evidence: {
      campaignId: evidence.campaignId,
      source: evidence.source,
      policyVersion: evidence.policyVersion,
      rangeStart: evidence.rangeStart,
      rangeEnd: evidence.rangeEnd,
      periodStart: evidence.periodStart,
      periodEnd: evidence.periodEnd,
      calculatedAt: evidence.calculatedAt,
      accountTimeZone: evidence.accountTimeZone,
      budgetHistoryConfirmed: evidence.budgetHistoryConfirmed,
      spendMicros: evidence.spendMicros,
      applicableSpendLimitMicros: evidence.applicableSpendLimitMicros,
      observedCompleteDays: range.observedDays,
      periodDays: range.periodDays,
    },
    dailyAnomaly: anomaly,
  };
}

export function evaluateBudgetGuards({
  campaigns,
  evidence,
  now,
  thresholds,
}: {
  campaigns: readonly Campaign[];
  evidence: readonly BudgetGuardEvidence[];
  now?: Date | string;
  thresholds?: Partial<BudgetGuardThresholds>;
}): BudgetGuardResult[] {
  const evidenceByCampaign = new Map<string, BudgetGuardEvidence | null>();
  for (const item of evidence) {
    evidenceByCampaign.set(
      item.campaignId,
      evidenceByCampaign.has(item.campaignId) ? null : item,
    );
  }

  return campaigns.map((campaign) =>
    evaluateBudgetGuard({
      campaign,
      evidence: evidenceByCampaign.get(campaign.id),
      now,
      thresholds,
    }),
  );
}
