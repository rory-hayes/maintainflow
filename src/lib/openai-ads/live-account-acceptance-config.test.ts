import { describe, expect, it } from "vitest";

import { readLiveAccountAcceptanceConfig } from "./live-account-acceptance-config";

const validEnvironment = {
  OPENAI_ADS_LIVE_TEST_ENABLED: "true",
  OPENAI_ADS_API_KEY: "ads-test-key",
  OPENAI_ADS_EXPECTED_ACCOUNT_ID: "adacct_expected",
  OPENAI_ADS_DATA_MODE: "live",
  MAINTAINFLOW_RELEASE_STAGE: "private_read",
  OPENAI_ADS_LIVE_WRITES_ENABLED: "false",
} as const;

describe("live account acceptance preflight", () => {
  it("requires the expected advertiser account before the caller can fetch", () => {
    expect(() =>
      readLiveAccountAcceptanceConfig({
        ...validEnvironment,
        OPENAI_ADS_EXPECTED_ACCOUNT_ID: undefined,
      }),
    ).toThrow("OPENAI_ADS_EXPECTED_ACCOUNT_ID is required");
  });

  it("returns the account binding only when every read-only gate is present", () => {
    expect(readLiveAccountAcceptanceConfig(validEnvironment)).toEqual({
      apiKey: "ads-test-key",
      expectedAccountId: "adacct_expected",
    });
  });
});
