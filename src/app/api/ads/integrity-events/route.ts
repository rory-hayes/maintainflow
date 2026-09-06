import { z, ZodError } from "zod";

import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  ChangeIntegrityStoreUnavailableError,
  ChangeIntegrityTransitionError,
  listChangeIntegrityEvents,
  verifyChangeIntegrityStore,
} from "@/lib/openai-ads/change-integrity-store.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import {
  AccountAccessForbiddenError,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const NO_STORE_HEADERS = { "Cache-Control": "private, no-store" };

const querySchema = z
  .object({
    accountId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/\s/.test(value)),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    afterOpen: z.enum(["true", "false"]).optional(),
    afterDetectedAt: z.string().datetime().optional(),
    afterId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const cursorParts = [
      value.afterOpen,
      value.afterDetectedAt,
      value.afterId,
    ];
    const supplied = cursorParts.filter((part) => part !== undefined).length;
    if (supplied !== 0 && supplied !== cursorParts.length) {
      context.addIssue({
        code: "custom",
        path: ["afterDetectedAt"],
        message: "Every integrity pagination cursor field is required together.",
      });
    }
  });

function parseQuery(request: Request) {
  const search = new URL(request.url).searchParams;
  return querySchema.parse({
    accountId: search.get("accountId") ?? undefined,
    limit: search.get("limit") ?? undefined,
    afterOpen: search.get("afterOpen") ?? undefined,
    afterDetectedAt: search.get("afterDetectedAt") ?? undefined,
    afterId: search.get("afterId") ?? undefined,
  });
}

export async function GET(request: Request) {
  const log = createServerLogger("api.ads.integrity_events");
  try {
    const input = parseQuery(request);
    const operatorId = await requireOperatorId();
    await requireAccountAccess(operatorId, input.accountId, "read");
    if (!(await verifyChangeIntegrityStore())) {
      throw new ChangeIntegrityStoreUnavailableError(
        "Apply the change-integrity migration before loading account changes.",
      );
    }

    const page = await listChangeIntegrityEvents({
      accountId: input.accountId,
      limit: input.limit,
      cursor:
        input.afterOpen === undefined
          ? undefined
          : {
              reviewStatus: input.afterOpen === "true" ? "open" : "reviewed",
              detectedAt: input.afterDetectedAt!,
              id: input.afterId!,
            },
    });
    log.info("ads.integrity_events.loaded", {
      status: 200,
    });
    return Response.json(page, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof OperatorUnauthorizedError) {
      const status = error.status === 403 ? 403 : 401;
      return Response.json(
        { error: error.message },
        { status, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json(
        { error: error.message },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof ZodError || error instanceof ChangeIntegrityTransitionError) {
      return Response.json(
        { error: "Choose a valid account and integrity-events page cursor." },
        { status: 422, headers: NO_STORE_HEADERS },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof ChangeIntegrityStoreUnavailableError
    ) {
      log.error("ads.integrity_events.unavailable", { error, status: 503 });
      return Response.json(
        { error: error.message },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    log.error("ads.integrity_events.failed", { error, status: 500 });
    return Response.json(
      { error: "Unable to load integrity events safely." },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
