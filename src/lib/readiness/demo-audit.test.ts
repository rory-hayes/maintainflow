import { describe, expect, it } from "vitest";

import { createSampleStorefrontAudit } from "./demo-audit";
import { readinessAuditSchema } from "./schema";

describe("sample storefront readiness audit", () => {
  it("stays schema-valid, visibly incomplete, and useful for report demos", () => {
    const now = new Date("2026-08-31T12:00:00.000Z");
    const audit = readinessAuditSchema.parse(createSampleStorefrontAudit(now));

    expect(audit).toMatchObject({
      scannedAt: now.toISOString(),
      score: 91,
      verdict: "needs_work",
      measurement: {
        status: "needs_attention",
        csp: { compatible: false },
      },
    });
    expect(audit.finalUrl).toContain(".example/");
    expect(audit.checks.filter((check) => check.status !== "pass")).toHaveLength(
      2,
    );
    expect(audit.limitations[0]).toContain("illustrative");
    expect(audit.limitations[0]).toContain("No website was requested");
  });
});
