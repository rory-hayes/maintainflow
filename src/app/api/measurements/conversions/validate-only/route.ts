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

export async function POST(request: Request) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return json(
        { error: "Secure same-origin conversion validation is required." },
        { status: 403 },
      );
    }

    const [operatorId, input] = await Promise.all([
      requireOperatorId(),
      readJsonBodyWithLimit(
        request,
        CONVERSIONS_PAYLOAD_MAX_BYTES + REQUEST_WRAPPER_BYTES,
      ).then((value) => requestSchema.parse(value)),
    ]);
    await requireAccountAccess(operatorId, input.accountId, "write");

    const result = await validateConversionsApiPayload({
      accountId: input.accountId,
      payload: input.payload,
    });

    return json({
      ...result,
      message:
        "OpenAI accepted the validate-only request. This request did not save the submitted events.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return json(
        { error: "The conversion validation request is too large." },
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
      return json(
        { error: error.message, providerStatus: error.providerStatus },
        { status: 502 },
      );
    }
    if (error instanceof ConversionsApiTransportUnconfirmedError) {
      return json({ error: error.message }, { status: 502 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof ConversionsApiValidationUnavailableError
    ) {
      return json({ error: error.message }, { status: 503 });
    }
    return json(
      { error: "OpenAI conversion validation could not be completed." },
      { status: 400 },
    );
  }
}
