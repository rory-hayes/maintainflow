import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

import {
  ChangeIntegrityGuard,
  changeIntegrityFieldClassification,
  changeIntegrityOperationEvidenceSummary,
  changeIntegrityPageVersion,
  displayChangeIntegrityValue,
  shouldRefreshAfterChangeIntegrityReview,
} from "./change-integrity-guard";
import type {
  ChangeIntegrityEventDto,
  ChangeIntegrityEventPage,
} from "@/lib/openai-ads/change-integrity";

const event: ChangeIntegrityEventDto = {
  id: "00000000-0000-4000-8000-000000000201",
  resourceType: "ad_group",
  resourceId: "adgrp_201",
  parentResourceId: "cmpn_201",
  resourceLabel: "High-intent storage",
  providerUpdatedAt: 1_788_499_800,
  changeType: "updated",
  classification: "unexplained",
  previousFingerprint: "1".repeat(64),
  currentFingerprint: "2".repeat(64),
  previousConfiguration: {
    bidding_config: { max_bid_micros: 20_000_000 },
  },
  currentConfiguration: {
    bidding_config: { max_bid_micros: 30_000_000 },
  },
  changedFieldPaths: ["bidding_config.max_bid_micros"],
  explainedFieldPaths: [],
  indeterminateFieldPaths: [],
  unexplainedFieldPaths: ["bidding_config.max_bid_micros"],
  matchedOperations: [],
  baselineObservationStartedAt: "2026-09-04T07:55:00.000Z",
  baselineObservedAt: "2026-09-04T08:00:00.000Z",
  detectionStartedAt: "2026-09-04T08:05:00.000Z",
  detectedAt: "2026-09-04T08:10:00.000Z",
  reviewStatus: "open",
  reviewedByName: null,
  reviewNote: null,
  reviewedAt: null,
};

function page(overrides: Partial<ChangeIntegrityEventPage> = {}) {
  return {
    events: [event],
    hasMore: false,
    summary: {
      baselineReady: true,
      lastCheckedAt: event.detectedAt,
      retainedEventCount: 1,
      openUnexplainedCount: 1,
      openIndeterminateCount: 0,
      consistentCount: 0,
      reviewedCount: 0,
    },
    ...overrides,
  } satisfies ChangeIntegrityEventPage;
}

describe("ChangeIntegrityGuard", () => {
  it("refreshes server evidence only after a live review", () => {
    expect(shouldRefreshAfterChangeIntegrityReview("live")).toBe(true);
    expect(shouldRefreshAfterChangeIntegrityReview("simulator")).toBe(false);
  });

  it("describes retained operations as considered evidence that may conflict", () => {
    const summary = changeIntegrityOperationEvidenceSummary([
      {
        approvalId: "00000000-0000-4000-8000-000000000401",
        resourceType: "ad",
        resourceId: "ad_401",
        mode: "apply",
        certainty: "indeterminate",
        uncertaintyReason: "snapshot_timing",
        occurredAt: "2026-09-04T08:07:00.000Z",
        expectedState: { status: "paused" },
      },
      {
        approvalId: "00000000-0000-4000-8000-000000000402",
        resourceType: "ad",
        resourceId: "ad_401",
        mode: "apply",
        certainty: "indeterminate",
        uncertaintyReason: "provider_outcome",
        occurredAt: "2026-09-04T08:08:00.000Z",
        expectedState: { status: "paused" },
      },
    ]);

    expect(summary).toContain("operations were considered");
    expect(summary).toContain("may agree with or conflict");
    expect(summary).toContain("overlapped the provider-read interval");
    expect(summary).toContain("no confirmed provider outcome");
    expect(summary).toContain("indeterminate at detection time");
    expect(summary).not.toContain("matched at least one changed field");
  });

  it("shows actionable live evidence without claiming actor attribution", () => {
    const markup = renderToStaticMarkup(
      createElement(ChangeIntegrityGuard, {
        accountId: "adacct_live",
        currencyCode: "EUR",
        source: "live",
        initialPage: page(),
        freshness: "current",
        ready: true,
        canReview: true,
        operatorName: "Rory Hayes",
      }),
    );

    expect(markup).toContain("Change Integrity Guard");
    expect(markup).toContain("Live evidence");
    expect(markup).toContain("High-intent storage");
    expect(markup).toContain("Unexplained");
    expect(markup).toContain("Change detection, not actor attribution");
    expect(markup).toContain("This does not prove who made the change");
    expect(markup).toContain("ambiguous snapshot timing");
    expect(markup).toContain("operation outcome that was not confirmed then");
    expect(markup).toContain("Inspect");
    expect(markup).toContain("Open unexplained events");
    expect(markup).toContain(
      "lacks unambiguous latest recorded operation evidence",
    );
    expect(markup).toContain(
      "Equal-time latest operations count as unambiguous when their recorded values agree",
    );
    expect(markup).toContain("conflicting tied values remain unexplained");
  });

  it("states the baseline requirement instead of declaring an unknown account clean", () => {
    const markup = renderToStaticMarkup(
      createElement(ChangeIntegrityGuard, {
        accountId: "adacct_demo",
        currencyCode: "EUR",
        source: "simulator",
        initialPage: page({
          events: [],
          summary: {
            baselineReady: false,
            lastCheckedAt: null,
            retainedEventCount: 0,
            openUnexplainedCount: 0,
            openIndeterminateCount: 0,
            consistentCount: 0,
            reviewedCount: 0,
          },
        }),
        freshness: "current",
        ready: true,
        canReview: true,
        operatorName: "Demo operator",
      }),
    );

    expect(markup).toContain("Simulator evidence");
    expect(markup).toContain("Awaiting baseline");
    expect(markup).toContain("A fresh snapshot will establish the baseline");
    expect(markup).not.toContain("No material changes in retained evidence");
  });

  it("labels unavailable evidence without presenting a retained baseline as active", () => {
    const markup = renderToStaticMarkup(
      createElement(ChangeIntegrityGuard, {
        accountId: "adacct_live",
        currencyCode: "EUR",
        source: "live",
        initialPage: page(),
        freshness: "current",
        ready: false,
        error: "The integrity store is unavailable.",
        canReview: false,
        operatorName: "Rory Hayes",
      }),
    );

    expect(markup).toContain("Integrity evidence is unavailable");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("Guard active");
  });

  it("keeps retained evidence visible when the latest live comparison is unknown", () => {
    const markup = renderToStaticMarkup(
      createElement(ChangeIntegrityGuard, {
        accountId: "adacct_live",
        currencyCode: "EUR",
        source: "live",
        initialPage: page(),
        freshness: "unknown",
        ready: true,
        canReview: true,
        operatorName: "Rory Hayes",
      }),
    );

    expect(markup).toContain("Latest comparison status unavailable");
    expect(markup).toContain("Status unknown");
    expect(markup).toContain("High-intent storage");
    expect(markup).not.toContain("Guard active");
  });

  it("changes the remount version when same-account evidence advances", () => {
    const current = page();
    const advanced = page({
      summary: {
        ...current.summary,
        lastCheckedAt: "2026-09-04T08:20:00.000Z",
        retainedEventCount: 2,
        openUnexplainedCount: 2,
      },
      events: [
        event,
        {
          ...event,
          id: "00000000-0000-4000-8000-000000000202",
          detectedAt: "2026-09-04T08:20:00.000Z",
        },
      ],
    });
    const reviewed = page({
      events: [
        {
          ...event,
          reviewStatus: "reviewed",
          reviewedByName: "Rory Hayes",
          reviewNote: "Confirmed with the merchant change log.",
          reviewedAt: "2026-09-04T08:30:00.000Z",
        },
      ],
      summary: {
        ...current.summary,
        openUnexplainedCount: 0,
        reviewedCount: 1,
      },
    });

    expect(changeIntegrityPageVersion(advanced)).not.toBe(
      changeIntegrityPageVersion(current),
    );
    expect(changeIntegrityPageVersion(reviewed)).not.toBe(
      changeIntegrityPageVersion(current),
    );
  });

  it("renders provider money units in account currency", () => {
    const markup = renderToStaticMarkup(
      createElement(ChangeIntegrityGuard, {
        accountId: "adacct_live",
        currencyCode: "EUR",
        source: "live",
        initialPage: page(),
        freshness: "current",
        ready: true,
        canReview: true,
        operatorName: "Rory Hayes",
      }),
    );

    expect(markup).not.toContain("max bid micros");
    expect(
      displayChangeIntegrityValue(
        20_000_000,
        "bidding_config.max_bid_micros",
        "EUR",
      ),
    ).toContain("€20");
  });

  it("exposes field-level explanation states and live pagination", () => {
    expect(
      changeIntegrityFieldClassification(event, event.changedFieldPaths[0]!),
    ).toMatchObject({
      label: "No unambiguous explanation",
    });
    expect(
      changeIntegrityFieldClassification(
        {
          ...event,
          classification: "indeterminate",
          unexplainedFieldPaths: [],
          indeterminateFieldPaths: event.changedFieldPaths,
        },
        event.changedFieldPaths[0]!,
      ),
    ).toMatchObject({ label: "Indeterminate at detection" });

    const markup = renderToStaticMarkup(
      createElement(ChangeIntegrityGuard, {
        accountId: "adacct_live",
        currencyCode: "EUR",
        source: "live",
        initialPage: page({ hasMore: true }),
        freshness: "current",
        ready: true,
        canReview: true,
        operatorName: "Rory Hayes",
      }),
    );
    expect(markup).toContain("Open items are shown first");
    expect(markup).toContain("Load more events");
  });
});
