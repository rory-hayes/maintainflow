import { z, ZodError } from "zod";

import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
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
import { createServerLogger } from "@/lib/observability/logger.server";
import { CONVERSIONS_PAYLOAD_MAX_BYTES } from "@/lib/readiness/conversions-api";
import {
  AccountAccessForbiddenError,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({
    accountId: z.string().trim().min(1).max(200),
    payload: z.record(z.unknown()),
  })
  .strict();

const REQUEST_WRAPPER_BYTES = 16_384;

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Cache-Control", "no-store");
  return Response.json(body, { ...init, headers });
}

class ConversionValidationRequestInvalidError extends Error {
  constructor() {
    super("The conversion validation request is invalid.");
    this.name = "ConversionValidationRequestInvalidError";
  }
}

async function readConversionValidationRequest(request: Request) {
  try {
    const value = await readJsonBodyWithLimit(
      request,
      CONVERSIONS_PAYLOAD_MAX_BYTES + REQUEST_WRAPPER_BYTES,
    );
    return requestSchema.parse(value);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new ConversionValidationRequestInvalidError();
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const log = createServerLogger("api.measurements.conversions_validate");
  const startedAt = Date.now();
  const fields = (status: number, error?: unknown) => ({
    status,
    durationMs: Date.now() - startedAt,
    ...(error === undefined ? {} : { error }),
  });

  try {
    if (!isSecureSameOriginRequest(request)) {
      log.warn("conversions.validate_only.rejected", fields(403));
      return json(
        { error: "Secure same-origin conversion validation is required." },
        { status: 403 },
      );
    }

    const [operatorId, input] = await Promise.all([
      requireOperatorId(),
      readConversionValidationRequest(request),
    ]);
    await requireAccountAccess(operatorId, input.accountId, "write");

    const result = await validateConversionsApiPayload({
      accountId: input.accountId,
      payload: input.payload,
    });

    log.info("conversions.validate_only.completed", fields(200));
    return json({
      ...result,
      message:
        "OpenAI accepted the validate-only request. This request did not save the submitted events.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      log.warn("conversions.validate_only.rejected", fields(413, error));
      return json(
        { error: "The conversion validation request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      log.warn("conversions.validate_only.rejected", fields(401, error));
      return json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      log.warn("conversions.validate_only.rejected", fields(403, error));
      return json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof ConversionValidationRequestInvalidError ||
      error instanceof ConversionsApiPayloadInvalidError
    ) {
      log.warn("conversions.validate_only.rejected", fields(422, error));
      return json(
        {
          error:
            error instanceof ConversionsApiPayloadInvalidError
              ? error.message
              : "Enter a valid account ID and documented conversion payload.",
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
      log.warn("conversions.validate_only.rejected", fields(502, error));
      return json(
        { error: error.message, providerStatus: error.providerStatus },
        { status: 502 },
      );
    }
    if (error instanceof ConversionsApiTransportUnconfirmedError) {
      log.error("conversions.validate_only.unavailable", fields(502, error));
      return json({ error: error.message }, { status: 502 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof ConversionsApiValidationUnavailableError
    ) {
      log.error("conversions.validate_only.unavailable", fields(503, error));
      return json({ error: error.message }, { status: 503 });
    }
    log.error("conversions.validate_only.failed", fields(500, error));
    return json(
      { error: "OpenAI conversion validation could not be completed." },
      { status: 500 },
    );
  }
}
