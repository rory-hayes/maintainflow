import { describe, expect, it } from "vitest";

import {
  formatDecimal,
  formatGroupedInteger,
  formatUtcDate,
  formatUtcDateTime,
} from "@/lib/formatting";

describe("deterministic presentation formatting", () => {
  it("formats dates from UTC parts without runtime locale punctuation", () => {
    expect(formatUtcDate("2026-08-29T14:20:00.000Z")).toBe("29 Aug 2026");
    expect(
      formatUtcDateTime("2026-08-29T14:20:00.000Z", {
        includeTimeZone: true,
      }),
    ).toBe("29 Aug 2026, 14:20 UTC");
  });

  it("uses an explicit fallback for invalid timestamps", () => {
    expect(
      formatUtcDateTime("Simulator snapshot", {
        fallback: "Simulator snapshot",
        includeTimeZone: true,
      }),
    ).toBe("Simulator snapshot");
  });

  it("groups integer and bounded decimal values consistently", () => {
    expect(formatGroupedInteger(12_345)).toBe("12,345");
    expect(formatGroupedInteger(-12_345.9)).toBe("-12,345");
    expect(formatDecimal(12_345.678, 2)).toBe("12,345.68");
    expect(formatDecimal(-4.5, 2)).toBe("-4.5");
  });
});
