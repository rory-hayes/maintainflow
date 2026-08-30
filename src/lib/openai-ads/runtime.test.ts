import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getAdsRuntimeMode } from "./client.server";

const keys = [
  "OPENAI_ADS_API_KEY",
  "OPENAI_ADS_DATA_MODE",
  "OPENAI_ADS_LIVE_WRITES_ENABLED",
  "MAINTAINFLOW_RELEASE_STAGE",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
] as const;

const original = new Map<string, string | undefined>();

beforeEach(() => {
  keys.forEach((key) => {
    original.set(key, process.env[key]);
    delete process.env[key];
  });
});

afterEach(() => {
  keys.forEach((key) => {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  original.clear();
});

describe("OpenAI Ads runtime gates", () => {
  it("defaults to demo data with external writes locked", () => {
    const runtime = getAdsRuntimeMode();

    expect(runtime.dataSource).toBe("demo");
    expect(runtime.writeInfrastructureConfigured).toBe(false);
    expect(runtime.writeBlockers).toContain("OpenAI Ads account key");
    expect(runtime.writeBlockers).toContain("live-write release stage");
    expect(runtime.writeBlockers).toContain("operator authentication");
    expect(runtime.writeBlockers).toContain("durable approval database");
  });

  it("does not arm writes when only the key and release flag exist", () => {
    process.env.OPENAI_ADS_API_KEY = "ads-test-key";
    process.env.OPENAI_ADS_DATA_MODE = "live";
    process.env.OPENAI_ADS_LIVE_WRITES_ENABLED = "true";

    const runtime = getAdsRuntimeMode();

    expect(runtime.dataSource).toBe("live");
    expect(runtime.writeInfrastructureConfigured).toBe(false);
    expect(runtime.writeBlockers).toEqual([
      "live-write release stage",
      "operator authentication",
      "durable approval database",
    ]);
  });

  it.each(["demo", "private_read"])(
    "keeps writes locked in the %s release stage even when every legacy gate is armed",
    (stage) => {
      process.env.OPENAI_ADS_API_KEY = "ads-test-key";
      process.env.OPENAI_ADS_DATA_MODE = "live";
      process.env.OPENAI_ADS_LIVE_WRITES_ENABLED = "true";
      process.env.MAINTAINFLOW_RELEASE_STAGE = stage;
      process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_placeholder";
      process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
      process.env.DATABASE_URL = "postgres://example.invalid/database";

      const runtime = getAdsRuntimeMode();

      expect(runtime.writeInfrastructureConfigured).toBe(false);
      expect(runtime.writeBlockers).toEqual(["live-write release stage"]);
    },
  );

  it("arms live-write infrastructure only when every server gate is present", () => {
    process.env.OPENAI_ADS_API_KEY = "ads-test-key";
    process.env.OPENAI_ADS_DATA_MODE = "live";
    process.env.OPENAI_ADS_LIVE_WRITES_ENABLED = "true";
    process.env.MAINTAINFLOW_RELEASE_STAGE = "live_write";
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_placeholder";
    process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
    process.env.DATABASE_URL = "postgres://example.invalid/database";

    const runtime = getAdsRuntimeMode();

    expect(runtime.dataSource).toBe("live");
    expect(runtime.writeInfrastructureConfigured).toBe(true);
    expect(runtime.writeBlockers).toEqual([]);
  });
});
