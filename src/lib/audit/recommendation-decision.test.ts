import { describe, expect, it } from "vitest";

import { demoRecommendations } from "../openai-ads/demo-data";
import {
  applyRecommendationDismissals,
  recommendationApprovalFingerprint,
  recommendationFingerprint,
  type RecommendationDismissal,
} from "./recommendation-decision";

const recommendation = demoRecommendations[0];

function dismissal(
  fingerprint = recommendationFingerprint(recommendation),
): RecommendationDismissal {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    accountId: "adacct_123",
    operatorId: "user_owner",
    organizationId: "00000000-0000-4000-8000-000000000011",
    membershipRole: "owner",
    accountRole: "owner",
    recommendationId: recommendation.id,
    recommendationTitle: recommendation.title,
    entityId: recommendation.entityId,
    fingerprint,
    reason: "Keep the current bid until the seasonal test completes.",
    dismissedAt: new Date("2026-08-30T13:00:00.000Z"),
  };
}

describe("recommendation dismissal decisions", () => {
  it("creates a stable fingerprint for the exact proposed change", () => {
    const reordered = {
      ...recommendation,
      mutation: {
        ...recommendation.mutation,
        body: recommendation.mutation.body
          ? Object.fromEntries(
              Object.entries(recommendation.mutation.body).reverse(),
            )
          : null,
      },
    };

    expect(recommendationFingerprint(reordered)).toBe(
      recommendationFingerprint(recommendation),
    );
  });

  it("binds approval consent to the displayed monitoring evidence", () => {
    const changedPlan = {
      ...recommendation,
      monitoringPlan: recommendation.monitoringPlan
        ? {
            ...recommendation.monitoringPlan,
            baseline: {
              ...recommendation.monitoringPlan.baseline,
              spend: recommendation.monitoringPlan.baseline.spend + 1,
            },
          }
        : undefined,
    };

    expect(recommendationFingerprint(changedPlan)).toBe(
      recommendationFingerprint(recommendation),
    );
    expect(recommendationApprovalFingerprint(changedPlan)).not.toBe(
      recommendationApprovalFingerprint(recommendation),
    );
  });

  it("marks only the matching ready recommendation as dismissed", () => {
    const [result] = applyRecommendationDismissals(
      [recommendation],
      [dismissal()],
    );

    expect(result).toMatchObject({
      status: "dismissed",
      dismissal: {
        reason: "Keep the current bid until the seasonal test completes.",
        dismissedAt: "2026-08-30T13:00:00.000Z",
      },
    });
  });

  it("resurfaces a materially changed action or priority", () => {
    const changedAction = {
      ...recommendation,
      mutation: {
        ...recommendation.mutation,
        body: { max_bid_micros: 123_000_000 },
      },
    };
    const changedPriority = {
      ...recommendation,
      priority: "medium" as const,
    };

    expect(
      applyRecommendationDismissals([changedAction], [dismissal()])[0].status,
    ).toBe("ready");
    expect(
      applyRecommendationDismissals([changedPriority], [dismissal()])[0]
        .status,
    ).toBe("ready");
  });

  it("never lets an older dismissal replace an active monitoring state", () => {
    const monitoring = { ...recommendation, status: "monitoring" as const };

    expect(
      applyRecommendationDismissals([monitoring], [dismissal()])[0].status,
    ).toBe("monitoring");
  });
});
