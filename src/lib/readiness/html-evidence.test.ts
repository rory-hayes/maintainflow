import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { analyzeHtml } from "./audit.server";
import {
  ReadinessHtmlComplexityExceededError,
  scanReadinessHtml,
} from "./html-evidence";
import { analyzeMeasurementInstallation } from "./measurement";

describe("bounded readiness HTML evidence", () => {
  it("handles mixed-case tags, attribute order, quotes, and quoted angle brackets", () => {
    const html = `
      <TiTlE>Useful lamp</TiTlE>
      <META content='A > useful lamp' NAME='description'>
      <LINK href='https://shop.example/lamp' REL='alternate canonical'>
      <SCRIPT data-purpose="measurement" SRC='https://bzrcdn.openai.com/sdk/oaiq.min.js'></SCRIPT>
      <script>OAIQ('init', { pixelId: 'px_live_123' }); OAIQ('measureSingle', 'px_live_123', 'order_created');</script>
    `;

    expect(analyzeHtml(html)).toMatchObject({
      hasCanonical: true,
      hasDescription: true,
      hasTitle: true,
    });
    expect(analyzeMeasurementInstallation(html)).toMatchObject({
      eventNames: ["order_created"],
      initializationDetected: true,
      pixelIdDetected: true,
      sdkDetected: true,
    });
  });

  it("commits evidence only from completed elements and exact attributes", () => {
    const html = `
      <meta name="description"
      <title>Unclosed
      <script data-src="https://bzrcdn.openai.com/sdk/oaiq.min.js">
        oaiq("init", { pixelId: "px_live_123" });
    `;
    const evidence = scanReadinessHtml(html);

    expect(evidence.hasTitle).toBe(false);
    expect(evidence.metaEntries).toEqual([]);
    expect(evidence.scripts).toEqual([]);
    expect(analyzeMeasurementInstallation(html)).toMatchObject({
      initializationDetected: false,
      pixelIdDetected: false,
      sdkDetected: false,
    });
  });

  it("ignores JSON-LD outside the bounded depth contract", () => {
    const deeplyNested = `${"[".repeat(65)}{"@type":"Product"}${"]".repeat(65)}`;
    const html = `<script type="application/ld+json">${deeplyNested}</script>`;

    expect(analyzeHtml(html)).toMatchObject({
      hasOfferFacts: false,
      hasProductSchema: false,
    });
  });

  it("skips malformed Pixel calls without rescanning their remaining suffix", () => {
    const malformedCalls = `oaiq("init", {`.repeat(8_192);
    const html = `<script>${malformedCalls}</script>`;
    const startedAt = performance.now();
    const result = analyzeMeasurementInstallation(html);
    const elapsedMs = performance.now() - startedAt;

    expect(result).toMatchObject({
      consentSignalDetected: false,
      eventNames: [],
      initializationDetected: false,
      pixelIdDetected: false,
    });
    expect(elapsedMs).toBeLessThan(1_500);
  });

  it("keeps hostile near-limit tag prefixes inside a bounded runtime", () => {
    const targetCharacters = 1_400_000;
    const hostileDocuments = [
      "<meta ",
      "<img ",
      "<script ",
      '<script type="application/ld+json" ',
      "<title ",
      '<link rel="canonical" ',
    ].map((prefix) => prefix.repeat(Math.ceil(targetCharacters / prefix.length)).slice(0, targetCharacters));
    const startedAt = performance.now();

    for (const html of hostileDocuments) {
      expect(analyzeHtml(html)).toMatchObject({
        hasCanonical: false,
        hasDescription: false,
        hasProductSchema: false,
        hasTitle: false,
      });
      expect(analyzeMeasurementInstallation(html)).toMatchObject({
        imageTagDetected: false,
        initializationDetected: false,
        sdkDetected: false,
      });
    }

    expect(performance.now() - startedAt).toBeLessThan(3_000);
  });

  it("does not maintain a quadratic HTML element stack", () => {
    const deeplyUnbalancedHtml = `${"<x>".repeat(80_000)}${"</y>".repeat(80_000)}`;
    const startedAt = performance.now();

    expect(scanReadinessHtml(deeplyUnbalancedHtml)).toMatchObject({
      hasCanonical: false,
      hasTitle: false,
      scripts: [],
    });
    expect(performance.now() - startedAt).toBeLessThan(1_500);
  });

  it("fails closed when the completed-tag work budget is exceeded", () => {
    expect(() => scanReadinessHtml("<x>".repeat(100_001))).toThrow(
      ReadinessHtmlComplexityExceededError,
    );
  });

  it("rejects direct analyzer input beyond the fetched-body contract", () => {
    expect(() => scanReadinessHtml("x".repeat(1_500_001))).toThrow(
      ReadinessHtmlComplexityExceededError,
    );
  });
});
