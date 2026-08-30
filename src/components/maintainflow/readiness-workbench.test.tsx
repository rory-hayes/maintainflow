import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConversionMeasurementReadiness } from "@/lib/openai-ads/measurement-readiness";
import type { MeasurementInstallation } from "@/lib/readiness/schema";

import {
  ConversionMeasurementCard,
  MeasurementInstallationCard,
} from "./readiness-workbench";

const readiness: ConversionMeasurementReadiness = {
  source: "live",
  status: "ready",
  checkedAt: "2026-08-30T12:00:00.000Z",
  activeConversionCampaigns: 1,
  healthyCampaigns: 1,
  eventSettingCount: 1,
  message:
    "Every active conversion campaign references a current event setting.",
  checks: [
    {
      campaignId: "cmpn_live",
      campaignName: "Live conversion campaign",
      status: "pass",
      eventSettingIds: ["ces_purchase"],
      title: "Conversion definition connected",
      detail: "Purchases · 30-day attribution · one source.",
    },
  ],
};

describe("conversion measurement readiness card", () => {
  it("separates verified account evidence from the storefront audit", () => {
    const html = renderToStaticMarkup(
      <ConversionMeasurementCard readiness={readiness} />,
    );

    expect(html).toContain("Measurement ready");
    expect(html).toContain("Live conversion campaign");
    expect(html).toContain("30-day attribution");
    expect(html).toContain("read-only Ads API check");
    expect(html).toContain("fail closed");
  });
});

const measurement: MeasurementInstallation = {
  status: "needs_attention",
  sdkDetected: true,
  initializationDetected: true,
  pixelIdDetected: true,
  imageTagDetected: false,
  consentSignalDetected: false,
  eventNames: ["page_viewed"],
  csp: {
    present: true,
    compatible: false,
    missingSources: ["connect-src https://bzr.openai.com"],
  },
  checks: [
    {
      id: "measurement_pixel",
      title: "Measurement tag installation",
      status: "pass",
      weight: 0,
      evidence: "The documented SDK and Pixel initialization were found.",
      recommendation: "Install the documented SDK.",
    },
    {
      id: "measurement_csp",
      title: "Content Security Policy compatibility",
      status: "fail",
      weight: 0,
      evidence: "The returned CSP is missing one documented source entry.",
      recommendation: "Merge the documented OpenAI origins into the existing CSP.",
    },
  ],
};

describe("measurement installation card", () => {
  it("keeps static evidence distinct from event delivery", () => {
    const html = renderToStaticMarkup(
      <MeasurementInstallationCard measurement={measurement} />,
    );

    expect(html).toContain("ChatGPT measurement installation");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Content Security Policy compatibility");
    expect(html).toContain("Static preflight only");
    expect(html).toContain("did not execute JavaScript or fire a conversion");
  });
});
