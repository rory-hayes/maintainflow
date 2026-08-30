import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import {
  ReadinessHistoryStoreUnavailableError,
  listReadinessAuditRuns,
  verifyReadinessHistoryStore,
} from "@/lib/readiness/history.server";
import {
  AccountAccessForbiddenError,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(
  _request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  const log = createServerLogger("api.readiness.history");
  try {
    const [operatorId, { accountId }] = await Promise.all([
      requireOperatorId(),
      context.params,
    ]);
    const access = await requireAccountAccess(operatorId, accountId, "read");
    if (!(await verifyReadinessHistoryStore())) {
      throw new ReadinessHistoryStoreUnavailableError(
        "Readiness history storage is not ready.",
      );
    }
    return Response.json(
      {
        entries: await listReadinessAuditRuns({
          accountId,
          operatorId,
          access,
        }),
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof OperatorUnauthorizedError) {
      return Response.json(
        { error: error.message },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json(
        { error: error.message },
        { status: 403, headers: NO_STORE_HEADERS },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof ReadinessHistoryStoreUnavailableError
    ) {
      return Response.json(
        { error: error.message },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    log.error("readiness.history_load.failed", { error, status: 400 });
    return Response.json(
      { error: "Readiness history could not be loaded." },
      { status: 400, headers: NO_STORE_HEADERS },
    );
  }
}
