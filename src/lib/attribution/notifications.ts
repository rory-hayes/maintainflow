export type NotificationPreferences = { health: boolean; weekly: boolean };
export type NotificationStatus = NotificationPreferences & {
  available: boolean;
  canEnable: boolean;
  recipient: string | null;
  status: "off" | "scheduled" | "retrying" | "needs_review";
  acceptedAt?: string;
};

// Private persisted data. Never include in workspace responses or exports.
export type NotificationSubscription = NotificationPreferences & {
  userId: string;
  email: string;
  version: string;
  unsubscribeToken: string;
  weeklyDueAt: number;
  healthFingerprint: string;
  acceptedAt?: string;
  pending?: {
    id: string;
    kind: "health" | "weekly";
    fingerprint: string;
    through: number;
    payload: { from: string; to: string; subject: string; text: string };
    firstAttemptAt: number;
    nextAttemptAt: number;
    attempts: number;
    leaseToken?: string;
    leaseUntil?: number;
    needsReview?: boolean;
  };
};
