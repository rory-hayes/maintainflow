import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("server-only", () => ({}));

const approvalMocks = vi.hoisted(() => ({
  create: vi.fn(async () => "approval-test-123"),
  update: vi.fn(async () => undefined),
  claim: vi.fn(),
  updateRollback: vi.fn(async () => undefined),
  verify: vi.fn(async () => true),
}));

const writeFenceMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock("../audit/approval-store.server", () => ({
  ApprovalStoreUnavailableError: class ApprovalStoreUnavailableError extends Error {},
  createApprovalRecord: approvalMocks.create,
  claimApprovalRollback: approvalMocks.claim,
  isApprovalStoreConfigured: () => Boolean(process.env.DATABASE_URL),
  updateApprovalRecord: approvalMocks.update,
  updateRollbackRecord: approvalMocks.updateRollback,
  verifyApprovalStore: approvalMocks.verify,
}));

vi.mock("../audit/recommendation-decision-store.server", () => ({
  verifyRecommendationDecisionStore: vi.fn(async () => true),
}));

vi.mock("../tenancy/store.server", () => ({
  withAuthorizedAdsWriteFence: writeFenceMocks.run,
}));

import {
  AdsMutationReconciliationRequiredError,
  adsApiRequest,
  applyAdsMutation,
  applyStoredRollback,
  buildAdsRequestHeaders,
  OpenAIAdsApiError,
} from "./client.server";
import { demoRecommendations } from "./demo-data";
import { buildAdsResourcePath } from "./resource-path";
import type { AccountAccess } from "../tenancy/schema";

const accountAccess: AccountAccess = {
  organizationId: "00000000-0000-4000-8000-000000000002",
  organizationName: "Northstar Agency",
  organizationType: "agency",
  accountId: "account-test",
  accountName: "Harbour Home",
  connectionMode: "vault",
  membershipRole: "owner",
  accountRole: "manager",
};

const environmentKeys = [
  "OPENAI_ADS_API_KEY",
  "OPENAI_ADS_DATA_MODE",
  "OPENAI_ADS_LIVE_WRITES_ENABLED",
  "MAINTAINFLOW_RELEASE_STAGE",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "DATABASE_URL",
] as const;

const originalEnvironment = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
const credentialGeneration = "vault:test-credential:1";

function adGroupResponse(id: string, maxBidMicros: number) {
  return {
    id,
    created_at: 1_788_048_000,
    updated_at: 1_788_048_100,
    name: "High intent",
    description: null,
    context_hints: ["buy modular storage"],
    status: "active",
    bidding_config: {
      billing_event_type: "click",
      max_bid_micros: maxBidMicros,
    },
  } as const;
}

function armLiveInfrastructure() {
  process.env.OPENAI_ADS_API_KEY = "ads-test-key";
  process.env.OPENAI_ADS_DATA_MODE = "live";
  process.env.OPENAI_ADS_LIVE_WRITES_ENABLED = "true";
  process.env.MAINTAINFLOW_RELEASE_STAGE = "live_write";
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_placeholder";
  process.env.CLERK_SECRET_KEY = "sk_test_placeholder";
  process.env.DATABASE_URL = "postgres://example.invalid/database";
}

beforeEach(() => {
  environmentKeys.forEach((key) => {
    originalEnvironment.set(key, process.env[key]);
    delete process.env[key];
  });
  process.env.OPENAI_ADS_DATA_MODE = "live";
  process.env.MAINTAINFLOW_RELEASE_STAGE = "private_read";
  approvalMocks.create.mockClear();
  approvalMocks.update.mockClear();
  approvalMocks.claim.mockReset();
  approvalMocks.updateRollback.mockClear();
  approvalMocks.verify.mockClear();
  writeFenceMocks.run.mockReset();
  writeFenceMocks.run.mockImplementation(async (options, operation) => {
    const credentialMaterial = {
      apiKey: process.env.OPENAI_ADS_API_KEY ?? "ads-vault-key",
      credentialGeneration: options.expectedCredentialGeneration,
    };
    const value = await operation({
      transaction: { test: "transaction" },
      access: accountAccess,
      credentialMaterial,
    });
    return { value, access: accountAccess, credentialMaterial };
  });
  globalThis.fetch = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  environmentKeys.forEach((key) => {
    const value = originalEnvironment.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });
  originalEnvironment.clear();
  globalThis.fetch = originalFetch;
});

describe("guarded live mutations", () => {
  it("never sends a demo recommendation even when every live flag is set", async () => {
    armLiveInfrastructure();

    const result = await applyAdsMutation(demoRecommendations[0], {
      accountId: "account-test",
      operatorId: "user_founder",
      access: accountAccess,
    });

    expect(result.applied).toBe(false);
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("stores a pending approval before making a live API request", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    const confirmed = adGroupResponse(recommendation.entityId, 216_000_000);
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify(confirmed), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await applyAdsMutation(recommendation, {
      accountId: "account-test",
      operatorId: "user_founder",
      access: accountAccess,
      credentialGeneration,
    });

    expect(result).toMatchObject({
      mode: "live",
      applied: true,
      approvalId: "approval-test-123",
    });
    expect(approvalMocks.create).toHaveBeenCalledOnce();
    expect(approvalMocks.create.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(globalThis.fetch).mock.invocationCallOrder[0],
    );
    expect(approvalMocks.update).toHaveBeenCalledWith(
      "approval-test-123",
      "applied",
      {
        response: {
          acknowledgement: confirmed,
          readback: confirmed,
        },
      },
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(globalThis.fetch).mock.calls[1][0])).toContain(
      `/ad_groups/${recommendation.entityId}`,
    );
  });

  it("applies a live change with an account-scoped vault credential", async () => {
    armLiveInfrastructure();
    delete process.env.OPENAI_ADS_API_KEY;
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    const confirmed = adGroupResponse(recommendation.entityId, 216_000_000);
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify(confirmed), {
        status: 200,
      }),
    );

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credential: { apiKey: "ads-vault-key" },
        credentialGeneration,
      }),
    ).resolves.toMatchObject({ mode: "live", applied: true });
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toContain(recommendation.mutation.path);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer ads-vault-key",
    );
  });

  it("keeps provider resource IDs encoded through mutation and readback", async () => {
    armLiveInfrastructure();
    const entityId = "adgrp/season?phase#one%";
    const path = buildAdsResourcePath("ad_groups", entityId);
    const recommendation = {
      ...demoRecommendations[0],
      id: "live_encoded_resource",
      source: "live" as const,
      entityId,
      mutation: { ...demoRecommendations[0].mutation, path },
      rollback: { ...demoRecommendations[0].rollback, path },
    };
    const confirmed = adGroupResponse(entityId, 216_000_000);
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify(confirmed), { status: 200 }),
    );

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).resolves.toMatchObject({ applied: true, mode: "live" });

    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
    for (const [input] of vi.mocked(globalThis.fetch).mock.calls) {
      expect(String(input)).toBe(`https://api.ads.openai.com/v1${path}`);
      expect(String(input)).not.toContain(entityId);
    }
  });

  it("rejects noncanonical resource paths before approval or provider access", async () => {
    armLiveInfrastructure();
    const recommendation = {
      ...demoRecommendations[0],
      source: "live" as const,
      mutation: {
        ...demoRecommendations[0].mutation,
        path: "/ad_groups/adgrp_live?account=other",
      },
    };

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("not enabled");
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires reconciliation when a successful response violates the resource schema", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: recommendation.entityId }), {
        status: 200,
      }),
    );

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("resulting state is unconfirmed");
    expect(approvalMocks.update).toHaveBeenCalledWith(
      "approval-test-123",
      "reconciliation_required",
      expect.objectContaining({
        response: { id: recommendation.entityId },
        error: expect.stringContaining("Required"),
      }),
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("requires reconciliation when readback does not contain the requested state", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    const acknowledgement = adGroupResponse(
      recommendation.entityId,
      216_000_000,
    );
    const staleReadback = adGroupResponse(
      recommendation.entityId,
      270_000_000,
    );
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify(acknowledgement), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(staleReadback), { status: 200 }),
      );

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("resulting state is unconfirmed");
    expect(approvalMocks.update).toHaveBeenCalledWith(
      "approval-test-123",
      "reconciliation_required",
      {
        response: acknowledgement,
        error: "The Ads API readback did not confirm the requested resource state.",
      },
    );
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it("requires an operator before creating or sending a live change", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };

    await expect(
      applyAdsMutation(recommendation, { accountId: "account-test" }),
    ).rejects.toThrow("authenticated operator");
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires a typed monitoring baseline before a live change", async () => {
    armLiveInfrastructure();
    const recommendation = {
      ...demoRecommendations[0],
      source: "live" as const,
      monitoringPlan: undefined,
    };

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("typed monitoring baseline");
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("requires the current approval migration before any live change", async () => {
    armLiveInfrastructure();
    approvalMocks.verify.mockResolvedValueOnce(false);
    const recommendation = { ...demoRecommendations[0], source: "live" as const };

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("migration is not ready");
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("keeps account viewers review-only even when infrastructure is armed", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: { ...accountAccess, accountRole: "viewer" },
      }),
    ).rejects.toThrow("account access is required");
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("marks an ambiguous network outcome for reconciliation", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("socket closed"));

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("must not be retried automatically");
    expect(approvalMocks.update).toHaveBeenCalledWith(
      "approval-test-123",
      "reconciliation_required",
      { error: "socket closed" },
    );
  });

  it("preserves must-not-retry semantics when reconciliation persistence also fails", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("socket closed"));
    approvalMocks.update.mockRejectedValueOnce(new Error("database unavailable"));

    const outcome = await applyAdsMutation(recommendation, {
      accountId: "account-test",
      operatorId: "user_founder",
      access: accountAccess,
      credentialGeneration,
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AdsMutationReconciliationRequiredError);
    expect(outcome).toMatchObject({
      approvalId: "approval-test-123",
      operation: "apply",
      mustNotRetry: true,
      persistenceWarning: true,
    });
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("does not claim or send when the final authority or credential fence fails", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    writeFenceMocks.run.mockRejectedValueOnce(
      new Error("Write access or credential generation changed."),
    );

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("changed");
    expect(writeFenceMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedCredentialGeneration: credentialGeneration,
      }),
      expect.any(Function),
    );
    expect(approvalMocks.create).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not send an actively dismissed recommendation through direct apply", async () => {
    armLiveInfrastructure();
    const recommendation = { ...demoRecommendations[0], source: "live" as const };
    approvalMocks.create.mockRejectedValueOnce(
      new Error("This recommendation is actively dismissed. Restore it first."),
    );

    await expect(
      applyAdsMutation(recommendation, {
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("actively dismissed");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("claims a rollback before sending its stored request", async () => {
    armLiveInfrastructure();
    const rollback = {
      method: "POST" as const,
      path: "/ad_groups/adgrp_live",
      body: {
        bidding_config: {
          billing_event_type: "click",
          max_bid_micros: 250_000_000,
        },
      },
    };
    approvalMocks.claim.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      rollback,
    });
    const confirmed = adGroupResponse("adgrp_live", 250_000_000);
    vi.mocked(globalThis.fetch).mockImplementation(async () =>
      new Response(JSON.stringify(confirmed), { status: 200 }),
    );

    await expect(
      applyStoredRollback({
        approvalId: "00000000-0000-4000-8000-000000000001",
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).resolves.toMatchObject({ applied: true });
    expect(approvalMocks.claim.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(globalThis.fetch).mock.invocationCallOrder[0],
    );
    expect(approvalMocks.updateRollback).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "rolled_back",
      {
        response: {
          acknowledgement: confirmed,
          readback: confirmed,
        },
      },
    );
  });

  it("marks an ambiguous rollback and forbids automatic retry", async () => {
    armLiveInfrastructure();
    approvalMocks.claim.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      rollback: {
        method: "POST",
        path: "/ad_groups/adgrp_live",
        body: {
          bidding_config: {
            billing_event_type: "click",
            max_bid_micros: 250_000_000,
          },
        },
      },
    });
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("socket closed"));

    await expect(
      applyStoredRollback({
        approvalId: "00000000-0000-4000-8000-000000000001",
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("must not be retried automatically");
    expect(approvalMocks.updateRollback).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "rollback_reconciliation_required",
      { error: "socket closed" },
    );
  });

  it("keeps rollback must-not-retry semantics when audit persistence fails", async () => {
    armLiveInfrastructure();
    approvalMocks.claim.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      rollback: {
        method: "POST",
        path: "/ad_groups/adgrp_live",
        body: {
          bidding_config: {
            billing_event_type: "click",
            max_bid_micros: 250_000_000,
          },
        },
      },
    });
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("socket closed"));
    approvalMocks.updateRollback.mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    const outcome = await applyStoredRollback({
      approvalId: "00000000-0000-4000-8000-000000000001",
      accountId: "account-test",
      operatorId: "user_founder",
      access: accountAccess,
      credentialGeneration,
    }).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(AdsMutationReconciliationRequiredError);
    expect(outcome).toMatchObject({
      approvalId: "00000000-0000-4000-8000-000000000001",
      operation: "rollback",
      mustNotRetry: true,
      persistenceWarning: true,
    });
  });

  it("does not contact the API when a stored rollback is invalid", async () => {
    armLiveInfrastructure();
    approvalMocks.claim.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      rollback: {
        method: "POST",
        path: "/campaigns/cmpn_live/archive",
        body: null,
      },
    });

    await expect(
      applyStoredRollback({
        approvalId: "00000000-0000-4000-8000-000000000001",
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
        credentialGeneration,
      }),
    ).rejects.toThrow("not enabled");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(approvalMocks.updateRollback).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
      "rollback_failed",
      { error: "This mutation path is not enabled in the MVP." },
    );
  });

  it("does not claim or send a rollback when live write gates are off", async () => {
    await expect(
      applyStoredRollback({
        approvalId: "00000000-0000-4000-8000-000000000001",
        accountId: "account-test",
        operatorId: "user_founder",
        access: accountAccess,
      }),
    ).rejects.toThrow("Live rollback is disabled");
    expect(approvalMocks.claim).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("guarded live reads", () => {
  it("refuses live reads outside an account-backed release stage before fetch", async () => {
    process.env.OPENAI_ADS_API_KEY = "ads-test-key";
    delete process.env.MAINTAINFLOW_RELEASE_STAGE;

    await expect(
      adsApiRequest("/ad_account", z.object({ id: z.string() })),
    ).rejects.toThrow("private_read or live_write");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("honors a bounded Retry-After delay before retrying a safe read", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_ADS_API_KEY = "ads-test-key";
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "Retry-After": "1" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "adacct_live" }), { status: 200 }),
      );

    const request = adsApiRequest(
      "/ad_account",
      z.object({ id: z.string() }),
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(request).resolves.toEqual({ id: "adacct_live" });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("attaches a bounded timeout to every Ads API read", async () => {
    process.env.OPENAI_ADS_API_KEY = "ads-test-key";
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "adacct_live" }), { status: 200 }),
    );

    await expect(
      adsApiRequest("/ad_account", z.object({ id: z.string() })),
    ).resolves.toEqual({ id: "adacct_live" });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.ads.openai.com/v1/ad_account",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects an unconfirmed read response without accepting partial data", async () => {
    process.env.OPENAI_ADS_API_KEY = "ads-test-key";
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("socket closed"));

    await expect(
      adsApiRequest("/ad_account", z.object({ id: z.string() })),
    ).rejects.toThrow("did not return a confirmed response");
  });

  it("uses an explicit account credential without a process-wide Ads key", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "adacct_vault" }), { status: 200 }),
    );

    await adsApiRequest(
      "/ad_account",
      z.object({ id: z.string() }),
      {},
      { apiKey: "ads-vault-key" },
    );

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(String(url)).toBe("https://api.ads.openai.com/v1/ad_account");
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer ads-vault-key",
    );
  });

  it("builds the documented account header for every supported credential mode", () => {
    const accountKeyHeaders = buildAdsRequestHeaders({
      kind: "account_api_key",
      secret: "account-secret",
      expectedAccountId: "adacct_123",
    });
    const oauthHeaders = buildAdsRequestHeaders({
      kind: "oauth",
      accessToken: "oauth-token",
      adAccountId: "adacct_456",
    });
    const sharedHeaders = buildAdsRequestHeaders(
      {
        kind: "shared_api_key",
        secret: "shared-secret",
        adAccountId: "adacct_789",
      },
      { idempotencyKey: "create-campaign-123", body: {} },
    );

    expect(accountKeyHeaders.get("OpenAI-Ad-Account")).toBe("adacct_123");
    expect(oauthHeaders.get("Authorization")).toBe("Bearer oauth-token");
    expect(oauthHeaders.get("OpenAI-Ad-Account")).toBe("adacct_456");
    expect(sharedHeaders.get("OpenAI-Ad-Account")).toBe("adacct_789");
    expect(sharedHeaders.get("Idempotency-Key")).toBe("create-campaign-123");
    expect(sharedHeaders.get("Content-Type")).toBe("application/json");
  });

  it("rejects account/header mismatches and malformed idempotency keys locally", () => {
    const credential = {
      kind: "oauth" as const,
      accessToken: "oauth-token",
      adAccountId: "adacct_expected",
    };

    expect(() =>
      buildAdsRequestHeaders(credential, { adAccountId: "adacct_other" }),
    ).toThrow("does not match");
    expect(() =>
      buildAdsRequestHeaders(credential, { idempotencyKey: "   " }),
    ).toThrow("Idempotency-Key");
    expect(() =>
      buildAdsRequestHeaders(credential, { body: {}, formData: new FormData() }),
    ).toThrow("both JSON and multipart");
  });

  it("supports PATCH requests and keeps undocumented provider error bodies opaque", async () => {
    vi.mocked(globalThis.fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ secret_detail: "do not expose" }), {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
      );

    await expect(
      adsApiRequest(
        "/feeds/feed_123/products",
        z.object({ accepted: z.boolean() }),
        {
          method: "PATCH",
          body: { updates: [] },
        },
        { apiKey: "ads-vault-key" },
      ),
    ).resolves.toEqual({ accepted: true });
    const [, patchInit] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(patchInit?.method).toBe("PATCH");
    expect(new Headers(patchInit?.headers).get("Content-Type")).toBe(
      "application/json",
    );

    const error = await adsApiRequest(
      "/ad_account",
      z.object({ id: z.string() }),
      {},
      { apiKey: "ads-vault-key" },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OpenAIAdsApiError);
    expect(error).toMatchObject({ status: 429, retryAfter: "30" });
    expect(String(error)).not.toContain("do not expose");
  });
});
