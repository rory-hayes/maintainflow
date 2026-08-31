import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getAdsRuntimeMode, type AdsApiCredential } from "./client.server";
import { fetchLiveAdAccount, fetchLiveWorkbenchData } from "./data.server";
import { readLiveAccountAcceptanceConfig } from "./live-account-acceptance-config";

describe("OpenAI Ads account read-only acceptance", () => {
  it("binds the account key and parses the complete read-only workbench contract", async () => {
    const config = readLiveAccountAcceptanceConfig();
    const account = await fetchLiveAdAccount();
    expect(account.id).toBe(config.expectedAccountId);

    const credential: AdsApiCredential = {
      kind: "account_api_key",
      secret: config.apiKey,
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
    expect(runtime.dataSource).toBe("live");
    expect(runtime.liveReadStage).toBe(true);
    expect(runtime.liveWritesRequested).toBe(false);
    expect(runtime.writeInfrastructureConfigured).toBe(false);
  });
});
