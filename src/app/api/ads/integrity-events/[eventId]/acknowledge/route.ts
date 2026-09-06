import { z, ZodError } from "zod";

import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperator,
} from "@/lib/auth/operator.server";
import {
  RequestBodyTooLargeError,
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
} from "@/lib/http/request-security.server";
import {
  ChangeIntegrityAuthorizationError,
  ChangeIntegrityStoreUnavailableError,
  ChangeIntegrityTransitionError,
  acknowledgeChangeIntegrityEvent,
  verifyChangeIntegrityStore,
} from "@/lib/openai-ads/change-integrity-store.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import {
  AccountAccessForbiddenError,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/\s/.test(value)),
    note: z.string().trim().min(10).max(1_000),
  })
  .strict();

const eventIdSchema = z.string().uuid();

export async function POST(
  request: Request,
  context: { params: Promise<{ eventId: string }> },
) {
  const log = createServerLogger("api.ads.integrity_review");
  try {
    if (!isSecureSameOriginRequest(request)) {
      log.warn("ads.integrity_review.rejected", { status: 403 });
      return Response.json(
        { error: "Secure same-origin integrity review is required." },
        { status: 403 },
      );
    }

    const [input, params, operator] = await Promise.all([
      readJsonBodyWithLimit(request, 4_096).then((value) =>
        requestSchema.parse(value),
      ),
      context.params,
      requireOperator(),
    ]);
    const eventId = eventIdSchema.parse(params.eventId);
    const access = await requireAccountAccess(
      operator.id,
      input.accountId,
      "write",
    );
    if (!(await verifyChangeIntegrityStore())) {
      throw new ChangeIntegrityStoreUnavailableError(
        "Apply the change-integrity migration before reviewing account changes.",
      );
    }

    const event = await acknowledgeChangeIntegrityEvent({
      accountId: input.accountId,
      eventId,
      operatorId: operator.id,
      reviewerName: operator.name,
      access,
      note: input.note,
    });
    log.info("ads.integrity_review.completed", { status: 200 });
    return Response.json({
      reviewed: true,
      event,
      message:
        "The integrity review was recorded without sending an OpenAI Ads change.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      log.warn("ads.integrity_review.rejected", { error, status: 413 });
      return Response.json(
        { error: "The integrity review request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      const status = error.status === 403 ? 403 : 401;
      log.warn("ads.integrity_review.rejected", { error, status });
      return Response.json({ error: error.message }, { status });
    }
    if (
      error instanceof AccountAccessForbiddenError ||
      error instanceof ChangeIntegrityAuthorizationError
    ) {
      log.warn("ads.integrity_review.rejected", { error, status: 403 });
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ChangeIntegrityTransitionError) {
      log.warn("ads.integrity_review.rejected", { error, status: 409 });
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      log.warn("ads.integrity_review.rejected", { error, status: 422 });
      return Response.json(
        {
          error:
            "Choose a valid integrity event and add a verification note of 10 to 1,000 characters.",
        },
        { status: 422 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof ChangeIntegrityStoreUnavailableError
    ) {
      log.error("ads.integrity_review.unavailable", { error, status: 503 });
      return Response.json({ error: error.message }, { status: 503 });
    }
    log.error("ads.integrity_review.failed", { error, status: 500 });
    return Response.json(
      { error: "Unable to record the integrity review safely." },
      { status: 500 },
    );
  }
}
