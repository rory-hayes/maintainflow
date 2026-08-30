import { describe, expect, it } from "vitest";

import {
  demoAccount,
  demoAds,
  demoCampaignPerformance,
  demoCampaigns,
} from "./demo-data";
import type { LiveWorkbenchData } from "./data.server";
import {
  LIVE_WORKBENCH_SNAPSHOT_MAX_BYTES,
  LiveWorkbenchSnapshotValidationError,
  parseLiveWorkbenchSnapshot,
  serializeLiveWorkbenchSnapshot,
} from "./live-sync-snapshot";

function snapshot(overrides: Partial<LiveWorkbenchData> = {}): LiveWorkbenchData {
  const syncedAt = "2026-08-30T12:00:00.000Z";
  return {
    account: demoAccount,
    campaigns: demoCampaigns,
    ads: demoAds,
    performance: demoCampaignPerformance,
    recommendations: [],
    conversionMeasurement: {
      source: "live",
      status: "ready",
      checkedAt: syncedAt,
      activeConversionCampaigns: 1,
      healthyCampaigns: 1,
      eventSettingCount: 1,
      checks: [],
      message: "Measurement is ready.",
    },
    syncedAt,
    ...overrides,
  };
}

describe("live workbench snapshot", () => {
  it("round-trips a versioned account-bound snapshot with an exact byte count", () => {
    const serialized = serializeLiveWorkbenchSnapshot(
      snapshot(),
      demoAccount.id,
    );

    expect(
      parseLiveWorkbenchSnapshot(serialized.envelope, {
        expectedAccountId: demoAccount.id,
        recordedSchemaVersion: serialized.envelope.schemaVersion,
        recordedBytes: serialized.bytes,
      }),
    ).toEqual(serialized.snapshot);
    expect(serialized.bytes).toBeLessThan(LIVE_WORKBENCH_SNAPSHOT_MAX_BYTES);
  });

  it("rejects snapshots for another advertiser account", () => {
    const serialized = serializeLiveWorkbenchSnapshot(
      snapshot(),
      demoAccount.id,
    );

    expect(() =>
      parseLiveWorkbenchSnapshot(serialized.envelope, {
        expectedAccountId: "adacct_other",
      }),
    ).toThrow(/different advertiser account/);
  });

  it("rejects unknown versions, extra envelope fields, and inconsistent metadata", () => {
    const serialized = serializeLiveWorkbenchSnapshot(
      snapshot(),
      demoAccount.id,
    );

    for (const invalid of [
      { ...serialized.envelope, schemaVersion: 2 },
      { ...serialized.envelope, unexpected: true },
    ]) {
      expect(() =>
        parseLiveWorkbenchSnapshot(invalid, {
          expectedAccountId: demoAccount.id,
        }),
      ).toThrow(LiveWorkbenchSnapshotValidationError);
    }
    expect(() =>
      parseLiveWorkbenchSnapshot(serialized.envelope, {
        expectedAccountId: demoAccount.id,
        recordedSchemaVersion: 2,
      }),
    ).toThrow(/version is inconsistent/);
    expect(() =>
      parseLiveWorkbenchSnapshot(serialized.envelope, {
        expectedAccountId: demoAccount.id,
        recordedBytes: serialized.bytes + 1,
      }),
    ).toThrow(/size is inconsistent/);
  });

  it("rejects payloads larger than 8 MiB", () => {
    expect(() =>
      serializeLiveWorkbenchSnapshot(
        snapshot({
          conversionMeasurement: {
            ...snapshot().conversionMeasurement,
            message: "x".repeat(LIVE_WORKBENCH_SNAPSHOT_MAX_BYTES),
          },
        }),
        demoAccount.id,
      ),
    ).toThrow(/exceeds the 8 MiB storage limit/);
  });
});
