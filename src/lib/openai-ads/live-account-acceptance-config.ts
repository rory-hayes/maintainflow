export type LiveAccountAcceptanceConfig = {
  apiKey: string;
  expectedAccountId: string;
};

type AcceptanceEnvironment = Readonly<
  Record<string, string | undefined>
>;

const LIVE_TEST_FLAG = "OPENAI_ADS_LIVE_TEST_ENABLED";

export function readLiveAccountAcceptanceConfig(
  environment: AcceptanceEnvironment = process.env,
): LiveAccountAcceptanceConfig {
  if (environment[LIVE_TEST_FLAG] !== "true") {
    throw new Error(
      `${LIVE_TEST_FLAG}=true is required because this suite contacts the real OpenAI Ads API.`,
    );
  }
  const apiKey = environment.OPENAI_ADS_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_ADS_API_KEY is required for the live acceptance suite.");
  }
  const expectedAccountId = environment.OPENAI_ADS_EXPECTED_ACCOUNT_ID?.trim();
  if (!expectedAccountId) {
    throw new Error(
      "OPENAI_ADS_EXPECTED_ACCOUNT_ID is required before the live acceptance suite contacts OpenAI.",
    );
  }
  if (environment.OPENAI_ADS_DATA_MODE !== "live") {
    throw new Error(
      "OPENAI_ADS_DATA_MODE=live is required for the live acceptance suite.",
    );
  }
  if (environment.MAINTAINFLOW_RELEASE_STAGE !== "private_read") {
    throw new Error(
      "MAINTAINFLOW_RELEASE_STAGE=private_read is required for read-only acceptance.",
    );
  }
  if (environment.OPENAI_ADS_LIVE_WRITES_ENABLED === "true") {
    throw new Error(
      "Disable OPENAI_ADS_LIVE_WRITES_ENABLED before running the read-only acceptance suite.",
    );
  }

  return { apiKey, expectedAccountId };
}
