import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  READINESS_HISTORY_PAYLOAD_SCHEMA_VERSION,
  READINESS_HISTORY_RULESET_VERSION,
  READINESS_HISTORY_SCANNER_VERSION,
  READINESS_HISTORY_SOURCE_CHECKED_AT,
  type ReadinessAuditHistoryEntry,
} from "@/lib/readiness/history";
import type { ReadinessAudit } from "@/lib/readiness/schema";

import { ReadinessHistoryCard } from "./readiness-history-card";

function audit(
  score: number,
  verdict: ReadinessAudit["verdict"],
  status: "pass" | "warning",
  scannedAt: string,
): ReadinessAudit {
  return {
    requestedUrl: "https://shop.example/products/bench",
    finalUrl: "https://shop.example/products/bench",
    scannedAt,
    score,
    verdict,
    checks: [
      {
        id: "crawl",
        title: "Crawler access",
        status,
        weight: 20,
        evidence: "Public response evidence.",
        recommendation: "Keep crawler access open.",
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

function textContent(markup: string) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/<!-- -->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("readiness history card", () => {
  it("keeps anonymous audits available without fabricating history", () => {
    const text = textContent(
      renderToStaticMarkup(
        <ReadinessHistoryCard ready={false} entries={[]} canSave={false} />,
      ),
    );

    expect(text).toContain("Not connected");
    expect(text).toContain("Public URL audits still run without an Ads key");
    expect(text).toContain("not page HTML, cookies, raw response bodies");
  });

  it("shows a same-URL before-and-after account comparison", () => {
    const entries = [
      entry(
        "eaf46cee-e398-458b-9005-0d866c095e20",
        audit(92, "ready", "pass", "2026-08-30T15:00:00.000Z"),
      ),
      entry(
        "79e46eb8-1bdb-4786-b993-455fe10ef82b",
        audit(72, "needs_work", "warning", "2026-08-29T15:00:00.000Z"),
      ),
    ];
    const text = textContent(
      renderToStaticMarkup(
        <ReadinessHistoryCard
          account={{ accountId: "adacct_client", accountName: "Harbour Home" }}
          ready
          entries={entries}
          canSave
        />,
      ),
    );

    expect(text).toContain("2 saved scans");
    expect(text).toContain("shop.example/products/bench");
    expect(text).toContain("Compared with the previous scan of this URL");
    expect(text).toContain("92/100");
    expect(text).toContain("+20 points");
    expect(text).toContain("Checks improved 1");
    expect(text).toContain("Checks regressed 0");
    expect(text).toContain("Verdict changed Yes");
  });
});
