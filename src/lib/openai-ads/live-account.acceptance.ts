import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getAdsRuntimeMode, type AdsApiCredential } from "./client.server";
import { fetchLiveAdAccount, fetchLiveWorkbenchData } from "./data.server";

const LIVE_TEST_FLAG = "OPENAI_ADS_LIVE_TEST_ENABLED";

describe("OpenAI Ads account read-only acceptance", () => {
  beforeAll(() => {
    if (process.env[LIVE_TEST_FLAG] !== "true") {
      throw new Error(
        `${LIVE_TEST_FLAG}=true is required because this suite contacts the real OpenAI Ads API.`,
      );
    }
    if (!process.env.OPENAI_ADS_API_KEY) {
      throw new Error("OPENAI_ADS_API_KEY is required for the live acceptance suite.");
    }
    if (process.env.OPENAI_ADS_LIVE_WRITES_ENABLED === "true") {
      throw new Error(
        "Disable OPENAI_ADS_LIVE_WRITES_ENABLED before running the read-only acceptance suite.",
      );
    }
  });

  it("binds the account key and parses the complete read-only workbench contract", async () => {
    const account = await fetchLiveAdAccount();
    const expectedAccountId = process.env.OPENAI_ADS_EXPECTED_ACCOUNT_ID;

    if (expectedAccountId) expect(account.id).toBe(expectedAccountId);

    const credential: AdsApiCredential = {
      kind: "account_api_key",
      secret: process.env.OPENAI_ADS_API_KEY!,
      expectedAccountId: account.id,
    };
    const workbench = await fetchLiveWorkbenchData(account, credential);

    expect(workbench.account.id).toBe(account.id);
    expect(workbench.syncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(workbench.campaigns).toEqual(expect.any(Array));
    expect(workbench.ads).toEqual(expect.any(Array));
    expect(workbench.performance).toEqual(expect.any(Array));
    expect(workbench.recommendations).toEqual(expect.any(Array));

    const runtime = getAdsRuntimeMode({ hasAccountKey: true });
    expect(runtime.liveWritesRequested).toBe(false);
    expect(runtime.writeInfrastructureConfigured).toBe(false);
  });
});
