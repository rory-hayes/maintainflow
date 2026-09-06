import { z, ZodError } from "zod";

import {
  cancelChangeApprovalRequest,
  ChangeApprovalRequestForbiddenError,
  ChangeApprovalRequestStoreUnavailableError,
  ChangeApprovalRequestTransitionError,
} from "@/lib/approvals/change-request-store.server";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperator,
} from "@/lib/auth/operator.server";
import {
  approvalNotificationAttemptMessage,
  attemptApprovalNotificationDelivery,
} from "@/lib/approvals/notification-route.server";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";

const requestSchema = z
  .object({ version: z.number().int().positive() })
  .strict();

export async function POST(
  request: Request,
  context: RouteContext<"/api/approvals/requests/[requestId]/cancel">,
) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin cancellation is required." },
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
    const result = await cancelChangeApprovalRequest({
      requestId,
      operator,
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
      message: `Approval request cancelled. ${approvalNotificationAttemptMessage(notificationAttempt, "requester")} No external change was made.`,
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The cancellation request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      const status = error.status === 403 ? 403 : 401;
      return Response.json({ error: error.message }, { status });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "Enter a valid approval request version." },
        { status: 422 },
      );
    }
    if (error instanceof ChangeApprovalRequestForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ChangeApprovalRequestTransitionError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ChangeApprovalRequestStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json(
      { error: "Unable to cancel the approval request safely." },
      { status: 500 },
    );
  }
}
