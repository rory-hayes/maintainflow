import "server-only";

import { createHash } from "node:crypto";

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
import { storedAdsMutationSchema } from "../audit/approval-schema";
import {
  verifyRecommendationDecisionStore,
} from "../audit/recommendation-decision-store.server";
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
import { buildAdsResourcePath, parseAdsResourcePath } from "./resource-path";
import type { AdsMutation, Recommendation } from "./demo-data";
import {
  canWriteAccount,
  type AccountAccess,
} from "../tenancy/schema";
import { withAuthorizedAdsWriteFence } from "../tenancy/store.server";
import { resolveReleaseStage } from "../release/stage";
import { createServerLogger } from "../observability/logger.server";

const OPENAI_ADS_BASE_URL = "https://api.ads.openai.com/v1";
const ADS_READ_TIMEOUT_MS = 15_000;
const ADS_RATE_LIMIT_MAX_ATTEMPTS = 3;
const ADS_RATE_LIMIT_BACKOFF_MS = 100;
const ADS_RATE_LIMIT_MAX_DELAY_MS = 2_000;

export const ADS_RESPONSE_LIMITS = {
  readBytes: 16 * 1024 * 1024,
  mutationBytes: 1024 * 1024,
} as const;

export function validateAdsMutation(mutation: AdsMutation) {
  let target: ReturnType<typeof parseAdsResourcePath>;
  try {
    target = parseAdsResourcePath(mutation.path);
  } catch {
    throw new Error("This mutation path is not enabled in the MVP.");
  }

  if (target.resource === "ad_groups" && !target.action) {
    return adGroupUpdateSchema.parse(mutation.body);
  }

  if (target.resource === "ads" && !target.action) {
    return adUpdateSchema.parse(mutation.body);
  }

  if (target.resource === "campaigns" && !target.action) {
    return campaignUpdateSchema.parse(mutation.body);
  }

  if (target.action) {
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
  const releaseStage = resolveReleaseStage();
  const liveWriteStage = releaseStage === "live_write";
  const liveReadStage = releaseStage === "private_read" || liveWriteStage;
  const dataSource =
    hasKey && liveDataRequested && liveReadStage ? "live" : "demo";
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
    liveReadStage,
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

export class OpenAIAdsResponseTooLargeError extends Error {
  readonly maximumBytes: number;

  constructor(maximumBytes: number) {
    super(
      `The OpenAI Ads API response exceeded the ${maximumBytes}-byte safety limit.`,
    );
    this.name = "OpenAIAdsResponseTooLargeError";
    this.maximumBytes = maximumBytes;
  }
}

export class OpenAIAdsLiveReadUnavailableError extends Error {
  constructor() {
    super(
      "Live OpenAI Ads reads require live data mode and a private_read or live_write release stage.",
    );
    this.name = "OpenAIAdsLiveReadUnavailableError";
  }
}

export class AdsMutationReconciliationRequiredError extends Error {
  readonly approvalId: string;
  readonly operation: "apply" | "rollback";
  readonly mustNotRetry = true;
  readonly persistenceWarning: boolean;

  constructor(
    approvalId: string,
    operation: "apply" | "rollback",
    message: string,
    options: { cause?: unknown; persistenceWarning?: boolean } = {},
  ) {
    super(message, options);
    this.name = "AdsMutationReconciliationRequiredError";
    this.approvalId = approvalId;
    this.operation = operation;
    this.persistenceWarning = options.persistenceWarning ?? false;
  }
}

export class AdsMutationRejectedError extends Error {
  readonly approvalId: string;
  readonly providerStatus: number;

  constructor(approvalId: string, providerStatus: number) {
    super("OpenAI Ads rejected the requested change.");
    this.name = "AdsMutationRejectedError";
    this.approvalId = approvalId;
    this.providerStatus = providerStatus;
  }
}

export class AdsMutationPreconditionFailedError extends Error {
  readonly approvalId: string;
  readonly operation: "apply" | "rollback";
  readonly reason: "provider_state_changed" | "provider_state_unavailable";
  readonly noMutationSent = true;
  readonly requiresFreshReview: boolean;
  readonly expectedStateFingerprint: string;
  readonly actualStateFingerprint: string | null;
  readonly persistenceWarning: boolean;

  constructor(
    approvalId: string,
    operation: "apply" | "rollback",
    reason: "provider_state_changed" | "provider_state_unavailable",
    options: {
      expectedStateFingerprint: string;
      actualStateFingerprint?: string | null;
      cause?: unknown;
      persistenceWarning?: boolean;
    },
  ) {
    super(
      reason === "provider_state_changed"
        ? "The provider resource changed after review. No mutation was sent. Refresh and review the current state before trying again."
        : "The provider resource could not be verified immediately before the write. No mutation was sent.",
      { cause: options.cause },
    );
    this.name = "AdsMutationPreconditionFailedError";
    this.approvalId = approvalId;
    this.operation = operation;
    this.reason = reason;
    this.requiresFreshReview = reason === "provider_state_changed";
    this.expectedStateFingerprint = options.expectedStateFingerprint;
    this.actualStateFingerprint = options.actualStateFingerprint ?? null;
    this.persistenceWarning = options.persistenceWarning ?? false;
  }
}

function isAmbiguousMutationStatus(status: number) {
  return status === 408 || status >= 500;
}

function cancelResponseBody(response: Response) {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Cancellation is best-effort after the response has already been rejected.
  }
}

async function readJsonResponseWithLimit(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const contentLength = response.headers.get("Content-Length")?.trim();
  if (contentLength && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
      cancelResponseBody(response);
      throw new OpenAIAdsResponseTooLargeError(maximumBytes);
    }
  }

  if (!response.body) return null;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let text = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maximumBytes) {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // Preserve the bounded-response error if cancellation itself fails.
        }
        throw new OpenAIAdsResponseTooLargeError(maximumBytes);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
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

type MutationProviderPrecondition = {
  detailPath: string;
  entityId: string;
  expectedState: unknown;
  expectedStateFingerprint: string;
  schema: ZodType<Record<string, unknown>>;
};

const missingControlledState = Object.freeze({
  __maintainflow_missing_controlled_state__: true,
});

function canonicalizeControlledState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeControlledState);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalizeControlledState(item)]),
    );
  }
  return value;
}

function controlledStateFingerprint(value: unknown) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeControlledState(value)))
    .digest("hex");
}

function projectExpectedControlledState(
  expectedCurrent: unknown,
  requestedState: unknown,
  path = "resource",
): unknown {
  if (Array.isArray(requestedState)) {
    return Array.isArray(expectedCurrent)
      ? expectedCurrent.map(canonicalizeControlledState)
      : canonicalizeControlledState(expectedCurrent);
  }

  if (requestedState !== null && typeof requestedState === "object") {
    if (
      expectedCurrent === null ||
      typeof expectedCurrent !== "object" ||
      Array.isArray(expectedCurrent)
    ) {
      return canonicalizeControlledState(expectedCurrent);
    }

    const expectedRecord = expectedCurrent as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(requestedState as Record<string, unknown>).map(
        ([key, requestedValue]) => {
          if (!Object.prototype.hasOwnProperty.call(expectedRecord, key)) {
            throw new Error(
              `The reviewed inverse request does not restore controlled field ${path}.${key}.`,
            );
          }
          return [
            key,
            projectExpectedControlledState(
              expectedRecord[key],
              requestedValue,
              `${path}.${key}`,
            ),
          ];
        },
      ),
    );
  }

  return canonicalizeControlledState(expectedCurrent);
}

function projectObservedControlledState(
  actual: unknown,
  expectedState: unknown,
): unknown {
  if (Array.isArray(expectedState)) {
    return Array.isArray(actual)
      ? actual.map(canonicalizeControlledState)
      : missingControlledState;
  }

  if (expectedState !== null && typeof expectedState === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
      return missingControlledState;
    }
    const actualRecord = actual as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(expectedState as Record<string, unknown>).map(
        ([key, expectedValue]) => [
          key,
          Object.prototype.hasOwnProperty.call(actualRecord, key)
            ? projectObservedControlledState(actualRecord[key], expectedValue)
            : missingControlledState,
        ],
      ),
    );
  }

  return canonicalizeControlledState(actual);
}

function mutationConfirmationTarget(
  mutation: AdsMutation,
  body: unknown,
): MutationConfirmationTarget {
  const { resource, entityId, action } = parseAdsResourcePath(mutation.path);
  const schema =
    resource === "campaigns"
      ? campaignSchema
      : resource === "ad_groups"
        ? adGroupSchema
        : adSchema;

  return {
    detailPath: buildAdsResourcePath(resource, entityId),
    entityId,
    expectedState: action
      ? { status: action === "activate" ? "active" : "paused" }
      : body,
    schema,
  };
}

function deriveMutationProviderPrecondition(
  mutation: AdsMutation,
  mutationBody: unknown,
  expectedCurrentMutation: AdsMutation,
  expectedCurrentBody: unknown,
): MutationProviderPrecondition {
  const requestedTarget = mutationConfirmationTarget(mutation, mutationBody);
  const expectedCurrentTarget = mutationConfirmationTarget(
    expectedCurrentMutation,
    expectedCurrentBody,
  );
  if (
    requestedTarget.detailPath !== expectedCurrentTarget.detailPath ||
    requestedTarget.entityId !== expectedCurrentTarget.entityId
  ) {
    throw new Error(
      "The reviewed request and inverse request do not address the same provider resource.",
    );
  }

  const expectedState = projectExpectedControlledState(
    expectedCurrentTarget.expectedState,
    requestedTarget.expectedState,
  );
  return {
    detailPath: requestedTarget.detailPath,
    entityId: requestedTarget.entityId,
    expectedState,
    expectedStateFingerprint: controlledStateFingerprint(expectedState),
    schema: requestedTarget.schema,
  };
}

async function verifyMutationProviderPrecondition(
  precondition: MutationProviderPrecondition,
  credential: AdsApiCredential,
) {
  const readback = await adsApiRequest(
    precondition.detailPath,
    precondition.schema,
    {},
    credential,
  );
  if (readback.id !== precondition.entityId) {
    throw new Error(
      "The Ads API precondition read referenced a different resource.",
    );
  }

  const actualState = projectObservedControlledState(
    readback,
    precondition.expectedState,
  );
  const actualStateFingerprint = controlledStateFingerprint(actualState);
  return {
    matches: actualStateFingerprint === precondition.expectedStateFingerprint,
    expectedStateFingerprint: precondition.expectedStateFingerprint,
    actualStateFingerprint,
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
  const runtime = getAdsRuntimeMode({
    hasAccountKey: hasAdsCredential(credential),
  });
  if (runtime.dataSource !== "live") {
    throw new OpenAIAdsLiveReadUnavailableError();
  }

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
      const payload = await readJsonResponseWithLimit(
        response,
        ADS_RESPONSE_LIMITS.readBytes,
      );
      return schema.parse(payload);
    }

    cancelResponseBody(response);

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
    credentialGeneration?: string;
  },
) {
  const log = createServerLogger("api.ads.apply");
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
  if (!options.credentialGeneration) {
    throw new Error(
      "A generation-scoped live snapshot is required for a live Ads change.",
    );
  }

  let providerPrecondition: MutationProviderPrecondition;
  try {
    const expectedCurrentBody = validateAdsMutation(recommendation.rollback);
    providerPrecondition = deriveMutationProviderPrecondition(
      recommendation.mutation,
      body,
      recommendation.rollback,
      expectedCurrentBody,
    );
  } catch (error) {
    throw new Error(
      "The reviewed rollback cannot establish a complete provider-state precondition for this change.",
      { cause: error },
    );
  }

  if (
    !(await verifyApprovalStore()) ||
    !(await verifyRecommendationDecisionStore())
  ) {
    throw new ApprovalStoreUnavailableError(
      "A durable approval or recommendation-decision database migration is not ready.",
    );
  }

  const prepared = await withAuthorizedAdsWriteFence(
    {
      accountId: options.accountId,
      operatorId: options.operatorId,
      access: options.access,
      expectedCredentialGeneration: options.credentialGeneration,
    },
    async ({ transaction, access }) =>
      createApprovalRecord(
        {
          accountId: options.accountId,
          operatorId: options.operatorId!,
          recommendation,
          access,
        },
        transaction,
      ),
  );
  const approvalId = prepared.value;
  const credential: AdsApiCredential = {
    kind: "account_api_key",
    secret: prepared.credentialMaterial.apiKey,
    expectedAccountId: options.accountId,
  };

  let providerState: Awaited<
    ReturnType<typeof verifyMutationProviderPrecondition>
  >;
  try {
    providerState = await verifyMutationProviderPrecondition(
      providerPrecondition,
      credential,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "failed", {
        response: {
          precondition: {
            outcome: "blocked_no_write",
            reason: "provider_state_unavailable",
            expectedStateFingerprint:
              providerPrecondition.expectedStateFingerprint,
          },
        },
        error:
          "Provider state could not be verified immediately before apply. No mutation was sent.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.warn("ads.apply.precondition_blocked");
    throw new AdsMutationPreconditionFailedError(
      approvalId,
      "apply",
      "provider_state_unavailable",
      {
        expectedStateFingerprint:
          providerPrecondition.expectedStateFingerprint,
        cause: error,
        persistenceWarning,
      },
    );
  }

  if (!providerState.matches) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "failed", {
        response: {
          precondition: {
            outcome: "blocked_no_write",
            reason: "provider_state_changed",
            expectedStateFingerprint:
              providerState.expectedStateFingerprint,
            actualStateFingerprint: providerState.actualStateFingerprint,
          },
        },
        error:
          "Provider-controlled fields changed after review. No mutation was sent; refresh and approve a newly generated recommendation.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.warn("ads.apply.precondition_blocked");
    throw new AdsMutationPreconditionFailedError(
      approvalId,
      "apply",
      "provider_state_changed",
      {
        expectedStateFingerprint: providerState.expectedStateFingerprint,
        actualStateFingerprint: providerState.actualStateFingerprint,
        persistenceWarning,
      },
    );
  }

  let response: Response;
  try {
    response = await sendAdsMutation(
      recommendation.mutation,
      body,
      credential,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "reconciliation_required", {
        error:
          error instanceof Error
            ? error.message
            : "The Ads API request ended without a confirmed response.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.apply.reconciliation_required", { error });
    throw new AdsMutationReconciliationRequiredError(
      approvalId,
      "apply",
      `The Ads API outcome is uncertain. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { cause: error, persistenceWarning },
    );
  }

  let payload: unknown;
  try {
    payload = await readJsonResponseWithLimit(
      response,
      ADS_RESPONSE_LIMITS.mutationBytes,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "reconciliation_required", {
        error:
          error instanceof OpenAIAdsResponseTooLargeError
            ? "OpenAI Ads API mutation response exceeded the bounded response limit and was not retained."
            : "OpenAI Ads API mutation response could not be safely read and was not retained.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.apply.reconciliation_required", {
      status: response.status,
      error,
    });
    throw new AdsMutationReconciliationRequiredError(
      approvalId,
      "apply",
      `The Ads API response could not be safely confirmed. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { cause: error, persistenceWarning },
    );
  }

  if (!response.ok && isAmbiguousMutationStatus(response.status)) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "reconciliation_required", {
        response: payload,
        error: `OpenAI Ads API returned an uncertain HTTP ${response.status} mutation outcome.`,
      });
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.apply.reconciliation_required", {
      status: response.status,
    });
    throw new AdsMutationReconciliationRequiredError(
      approvalId,
      "apply",
      `The Ads API returned an uncertain HTTP ${response.status} outcome. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { persistenceWarning },
    );
  }

  if (!response.ok) {
    await updateApprovalRecord(approvalId, "failed", {
      response: payload,
      error: `OpenAI Ads API returned HTTP ${response.status}.`,
    });
    log.warn("ads.apply.rejected", { status: response.status });
    throw new AdsMutationRejectedError(approvalId, response.status);
  }

  if (response.status !== 200) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "reconciliation_required", {
        response: payload,
        error: `OpenAI Ads API returned unexpected success status ${response.status}.`,
      });
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.apply.reconciliation_required", {
      status: response.status,
    });
    throw new AdsMutationReconciliationRequiredError(
      approvalId,
      "apply",
      `The Ads API returned an undocumented success status. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { persistenceWarning },
    );
  }

  let confirmation: Awaited<ReturnType<typeof confirmAdsMutation>>;
  try {
    confirmation = await confirmAdsMutation(
      recommendation.mutation,
      body,
      payload,
      credential,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
      await updateApprovalRecord(approvalId, "reconciliation_required", {
        response: payload,
        error:
          error instanceof Error
            ? error.message
            : "The Ads API response or readback could not be confirmed.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.apply.reconciliation_required", { error });
    throw new AdsMutationReconciliationRequiredError(
      approvalId,
      "apply",
      `The Ads API acknowledged the request, but its resulting state is unconfirmed. Approval ${approvalId} requires manual reconciliation and must not be retried automatically.`,
      { cause: error, persistenceWarning },
    );
  }

  try {
    await updateApprovalRecord(approvalId, "applied", {
      response: confirmation,
    });
  } catch {
    log.error("ads.apply.audit_persistence_failed");
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

  log.info("ads.apply.completed");
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
  credentialGeneration?: string;
}) {
  const log = createServerLogger("api.ads.rollback");
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
  if (!options.credentialGeneration) {
    throw new Error(
      "A generation-scoped live account check is required for rollback.",
    );
  }

  const prepared = await withAuthorizedAdsWriteFence(
    {
      accountId: options.accountId,
      operatorId: options.operatorId,
      access: options.access,
      expectedCredentialGeneration: options.credentialGeneration,
    },
    async ({ transaction, access }) =>
      claimApprovalRollback(
        options.approvalId,
        options.accountId,
        options.operatorId,
        access,
        transaction,
      ),
  );
  const approval = prepared.value;
  const credential: AdsApiCredential = {
    kind: "account_api_key",
    secret: prepared.credentialMaterial.apiKey,
    expectedAccountId: options.accountId,
  };

  let rollbackMutation: AdsMutation;
  let body: unknown;
  let providerPrecondition: MutationProviderPrecondition;
  try {
    rollbackMutation = storedAdsMutationSchema.parse(approval.rollbackPayload);
    const appliedMutation = storedAdsMutationSchema.parse(
      approval.mutationPayload,
    );
    body = validateAdsMutation(rollbackMutation);
    const expectedCurrentBody = validateAdsMutation(appliedMutation);
    providerPrecondition = deriveMutationProviderPrecondition(
      rollbackMutation,
      body,
      appliedMutation,
      expectedCurrentBody,
    );
  } catch (error) {
    await updateRollbackRecord(approval.id, "rollback_failed", {
      error:
        error instanceof Error
          ? error.message
          : "The stored request pair cannot establish a rollback precondition.",
    });
    log.warn("ads.rollback.invalid_stored_request", { error });
    throw error;
  }

  let providerState: Awaited<
    ReturnType<typeof verifyMutationProviderPrecondition>
  >;
  try {
    providerState = await verifyMutationProviderPrecondition(
      providerPrecondition,
      credential,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
      await updateRollbackRecord(approval.id, "rollback_failed", {
        response: {
          precondition: {
            outcome: "blocked_no_write",
            reason: "provider_state_unavailable",
            expectedStateFingerprint:
              providerPrecondition.expectedStateFingerprint,
          },
        },
        error:
          "Provider state could not be verified immediately before rollback. No mutation was sent.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.warn("ads.rollback.precondition_blocked");
    throw new AdsMutationPreconditionFailedError(
      approval.id,
      "rollback",
      "provider_state_unavailable",
      {
        expectedStateFingerprint:
          providerPrecondition.expectedStateFingerprint,
        cause: error,
        persistenceWarning,
      },
    );
  }

  if (!providerState.matches) {
    let persistenceWarning = false;
    try {
      await updateRollbackRecord(approval.id, "rollback_failed", {
        response: {
          precondition: {
            outcome: "blocked_no_write",
            reason: "provider_state_changed",
            expectedStateFingerprint:
              providerState.expectedStateFingerprint,
            actualStateFingerprint: providerState.actualStateFingerprint,
          },
        },
        error:
          "Provider-controlled fields changed after apply. No rollback was sent; reconcile the live state before retrying.",
      });
    } catch {
      persistenceWarning = true;
    }
    log.warn("ads.rollback.precondition_blocked");
    throw new AdsMutationPreconditionFailedError(
      approval.id,
      "rollback",
      "provider_state_changed",
      {
        expectedStateFingerprint: providerState.expectedStateFingerprint,
        actualStateFingerprint: providerState.actualStateFingerprint,
        persistenceWarning,
      },
    );
  }

  let response: Response;
  try {
    response = await sendAdsMutation(
      rollbackMutation,
      body,
      credential,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
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
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.rollback.reconciliation_required", { error });
    throw new AdsMutationReconciliationRequiredError(
      approval.id,
      "rollback",
      `The rollback outcome is uncertain. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { cause: error, persistenceWarning },
    );
  }

  let payload: unknown;
  try {
    payload = await readJsonResponseWithLimit(
      response,
      ADS_RESPONSE_LIMITS.mutationBytes,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
      await updateRollbackRecord(
        approval.id,
        "rollback_reconciliation_required",
        {
          error:
            error instanceof OpenAIAdsResponseTooLargeError
              ? "OpenAI Ads API rollback response exceeded the bounded response limit and was not retained."
              : "OpenAI Ads API rollback response could not be safely read and was not retained.",
        },
      );
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.rollback.reconciliation_required", {
      status: response.status,
      error,
    });
    throw new AdsMutationReconciliationRequiredError(
      approval.id,
      "rollback",
      `The Ads API rollback response could not be safely confirmed. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { cause: error, persistenceWarning },
    );
  }
  if (!response.ok && isAmbiguousMutationStatus(response.status)) {
    let persistenceWarning = false;
    try {
      await updateRollbackRecord(
        approval.id,
        "rollback_reconciliation_required",
        {
          response: payload,
          error: `OpenAI Ads API returned an uncertain HTTP ${response.status} rollback outcome.`,
        },
      );
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.rollback.reconciliation_required", {
      status: response.status,
    });
    throw new AdsMutationReconciliationRequiredError(
      approval.id,
      "rollback",
      `The Ads API returned an uncertain HTTP ${response.status} rollback outcome. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { persistenceWarning },
    );
  }

  if (!response.ok) {
    await updateRollbackRecord(approval.id, "rollback_failed", {
      response: payload,
      error: `OpenAI Ads API returned HTTP ${response.status}.`,
    });
    log.warn("ads.rollback.rejected", { status: response.status });
    throw new AdsMutationRejectedError(approval.id, response.status);
  }

  if (response.status !== 200) {
    let persistenceWarning = false;
    try {
      await updateRollbackRecord(
        approval.id,
        "rollback_reconciliation_required",
        {
          response: payload,
          error: `OpenAI Ads API returned unexpected success status ${response.status}.`,
        },
      );
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.rollback.reconciliation_required", {
      status: response.status,
    });
    throw new AdsMutationReconciliationRequiredError(
      approval.id,
      "rollback",
      `The Ads API returned an undocumented rollback success status. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { persistenceWarning },
    );
  }

  let confirmation: Awaited<ReturnType<typeof confirmAdsMutation>>;
  try {
    confirmation = await confirmAdsMutation(
      rollbackMutation,
      body,
      payload,
      credential,
    );
  } catch (error) {
    let persistenceWarning = false;
    try {
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
    } catch {
      persistenceWarning = true;
    }
    log.error("ads.rollback.reconciliation_required", { error });
    throw new AdsMutationReconciliationRequiredError(
      approval.id,
      "rollback",
      `The Ads API acknowledged the rollback, but its resulting state is unconfirmed. Approval ${approval.id} requires manual reconciliation and must not be retried automatically.`,
      { cause: error, persistenceWarning },
    );
  }

  try {
    await updateRollbackRecord(approval.id, "rolled_back", {
      response: confirmation,
    });
  } catch {
    log.error("ads.rollback.audit_persistence_failed");
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

  log.info("ads.rollback.completed");
  return {
    mode: "live" as const,
    applied: true,
    approvalId: approval.id,
    message: "The stored rollback was applied through the OpenAI Ads API.",
    payload: confirmation.acknowledgement,
    readback: confirmation.readback,
  };
}
