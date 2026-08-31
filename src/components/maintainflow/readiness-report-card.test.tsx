import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConversionMeasurementReadiness } from "@/lib/openai-ads/measurement-readiness";
import type { ProductFeedAudit } from "@/lib/readiness/product-feed";

import { ReadinessReportCard } from "./readiness-report-card";

const accountMeasurement: ConversionMeasurementReadiness = {
  source: "demo",
  status: "unavailable",
  checkedAt: "2026-08-30T14:00:00.000Z",
  activeConversionCampaigns: 0,
  healthyCampaigns: 0,
  eventSettingCount: 0,
  checks: [],
  message: "Simulator mode does not fabricate event-setting evidence.",
};

const productFeed: ProductFeedAudit = {
  fileName: "catalog.csv",
  format: "csv",
  rowCount: 3,
  adsEligibleRows: 1,
  blockedRows: 2,
  warningRows: 0,
  verdict: "needs_work",
  issues: [],
};

describe("readiness client report card", () => {
  it("disables an empty report and states the privacy boundary", () => {
    const html = renderToStaticMarkup(
      <ReadinessReportCard
        storefront={null}
        productFeed={null}
        conversionsApi={null}
        accountMeasurement={accountMeasurement}
      />,
    );

    expect(html).toContain("Client-ready launch report");
    expect(html).toContain("0 of 4 evaluated");
    expect(html).toContain("disabled");
    expect(html).toContain("excludes raw feed rows");
    expect(html).toContain("Complete at least one readiness check");
  });

  it("enables a partial report without presenting it as complete", () => {
    const html = renderToStaticMarkup(
      <ReadinessReportCard
        storefront={null}
        productFeed={productFeed}
        conversionsApi={null}
        accountMeasurement={accountMeasurement}
      />,
    );

    expect(html).toContain("1 of 4 evaluated");
    expect(html).toContain("Products need attention");
    expect(html).toContain("Needs work");
    expect(html).not.toContain('disabled=""');
  });
});
