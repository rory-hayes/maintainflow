import { describe, expect, it } from "vitest";

import { accountLocalMonthPeriod } from "./account-local-period";

describe("accountLocalMonthPeriod", () => {
  it("uses complete Europe/Dublin days and preserves the summer offset", () => {
    const result = accountLocalMonthPeriod(
      new Date("2026-08-31T08:00:00.000Z"),
      "Europe/Dublin",
    );

    expect(result).toEqual({
      accountTimeZone: "Europe/Dublin",
      calculatedAt: "2026-08-31T08:00:00.000Z",
      rangeStart: Date.parse("2026-07-31T23:00:00.000Z") / 1_000,
      rangeEnd: Date.parse("2026-08-30T23:00:00.000Z") / 1_000,
      periodStart: Date.parse("2026-07-31T23:00:00.000Z") / 1_000,
      periodEnd: Date.parse("2026-08-31T23:00:00.000Z") / 1_000,
      completeAccountLocalDays: 30,
      totalAccountLocalDays: 31,
    });
  });

  it("handles a month containing a New York daylight-saving transition", () => {
    const result = accountLocalMonthPeriod(
      new Date("2026-03-20T16:00:00.000Z"),
      "America/New_York",
    );

    expect(result.rangeStart).toBe(
      Date.parse("2026-03-01T05:00:00.000Z") / 1_000,
    );
    expect(result.rangeEnd).toBe(
      Date.parse("2026-03-20T04:00:00.000Z") / 1_000,
    );
    expect(result.periodEnd).toBe(
      Date.parse("2026-04-01T04:00:00.000Z") / 1_000,
    );
    expect(result.completeAccountLocalDays).toBe(19);
    expect(result.totalAccountLocalDays).toBe(31);
  });

  it("returns an empty complete-day prefix on the first local day", () => {
    const result = accountLocalMonthPeriod(
      new Date("2026-12-31T12:00:00.000Z"),
      "Pacific/Auckland",
    );

    expect(result.rangeEnd).toBe(result.rangeStart);
    expect(result.completeAccountLocalDays).toBe(0);
    expect(result.totalAccountLocalDays).toBe(31);
  });

  it("rejects invalid dates and time zones", () => {
    expect(() =>
      accountLocalMonthPeriod(new Date("invalid"), "Europe/Dublin"),
    ).toThrow("valid calculation time");
    expect(() =>
      accountLocalMonthPeriod(new Date("2026-08-31T08:00:00.000Z"), "Mars/Base"),
    ).toThrow(RangeError);
  });
});
