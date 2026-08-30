import "server-only";

import {
  auditConversionsApiPayload,
  type ConversionPayloadAudit,
} from "../readiness/conversions-api";
import type { ConversionsApiCredential } from "../credentials/crypto.server";
import type { ConversionsConnectionStatus } from "./conversions-connection";
import {
  ConversionsCredentialUnavailableError,
  getConversionsApiCredentialForAccount,
  getConversionsApiCredentialMetadataForAccount,
  verifyConversionCredentialStore,
} from "../tenancy/store.server";

const CONVERSIONS_API_ORIGIN = "https://bzr.openai.com";
const CONVERSIONS_API_PATH = "/v1/events";
const CONVERSIONS_API_TIMEOUT_MS = 15_000;
const MAINTAINFLOW_INTEGRATION_SOURCE = "maintainflow";

function isValidationEnabled() {
  const releaseStage = process.env.MAINTAINFLOW_RELEASE_STAGE;
  return (
    (releaseStage === "private_read" || releaseStage === "live_write") &&
    process.env.OPENAI_CONVERSIONS_VALIDATE_ONLY_ENABLED?.trim().toLowerCase() ===
      "true"
  );
}

function getEnvironmentCredential(accountId: string) {
  const configuredAccountId = process.env.OPENAI_CONVERSIONS_ACCOUNT_ID?.trim();
  const pixelId = process.env.OPENAI_CONVERSIONS_PIXEL_ID?.trim();
  const apiKey = process.env.OPENAI_CONVERSIONS_API_KEY?.trim();
  return configuredAccountId === accountId && pixelId && apiKey
    ? { pixelId, apiKey }
    : null;
}

export async function getConversionsApiConnectionStatus(
  accountId: string,
): Promise<ConversionsConnectionStatus> {
  const validationEnabled = isValidationEnabled();
  const storeReady = await verifyConversionCredentialStore();
  if (storeReady) {
    const metadata = await getConversionsApiCredentialMetadataForAccount(
      accountId,
    );
    if (metadata) {
      return {
        state: "connected",
        source: "vault",
        validationEnabled,
        credentialVersion: metadata.credentialVersion,
        validatedAt: metadata.validatedAt.toISOString(),
        providerStatus: metadata.providerStatus,
        eventCount: metadata.eventCount,
      };
    }
  }

  if (getEnvironmentCredential(accountId)) {
    return {
      state: "configured",
      source: "environment",
      validationEnabled,
      credentialVersion: null,
      validatedAt: null,
      providerStatus: null,
      eventCount: null,
    };
  }

  return {
    state: storeReady ? "not_connected" : "unavailable",
    source: null,
    validationEnabled,
    credentialVersion: null,
    validatedAt: null,
    providerStatus: null,
    eventCount: null,
  };
}

export type ConversionsApiValidationResult = {
  status: "validated";
  mode: "validate_only";
  eventCount: number;
  providerStatus: number;
};

export class ConversionsApiValidationUnavailableError extends Error {
  constructor() {
    super("OpenAI Conversions API validation is not configured for this account.");
    this.name = "ConversionsApiValidationUnavailableError";
  }
}

export class ConversionsApiPayloadInvalidError extends Error {
  readonly audit: ConversionPayloadAudit;

  constructor(audit: ConversionPayloadAudit) {
    super("The conversion payload did not pass the documented OpenAI schema checks.");
    this.name = "ConversionsApiPayloadInvalidError";
    this.audit = audit;
  }
}

export class ConversionsApiProviderRejectedError extends Error {
  readonly providerStatus: number;

  constructor(providerStatus: number) {
    super("OpenAI did not accept the validate-only conversion request.");
    this.name = "ConversionsApiProviderRejectedError";
    this.providerStatus = providerStatus;
  }
}

export class ConversionsApiTransportUnconfirmedError extends Error {
  constructor() {
    super("OpenAI validation could not be confirmed. No result was recorded by MaintainFlow.");
    this.name = "ConversionsApiTransportUnconfirmedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function auditInvalidPayload(payload: unknown, now: Date) {
  try {
    return auditConversionsApiPayload(JSON.stringify(payload) ?? "", now);
  } catch {
    return auditConversionsApiPayload("", now);
  }
}

async function getValidationConfig(
  accountId: string,
  suppliedCredential?: ConversionsApiCredential,
): Promise<ConversionsApiCredential> {
  if (!isValidationEnabled()) {
    throw new ConversionsApiValidationUnavailableError();
  }

  if (
    suppliedCredential?.apiKey.trim() &&
    suppliedCredential.pixelId.trim()
  ) {
    return {
      apiKey: suppliedCredential.apiKey.trim(),
      pixelId: suppliedCredential.pixelId.trim(),
    };
  }

  if (await verifyConversionCredentialStore()) {
    try {
      return await getConversionsApiCredentialForAccount(accountId);
    } catch (error) {
      if (!(error instanceof ConversionsCredentialUnavailableError)) throw error;
    }
  }

  const environmentCredential = getEnvironmentCredential(accountId);
  if (!environmentCredential) {
    throw new ConversionsApiValidationUnavailableError();
  }
  return environmentCredential;
}

function prepareValidationBody(payload: unknown, now: Date) {
  if (!isRecord(payload) || payload.validate_only !== true) {
    throw new ConversionsApiPayloadInvalidError(auditInvalidPayload(payload, now));
  }

  let body: string;
  try {
    body = JSON.stringify({
      ...payload,
      validate_only: true,
      integration_source: MAINTAINFLOW_INTEGRATION_SOURCE,
    });
  } catch {
    throw new ConversionsApiPayloadInvalidError(auditInvalidPayload(payload, now));
  }

  const audit = auditConversionsApiPayload(body, now);
  if (audit.blockerCount > 0 || audit.validateOnly !== true) {
    throw new ConversionsApiPayloadInvalidError(audit);
  }

  return { audit, body };
}

export async function validateConversionsApiPayload(options: {
  accountId: string;
  payload: unknown;
  credential?: ConversionsApiCredential;
  now?: Date;
}): Promise<ConversionsApiValidationResult> {
  const config = await getValidationConfig(
    options.accountId,
    options.credential,
  );
  const { audit, body } = prepareValidationBody(
    options.payload,
    options.now ?? new Date(),
  );
  const url = new URL(CONVERSIONS_API_PATH, CONVERSIONS_API_ORIGIN);
  url.searchParams.set("pid", config.pixelId);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(CONVERSIONS_API_TIMEOUT_MS),
    });
  } catch {
    throw new ConversionsApiTransportUnconfirmedError();
  }

  const providerStatus = response.status;
  try {
    await response.body?.cancel();
  } catch {
    // The response body is undocumented and intentionally never parsed or exposed.
  }

  if (!response.ok) {
    throw new ConversionsApiProviderRejectedError(providerStatus);
  }

  return {
    status: "validated",
    mode: "validate_only",
    eventCount: audit.eventCount,
    providerStatus,
  };
}
