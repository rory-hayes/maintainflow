import { z, ZodError } from "zod";

import {
  ApprovalStoreUnavailableError,
  ApprovalTransitionError,
  getApprovalAccountId,
  reconcileApprovalRecord,
} from "@/lib/audit/approval-store.server";
import { reconciliationActionSchema } from "@/lib/audit/approval-schema";
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
  AccountAccessForbiddenError,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({
    action: reconciliationActionSchema,
    note: z.string().trim().min(10).max(1000),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin reconciliation is required." },
        { status: 403 },
      );
    }
    if (!process.env.DATABASE_URL) {
      throw new ApprovalStoreUnavailableError();
    }

    const [body, { approvalId }, operatorId] = await Promise.all([
      readJsonBodyWithLimit(request, 4_096).then((value) =>
        requestSchema.parse(value),
      ),
      context.params,
      requireOperatorId(),
    ]);
    const accountId = await getApprovalAccountId(approvalId);
    const access = await requireAccountAccess(operatorId, accountId, "write");
    const record = await reconcileApprovalRecord({
      id: approvalId,
      accountId,
      operatorId,
      action: body.action,
      note: body.note,
      access,
    });
    return Response.json({
      reconciled: true,
      status: record.status,
      message: "The approval record was reconciled without sending an Ads API write.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The reconciliation request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ApprovalTransitionError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "Choose a valid outcome and add a reconciliation note of at least 10 characters." },
        { status: 422 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ApprovalStoreUnavailableError ||
      error instanceof TenancyStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof Error ? error.message : "Unable to reconcile approval.";
    return Response.json({ error: message }, { status: 400 });
  }
}
