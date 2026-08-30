import {
  ApprovalStoreUnavailableError,
  ApprovalTransitionError,
  getApprovalAccountId,
} from "@/lib/audit/approval-store.server";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  isSecureSameOriginRequest,
  readBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";
import {
  applyStoredRollback,
  getAdsRuntimeMode,
} from "@/lib/openai-ads/client.server";
import { fetchLiveAdAccount } from "@/lib/openai-ads/data.server";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsApiKeyForAccount,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

export async function POST(
  request: Request,
  context: { params: Promise<{ approvalId: string }> },
) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin rollback is required." },
        { status: 403 },
      );
    }
    const [{ approvalId }, operatorId] = await Promise.all([
      context.params,
      requireOperatorId(),
      readBodyWithLimit(request, 1_024),
    ]);
    const accountId = await getApprovalAccountId(approvalId);
    const access = await requireAccountAccess(operatorId, accountId, "write");
    const credential = {
      kind: "account_api_key" as const,
      secret: await getAdsApiKeyForAccount(accountId),
      expectedAccountId: accountId,
    };
    const runtime = getAdsRuntimeMode({ hasAccountKey: true });
    if (!runtime.writeInfrastructureConfigured) {
      return Response.json(
        {
          error: `Live rollback is disabled. Missing gates: ${runtime.writeBlockers.join(", ")}.`,
        },
        { status: 503 },
      );
    }
    const account = await fetchLiveAdAccount(credential);
    if (account.id !== accountId) {
      throw new AccountAccessForbiddenError(
        "The stored credential does not match this approval's Ads account.",
      );
    }
    const result = await applyStoredRollback({
      approvalId,
      accountId,
      operatorId,
      access,
      credential,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The rollback request is too large." },
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
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ApprovalStoreUnavailableError ||
      error instanceof AdvertiserCredentialUnavailableError ||
      error instanceof TenancyStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof Error ? error.message : "Unable to apply rollback.";
    return Response.json({ error: message }, { status: 400 });
  }
}
