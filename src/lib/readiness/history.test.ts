import { describe, expect, it } from "vitest";

import {
  compareReadinessAuditHistory,
  READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION,
  READINESS_HISTORY_RULESET_VERSION,
  READINESS_HISTORY_SCANNER_VERSION,
  READINESS_HISTORY_SOURCE_CHECKED_AT,
  sanitizeReadinessAuditForHistory,
  type ReadinessAuditHistoryEntry,
} from "./history";
import type { ReadinessAudit, ReadinessCheck } from "./schema";

function check(
  id: string,
  title: string,
  status: ReadinessCheck["status"],
): ReadinessCheck {
  return {
    id,
    title,
    status,
    weight: 10,
    evidence: `${title} evidence`,
    recommendation: `${title} recommendation`,
  };
}

function audit(options: {
  url: string;
  score: number;
  verdict: ReadinessAudit["verdict"];
  crawlStatus: ReadinessCheck["status"];
  measurementStatus: ReadinessCheck["status"];
  scannedAt: string;
}): ReadinessAudit {
  return {
    requestedUrl: options.url,
    finalUrl: options.url,
    scannedAt: options.scannedAt,
    score: options.score,
    verdict: options.verdict,
    checks: [check("crawl", "Crawler access", options.crawlStatus)],
    measurement: {
      status:
        options.measurementStatus === "pass"
          ? "detected"
          : options.measurementStatus === "warning"
            ? "needs_attention"
            : "not_detected",
      sdkDetected: options.measurementStatus === "pass",
      initializationDetected: options.measurementStatus === "pass",
      pixelIdDetected: options.measurementStatus === "pass",
      imageTagDetected: false,
      consentSignalDetected: false,
      eventNames: [],
      csp: { present: true, compatible: true, missingSources: [] },
      checks: [
        check(
          "measurement_csp",
          "Measurement CSP",
          options.measurementStatus,
        ),
      ],
    },
    limitations: ["Static evidence only."],
  };
}

function entry(
  id: string,
  value: ReadinessAudit,
): ReadinessAuditHistoryEntry {
  return {
    id,
    accountId: "adacct_client",
    audit: value,
    payloadSchemaVersion: READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION,
    rulesetVersion: READINESS_HISTORY_RULESET_VERSION,
    scannerVersion: READINESS_HISTORY_SCANNER_VERSION,
    sourceCheckedAt: READINESS_HISTORY_SOURCE_CHECKED_AT,
    targetAssociation: {
      type: "manual_unverified",
      providerResourceType: null,
      providerResourceId: null,
    },
    queryParametersRedacted: false,
    recordedAt: value.scannedAt,
  };
}

describe("readiness history comparison", () => {
  it("returns no comparison when no account scan is saved", () => {
    expect(compareReadinessAuditHistory([])).toBeNull();
  });

  it("compares the latest scan only with a prior scan of the same final URL", () => {
    const current = entry(
      "c184c3e4-70c1-4e42-9584-45d51aa43284",
      audit({
        url: "https://shop.example/products/bench#details",
        score: 90,
        verdict: "ready",
        crawlStatus: "pass",
        measurementStatus: "fail",
        scannedAt: "2026-08-30T15:00:00.000Z",
      }),
    );
    const unrelated = entry(
      "88cd554c-e25d-4712-98d7-f2ba47995593",
      audit({
        url: "https://shop.example/products/lamp",
        score: 99,
        verdict: "ready",
        crawlStatus: "pass",
        measurementStatus: "pass",
        scannedAt: "2026-08-30T14:00:00.000Z",
      }),
    );
    const previous = entry(
      "60c7d843-9db0-4684-95dc-cb399aa6bdd1",
      audit({
        url: "https://shop.example/products/bench",
        score: 70,
        verdict: "needs_work",
        crawlStatus: "fail",
        measurementStatus: "pass",
        scannedAt: "2026-08-29T15:00:00.000Z",
      }),
    );

    const comparison = compareReadinessAuditHistory([
      current,
      unrelated,
      previous,
    ]);

    expect(comparison).toMatchObject({
      current,
      previous,
      scoreDelta: 20,
      verdictChanged: true,
      compatible: true,
    });
    expect(comparison?.improvedChecks.map((item) => item.id)).toEqual([
      "crawl",
    ]);
    expect(comparison?.regressedChecks.map((item) => item.id)).toEqual([
      "measurement_csp",
    ]);
  });

  it("labels the latest scan as the first for its URL when no match exists", () => {
    const current = entry(
      "9e3238f2-188e-4702-a7c7-e8aee6796540",
      audit({
        url: "https://shop.example/new",
        score: 50,
        verdict: "not_ready",
        crawlStatus: "fail",
        measurementStatus: "fail",
        scannedAt: "2026-08-30T15:00:00.000Z",
      }),
    );
    const previousOtherUrl = entry(
      "dad57a3c-e1ad-41c3-9a94-ec0c7768211d",
      audit({
        url: "https://shop.example/old",
        score: 80,
        verdict: "needs_work",
        crawlStatus: "warning",
        measurementStatus: "pass",
        scannedAt: "2026-08-29T15:00:00.000Z",
      }),
    );

    expect(
      compareReadinessAuditHistory([current, previousOtherUrl]),
    ).toMatchObject({
      previous: null,
      compatible: false,
      scoreDelta: null,
      improvedChecks: [],
      regressedChecks: [],
    });
  });

  it("redacts query parameters before an audit enters shared history", () => {
    const value = audit({
      url: "https://shop.example/products/bench?email=buyer%40example.com&token=secret#details",
      score: 72,
      verdict: "needs_work",
      crawlStatus: "warning",
      measurementStatus: "warning",
      scannedAt: "2026-08-30T15:00:00.000Z",
    });

    const sanitized = sanitizeReadinessAuditForHistory(value);

    expect(sanitized.queryParametersRedacted).toBe(true);
    expect(sanitized.audit.requestedUrl).toBe(
      "https://shop.example/products/bench",
    );
    expect(sanitized.audit.finalUrl).toBe(
      "https://shop.example/products/bench",
    );
    expect(JSON.stringify(sanitized)).not.toContain("buyer%40example.com");
    expect(JSON.stringify(sanitized)).not.toContain("secret");
  });

  it("does not compare scores produced by a different ruleset", () => {
    const current = entry(
      "a337545e-9b49-41d8-8744-cdd5fb85e66b",
      audit({
        url: "https://shop.example/products/bench",
        score: 90,
        verdict: "ready",
        crawlStatus: "pass",
        measurementStatus: "pass",
        scannedAt: "2026-08-30T15:00:00.000Z",
      }),
    );
    const previous = {
      ...entry(
        "c04e495e-bf79-4c6f-bbbd-8855fb7c64d6",
        audit({
          url: "https://shop.example/products/bench",
          score: 40,
          verdict: "not_ready",
          crawlStatus: "fail",
          measurementStatus: "fail",
          scannedAt: "2026-08-20T15:00:00.000Z",
        }),
      ),
      rulesetVersion: "older-ruleset",
    };

    expect(compareReadinessAuditHistory([current, previous])).toMatchObject({
      previous,
      compatible: false,
      scoreDelta: null,
      verdictChanged: false,
      incompatibilityReason: expect.stringContaining("different readiness rules"),
    });
  });
});
