import { describe, expect, it } from "vitest";

import {
  READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION,
  READINESS_HISTORY_RULESET_VERSION,
  READINESS_HISTORY_SCANNER_VERSION,
  READINESS_HISTORY_SOURCE_CHECKED_AT,
} from "../readiness/history";
import { createSampleStorefrontAudit } from "../readiness/demo-audit";
import {
  buildLivePortfolioActionQueue,
  buildSimulatedPortfolioActionQueue,
  rankPortfolioActionItems,
  summarizePortfolioActionQueue,
  type PortfolioActionItem,
} from "./action-queue";
import { buildConversionMeasurementReadiness } from "./measurement-readiness";
import {
  listAgencySimulatedWorkspaces,
  resolveSimulatedWorkspace,
} from "./simulated-workspaces";
import type { LivePortfolioAccount } from "./live-portfolio";
import { buildSimulatedChangeIntegrityEventPage } from "./change-integrity-demo";
import type { ChangeIntegrityEventDto } from "./change-integrity-schema";

function action(
  id: string,
  overrides: Partial<PortfolioActionItem> = {},
): PortfolioActionItem {
  return {
    id,
    source: "live",
    accountId: "adacct_one",
    accountName: "Account One",
    category: "evidence",
    severity: "critical",
    title: id,
    detail: "Evidence-backed action",
    evidenceLabel: "Test evidence",
    evidenceAt: "2026-09-03T12:00:00.000Z",
    freshness: "current",
    deliveryImpact: "unknown",
    moneyAtRisk: {
      state: "unknown",
      reason: "Amount unavailable",
    },
    occurrenceCount: 1,
    targetTab: "review",
    ...overrides,
  };
}

function compactLiveAccount(
  overrides: Partial<LivePortfolioAccount> = {},
): LivePortfolioAccount {
  return {
    accountId: "adacct_one",
    accountName: "Account One",
    hasConfirmedSnapshot: true,
    detectedSignalCount: 0,
    evidenceState: "confirmed_fresh",
    evidenceAt: "2026-09-03T12:00:00.000Z",
    operationalExceptions: {
      changeIntegrityUnexplained: { count: 0, oldestAt: null },
      changeIntegrityIndeterminate: { count: 0, oldestAt: null },
      safeguardTriggered: { count: 0, oldestAt: null },
      insufficientEvidence: { count: 0, oldestAt: null },
      monitoringFailures: { count: 0, oldestAt: null },
      reconciliationRequired: { count: 0, oldestAt: null },
    },
    ...overrides,
  };
}

describe("portfolio action queue", () => {
  it("uses a deterministic evidence-first ranking without letting a lower severity buy priority", () => {
    const ranked = rankPortfolioActionItems([
      action("high-known", {
        severity: "high",
        moneyAtRisk: {
          state: "known",
          amountMicros: 9_000_000_000,
          currencyCode: "EUR",
          basis: "Confirmed exposure",
        },
      }),
      action("critical-unknown-stale", { freshness: "stale" }),
      action("critical-unknown-current", {
        deliveryImpact: "unknown",
      }),
      action("critical-unknown-blocked", {
        deliveryImpact: "blocked",
      }),
      action("critical-known", {
        moneyAtRisk: {
          state: "known",
          amountMicros: 100_000_000,
          currencyCode: "EUR",
          basis: "Confirmed exposure",
        },
      }),
    ]);

    expect(ranked.map((item) => item.id)).toEqual([
      "critical-known",
      "critical-unknown-blocked",
      "critical-unknown-current",
      "critical-unknown-stale",
      "high-known",
    ]);
  });

  it("groups different currencies without conversion and stays permutation-invariant", () => {
    const eurHigh = action("eur-high", {
      accountName: "Zulu",
      moneyAtRisk: {
        state: "known",
        amountMicros: 100_000_000,
        currencyCode: "EUR",
        basis: "Projected overspend",
      },
    });
    const usdMid = action("usd-mid", {
      accountName: "Mike",
      moneyAtRisk: {
        state: "known",
        amountMicros: 50_000_000,
        currencyCode: "USD",
        basis: "Projected overspend",
      },
    });
    const eurLow = action("eur-low", {
      accountName: "Alpha",
      moneyAtRisk: {
        state: "known",
        amountMicros: 1_000_000,
        currencyCode: "EUR",
        basis: "Projected overspend",
      },
    });
    const permutations = [
      [eurHigh, usdMid, eurLow],
      [eurHigh, eurLow, usdMid],
      [usdMid, eurHigh, eurLow],
      [usdMid, eurLow, eurHigh],
      [eurLow, eurHigh, usdMid],
      [eurLow, usdMid, eurHigh],
    ];

    expect(
      new Set(
        permutations.map((items) =>
          rankPortfolioActionItems(items)
            .map((item) => item.id)
            .join(","),
        ),
      ),
    ).toEqual(new Set(["eur-high,eur-low,usd-mid"]));
  });

  it("turns all five agency fixtures into one queue using existing detectors", () => {
    const queue = buildSimulatedPortfolioActionQueue(
      listAgencySimulatedWorkspaces(),
    );
    const categories = new Set(queue.map((item) => item.category));

    expect(new Set(queue.map((item) => item.accountId)).size).toBe(5);
    expect(categories).toEqual(
      new Set([
        "budget_pacing",
        "change_integrity",
        "creative_delivery",
        "recommendation",
        "tracking_template",
        "reconciliation",
      ]),
    );
    expect(queue.every((item) => item.source === "simulator")).toBe(true);
    expect(
      queue.filter((item) => item.category === "reconciliation"),
    ).toHaveLength(5);
    expect(
      queue.some(
        (item) =>
          item.category === "budget_pacing" &&
          item.moneyAtRisk.state === "known" &&
          item.moneyAtRisk.currencyCode === "EUR",
      ),
    ).toBe(true);
    expect(
      queue.some((item) => item.moneyAtRisk.state === "unknown"),
    ).toBe(true);
    expect(
      queue.some(
        (item) =>
          item.category === "change_integrity" &&
          item.title.startsWith("Review unexplained change") &&
          item.detail.includes("does not identify who made the change"),
      ),
    ).toBe(true);
    expect(queue[0]?.severity).toBe("critical");
  });

  it("surfaces compact integrity exceptions for every live client account", () => {
    const queue = buildLivePortfolioActionQueue([
      compactLiveAccount({
        accountId: "adacct_integrity",
        operationalExceptions: {
          ...compactLiveAccount().operationalExceptions,
          changeIntegrityUnexplained: {
            count: 2,
            oldestAt: "2026-09-03T08:00:00.000Z",
          },
          changeIntegrityIndeterminate: {
            count: 1,
            oldestAt: "2026-09-03T09:00:00.000Z",
          },
        },
      }),
    ]);

    const integrityActions = queue.filter(
      (item) => item.category === "change_integrity",
    );
    expect(integrityActions).toEqual([
      expect.objectContaining({
        severity: "high",
        occurrenceCount: 2,
        targetTab: "experiments",
      }),
      expect.objectContaining({
        severity: "medium",
        title: "Review indeterminate change evidence (1)",
        occurrenceCount: 1,
        targetTab: "experiments",
      }),
    ]);
    expect(integrityActions[1]?.detail).toContain("At detection time");
    expect(integrityActions[1]?.detail).toContain("snapshot timing was ambiguous");
    expect(integrityActions[1]?.detail).toContain(
      "operation outcome was not confirmed",
    );
    expect(integrityActions[1]?.detail).not.toContain("remains uncertain");
  });

  it("describes expanded indeterminate evidence at its historical detection time", () => {
    const indeterminateEvent = {
      id: "00000000-0000-4000-8000-000000000601",
      resourceType: "ad",
      resourceId: "ad_integrity_copy",
      parentResourceId: "adgrp_integrity_copy",
      resourceLabel: "Storage proof point",
      providerUpdatedAt: null,
      changeType: "updated",
      classification: "indeterminate",
      previousFingerprint: "1".repeat(64),
      currentFingerprint: "2".repeat(64),
      previousConfiguration: { status: "active" },
      currentConfiguration: { status: "paused" },
      changedFieldPaths: ["status"],
      explainedFieldPaths: [],
      indeterminateFieldPaths: ["status"],
      unexplainedFieldPaths: [],
      matchedOperations: [
        {
          approvalId: "00000000-0000-4000-8000-000000000602",
          resourceType: "ad",
          resourceId: "ad_integrity_copy",
          mode: "apply",
          certainty: "indeterminate",
          uncertaintyReason: "snapshot_timing",
          occurredAt: "2026-09-03T08:12:00.000Z",
          expectedState: { status: "paused" },
        },
      ],
      baselineObservationStartedAt: "2026-09-03T08:00:00.000Z",
      baselineObservedAt: "2026-09-03T08:05:00.000Z",
      detectionStartedAt: "2026-09-03T08:10:00.000Z",
      detectedAt: "2026-09-03T08:15:00.000Z",
      reviewStatus: "open",
      reviewedByName: null,
      reviewNote: null,
      reviewedAt: null,
    } satisfies ChangeIntegrityEventDto;
    const [integrityAction] = buildLivePortfolioActionQueue([], {
      accountId: "adacct_integrity_copy",
      accountName: "Integrity Copy Account",
      currencyCode: "EUR",
      campaigns: [],
      ads: [],
      budgetGuardEvidence: [],
      recommendations: [],
      changeIntegrityEvents: [indeterminateEvent],
      snapshotAt: "2026-09-03T08:15:00.000Z",
      snapshotFreshness: "current",
    }).filter((item) => item.category === "change_integrity");

    expect(integrityAction?.title).toBe(
      "Review indeterminate change evidence for Storage proof point",
    );
    expect(integrityAction?.detail).toContain(
      "indeterminate retained evidence at detection time",
    );
    expect(integrityAction?.detail).toContain(
      "overlapped the provider-read interval",
    );
    expect(integrityAction?.detail).toContain(
      "snapshot ordering was not proven",
    );
    expect(integrityAction?.detail).not.toContain("no confirmed provider outcome");
    expect(integrityAction?.detail).not.toContain("remains uncertain");
  });

  it("keeps an aggregate remainder when expanded integrity evidence is paginated", () => {
    const selected = resolveSimulatedWorkspace("adacct_sim_northstar");
    const template = buildSimulatedChangeIntegrityEventPage({
      account: selected.account,
      campaigns: selected.campaigns,
      ads: selected.ads,
    }).events.find((item) => item.classification === "unexplained")!;
    const visibleEvents = Array.from({ length: 50 }, (_, index) => ({
      ...template,
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    }));
    const queue = buildLivePortfolioActionQueue(
      [
        compactLiveAccount({
          accountId: selected.account.id,
          accountName: selected.account.name,
          operationalExceptions: {
            ...compactLiveAccount().operationalExceptions,
            changeIntegrityUnexplained: {
              count: 51,
              oldestAt: "2026-09-01T08:00:00.000Z",
            },
          },
        }),
      ],
      {
        accountId: selected.account.id,
        accountName: selected.account.name,
        currencyCode: selected.account.currency_code,
        campaigns: selected.campaigns,
        ads: selected.ads,
        budgetGuardEvidence: [],
        recommendations: [],
        changeIntegrityEvents: visibleEvents,
        snapshotAt: "2026-09-03T12:00:00.000Z",
        snapshotFreshness: "current",
      },
    );

    const integrity = queue.filter((item) => item.category === "change_integrity");
    expect(integrity).toHaveLength(51);
    expect(integrity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `${selected.account.id}:live:changeIntegrityUnexplained`,
          title: "Review unexplained configuration changes (1)",
          occurrenceCount: 1,
        }),
      ]),
    );
  });

  it("describes only the unresolved fields in a mixed integrity event", () => {
    const selected = resolveSimulatedWorkspace("adacct_sim_northstar");
    const template = buildSimulatedChangeIntegrityEventPage({
      account: selected.account,
      campaigns: selected.campaigns,
      ads: selected.ads,
    }).events.find((item) => item.classification === "unexplained")!;
    const [integrity] = buildLivePortfolioActionQueue([], {
      accountId: selected.account.id,
      accountName: selected.account.name,
      currencyCode: selected.account.currency_code,
      campaigns: [],
      ads: [],
      budgetGuardEvidence: [],
      recommendations: [],
      changeIntegrityEvents: [
        {
          ...template,
          changedFieldPaths: ["budget.daily_spend_limit_micros", "status"],
          explainedFieldPaths: ["status"],
          unexplainedFieldPaths: ["budget.daily_spend_limit_micros"],
        },
      ],
      snapshotAt: "2026-09-03T12:00:00.000Z",
      snapshotFreshness: "current",
    }).filter((item) => item.category === "change_integrity");

    expect(integrity?.detail).toContain("1 of 2 material changed fields");
    expect(integrity?.detail).toContain(
      "unambiguous latest recorded operation evidence",
    );
    expect(integrity?.detail).toContain(
      "conflicting tied values remain unexplained",
    );
  });

  it("keeps missing live evidence unknown and expands only the selected account's detailed snapshot", () => {
    const selected = resolveSimulatedWorkspace("adacct_sim_northstar");
    const conversionMeasurement = buildConversionMeasurementReadiness({
      campaigns: selected.campaigns,
      eventSettings: [],
      checkedAt: "2026-09-03T12:00:00.000Z",
    });
    const readinessAudit = createSampleStorefrontAudit(
      new Date("2026-09-03T11:00:00.000Z"),
    );
    const queue = buildLivePortfolioActionQueue(
      [
        compactLiveAccount({
          accountId: selected.account.id,
          accountName: selected.account.name,
          detectedSignalCount: selected.recommendations.length,
        }),
        compactLiveAccount({
          accountId: "adacct_missing",
          accountName: "Missing Client",
          hasConfirmedSnapshot: false,
          detectedSignalCount: null,
          evidenceState: "not_confirmed",
          evidenceAt: null,
          operationalExceptions: {
            changeIntegrityUnexplained: { count: 0, oldestAt: null },
            changeIntegrityIndeterminate: { count: 0, oldestAt: null },
            safeguardTriggered: { count: 0, oldestAt: null },
            insufficientEvidence: { count: 0, oldestAt: null },
            monitoringFailures: { count: 0, oldestAt: null },
            reconciliationRequired: {
              count: 1,
              oldestAt: "2026-09-02T09:00:00.000Z",
            },
          },
        }),
        compactLiveAccount({
          accountId: "adacct_other",
          accountName: "Other Client",
          detectedSignalCount: 2,
        }),
      ],
      {
        accountId: selected.account.id,
        accountName: selected.account.name,
        currencyCode: selected.account.currency_code,
        campaigns: selected.campaigns,
        ads: selected.ads,
        budgetGuardEvidence: selected.budgetGuardEvidence.map((item) => ({
          ...item,
          source: "live" as const,
        })),
        recommendations: selected.recommendations.map((item) => ({
          ...item,
          source: "live" as const,
        })),
        snapshotAt: "2026-09-03T12:00:00.000Z",
        snapshotFreshness: "current",
        conversionMeasurement,
        readinessHistory: [
          {
            id: "00000000-0000-4000-8000-000000009001",
            accountId: selected.account.id,
            audit: readinessAudit,
            payloadSchemaVersion: READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION,
            rulesetVersion: READINESS_HISTORY_RULESET_VERSION,
            scannerVersion: READINESS_HISTORY_SCANNER_VERSION,
            sourceCheckedAt: READINESS_HISTORY_SOURCE_CHECKED_AT,
            targetAssociation: {
              type: "manual_unverified",
              providerResourceType: null,
              providerResourceId: null,
            },
            queryParametersRedacted: false,
            recordedAt: readinessAudit.scannedAt,
          },
        ],
      },
    );

    expect(queue).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "adacct_missing",
          category: "reconciliation",
          severity: "critical",
          moneyAtRisk: expect.objectContaining({ state: "unknown" }),
        }),
        expect.objectContaining({
          accountId: "adacct_missing",
          category: "evidence",
          evidenceLabel: "Detected signals unknown",
        }),
        expect.objectContaining({
          accountId: "adacct_other",
          category: "recommendation",
          occurrenceCount: 2,
        }),
        expect.objectContaining({
          accountId: selected.account.id,
          category: "measurement",
        }),
        expect.objectContaining({
          accountId: selected.account.id,
          category: "site_readiness",
        }),
      ]),
    );
    expect(
      queue.filter(
        (item) =>
          item.accountId === selected.account.id &&
          item.id.endsWith("detected-signals"),
      ),
    ).toHaveLength(0);
    expect(queue.some((item) => item.moneyAtRisk.state === "unknown")).toBe(
      true,
    );
  });

  it("sums only known money within its original currency", () => {
    const summary = summarizePortfolioActionQueue([
      action("eur-one", {
        moneyAtRisk: {
          state: "known",
          amountMicros: 10_000_000,
          currencyCode: "EUR",
          basis: "Confirmed exposure",
        },
      }),
      action("eur-two", {
        moneyAtRisk: {
          state: "known",
          amountMicros: 5_000_000,
          currencyCode: "EUR",
          basis: "Confirmed exposure",
        },
      }),
      action("unknown"),
    ]);

    expect(summary.knownMoneyByCurrency).toEqual([
      { currencyCode: "EUR", amountMicros: 15_000_000 },
    ]);
    expect(summary.unknownMoneyCount).toBe(1);
    expect(summary.urgentCount).toBe(3);
  });
});
