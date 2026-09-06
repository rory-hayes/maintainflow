import {
  changeIntegrityEventPageSchema,
  type ChangeIntegrityEventDto,
  type ChangeIntegrityEventPage,
} from "./change-integrity-schema";
import type { AdAccount, Campaign, ScopedAd } from "./schema";

const BASELINE_AT = "2026-09-02T08:00:00.000Z";
const BASELINE_STARTED_AT = "2026-09-02T07:59:30.000Z";
const CHECKED_AT = "2026-09-02T09:15:00.000Z";

function fingerprint(character: string) {
  return character.repeat(64);
}

function campaignBudgetMicros(campaign: Campaign) {
  return (
    campaign.budget.daily_spend_limit_micros ??
    campaign.budget.lifetime_spend_limit_micros ??
    25_000_000
  );
}

export function buildSimulatedChangeIntegrityEventPage(input: {
  account: AdAccount;
  campaigns: Campaign[];
  ads: ScopedAd[];
}): ChangeIntegrityEventPage {
  const campaign = input.campaigns[0];
  const ad = input.ads[0];
  const events: ChangeIntegrityEventDto[] = [];

  if (campaign) {
    const currentBudget = campaignBudgetMicros(campaign);
    events.push({
      id: "00000000-0000-4000-8000-000000000301",
      resourceType: "campaign",
      resourceId: campaign.id,
      parentResourceId: input.account.id,
      resourceLabel: campaign.name,
      providerUpdatedAt: campaign.updated_at,
      changeType: "updated",
      classification: "unexplained",
      previousFingerprint: fingerprint("1"),
      currentFingerprint: fingerprint("2"),
      previousConfiguration: {
        budget: { daily_spend_limit_micros: Math.round(currentBudget * 0.7) },
      },
      currentConfiguration: {
        budget: { daily_spend_limit_micros: currentBudget },
      },
      changedFieldPaths: ["budget.daily_spend_limit_micros"],
      explainedFieldPaths: [],
      indeterminateFieldPaths: [],
      unexplainedFieldPaths: ["budget.daily_spend_limit_micros"],
      matchedOperations: [],
      baselineObservationStartedAt: BASELINE_STARTED_AT,
      baselineObservedAt: BASELINE_AT,
      detectionStartedAt: "2026-09-02T08:44:30.000Z",
      detectedAt: "2026-09-02T08:45:00.000Z",
      reviewStatus: "open",
      reviewedByName: null,
      reviewNote: null,
      reviewedAt: null,
    });
  }

  if (ad) {
    events.push({
      id: "00000000-0000-4000-8000-000000000302",
      resourceType: "ad",
      resourceId: ad.id,
      parentResourceId: ad.ad_group_id,
      resourceLabel: ad.name,
      providerUpdatedAt: ad.updated_at,
      changeType: "updated",
      classification: "indeterminate",
      previousFingerprint: fingerprint("3"),
      currentFingerprint: fingerprint("4"),
      previousConfiguration: { status: ad.status === "paused" ? "active" : "paused" },
      currentConfiguration: { status: ad.status },
      changedFieldPaths: ["status"],
      explainedFieldPaths: [],
      indeterminateFieldPaths: ["status"],
      unexplainedFieldPaths: [],
      matchedOperations: [
        {
          approvalId: "00000000-0000-4000-8000-000000000401",
          resourceType: "ad",
          resourceId: ad.id,
          mode: "apply",
          certainty: "indeterminate",
          uncertaintyReason: "provider_outcome",
          occurredAt: "2026-09-02T09:00:00.000Z",
          expectedState: { status: ad.status },
        },
      ],
      baselineObservationStartedAt: BASELINE_STARTED_AT,
      baselineObservedAt: BASELINE_AT,
      detectionStartedAt: "2026-09-02T09:04:30.000Z",
      detectedAt: "2026-09-02T09:05:00.000Z",
      reviewStatus: "open",
      reviewedByName: null,
      reviewNote: null,
      reviewedAt: null,
    });

    events.push({
      id: "00000000-0000-4000-8000-000000000303",
      resourceType: "ad",
      resourceId: ad.id,
      parentResourceId: ad.ad_group_id,
      resourceLabel: ad.name,
      providerUpdatedAt: ad.updated_at,
      changeType: "updated",
      classification: "maintainflow_consistent",
      previousFingerprint: fingerprint("5"),
      currentFingerprint: fingerprint("6"),
      previousConfiguration: {
        creative: { title: `${ad.creative.title} — previous` },
      },
      currentConfiguration: { creative: { title: ad.creative.title } },
      changedFieldPaths: ["creative.title"],
      explainedFieldPaths: ["creative.title"],
      indeterminateFieldPaths: [],
      unexplainedFieldPaths: [],
      matchedOperations: [
        {
          approvalId: "00000000-0000-4000-8000-000000000402",
          resourceType: "ad",
          resourceId: ad.id,
          mode: "apply",
          certainty: "confirmed",
          uncertaintyReason: null,
          occurredAt: "2026-09-02T09:10:00.000Z",
          expectedState: { creative: { title: ad.creative.title } },
        },
      ],
      baselineObservationStartedAt: BASELINE_STARTED_AT,
      baselineObservedAt: BASELINE_AT,
      detectionStartedAt: "2026-09-02T09:14:30.000Z",
      detectedAt: CHECKED_AT,
      reviewStatus: "not_required",
      reviewedByName: null,
      reviewNote: null,
      reviewedAt: null,
    });
  }

  const openUnexplainedCount = events.filter(
    (event) =>
      event.classification === "unexplained" && event.reviewStatus === "open",
  ).length;
  const openIndeterminateCount = events.filter(
    (event) =>
      event.classification === "indeterminate" && event.reviewStatus === "open",
  ).length;

  return changeIntegrityEventPageSchema.parse({
    events: events.sort(
      (left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt),
    ),
    hasMore: false,
    summary: {
      baselineReady: true,
      lastCheckedAt: CHECKED_AT,
      retainedEventCount: events.length,
      openUnexplainedCount,
      openIndeterminateCount,
      consistentCount: events.filter(
        (event) => event.classification === "maintainflow_consistent",
      ).length,
      reviewedCount: events.filter((event) => event.reviewStatus === "reviewed")
        .length,
    },
  });
}
