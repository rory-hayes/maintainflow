import "server-only";

import { randomUUID } from "node:crypto";

import {
  claimDueMonitoringAccounts,
  claimDueMonitoringRecords,
  completeMonitoringAccountAttempt,
  recordMonitoringOutcome,
  releaseMonitoringClaim,
} from "../audit/approval-store.server";
import { createServerLogger } from "../observability/logger.server";
import { getAdsApiKeyForAccount } from "../tenancy/store.server";
import type { AdsApiCredential } from "./client.server";
import { evaluateLiveMonitoringWindow } from "./monitoring.server";

const MAX_REPORTED_SELECTED_BACKLOG = 10_000;
const MAX_REPORTED_BACKLOG_AGE_SECONDS = 365 * 24 * 60 * 60;

export async function evaluateDueMonitoringWindows(options: {
  accountId: string;
  credential: AdsApiCredential;
  now?: Date;
  limit?: number;
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
} = {}) {
  const log = createServerLogger("monitoring.runner");
  const now = options.now ?? new Date();
  const maxAccounts = Math.max(
    1,
    Math.min(20, Math.trunc(options.maxAccounts ?? 6)),
  );
  const windowsPerAccount = Math.max(
    1,
    Math.min(5, Math.trunc(options.windowsPerAccount ?? 3)),
  );
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
  };

  for (let index = 0; index < dueAccounts.length; index += 2) {
    const results = await Promise.all(
      dueAccounts
        .slice(index, index + 2)
        .map(async ({ accountId, attemptId: accountAttemptId }) => {
          let attemptCompleted = false;
          try {
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
            });
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
                const recorded = await completeMonitoringAccountAttempt({
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

  return summary;
}
