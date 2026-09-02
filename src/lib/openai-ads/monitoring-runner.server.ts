import "server-only";

import { randomUUID } from "node:crypto";

import {
  claimDueMonitoringAccounts,
  claimDueMonitoringRecords,
  completeMonitoringAccountAttempt,
  recordMonitoringOutcome,
  releaseMonitoringAccountAttempt,
  releaseMonitoringClaim,
} from "../audit/approval-store.server";
import { createServerLogger } from "../observability/logger.server";
import { getAdsApiKeyForAccount } from "../tenancy/store.server";
import type {
  AdsApiCredential,
  AdsProviderRequestBudget,
} from "./client.server";
import { evaluateLiveMonitoringWindow } from "./monitoring.server";

const MAX_REPORTED_SELECTED_BACKLOG = 10_000;
const MAX_REPORTED_BACKLOG_AGE_SECONDS = 365 * 24 * 60 * 60;
const MINIMUM_PROVIDER_START_BUDGET_MS = 2_000;

export class MonitoringRunDeadlineExceededError extends Error {
  constructor() {
    super("The scheduled monitoring run reached its bounded provider deadline.");
    this.name = "MonitoringRunDeadlineExceededError";
  }
}

class MonitoringProviderRequestBudget implements AdsProviderRequestBudget {
  readonly #controller = new AbortController();
  readonly #deadlineTimer: ReturnType<typeof setTimeout>;

  constructor(deadlineAt: number, clock: () => number) {
    const remainingMs = Math.max(0, deadlineAt - clock());
    this.#deadlineTimer = setTimeout(() => {
      this.#controller.abort(new MonitoringRunDeadlineExceededError());
    }, remainingMs);
    this.#deadlineTimer.unref?.();
    if (remainingMs === 0) {
      this.#controller.abort(new MonitoringRunDeadlineExceededError());
    }
  }

  get signal() {
    return this.#controller.signal;
  }

  async runRequest<T>(request: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      throw this.signal.reason ?? new MonitoringRunDeadlineExceededError();
    }
    return request();
  }

  dispose() {
    clearTimeout(this.#deadlineTimer);
  }
}

function hasProviderStartBudget(
  deadlineAt: number | undefined,
  clock: () => number,
) {
  return (
    deadlineAt === undefined ||
    deadlineAt - clock() >= MINIMUM_PROVIDER_START_BUDGET_MS
  );
}

function emptyScheduledMonitoringSummary(deadlineExhausted = false) {
  return {
    accountsSelected: 0,
    accountsProcessed: 0,
    accountsFailed: 0,
    due: 0,
    evaluated: 0,
    failed: 0,
    selectedBacklogDueCount: 0,
    selectedBacklogDueCountCapped: false,
    oldestSelectedBacklogAgeSeconds: 0,
    oldestSelectedBacklogAgeCapped: false,
    deadlineExhausted,
  };
}

export async function evaluateDueMonitoringWindows(options: {
  accountId: string;
  credential: AdsApiCredential;
  now?: Date;
  limit?: number;
  providerBudget?: AdsProviderRequestBudget;
}) {
  const log = createServerLogger("monitoring.runner");
  const now = options.now ?? new Date();
  const claimId = randomUUID();
  const dueRecords = await claimDueMonitoringRecords({
    accountId: options.accountId,
    claimId,
    now,
    limit: options.limit ?? 3,
  });
  let evaluated = 0;
  let failed = 0;

  for (let index = 0; index < dueRecords.length; index += 3) {
    const results = await Promise.all(
      dueRecords.slice(index, index + 3).map(async (record) => {
        if (
          !record.monitoringPlan ||
          !record.monitoringStartedAt ||
          !record.monitoringEndsAt
        ) {
          return "failed" as const;
        }

        try {
          const result = await evaluateLiveMonitoringWindow({
            entityId: record.entityId,
            plan: record.monitoringPlan,
            startedAt: record.monitoringStartedAt,
            endsAt: record.monitoringEndsAt,
            credential: options.credential,
            providerBudget: options.providerBudget,
          });
          const recorded = await recordMonitoringOutcome({
            id: record.id,
            accountId: options.accountId,
            outcome: result.outcome,
            observation: result.observation,
            claimId,
            evaluatedAt: now,
          });
          return recorded ? ("evaluated" as const) : ("unchanged" as const);
        } catch (error) {
          log.error("monitoring.evaluation.failed", { error });
          try {
            const released = await releaseMonitoringClaim({
              id: record.id,
              accountId: options.accountId,
              claimId,
            });
            if (!released) {
              log.warn("monitoring.claim_release.unconfirmed");
            }
          } catch (releaseError) {
            log.error("monitoring.claim_release.failed", {
              error: releaseError,
            });
          }
          return "failed" as const;
        }
      }),
    );
    for (const result of results) {
      if (result === "evaluated") evaluated += 1;
      if (result === "failed") failed += 1;
    }
  }

  return { due: dueRecords.length, evaluated, failed };
}

export async function evaluateScheduledMonitoringWindows(options: {
  now?: Date;
  maxAccounts?: number;
  windowsPerAccount?: number;
  deadlineAt?: number;
  clock?: () => number;
} = {}) {
  const log = createServerLogger("monitoring.runner");
  const now = options.now ?? new Date();
  const clock = options.clock ?? Date.now;
  const maxAccounts = Math.max(
    1,
    Math.min(20, Math.trunc(options.maxAccounts ?? 6)),
  );
  const windowsPerAccount = Math.max(
    1,
    Math.min(5, Math.trunc(options.windowsPerAccount ?? 3)),
  );
  if (!hasProviderStartBudget(options.deadlineAt, clock)) {
    return emptyScheduledMonitoringSummary(true);
  }
  const attemptId = randomUUID();
  const dueAccounts = await claimDueMonitoringAccounts({
    attemptId,
    now,
    limit: maxAccounts,
  });
  const rawSelectedBacklog = dueAccounts.reduce(
    (total, account) => total + account.dueCount,
    0,
  );
  const rawOldestBacklogAgeSeconds = dueAccounts.reduce((oldest, account) => {
    const ageSeconds = Math.max(
      0,
      Math.floor((now.getTime() - account.oldestDueAt.getTime()) / 1_000),
    );
    return Math.max(oldest, ageSeconds);
  }, 0);
  const summary = {
    accountsSelected: dueAccounts.length,
    accountsProcessed: 0,
    accountsFailed: 0,
    due: 0,
    evaluated: 0,
    failed: 0,
    selectedBacklogDueCount: Math.min(
      MAX_REPORTED_SELECTED_BACKLOG,
      rawSelectedBacklog,
    ),
    selectedBacklogDueCountCapped:
      rawSelectedBacklog > MAX_REPORTED_SELECTED_BACKLOG,
    oldestSelectedBacklogAgeSeconds: Math.min(
      MAX_REPORTED_BACKLOG_AGE_SECONDS,
      rawOldestBacklogAgeSeconds,
    ),
    oldestSelectedBacklogAgeCapped:
      rawOldestBacklogAgeSeconds > MAX_REPORTED_BACKLOG_AGE_SECONDS,
    deadlineExhausted: false,
  };

  const providerBudget =
    options.deadlineAt === undefined
      ? undefined
      : new MonitoringProviderRequestBudget(options.deadlineAt, clock);

  try {
    for (let index = 0; index < dueAccounts.length; index += 2) {
      const accountBatch = dueAccounts.slice(index, index + 2);
      if (!hasProviderStartBudget(options.deadlineAt, clock)) {
        summary.deadlineExhausted = true;
        const releases = await Promise.allSettled(
          accountBatch.map(({ accountId, attemptId: accountAttemptId }) =>
            releaseMonitoringAccountAttempt({
              accountId,
              attemptId: accountAttemptId,
              now,
            }),
          ),
        );
        summary.accountsFailed += accountBatch.length;
        if (
          releases.some(
            (release) =>
              release.status === "rejected" || release.value !== true,
          )
        ) {
          log.error("monitoring.account_attempt_release.failed", {
            error: new Error(
              "A deadline-expired monitoring account claim could not be released.",
            ),
          });
        }
        continue;
      }
      const results = await Promise.all(
        accountBatch.map(async ({ accountId, attemptId: accountAttemptId }) => {
          let attemptCompleted = false;
          try {
            if (!hasProviderStartBudget(options.deadlineAt, clock)) {
              throw new MonitoringRunDeadlineExceededError();
            }
            const apiKey = await getAdsApiKeyForAccount(accountId);
            const result = await evaluateDueMonitoringWindows({
              accountId,
              credential: {
                kind: "account_api_key",
                secret: apiKey,
                expectedAccountId: accountId,
              },
              now,
              limit: windowsPerAccount,
              providerBudget,
            });
            if (providerBudget?.signal.aborted) {
              throw (
                providerBudget.signal.reason ??
                new MonitoringRunDeadlineExceededError()
              );
            }
            const recorded = await completeMonitoringAccountAttempt({
              accountId,
              attemptId: accountAttemptId,
              succeeded: result.failed === 0,
              now,
            });
            if (!recorded) {
              throw new Error(
                "The selected monitoring account attempt was no longer current.",
              );
            }
            attemptCompleted = true;
            return { ok: true as const, result };
          } catch (error) {
            if (!attemptCompleted) {
              try {
                const recorded = providerBudget?.signal.aborted
                  ? await releaseMonitoringAccountAttempt({
                      accountId,
                      attemptId: accountAttemptId,
                      now,
                    })
                  : await completeMonitoringAccountAttempt({
                      accountId,
                      attemptId: accountAttemptId,
                      succeeded: false,
                      now,
                    });
                if (!recorded) {
                  log.warn("monitoring.account_attempt_release.unconfirmed");
                }
              } catch (completionError) {
                log.error("monitoring.account_attempt_release.failed", {
                  error: completionError,
                });
              }
            }
            log.error("monitoring.account_evaluation.failed", { error });
            return { ok: false as const };
          }
        }),
      );
      for (const result of results) {
        if (!result.ok) {
          summary.accountsFailed += 1;
          continue;
        }
        summary.accountsProcessed += 1;
        summary.due += result.result.due;
        summary.evaluated += result.result.evaluated;
        summary.failed += result.result.failed;
      }
    }
    if (providerBudget?.signal.aborted) {
      summary.deadlineExhausted = true;
    }
  } finally {
    providerBudget?.dispose();
  }

  return summary;
}
