import { z, ZodError } from "zod";

import {
  ChangeApprovalRequestForbiddenError,
  ChangeApprovalRequestInvalidError,
  ChangeApprovalRequestStoreUnavailableError,
  ChangeApprovalRequestTransitionError,
  decideChangeApprovalRequest,
} from "@/lib/approvals/change-request-store.server";
import { changeApprovalDecisionActionSchema } from "@/lib/approvals/change-request-schema";
import {
  approvalNotificationAttemptMessage,
  attemptApprovalNotificationDelivery,
} from "@/lib/approvals/notification-route.server";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperator,
} from "@/lib/auth/operator.server";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";

const requestSchema = z
  .object({
    action: changeApprovalDecisionActionSchema,
    note: z.string().trim().min(1).max(500).optional(),
    version: z.number().int().positive(),
  })
  .strict();

export async function POST(
  request: Request,
  context: RouteContext<"/api/approvals/requests/[requestId]/decision">,
) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin approval is required." },
        { status: 403 },
      );
    }
    const [requestId, operator, body] = await Promise.all([
      context.params.then((params) =>
        z.string().uuid().parse(params.requestId),
      ),
      requireOperator(),
      readJsonBodyWithLimit(request, 4_096).then((value) =>
        requestSchema.parse(value),
      ),
    ]);
    const result = await decideChangeApprovalRequest({
      requestId,
      operator,
      action: body.action,
      note: body.note,
      expectedVersion: body.version,
    });
    const notificationAttempt = await attemptApprovalNotificationDelivery(
      result.notificationDeliveryIds,
    );
    const responseResult = {
      id: result.id,
      status: result.status,
      version: result.version,
    };
    return Response.json({
      ...responseResult,
      notification: notificationAttempt,
      message:
        result.status === "approved"
          ? `Approved for later execution. ${approvalNotificationAttemptMessage(notificationAttempt, "requester")} No external change was made.`
          : `Changes requested. ${approvalNotificationAttemptMessage(notificationAttempt, "requester")} No external change was made.`,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The approval decision is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      const status = error.status === 403 ? 403 : 401;
      return Response.json({ error: error.message }, { status });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "Enter a valid approval decision and request version." },
        { status: 422 },
      );
    }
    if (error instanceof ChangeApprovalRequestForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof ChangeApprovalRequestInvalidError ||
      error instanceof ChangeApprovalRequestTransitionError
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ChangeApprovalRequestStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json(
      { error: "Unable to record the approval decision safely." },
      { status: 500 },
    );
  }
}
