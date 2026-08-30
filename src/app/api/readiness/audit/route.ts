import { ZodError } from "zod";

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
  auditStorefront,
  normalizeAuditUrl,
} from "@/lib/readiness/audit.server";
import {
  consumeReadinessAuditQuota,
  getTrustedReadinessClientIp,
  isReadinessRateLimitConfigured,
  type ReadinessRateLimitDecision,
} from "@/lib/readiness/rate-limit.server";
import {
  ReadinessHistoryStoreUnavailableError,
  recordReadinessAuditRun,
  verifyReadinessHistoryStore,
} from "@/lib/readiness/history.server";
import { readinessAuditRequestSchema } from "@/lib/readiness/schema";
import type { AccountAccess } from "@/lib/tenancy/schema";
import {
  AccountAccessForbiddenError,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

function quotaHeaders(decision: ReadinessRateLimitDecision) {
  return {
    ...NO_STORE_HEADERS,
    "X-RateLimit-Limit": String(decision.limit),
    "X-RateLimit-Remaining": String(decision.remaining),
    "X-RateLimit-Reset": String(
      Math.ceil(decision.resetAt.getTime() / 1_000),
    ),
  };
}

export async function POST(request: Request) {
  if (!isSecureSameOriginRequest(request)) {
    return Response.json(
      { error: "Secure same-origin readiness requests are required." },
      { status: 403, headers: NO_STORE_HEADERS },
    );
  }
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return Response.json(
      { error: "Send the readiness request as application/json." },
      { status: 415, headers: NO_STORE_HEADERS },
    );
  }

  let input: { url: string; accountId?: string };
  let normalizedUrl: URL;
  try {
    input = readinessAuditRequestSchema.parse(
      await readJsonBodyWithLimit(request, 4_096),
    );
    normalizedUrl = normalizeAuditUrl(input.url);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The readiness audit request is too large." },
        { status: 413, headers: NO_STORE_HEADERS },
      );
    }
    return Response.json(
      { error: "Enter a valid public landing-page URL." },
      { status: 422, headers: NO_STORE_HEADERS },
    );
  }

  let historyContext:
    | { operatorId: string; accountId: string; access: AccountAccess }
    | undefined;
  if (input.accountId) {
    try {
      const operatorId = await requireOperatorId();
      const access = await requireAccountAccess(
        operatorId,
        input.accountId,
        "write",
      );
      if (!(await verifyReadinessHistoryStore())) {
        throw new ReadinessHistoryStoreUnavailableError(
          "Readiness history storage is not ready.",
        );
      }
      historyContext = { operatorId, accountId: input.accountId, access };
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
      console.error("Readiness history authorization failed", error);
      return Response.json(
        { error: "Readiness history authorization is unavailable." },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
  }

  let quota: ReadinessRateLimitDecision | undefined;
  if (isReadinessRateLimitConfigured()) {
    const clientIp = getTrustedReadinessClientIp(request);
    if (!clientIp) {
      return Response.json(
        { error: "The readiness audit cannot verify the client address." },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    try {
      quota = await consumeReadinessAuditQuota({
        clientIp,
        hostname: normalizedUrl.hostname,
      });
    } catch (error) {
      console.error("Readiness rate-limit check failed", error);
      return Response.json(
        { error: "The readiness audit capacity check is unavailable." },
        { status: 503, headers: NO_STORE_HEADERS },
      );
    }
    if (!quota.allowed) {
      const retryAfter = Math.max(
        1,
        Math.ceil((quota.resetAt.getTime() - Date.now()) / 1_000),
      );
      return Response.json(
        { error: "Too many readiness audits. Try again after the limit resets." },
        {
          status: 429,
          headers: {
            ...quotaHeaders(quota),
            "Retry-After": String(retryAfter),
          },
        },
      );
    }
  } else if (process.env.NODE_ENV === "production") {
    return Response.json(
      { error: "Readiness audit rate limiting is not configured." },
      { status: 503, headers: NO_STORE_HEADERS },
    );
  }

  try {
    const audit = await auditStorefront(normalizedUrl.toString());
    if (!historyContext) {
      return Response.json(audit, {
        headers: quota ? quotaHeaders(quota) : NO_STORE_HEADERS,
      });
    }

    try {
      const historyEntry = await recordReadinessAuditRun({
        ...historyContext,
        audit,
      });
      return Response.json({ ...audit, historyEntry }, {
        headers: quota ? quotaHeaders(quota) : NO_STORE_HEADERS,
      });
    } catch (error) {
      console.error("Readiness audit history save failed", error);
      return Response.json(
        {
          ...audit,
          historySaveError:
            "The scan completed, but its account history could not be saved.",
        },
        { headers: quota ? quotaHeaders(quota) : NO_STORE_HEADERS },
      );
    }
  } catch (error) {
    const message =
      error instanceof ZodError
        ? "Enter a valid public landing-page URL."
        : error instanceof Error
          ? error.message
          : "The landing page could not be audited.";

    return Response.json(
      { error: message },
      {
        status: 422,
        headers: quota ? quotaHeaders(quota) : NO_STORE_HEADERS,
      },
    );
  }
}
