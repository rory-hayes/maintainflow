import "server-only";

import { randomUUID } from "node:crypto";

import {
  claimDueMonitoringRecords,
  listDueMonitoringAccountIds,
  recordMonitoringOutcome,
} from "../audit/approval-store.server";
import { getAdsApiKeyForAccount } from "../tenancy/store.server";
import type { AdsApiCredential } from "./client.server";
import { evaluateLiveMonitoringWindow } from "./monitoring.server";

export async function evaluateDueMonitoringWindows(options: {
  accountId: string;
  credential: AdsApiCredential;
  now?: Date;
  limit?: number;
}) {
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
          console.error(
            `Monitoring evaluation failed for approval ${record.id}`,
            error,
          );
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
  const now = options.now ?? new Date();
  const maxAccounts = Math.max(
    1,
    Math.min(20, Math.trunc(options.maxAccounts ?? 6)),
  );
  const windowsPerAccount = Math.max(
    1,
    Math.min(5, Math.trunc(options.windowsPerAccount ?? 3)),
  );
  const accountIds = await listDueMonitoringAccountIds(now, maxAccounts);
  const summary = {
    accountsSelected: accountIds.length,
    accountsProcessed: 0,
    accountsFailed: 0,
    due: 0,
    evaluated: 0,
    failed: 0,
  };

  for (let index = 0; index < accountIds.length; index += 2) {
    const results = await Promise.all(
      accountIds.slice(index, index + 2).map(async (accountId) => {
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
          return { ok: true as const, result };
        } catch (error) {
          console.error("Scheduled monitoring account evaluation failed", error);
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
