import { z, ZodError } from "zod";

import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  CredentialVaultUnavailableError,
  encryptConversionsApiCredential,
  isCredentialVaultConfigured,
} from "@/lib/credentials/crypto.server";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";
import {
  ConversionsApiPayloadInvalidError,
  ConversionsApiProviderRejectedError,
  ConversionsApiTransportUnconfirmedError,
  ConversionsApiValidationUnavailableError,
  validateConversionsApiPayload,
} from "@/lib/openai-ads/conversions.server";
import { CONVERSIONS_PAYLOAD_MAX_BYTES } from "@/lib/readiness/conversions-api";
import {
  AccountAccessForbiddenError,
  ConversionsCredentialUnavailableError,
  requireAccountAccess,
  rotateConversionsApiCredential,
  TenancyStoreUnavailableError,
  verifyConversionCredentialStore,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({
    pixelId: z.string().trim().min(1).max(4096),
    conversionsApiKey: z.string().trim().min(10).max(4096),
    validationPayload: z.record(z.unknown()),
  })
  .strict();

const CONNECTION_WRAPPER_BYTES = 32_768;

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return json(
        { error: "Secure same-origin measurement setup is required." },
        { status: 403 },
      );
    }

    const [operatorId, { accountId }, input] = await Promise.all([
      requireOperatorId(),
      context.params,
      readJsonBodyWithLimit(
        request,
        CONVERSIONS_PAYLOAD_MAX_BYTES + CONNECTION_WRAPPER_BYTES,
      ).then((value) => requestSchema.parse(value)),
    ]);
    const access = await requireAccountAccess(operatorId, accountId, "write");
    if (
      !isCredentialVaultConfigured() ||
      !(await verifyConversionCredentialStore())
    ) {
      throw new CredentialVaultUnavailableError(
        "The encrypted conversion credential vault is not ready.",
      );
    }

    const candidate = {
      pixelId: input.pixelId,
      apiKey: input.conversionsApiKey,
    };
    const validation = await validateConversionsApiPayload({
      accountId,
      credential: candidate,
      payload: input.validationPayload,
    });

    const validatedAt = new Date();
    const credential = encryptConversionsApiCredential({
      credential: candidate,
      externalAccountId: accountId,
    });
    const result = await rotateConversionsApiCredential({
      operatorId,
      accountId,
      access,
      credential,
      validatedAt,
      validation: {
        providerStatus: validation.providerStatus,
        eventCount: validation.eventCount,
      },
    });

    return json({
      connected: true,
      mode: "validate_only",
      credentialVersion: result.credentialVersion,
      validatedAt: result.validatedAt.toISOString(),
      message:
        "The Pixel and Conversions API key passed a dry-run request and were encrypted for the selected account.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json(
        { error: "The conversion connection request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      return json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      return json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      error instanceof ConversionsApiPayloadInvalidError
    ) {
      return json(
        {
          error:
            error instanceof ConversionsApiPayloadInvalidError
              ? error.message
              : "Enter a Pixel ID, Conversions API key, and documented dry-run payload.",
          ...(error instanceof ConversionsApiPayloadInvalidError
            ? {
                eventCount: error.audit.eventCount,
                blockerCount: error.audit.blockerCount,
              }
            : {}),
        },
        { status: 422 },
      );
    }
    if (error instanceof ConversionsApiProviderRejectedError) {
      return json(
        { error: error.message, providerStatus: error.providerStatus },
        {
          status:
            error.providerStatus >= 400 && error.providerStatus < 500
              ? 422
              : 502,
        },
      );
    }
    if (error instanceof ConversionsApiTransportUnconfirmedError) {
      return json({ error: error.message }, { status: 502 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof CredentialVaultUnavailableError ||
      error instanceof ConversionsCredentialUnavailableError ||
      error instanceof ConversionsApiValidationUnavailableError
    ) {
      return json({ error: error.message }, { status: 503 });
    }
    return json(
      { error: "The conversion credentials could not be connected." },
      { status: 400 },
    );
  }
}
