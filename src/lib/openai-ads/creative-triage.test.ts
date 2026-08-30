import { describe, expect, it } from "vitest";

import { demoAds } from "./demo-data";
import {
  getCreativeTriageGuidance,
  needsCreativeReviewAttention,
} from "./creative-triage";

describe("creative review triage", () => {
  it("maps a documented provider rejection to a concrete launch check", () => {
    const rejected = demoAds.find((ad) => ad.review_status === "rejected");

    expect(rejected).toBeDefined();
    expect(getCreativeTriageGuidance(rejected!)).toMatchObject({
      state: "blocked",
      needsReviewAttention: true,
      label: "Allow the OpenAI crawler",
      providerSignal: "Robots Txt",
      evidenceUrl: "https://cdn.openai.com/ads/reviews/ad_505.png",
    });
  });

  it("treats in-review creatives as pending rather than approved", () => {
    const pending = demoAds.find((ad) => ad.review_status === "in_review");

    expect(pending).toBeDefined();
    expect(getCreativeTriageGuidance(pending!)).toMatchObject({
      state: "pending",
      needsReviewAttention: true,
      label: "Await OpenAI review",
    });
  });

  it("separates approved delivery state from provider review state", () => {
    const approvedActive = demoAds.find(
      (ad) => ad.review_status === "approved" && ad.status === "active",
    );

    expect(approvedActive).toBeDefined();
    expect(getCreativeTriageGuidance(approvedActive!)).toMatchObject({
      state: "clear",
      needsReviewAttention: false,
      label: "No review action",
    });

    const approvedPaused = {
      ...approvedActive!,
      id: "ad_approved_paused",
      status: "paused" as const,
    };
    expect(getCreativeTriageGuidance(approvedPaused)).toMatchObject({
      state: "delivery",
      needsReviewAttention: false,
      label: "Review delivery state",
    });
  });

  it("builds the watchlist from non-final or rejected provider decisions", () => {
    expect(demoAds.filter(needsCreativeReviewAttention).map((ad) => ad.id)).toEqual([
      "ad_503",
      "ad_505",
    ]);
  });

  it("retains unknown provider reasons instead of inventing a fix", () => {
    const rejected = demoAds.find((ad) => ad.review_status === "rejected")!;
    const result = getCreativeTriageGuidance({
      ...rejected,
      review: { status: "rejected", reason: "new_provider_reason" },
    });

    expect(result).toMatchObject({
      state: "blocked",
      label: "Review the provider rejection",
      providerSignal: "New Provider Reason",
    });
  });

  it("adds an approved creative with a serving issue to the watchlist", () => {
    const approved = demoAds.find((ad) => ad.review_status === "approved")!;
    const result = getCreativeTriageGuidance({
      ...approved,
      serving_issues: [{ code: "target_url_invalid" }],
    });

    expect(result).toMatchObject({
      state: "blocked",
      needsReviewAttention: true,
      label: "Fix the destination URL",
      providerSignal: "Target Url Invalid",
    });
  });
});
