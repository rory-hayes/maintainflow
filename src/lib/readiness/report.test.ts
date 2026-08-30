import { describe, expect, it } from "vitest";

import type { ConversionMeasurementReadiness } from "../openai-ads/measurement-readiness";
import {
  auditConversionsApiPayload,
  createConversionsApiSample,
  type ConversionPayloadAudit,
} from "./conversions-api";
import { auditProductFeedText, type ProductFeedAudit } from "./product-feed";
import {
  buildReadinessReportHtml,
  getReadinessReportSummary,
  readinessReportFileName,
  type ReadinessReportInput,
} from "./report";
import type { ReadinessAudit } from "./schema";

const generatedAt = "2026-08-30T14:00:00.000Z";

const accountMeasurement: ConversionMeasurementReadiness = {
  source: "demo",
  status: "unavailable",
  checkedAt: generatedAt,
  activeConversionCampaigns: 0,
  healthyCampaigns: 0,
  eventSettingCount: 0,
  checks: [],
  message: "Demo mode does not fabricate event-setting evidence.",
};

const storefront: ReadinessAudit = {
  requestedUrl: "https://shop.example/products/bench",
  finalUrl: "https://shop.example/products/bench",
  scannedAt: generatedAt,
  score: 84,
  verdict: "needs_work",
  checks: [
    {
      id: "metadata",
      title: "<script>alert('report')</script>",
      status: "warning",
      weight: 10,
      evidence: "The public title is incomplete.",
      recommendation: "Add a useful product title.",
    },
  ],
  measurement: {
    status: "not_detected",
    sdkDetected: false,
    initializationDetected: false,
    pixelIdDetected: false,
    imageTagDetected: false,
    consentSignalDetected: false,
    eventNames: [],
    csp: { present: false, compatible: false, missingSources: [] },
    checks: [],
  },
  limitations: ["Static HTML cannot prove runtime event delivery."],
};

function readyProductFeed(): ProductFeedAudit {
  return {
    fileName: "catalog.csv",
    format: "csv",
    rowCount: 1,
    adsEligibleRows: 1,
    blockedRows: 0,
    warningRows: 0,
    verdict: "ready",
    issues: [],
  };
}

function readyConversionsApi(): ConversionPayloadAudit {
  return {
    verdict: "ready_for_validation",
    eventCount: 1,
    readyEventCount: 1,
    blockerCount: 0,
    warningCount: 0,
    validateOnly: true,
    integrationSourcePresent: true,
    eventTypes: [{ name: "purchase", count: 1 }],
    issues: [],
    limitations: ["A static result does not prove provider receipt."],
  };
}

describe("readiness client report summary", () => {
  it("keeps incomplete evidence visibly partial", () => {
    const empty = getReadinessReportSummary({
      storefront: null,
      productFeed: null,
      conversionsApi: null,
      accountMeasurement,
    });
    expect(empty).toMatchObject({
      canExport: false,
      completedSections: 0,
      totalSections: 4,
      verdict: "partial",
    });

    const partial = getReadinessReportSummary({
      storefront: null,
      productFeed: readyProductFeed(),
      conversionsApi: null,
      accountMeasurement,
    });
    expect(partial).toMatchObject({
      canExport: true,
      completedSections: 1,
      verdict: "partial",
      verdictLabel: "Partial evidence",
    });
  });

  it("uses ready-for-review only after every section has affirmative evidence", () => {
    const liveMeasurement: ConversionMeasurementReadiness = {
      ...accountMeasurement,
      source: "live",
      status: "ready",
      activeConversionCampaigns: 1,
      healthyCampaigns: 1,
      eventSettingCount: 1,
    };
    const summary = getReadinessReportSummary({
      storefront: { ...storefront, score: 100, verdict: "ready" },
      productFeed: readyProductFeed(),
      conversionsApi: readyConversionsApi(),
      accountMeasurement: liveMeasurement,
    });

    expect(summary).toMatchObject({
      completedSections: 4,
      verdict: "ready_for_review",
      verdictLabel: "Ready for human review",
    });
  });
});

describe("readiness client report HTML", () => {
  it("exports sanitized findings without raw product or event values", () => {
    const productFeed = auditProductFeedText(
      "id,title,description,link,image_link,availability,price,brand,is_ads_eligible\nsecret-1,Private launch product,Private description,https://shop.example/private,https://shop.example/private.jpg,in_stock,10.00 EUR,Private Brand,true",
      "agency-client-catalog.csv",
    );
    const payload = JSON.parse(
      createConversionsApiSample(new Date(generatedAt)),
    ) as { events: Array<Record<string, unknown>> };
    payload.events[0].event_id = "order_private_123";
    payload.events[0].event_source_url = "https://shop.example/private-checkout";
    const conversionsApi = auditConversionsApiPayload(
      JSON.stringify(payload),
      new Date(generatedAt),
    );
    const input: ReadinessReportInput = {
      generatedAt,
      storefront,
      productFeed,
      conversionsApi,
      accountMeasurement,
    };

    const html = buildReadinessReportHtml(input);

    expect(html).toContain("ChatGPT commerce launch readiness");
    expect(html).toContain("&lt;script&gt;alert(&#039;report&#039;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('report')</script>");
    expect(html).not.toContain("Private launch product");
    expect(html).not.toContain("order_private_123");
    expect(html).not.toContain("private-checkout");
    expect(html).toContain("https://developers.openai.com/ads/conversions-api");
    expect(html).toContain("excludes raw product-feed rows");
    expect(readinessReportFileName(input)).toBe(
      "maintainflow-readiness-shop-example-2026-08-30.html",
    );
  });

  it("refuses to create an empty report", () => {
    expect(() =>
      buildReadinessReportHtml({
        generatedAt,
        storefront: null,
        productFeed: null,
        conversionsApi: null,
        accountMeasurement,
      }),
    ).toThrow("Complete at least one readiness check");
  });
});
