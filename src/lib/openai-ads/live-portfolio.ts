export type LivePortfolioEvidenceState =
  | "confirmed_fresh"
  | "confirmed_stale"
  | "confirmed_expired"
  | "not_confirmed"
  | "refresh_required"
  | "invalid";

export type LivePortfolioExceptionEvidence = {
  count: number;
  oldestAt: string | null;
};

export type LivePortfolioOperationalExceptions = {
  safeguardTriggered: LivePortfolioExceptionEvidence;
  insufficientEvidence: LivePortfolioExceptionEvidence;
  monitoringFailures: LivePortfolioExceptionEvidence;
  reconciliationRequired: LivePortfolioExceptionEvidence;
};

export type LivePortfolioUrgency =
  | "critical"
  | "attention"
  | "review"
  | "clear";

/**
 * Minimal client-safe evidence for one live agency account.
 *
 * This intentionally excludes credentials, provider payloads, currency, spend,
 * and other values that cannot be compared safely across client accounts.
 */
export type LivePortfolioAccount = {
  accountId: string;
  accountName: string;
  hasConfirmedSnapshot: boolean;
  detectedSignalCount: number | null;
  evidenceState: LivePortfolioEvidenceState;
  evidenceAt: string | null;
  operationalExceptions: LivePortfolioOperationalExceptions;
};

export function livePortfolioOperationalExceptionCount(
  account: LivePortfolioAccount,
) {
  return Object.values(account.operationalExceptions).reduce(
    (total, exception) => total + exception.count,
    0,
  );
}

export function oldestLivePortfolioExceptionAt(
  account: LivePortfolioAccount,
) {
  const timestamps = Object.values(account.operationalExceptions)
    .map((exception) => exception.oldestAt)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(left) - Date.parse(right));

  return timestamps[0] ?? null;
}

export function livePortfolioUrgency(
  account: LivePortfolioAccount,
): LivePortfolioUrgency {
  if (
    account.operationalExceptions.reconciliationRequired.count > 0 ||
    account.operationalExceptions.monitoringFailures.count > 0
  ) {
    return "critical";
  }
  if (
    account.operationalExceptions.safeguardTriggered.count > 0 ||
    account.operationalExceptions.insufficientEvidence.count > 0
  ) {
    return "attention";
  }
  if (
    account.detectedSignalCount === null ||
    account.detectedSignalCount > 0 ||
    !["confirmed_fresh", "confirmed_stale"].includes(account.evidenceState)
  ) {
    return "review";
  }
  return "clear";
}

const urgencyRank: Record<LivePortfolioUrgency, number> = {
  critical: 0,
  attention: 1,
  review: 2,
  clear: 3,
};

function sortableTimestamp(value: string | null) {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

export function rankLivePortfolioAccounts(
  accounts: readonly LivePortfolioAccount[],
) {
  return [...accounts].sort((left, right) => {
    const urgencyDifference =
      urgencyRank[livePortfolioUrgency(left)] -
      urgencyRank[livePortfolioUrgency(right)];
    if (urgencyDifference !== 0) return urgencyDifference;

    const timestampDifference =
      sortableTimestamp(oldestLivePortfolioExceptionAt(left)) -
      sortableTimestamp(oldestLivePortfolioExceptionAt(right));
    if (timestampDifference !== 0) return timestampDifference;

    const nameDifference = left.accountName.localeCompare(right.accountName);
    return nameDifference !== 0
      ? nameDifference
      : left.accountId.localeCompare(right.accountId);
  });
}

export function summarizeLivePortfolioEvidence(
  accounts: readonly LivePortfolioAccount[],
) {
  const usableAccounts = accounts.filter(
    (account) =>
      account.hasConfirmedSnapshot &&
      account.detectedSignalCount !== null &&
      (account.evidenceState === "confirmed_fresh" ||
        account.evidenceState === "confirmed_stale"),
  );

  return {
    usableSnapshotCount: usableAccounts.length,
    unavailableSnapshotCount: accounts.length - usableAccounts.length,
    operationalExceptionAccountCount: accounts.filter(
      (account) => livePortfolioOperationalExceptionCount(account) > 0,
    ).length,
    reconciliationRequiredCount: accounts.reduce(
      (total, account) =>
        total + account.operationalExceptions.reconciliationRequired.count,
      0,
    ),
    monitoringExceptionCount: accounts.reduce(
      (total, account) =>
        total +
        account.operationalExceptions.safeguardTriggered.count +
        account.operationalExceptions.insufficientEvidence.count +
        account.operationalExceptions.monitoringFailures.count,
      0,
    ),
    detectedSignalCount:
      usableAccounts.length === 0
        ? null
        : usableAccounts.reduce(
            (total, account) => total + (account.detectedSignalCount ?? 0),
            0,
          ),
  };
}
