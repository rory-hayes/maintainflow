export type LivePortfolioEvidenceState =
  | "confirmed_fresh"
  | "confirmed_stale"
  | "confirmed_expired"
  | "not_confirmed"
  | "refresh_required"
  | "invalid";

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
};

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
    detectedSignalCount:
      usableAccounts.length === 0
        ? null
        : usableAccounts.reduce(
            (total, account) => total + (account.detectedSignalCount ?? 0),
            0,
          ),
  };
}
