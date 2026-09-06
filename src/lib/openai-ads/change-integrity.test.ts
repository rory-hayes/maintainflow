import { describe, expect, it } from "vitest";

import type { ScopedAdGroup } from "./recommendations";
import type { AdAccount, Campaign, ScopedAd } from "./schema";
import {
  buildChangeIntegritySnapshot,
  changeIntegrityCandidateSchema,
  changeIntegrityFingerprint,
  changeIntegrityOperationEvidenceSchema,
  compareChangeIntegritySnapshots,
  type ChangeIntegrityOperationEvidence,
} from "./change-integrity";

const account: AdAccount = {
  id: "adacct_integrity",
  name: "Northstar Home",
  url: "https://northstar.example",
  preview_url: null,
  status: "active",
  timezone: "Europe/Dublin",
  currency_code: "EUR",
  negative_keywords: ["free", "used"],
  review: { status: "approved", reason: "provider-owned" },
  provider_extension: "must not enter the projection",
};

const campaigns: Campaign[] = [
  {
    id: "cmpn_integrity",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_100,
    name: "Storage",
    description: "Storage campaign",
    status: "active",
    mode: null,
    product_feed_id: null,
    start_time: 1_700_000_000,
    end_time: null,
    budget: { daily_spend_limit_micros: 20_000_000 },
    bidding_type: "conversions",
    objective: "conversions",
    billing_event_type: "click",
    conversion_event_setting_ids: ["ces_b", "ces_a"],
    targeting: {
      locations: { countries: ["US", "IE"] },
      platforms: { included: ["chatgpt_web", "chatgpt_ios"] },
    },
    review_status: "provider-extension",
  },
];

const adGroups: ScopedAdGroup[] = [
  {
    id: "adgrp_integrity",
    campaign_id: "cmpn_integrity",
    created_at: 1_700_000_010,
    updated_at: 1_700_000_110,
    name: "High intent",
    description: null,
    context_hints: ["modular storage", "small rooms"],
    status: "active",
    bidding_config: {
      billing_event_type: "click",
      strategy: "fixed_bid",
      max_bid_micros: 20_000_000,
    },
    serving_issues: [{ code: "provider-owned" }],
  },
];

const ads: ScopedAd[] = [
  {
    id: "ad_integrity",
    ad_group_id: "adgrp_integrity",
    name: "Storage card",
    created_at: 1_700_000_020,
    updated_at: 1_700_000_120,
    creative: {
      type: "chat_card",
      title: "Make space",
      body: "Storage for compact homes.",
      target_url: "https://northstar.example/storage",
      file_id: "file_1",
      image_url: "https://cdn.openai.com/generated.png",
    },
    status: "active",
    review_status: "approved",
    review: { status: "approved", screenshot_url: "https://provider/review.png" },
  },
];

function snapshot(
  observedAt: string,
  mutate?: (input: {
    account: AdAccount;
    campaigns: Campaign[];
    adGroups: ScopedAdGroup[];
    ads: ScopedAd[];
  }) => void,
  observationStartedAt = observedAt,
) {
  const input = structuredClone({ account, campaigns, adGroups, ads });
  mutate?.(input);
  return buildChangeIntegritySnapshot({
    ...input,
    observationStartedAt,
    observedAt,
  });
}

function operation(
  overrides: Partial<ChangeIntegrityOperationEvidence> = {},
): ChangeIntegrityOperationEvidence {
  const certainty = overrides.certainty ?? "confirmed";
  return {
    approvalId: "00000000-0000-4000-8000-000000000111",
    resourceType: "ad_group",
    resourceId: "adgrp_integrity",
    mode: "apply",
    occurredAt: "2026-09-04T09:05:00.000Z",
    expectedState: {
      bidding_config: { max_bid_micros: 16_000_000 },
    },
    ...overrides,
    certainty,
    uncertaintyReason:
      certainty === "indeterminate"
        ? (overrides.uncertaintyReason ?? "provider_outcome")
        : null,
  };
}

describe("change-integrity projection", () => {
  it("keeps only material user-controlled fields and canonicalizes sets", () => {
    const first = snapshot("2026-09-04T09:00:00.000Z");
    const reordered = snapshot("2026-09-04T09:01:00.000Z", (input) => {
      input.account.negative_keywords = ["used", "free"];
      input.campaigns[0]!.conversion_event_setting_ids = ["ces_a", "ces_b"];
      input.campaigns[0]!.targeting!.locations!.countries = ["IE", "US"];
      input.campaigns[0]!.targeting!.platforms!.included!.reverse();
      input.adGroups[0]!.context_hints.reverse();
    });

    expect(reordered.resources.map((item) => item.fingerprint)).toEqual(
      first.resources.map((item) => item.fingerprint),
    );
    const projectedAccount = first.resources[0]!.configuration;
    expect(projectedAccount).not.toHaveProperty("review");
    expect(projectedAccount).not.toHaveProperty("provider_extension");
    const projectedAd = first.resources.find(
      (item) => item.resourceType === "ad",
    )!.configuration;
    expect(projectedAd).not.toHaveProperty("review_status");
    expect(projectedAd).not.toHaveProperty("review");
    expect(projectedAd).not.toHaveProperty("creative.image_url");
  });

  it("produces one stable account-scoped hierarchy", () => {
    const result = snapshot("2026-09-04T09:00:00.000Z");

    expect(result.resources.map((item) => item.resourceType)).toEqual([
      "ad_account",
      "campaign",
      "ad_group",
      "ad",
    ]);
    expect(result.resources[2]).toMatchObject({
      resourceId: "adgrp_integrity",
      parentResourceId: "cmpn_integrity",
      providerUpdatedAt: 1_700_000_110,
    });
  });

  it("uses a stable canonical fingerprint for object key order", () => {
    expect(changeIntegrityFingerprint({ b: 2, a: { y: 2, x: 1 } })).toBe(
      changeIntegrityFingerprint({ a: { x: 1, y: 2 }, b: 2 }),
    );
  });

  it("fingerprints an omitted optional value without colliding with null", () => {
    expect(() => changeIntegrityFingerprint(undefined)).not.toThrow();
    expect(changeIntegrityFingerprint(undefined)).not.toBe(
      changeIntegrityFingerprint(null),
    );
  });
});

describe("change-integrity comparison", () => {
  const baselineAt = "2026-09-04T09:00:00.000Z";
  const detectedAt = "2026-09-04T09:10:00.000Z";

  it("does not emit noise for a no-op refresh or provider-only changes", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.ads[0]!.review_status = "rejected";
      input.ads[0]!.review = { status: "rejected", reason: "robots_txt" };
      input.ads[0]!.serving_issues = [{ code: "landing_page_crawl_issue" }];
      input.ads[0]!.updated_at += 500;
    });

    expect(compareChangeIntegritySnapshots({ previous, current })).toEqual([]);
  });

  it("classifies an unexplained material update", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 18_000_000;
    });

    expect(compareChangeIntegritySnapshots({ previous, current })).toEqual([
      expect.objectContaining({
        changeType: "updated",
        classification: "unexplained",
        resourceType: "ad_group",
        resourceId: "adgrp_integrity",
        changedFieldPaths: ["bidding_config.max_bid_micros"],
        explainedFieldPaths: [],
        indeterminateFieldPaths: [],
        unexplainedFieldPaths: ["bidding_config.max_bid_micros"],
      }),
    ]);
  });

  it("recognizes an exact confirmed MaintainFlow apply", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
    });

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [operation()],
      }),
    ).toEqual([
      expect.objectContaining({
        classification: "maintainflow_consistent",
        explainedFieldPaths: ["bidding_config.max_bid_micros"],
        indeterminateFieldPaths: [],
        unexplainedFieldPaths: [],
        matchedOperations: [expect.objectContaining({ mode: "apply" })],
      }),
    ]);
  });

  it("keeps an extra external field unexplained beside a matching apply", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
      input.adGroups[0]!.status = "paused";
    });

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [operation()],
      })[0],
    ).toMatchObject({
      classification: "unexplained",
      explainedFieldPaths: ["bidding_config.max_bid_micros"],
      indeterminateFieldPaths: [],
      unexplainedFieldPaths: ["status"],
    });
  });

  it("marks a change as indeterminate when an ambiguous operation fits", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
    });

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [operation({ certainty: "indeterminate" })],
      })[0],
    ).toMatchObject({
      classification: "indeterminate",
      explainedFieldPaths: [],
      indeterminateFieldPaths: ["bidding_config.max_bid_micros"],
      unexplainedFieldPaths: [],
    });
  });

  it("retains operations from the prior observation interval for the next comparison", () => {
    const previous = snapshot(
      baselineAt,
      undefined,
      "2026-09-04T08:59:00.000Z",
    );
    const current = snapshot(
      detectedAt,
      (input) => {
        input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
      },
      "2026-09-04T09:09:00.000Z",
    );

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [
          operation({ occurredAt: "2026-09-04T08:59:30.000Z" }),
        ],
      })[0],
    ).toMatchObject({
      classification: "maintainflow_consistent",
      baselineObservationStartedAt: "2026-09-04T08:59:00.000Z",
      detectionStartedAt: "2026-09-04T09:09:00.000Z",
    });
  });

  it("treats a confirmed operation inside the provider-read interval as timing-indeterminate", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(
      detectedAt,
      (input) => {
        input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
      },
      "2026-09-04T09:04:00.000Z",
    );

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [operation()],
      })[0],
    ).toMatchObject({
      classification: "indeterminate",
      matchedOperations: [
        expect.objectContaining({
          certainty: "indeterminate",
          uncertaintyReason: "snapshot_timing",
        }),
      ],
    });
  });

  it("requires an explicit reason for indeterminate operation evidence", () => {
    expect(() =>
      changeIntegrityOperationEvidenceSchema.parse({
        ...operation(),
        certainty: "indeterminate",
        uncertaintyReason: null,
      }),
    ).toThrow(/uncertainty reason/i);
  });

  it("detects removal of an optional projected field", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      delete input.campaigns[0]!.objective;
    });

    expect(() =>
      compareChangeIntegritySnapshots({ previous, current }),
    ).not.toThrow();
    expect(compareChangeIntegritySnapshots({ previous, current })[0]).toMatchObject({
      resourceType: "campaign",
      resourceId: "cmpn_integrity",
      changedFieldPaths: ["objective"],
      unexplainedFieldPaths: ["objective"],
    });
  });

  it("lets the latest operation targeting a field control its explanation", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
    });

    const result = compareChangeIntegritySnapshots({
      previous,
      current,
      operations: [
        operation(),
        operation({
          approvalId: "00000000-0000-4000-8000-000000000222",
          occurredAt: "2026-09-04T09:07:00.000Z",
          expectedState: {
            bidding_config: { max_bid_micros: 14_000_000 },
          },
        }),
      ],
    })[0]!;

    expect(result).toMatchObject({
      classification: "unexplained",
      explainedFieldPaths: [],
      indeterminateFieldPaths: [],
      unexplainedFieldPaths: ["bidding_config.max_bid_micros"],
      matchedOperations: [],
    });
  });

  it("uses the latest operation certainty when repeated targets agree", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
    });

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [
          operation(),
          operation({
            approvalId: "00000000-0000-4000-8000-000000000222",
            occurredAt: "2026-09-04T09:07:00.000Z",
            certainty: "indeterminate",
          }),
        ],
      })[0],
    ).toMatchObject({
      classification: "indeterminate",
      explainedFieldPaths: [],
      indeterminateFieldPaths: ["bidding_config.max_bid_micros"],
      unexplainedFieldPaths: [],
      matchedOperations: [
        expect.objectContaining({
          approvalId: "00000000-0000-4000-8000-000000000222",
        }),
      ],
    });
  });

  it("keeps conflicting same-time operations unexplained", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.adGroups[0]!.bidding_config.max_bid_micros = 16_000_000;
    });

    expect(
      compareChangeIntegritySnapshots({
        previous,
        current,
        operations: [
          operation(),
          operation({
            approvalId: "00000000-0000-4000-8000-000000000222",
            expectedState: {
              bidding_config: { max_bid_micros: 14_000_000 },
            },
          }),
        ],
      })[0],
    ).toMatchObject({
      classification: "unexplained",
      explainedFieldPaths: [],
      indeterminateFieldPaths: [],
      unexplainedFieldPaths: ["bidding_config.max_bid_micros"],
      matchedOperations: [
        expect.objectContaining({
          approvalId: "00000000-0000-4000-8000-000000000111",
        }),
        expect.objectContaining({
          approvalId: "00000000-0000-4000-8000-000000000222",
        }),
      ],
    });
  });

  it("detects resource creation and removal", () => {
    const previous = snapshot(baselineAt);
    const current = snapshot(detectedAt, (input) => {
      input.campaigns = [];
      input.adGroups = [];
      input.ads.push({
        ...structuredClone(input.ads[0]!),
        id: "ad_new",
        name: "New creative",
      });
    });
    const events = compareChangeIntegritySnapshots({ previous, current });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resourceId: "cmpn_integrity", changeType: "removed" }),
        expect.objectContaining({ resourceId: "adgrp_integrity", changeType: "removed" }),
        expect.objectContaining({ resourceId: "ad_new", changeType: "created" }),
      ]),
    );
  });

  it("keeps repeated identical transitions as distinct observed events", () => {
    const first = compareChangeIntegritySnapshots({
      previous: snapshot("2026-09-04T09:00:00.000Z"),
      current: snapshot("2026-09-04T09:10:00.000Z", (input) => {
        input.adGroups[0]!.status = "paused";
      }),
    })[0]!;
    const repeated = compareChangeIntegritySnapshots({
      previous: snapshot("2026-09-04T10:00:00.000Z"),
      current: snapshot("2026-09-04T10:10:00.000Z", (input) => {
        input.adGroups[0]!.status = "paused";
      }),
    })[0]!;

    expect(repeated).toMatchObject({
      resourceId: first.resourceId,
      classification: first.classification,
      previousFingerprint: first.previousFingerprint,
      currentFingerprint: first.currentFingerprint,
      changedFieldPaths: first.changedFieldPaths,
    });
    expect(repeated.eventFingerprint).not.toBe(first.eventFingerprint);
  });

  it("rejects malformed or contradictory path partitions", () => {
    const [candidate] = compareChangeIntegritySnapshots({
      previous: snapshot(baselineAt),
      current: snapshot(detectedAt, (input) => {
        input.adGroups[0]!.status = "paused";
      }),
    });
    expect(candidate).toBeDefined();

    for (const malformed of [
      {
        ...candidate,
        unexplainedFieldPaths: ["name"],
      },
      {
        ...candidate,
        explainedFieldPaths: ["status"],
      },
      {
        ...candidate,
        changedFieldPaths: ["status", "status"],
        unexplainedFieldPaths: ["status", "status"],
      },
      {
        ...candidate,
        classification: "maintainflow_consistent" as const,
      },
    ]) {
      expect(() => changeIntegrityCandidateSchema.parse(malformed)).toThrow();
    }
  });

  it("rejects cross-account and backwards comparisons", () => {
    const previous = snapshot(baselineAt);
    const other = snapshot(detectedAt, (input) => {
      input.account.id = "adacct_other";
    });
    expect(() =>
      compareChangeIntegritySnapshots({ previous, current: other }),
    ).toThrow(/same advertiser account/i);

    expect(() =>
      compareChangeIntegritySnapshots({
        previous: snapshot(detectedAt),
        current: snapshot(baselineAt),
      }),
    ).toThrow(/backwards/i);

    expect(() =>
      compareChangeIntegritySnapshots({
        previous: snapshot(baselineAt),
        current: snapshot(
          detectedAt,
          undefined,
          "2026-09-04T08:59:30.000Z",
        ),
      }),
    ).toThrow(/cannot overlap/i);
  });
});
