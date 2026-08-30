import { describe, expect, it } from "vitest";

import { demoAds } from "./demo-data";
import {
  buildCreativeReviewTransitions,
  toCreativeReviewState,
} from "./creative-history";

const detectedAt = "2026-08-30T10:00:00.000Z";

describe("creative review history", () => {
  it("does not fabricate a transition for the first observation", () => {
    expect(
      buildCreativeReviewTransitions({
        accountId: "adacct_demo",
        previousStates: [],
        ads: demoAds,
        detectedAt,
      }),
    ).toEqual([]);
  });

  it("records a provider review decision with both states", () => {
    const current = demoAds.find((ad) => ad.id === "ad_503")!;
    const previous = {
      ...toCreativeReviewState(current),
      reviewStatus: "in_review" as const,
    };
    const approved = {
      ...current,
      updated_at: current.updated_at + 60,
      review_status: "approved" as const,
    };

    expect(
      buildCreativeReviewTransitions({
        accountId: "adacct_demo",
        previousStates: [previous],
        ads: [approved],
        detectedAt,
      }),
    ).toEqual([
      expect.objectContaining({
        eventType: "review_status_changed",
        previousReviewStatus: "in_review",
        reviewStatus: "approved",
        previousDeliveryStatus: "paused",
        deliveryStatus: "paused",
      }),
    ]);
  });

  it("distinguishes delivery-only and combined changes", () => {
    const current = demoAds.find((ad) => ad.id === "ad_505")!;
    const previous = toCreativeReviewState(current);
    const active = {
      ...current,
      updated_at: current.updated_at + 60,
      status: "active" as const,
    };
    const approved = {
      ...active,
      review_status: "approved" as const,
    };

    expect(
      buildCreativeReviewTransitions({
        accountId: "adacct_demo",
        previousStates: [previous],
        ads: [active],
        detectedAt,
      })[0]?.eventType,
    ).toBe("delivery_status_changed");
    expect(
      buildCreativeReviewTransitions({
        accountId: "adacct_demo",
        previousStates: [previous],
        ads: [approved],
        detectedAt,
      })[0]?.eventType,
    ).toBe("review_and_delivery_changed");
  });

  it("ignores a stale provider snapshot", () => {
    const current = demoAds.find((ad) => ad.id === "ad_503")!;
    const previous = {
      ...toCreativeReviewState(current),
      providerUpdatedAt: current.updated_at + 120,
      reviewStatus: "approved" as const,
    };

    expect(
      buildCreativeReviewTransitions({
        accountId: "adacct_demo",
        previousStates: [previous],
        ads: [current],
        detectedAt,
      }),
    ).toEqual([]);
  });
});
