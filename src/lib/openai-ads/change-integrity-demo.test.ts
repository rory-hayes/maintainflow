import { describe, expect, it } from "vitest";

import { demoAccount, demoAds, demoCampaigns } from "./demo-data";
import { buildSimulatedChangeIntegrityEventPage } from "./change-integrity-demo";
import { changeIntegrityEventPageSchema } from "./change-integrity-schema";

describe("change-integrity simulator evidence", () => {
  it("returns deterministic schema-valid examples for all three classifications", () => {
    const first = buildSimulatedChangeIntegrityEventPage({
      account: demoAccount,
      campaigns: demoCampaigns,
      ads: demoAds,
    });
    const second = buildSimulatedChangeIntegrityEventPage({
      account: demoAccount,
      campaigns: demoCampaigns,
      ads: demoAds,
    });

    expect(changeIntegrityEventPageSchema.parse(first)).toEqual(first);
    expect(second).toEqual(first);
    expect(new Set(first.events.map((event) => event.classification))).toEqual(
      new Set([
        "maintainflow_consistent",
        "unexplained",
        "indeterminate",
      ]),
    );
    expect(first.summary).toMatchObject({
      baselineReady: true,
      openUnexplainedCount: 1,
      openIndeterminateCount: 1,
      consistentCount: 1,
      reviewedCount: 0,
    });
  });

  it("does not fabricate change events when no resource exists to demonstrate", () => {
    const result = buildSimulatedChangeIntegrityEventPage({
      account: demoAccount,
      campaigns: [],
      ads: [],
    });

    expect(result.events).toEqual([]);
    expect(result.summary).toMatchObject({
      baselineReady: true,
      retainedEventCount: 0,
      openUnexplainedCount: 0,
      openIndeterminateCount: 0,
    });
  });
});
