import { z } from "zod";

import { getApprovalNotificationAppOrigin } from "@/lib/approvals/notification-config.server";
import { resolveApprovalNotificationDeepLink } from "@/lib/approvals/notification-delivery-store.server";
import { isWorkspaceAdmissionAllowed } from "@/lib/auth/config";
import { getOptionalOperator } from "@/lib/auth/operator.server";

export const runtime = "nodejs";

function noStore(status: number) {
  return new Response("Not found.", {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function redirectNoStore(target: URL) {
  return new Response(null, {
    status: 302,
    headers: { Location: target.toString(), "Cache-Control": "no-store" },
  });
}

export async function GET(
  _request: Request,
  context: RouteContext<"/approvals/open/[deliveryId]">,
) {
  let deliveryId: string;
  try {
    deliveryId = z.string().uuid().parse(
      (await context.params).deliveryId,
    );
  } catch {
    return noStore(404);
  }
  let appOrigin: string;
  let operator: Awaited<ReturnType<typeof getOptionalOperator>>;
  try {
    appOrigin = getApprovalNotificationAppOrigin();
    operator = await getOptionalOperator();
  } catch {
    return noStore(503);
  }
  if (!operator) {
    const signIn = new URL("/auth/sign-in", appOrigin);
    signIn.searchParams.set("returnTo", `/approvals/open/${deliveryId}`);
    return redirectNoStore(signIn);
  }
  if (!isWorkspaceAdmissionAllowed(operator.id)) return noStore(404);
  try {
    const destination = await resolveApprovalNotificationDeepLink({
      deliveryId,
      operatorId: operator.id,
    });
    if (!destination) return noStore(404);
    const target = new URL("/app", appOrigin);
    target.searchParams.set("tab", "approvals");
    target.searchParams.set("organization", destination.organizationId);
    target.searchParams.set("account", destination.accountId);
    target.searchParams.set(
      "approvalFilter",
      destination.eventType === "review_requested"
        ? "needs-review"
        : destination.eventType === "approval_approved" &&
            destination.source === "live"
          ? "ready-to-apply"
          : "history",
    );
    target.searchParams.set("approvalRequest", destination.approvalRequestId);
    return redirectNoStore(target);
  } catch {
    return noStore(503);
  }
}
