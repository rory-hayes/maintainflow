import "server-only";

import type { ZodType } from "zod";

import {
  ApprovalStoreUnavailableError,
  claimApprovalRollback,
  createApprovalRecord,
  isApprovalStoreConfigured,
  updateApprovalRecord,
  updateRollbackRecord,
  verifyApprovalStore,
} from "../audit/approval-store.server";
import {
  isClerkConfigured,
} from "../auth/config";

import {
  adGroupSchema,
  adGroupUpdateSchema,
  adSchema,
  adUpdateSchema,
  campaignSchema,
  campaignUpdateSchema,
} from "./schema";
import type { AdsMutation, Recommendation } from "./demo-data";
import {
  canWriteAccount,
  type AccountAccess,
} from "../tenancy/schema";

const OPENAI_ADS_BASE_URL = "https://api.ads.openai.com/v1";
const ADS_READ_TIMEOUT_MS = 15_000;
const ADS_RATE_LIMIT_MAX_ATTEMPTS = 3;
const ADS_RATE_LIMIT_BACKOFF_MS = 100;
const ADS_RATE_LIMIT_MAX_DELAY_MS = 2_000;

export function validateAdsMutation(mutation: AdsMutation) {
  if (/^\/ad_groups\/[^/]+$/.test(mutation.path)) {
    return adGroupUpdateSchema.parse(mutation.body);
  }

  if (/^\/ads\/[^/]+$/.test(mutation.path)) {
    return adUpdateSchema.parse(mutation.body);
  }

  if (/^\/campaigns\/[^/]+$/.test(mutation.path)) {
    return campaignUpdateSchema.parse(mutation.body);
  }

  if (/^\/(ads|ad_groups|campaigns)\/[^/]+\/(activate|pause)$/.test(mutation.path)) {
    if (mutation.body !== null) {
      throw new Error("State actions must not include a request body.");
    }
    return null;
  }

  throw new Error("This mutation path is not enabled in the MVP.");
}

export function getAdsRuntimeMode(
  options: { hasAccountKey?: boolean } = {},
) {
  const hasKey = options.hasAccountKey ?? Boolean(process.env.OPENAI_ADS_API_KEY);
  const liveDataRequested = process.env.OPENAI_ADS_DATA_MODE === "live";
  const liveWritesRequested = process.env.OPENAI_ADS_LIVE_WRITES_ENABLED === "true";
  const releaseStage = process.env.MAINTAINFLOW_RELEASE_STAGE;
  const liveWriteStage = releaseStage === "live_write";
  const dataSource = hasKey && liveDataRequested ? "live" : "demo";
  const authConfigured = isClerkConfigured();
  const approvalStoreConfigured = isApprovalStoreConfigured();
  const writeInfrastructureConfigured =
    dataSource === "live" &&
    liveWritesRequested &&
    liveWriteStage &&
    authConfigured &&
    approvalStoreConfigured;
  const writeBlockers = [
    ...(!hasKey ? ["OpenAI Ads account key"] : []),
    ...(!liveDataRequested ? ["live Ads data mode"] : []),
    ...(!liveWritesRequested ? ["live-write release flag"] : []),
    ...(!liveWriteStage ? ["live-write release stage"] : []),
    ...(!authConfigured ? ["operator authentication"] : []),
    ...(!approvalStoreConfigured ? ["durable approval database"] : []),
  ];

  return {
    hasKey,
    liveDataRequested,
    liveWritesRequested,
    releaseStage,
    liveWriteStage,
    dataSource,
    authConfigured,
    approvalStoreConfigured,
    writeInfrastructureConfigured,
    writeBlockers,
  } as const;
}

export type AdsApiCredential =
  | Readonly<{
      kind: "account_api_key";
      secret: string;
      expectedAccountId: string;
    }>
  | Readonly<{
      kind: "oauth";
      accessToken: string;
      adAccountId: string;
    }>
  | Readonly<{
      kind: "shared_api_key";
      secret: string;
      adAccountId: string;
    }>
  // Compatibility shape for encrypted account-scoped keys already stored by
  // the MVP. New integrations should use the discriminated contract above.
  | Readonly<{ apiKey: string }>;

export type AdsRequestInit = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  formData?: FormData;
  idempotencyKey?: string;
  adAccountId?: string;
  omitAdAccountHeader?: boolean;
  timeoutMs?: number;
  /** Internal request-scoped limiter used by a complete live-account sync. */
  providerBudget?: AdsProviderRequestBudget;
  /** Opt in only for POST endpoints that are documented, side-effect-free reads. */
  retryOnRateLimit?: boolean;
};

export interface AdsProviderRequestBudget {
  readonly signal: AbortSignal;
  runRequest<T>(request: () => Promise<T>): Promise<T>;
}

type ResolvedAdsCredential = {
  kind: "account_api_key" | "oauth" | "shared_api_key";
  token: string;
  adAccountId?: string;
};

export class OpenAIAdsApiError extends Error {
  readonly status: number;
  readonly retryAfter: string | null;
  readonly retryAfterMs: number | null;
  readonly attempts: number;

  constructor(
    status: number,
    retryAfter: string | null,
    options: { retryAfterMs?: number | null; attempts?: number } = {},
  ) {
    super(`OpenAI Ads API request failed with status ${status}.`);
    this.name = "OpenAIAdsApiError";
    this.status = status;
    this.retryAfter = retryAfter;
    this.retryAfterMs = options.retryAfterMs ?? null;
    this.attempts = options.attempts ?? 1;
  }
}

function parseRetryAfterMs(
  value: string | null,
  now = Date.now(),
): number | null {
  if (value === null) return null;
  const normalized = value.trim();
  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isSafeInteger(seconds) ? seconds * 1_000 : Number.POSITIVE_INFINITY;
  }

  const retryAt = Date.parse(normalized);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now) : null;
}

function rateLimitRetryDelayMs(
  retryAfterMs: number | null,
  completedAttempts: number,
) {
  if (retryAfterMs !== null) {
    return retryAfterMs <= ADS_RATE_LIMIT_MAX_DELAY_MS ? retryAfterMs : null;
  }
  return Math.min(
    ADS_RATE_LIMIT_BACKOFF_MS * 2 ** Math.max(0, completedAttempts - 1),
    ADS_RATE_LIMIT_MAX_DELAY_MS,
  );
}

async function waitForRateLimitRetry(
  delayMs: number,
  signal?: AbortSignal,
) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
  if (delayMs === 0) {
    await Promise.resolve();
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function resolveAdsCredential(
  credential?: AdsApiCredential,
): ResolvedAdsCredential | undefined {
  if (!credential) {
    const token = process.env.OPENAI_ADS_API_KEY;
    return token ? { kind: "account_api_key", token } : undefined;
  }

  if ("apiKey" in credential) {
    return { kind: "account_api_key", token: credential.apiKey };
  }
  if (credential.kind === "oauth") {
    return {
      kind: credential.kind,
      token: credential.accessToken,
      adAccountId: credential.adAccountId,
    };
  }
  if (credential.kind === "shared_api_key") {
    return {
      kind: credential.kind,
      token: credential.secret,
      adAccountId: credential.adAccountId,
    };
  }
  return {
    kind: credential.kind,
    token: credential.secret,
    adAccountId: credential.expectedAccountId,
  };
}

function hasAdsCredential(credential?: AdsApiCredential) {
  return Boolean(resolveAdsCredential(credential)?.token);
}

function validatedIdempotencyKey(value?: string) {
  if (value === undefined) return undefined;
  if (value.length < 1 || value.length > 255 || !/\S/.test(value)) {
    throw new Error(
      "Idempotency-Key must be 1-255 characters and contain a non-whitespace character.",
    );
  }
  return value;
}

export function buildAdsRequestHeaders(
  credential: AdsApiCredential,
  init: AdsRequestInit = {},
) {
  const resolved = resolveAdsCredential(credential);
  if (!resolved?.token) throw new Error("No OpenAI Ads credential is configured.");
  if (init.body !== undefined && init.formData !== undefined) {
    throw new Error("An Ads API request cannot contain both JSON and multipart bodies.");
  }

  const credentialAccountId = resolved.adAccountId;
  if (
    init.adAccountId &&
    credentialAccountId &&
    init.adAccountId !== credentialAccountId
  ) {
    throw new Error("The requested Ads account does not match the credential scope.");
  }
  const adAccountId = init.adAccountId ?? credentialAccountId;
  if (
    (resolved.kind === "oauth" || resolved.kind === "shared_api_key") &&
    !adAccountId
  ) {
    throw new Error("OAuth and shared Ads credentials require an advertiser account.");
  }

  return new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${resolved.token}`,
    ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(validatedIdempotencyKey(init.idempotencyKey)
      ? { "Idempotency-Key": init.idempotencyKey }
      : {}),
    ...(!init.omitAdAccountHeader && adAccountId
      ? { "OpenAI-Ad-Account": adAccountId }
      : {}),
  });
}

function assertAdsPath(path: string) {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Ads API paths must be relative to the configured /v1 origin.");
  }
}

async function fetchAdsResponse(
  path: string,
  init: AdsRequestInit = {},
  credential?: AdsApiCredential,
) {
  assertAdsPath(path);
  const resolved = resolveAdsCredential(credential);
  if (!resolved?.token) throw new Error("No OpenAI Ads API key is configured.");
  const normalizedCredential: AdsApiCredential =
    resolved.kind === "oauth"
      ? {
          kind: "oauth",
          accessToken: resolved.token,
          adAccountId: resolved.adAccountId!,
        }
      : resolved.kind === "shared_api_key"
        ? {
            kind: "shared_api_key",
            secret: resolved.token,
            adAccountId: resolved.adAccountId!,
          }
        : resolved.adAccountId
          ? {
              kind: "account_api_key",
              secret: resolved.token,
              expectedAccountId: resolved.adAccountId,
            }
          : { apiKey: resolved.token };
  const headers = buildAdsRequestHeaders(normalizedCredential, init);
  const body =
    init.formData ??
    (init.body !== undefined ? JSON.stringify(init.body) : undefined);
  const timeoutSignal = AbortSignal.timeout(
    init.timeoutMs ?? ADS_READ_TIMEOUT_MS,
  );
  const signal = init.providerBudget
    ? AbortSignal.any([timeoutSignal, init.providerBudget.signal])
    : timeoutSignal;
  const request = () =>
    fetch(`${OPENAI_ADS_BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      body,
      cache: "no-store",
      signal,
    });

  return init.providerBudget
    ? init.providerBudget.runRequest(request)
    : request();
}

async function sendAdsMutation(
  mutation: AdsMutation,
  body: unknown,
  credential?: AdsApiCredential,
) {
  return fetchAdsResponse(
    mutation.path,
    {
      method: mutation.method,
      ...(body !== null ? { body } : {}),
    },
    credential,
  );
}

type MutationConfirmationTarget = {
  detailPath: string;
  entityId: string;
  expectedState: unknown;
  schema: ZodType<Record<string, unknown>>;
};

function mutationConfirmationTarget(
  mutation: AdsMutation,
  body: unknown,
): MutationConfirmationTarget {
  const match = mutation.path.match(
    /^\/(campaigns|ad_groups|ads)\/([^/]+)(?:\/(activate|pause))?$/,
  );
  if (!match) {
    throw new Error("This mutation path does not have a readback contract.");
  }

  const [, resource, entityId, action] = match;
  const schema =
    resource === "campaigns"
      ? campaignSchema
      : resource === "ad_groups"
        ? adGroupSchema
        : adSchema;

  return {
    detailPath: `/${resource}/${entityId}`,
    entityId,
    expectedState: action
      ? { status: action === "activate" ? "active" : "paused" }
      : body,
    schema,
  };
}

function containsRequestedState(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) =>
        containsRequestedState(actual[index], value),
      )
    );
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return false;
    }
    return Object.entries(expected).every(([key, value]) =>
      containsRequestedState(
        (actual as Record<string, unknown>)[key],
        value,
      ),
    );
  }
  return Object.is(actual, expected);
}

async function confirmAdsMutation(
  mutation: AdsMutation,
  body: unknown,
  payload: unknown,
  credential?: AdsApiCredential,
) {
  const target = mutationConfirmationTarget(mutation, body);
  const acknowledgement = target.schema.parse(payload);
  if (acknowledgement.id !== target.entityId) {
    throw new Error("The Ads API acknowledgement referenced a different resource.");
  }

  const readback = await adsApiRequest(
    target.detailPath,
    target.schema,
    {},
    credential,
  );
  if (readback.id !== target.entityId) {
    throw new Error("The Ads API readback referenced a different resource.");
  }
  if (!containsRequestedState(readback, target.expectedState)) {
    throw new Error(
      "The Ads API readback did not confirm the requested resource state.",
    );
  }

  return { acknowledgement, readback };
}

export async function adsApiRequest<T>(
  path: string,
  schema: ZodType<T>,
  init: AdsRequestInit = {},
  credential?: AdsApiCredential,
) {
  const method = init.method ?? "GET";
  const rateLimitRetrySafe = method === "GET" || init.retryOnRateLimit === true;

  for (
    let attempt = 1;
    attempt <= ADS_RATE_LIMIT_MAX_ATTEMPTS;
    attempt += 1
  ) {
    let response: Response;
    try {
      response = await fetchAdsResponse(path, init, credential);
    } catch (error) {
      throw new Error(
        "The OpenAI Ads API did not return a confirmed response. No data was accepted.",
        { cause: error },
      );
    }

    if (response.ok) {
      const payload: unknown = await response.json().catch(() => null);
      return schema.parse(payload);
    }

    const retryAfter = response.headers.get("Retry-After");
    const retryAfterMs = parseRetryAfterMs(retryAfter);
    const apiError = new OpenAIAdsApiError(response.status, retryAfter, {
      retryAfterMs,
      attempts: attempt,
    });
    if (
      response.status !== 429 ||
      !rateLimitRetrySafe ||
      attempt === ADS_RATE_LIMIT_MAX_ATTEMPTS
    ) {
      throw apiError;
    }

    const retryDelayMs = rateLimitRetryDelayMs(retryAfterMs, attempt);
    // Never retry sooner than a provider-supplied Retry-After value. If the
    // provider asks us to wait beyond this route's bounded retry window, fail
    // closed and let the caller try again later.
    if (retryDelayMs === null) throw apiError;
    try {
      await waitForRateLimitRetry(retryDelayMs, init.providerBudget?.signal);
    } catch (error) {
      throw new Error(
        "The OpenAI Ads API retry was cancelled. No data was accepted.",
        { cause: error },
      );
    }
  }

  throw new Error("The OpenAI Ads API retry budget was exhausted.");
}

export async function applyAdsMutation(
  recommendation: Recommendation,
  options: {
    accountId: string;
    operatorId?: string;
    access?: AccountAccess;
    credential?: AdsApiCredential;
  },
) {
  const body = validateAdsMutation(recommendation.mutation);
  const runtime = getAdsRuntimeMode({
    hasAccountKey: hasAdsCredential(options.credential),
  });

  if (recommendation.source !== "live" || !runtime.writeInfrastructureConfigured) {
    return {
      mode: "demo" as const,
      applied: false,
      message:
        recommendation.source === "demo"
          ? "Demo approval recorded. Demo resource IDs can never be sent to the Ads API."
          : "Review decision recorded for this session. Live writes remain disabled until every release gate is ready.",
    };
  }

  if (!options.operatorId) {
    throw new Error("An authenticated operator is required for a live Ads change.");
  }
  if (!recommendation.monitoringPlan) {
    throw new Error(
      "A typed monitoring baseline is required before a live Ads change.",
    );
  }
  if (
    !options.access ||
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new Error("Verified advertiser-account access is required for a live Ads change.");
  }

  if (!(await verifyApprovalStore())) {
    throw new ApprovalStoreUnavailableError(
      "The durable approval database migration is not ready.",
    );
  }

  const approvalId = await createApprovalRecord({
    accountId: options.accountId,
    operatorId: options.operatorId,
    recommendation,
    access: options.access,
  });

  let response: Response;
  try {
    response = await sendAdsMutation(
      recommendation.mutation,
      body,
      options.credential,
    );
  } catch (error) {
    await updateApprovalRecord(approvalId, "reconciliation_required", {
      error:
        error instanceof Error
          ? error.message
          : "The Ads API request ended without a confirmed response.",
    });
    throw new Error(
      `The Ads API outcome is uncertain. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { cause: error },
    );
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    await updateApprovalRecord(approvalId, "failed", {
      response: payload,
      error: `OpenAI Ads API returned HTTP ${response.status}.`,
    });
    throw new Error(
      `OpenAI Ads API request failed with status ${response.status}.`,
      { cause: payload },
    );
  }

  if (response.status !== 200) {
    await updateApprovalRecord(approvalId, "reconciliation_required", {
      response: payload,
      error: `OpenAI Ads API returned unexpected success status ${response.status}.`,
    });
    throw new Error(
      `The Ads API returned an undocumented success status. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
    );
  }

  let confirmation: Awaited<ReturnType<typeof confirmAdsMutation>>;
  try {
    confirmation = await confirmAdsMutation(
      recommendation.mutation,
      body,
      payload,
      options.credential,
    );
  } catch (error) {
    await updateApprovalRecord(approvalId, "reconciliation_required", {
      response: payload,
      error:
        error instanceof Error
          ? error.message
          : "The Ads API response or readback could not be confirmed.",
    });
    throw new Error(
      `The Ads API acknowledged the request, but its resulting state is unconfirmed. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { cause: error },
    );
  }

  try {
    await updateApprovalRecord(approvalId, "applied", {
      response: confirmation,
    });
  } catch {
    return {
      mode: "live" as const,
      applied: true,
      approvalId,
      persistenceWarning: true,
      message:
        "The change was applied, but the approval record could not be finalized. Do not retry; reconcile the pending record manually.",
      payload: confirmation.acknowledgement,
      readback: confirmation.readback,
    };
  }

  return {
    mode: "live" as const,
    applied: true,
    approvalId,
    message: "The approved change was applied through the OpenAI Ads API.",
    payload: confirmation.acknowledgement,
    readback: confirmation.readback,
  };
}

export async function applyStoredRollback(options: {
  approvalId: string;
  accountId: string;
  operatorId: string;
  access: AccountAccess;
  credential?: AdsApiCredential;
}) {
  const runtime = getAdsRuntimeMode({
    hasAccountKey: hasAdsCredential(options.credential),
  });
  if (!runtime.writeInfrastructureConfigured) {
    throw new Error(
      `Live rollback is disabled. Missing gates: ${runtime.writeBlockers.join(", ")}.`,
    );
  }
  if (!(await verifyApprovalStore())) {
    throw new ApprovalStoreUnavailableError(
      "The durable approval database migration is not ready.",
    );
  }
  if (
    options.access.accountId !== options.accountId ||
    !canWriteAccount(options.access)
  ) {
    throw new Error(
      "Verified advertiser-account write access is required for rollback.",
    );
  }

  const approval = await claimApprovalRollback(
    options.approvalId,
    options.accountId,
    options.operatorId,
    options.access,
  );

  let body: unknown;
  try {
    body = validateAdsMutation(approval.rollback);
  } catch (error) {
    await updateRollbackRecord(approval.id, "rollback_failed", {
      error:
        error instanceof Error
          ? error.message
          : "The stored rollback request is invalid.",
    });
    throw error;
  }

  let response: Response;
  try {
    response = await sendAdsMutation(
      approval.rollback,
      body,
      options.credential,
    );
  } catch (error) {
    await updateRollbackRecord(
      approval.id,
      "rollback_reconciliation_required",
      {
        error:
          error instanceof Error
            ? error.message
            : "The rollback request ended without a confirmed response.",
      },
    );
    throw new Error(
      `The rollback outcome is uncertain. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { cause: error },
    );
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    await updateRollbackRecord(approval.id, "rollback_failed", {
      response: payload,
      error: `OpenAI Ads API returned HTTP ${response.status}.`,
    });
    throw new Error(
      `OpenAI Ads API rollback failed with status ${response.status}.`,
      { cause: payload },
    );
  }

  if (response.status !== 200) {
    await updateRollbackRecord(
      approval.id,
      "rollback_reconciliation_required",
      {
        response: payload,
        error: `OpenAI Ads API returned unexpected success status ${response.status}.`,
      },
    );
    throw new Error(
      `The Ads API returned an undocumented rollback success status. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
    );
  }

  let confirmation: Awaited<ReturnType<typeof confirmAdsMutation>>;
  try {
    confirmation = await confirmAdsMutation(
      approval.rollback,
      body,
      payload,
      options.credential,
    );
  } catch (error) {
    await updateRollbackRecord(
      approval.id,
      "rollback_reconciliation_required",
      {
        response: payload,
        error:
          error instanceof Error
            ? error.message
            : "The Ads API rollback response or readback could not be confirmed.",
      },
    );
    throw new Error(
      `The Ads API acknowledged the rollback, but its resulting state is unconfirmed. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { cause: error },
    );
  }

  try {
    await updateRollbackRecord(approval.id, "rolled_back", {
      response: confirmation,
    });
  } catch {
    return {
      mode: "live" as const,
      applied: true,
      approvalId: approval.id,
      persistenceWarning: true,
      message:
        "The rollback was applied, but its audit record could not be finalized. Do not retry; reconcile the record manually.",
      payload: confirmation.acknowledgement,
      readback: confirmation.readback,
    };
  }

  return {
    mode: "live" as const,
    applied: true,
    approvalId: approval.id,
    message: "The stored rollback was applied through the OpenAI Ads API.",
    payload: confirmation.acknowledgement,
    readback: confirmation.readback,
  };
}
