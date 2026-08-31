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
  AdsMutationPreconditionFailedError,
  AdsMutationReconciliationRequiredError,
  AdsMutationRejectedError,
  applyStoredRollback,
  getAdsRuntimeMode,
} from "@/lib/openai-ads/client.server";
import { fetchLiveAdAccount } from "@/lib/openai-ads/data.server";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsCredentialMaterialForAccount,
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
    const credentialMaterial =
      await getAdsCredentialMaterialForAccount(accountId);
    const credential = {
      kind: "account_api_key" as const,
      secret: credentialMaterial.apiKey,
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
      credentialGeneration: credentialMaterial.credentialGeneration,
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
    if (error instanceof AdsMutationPreconditionFailedError) {
      const providerUnavailable =
        error.reason === "provider_state_unavailable";
      return Response.json(
        {
          error: providerUnavailable
            ? "MaintainFlow could not verify the current OpenAI Ads state. No rollback was sent; retry after provider reads recover."
            : "OpenAI Ads changed after this rollback became eligible. No rollback was sent; reconcile the live state before retrying.",
          code: error.reason,
          approvalId: error.approvalId,
          operation: error.operation,
          noMutationSent: true,
          requiresFreshReview: error.requiresFreshReview,
          persistenceWarning: error.persistenceWarning,
        },
        {
          status: providerUnavailable ? 503 : 409,
          ...(providerUnavailable
            ? { headers: { "Retry-After": "30" } }
            : {}),
        },
      );
    }
    if (error instanceof AdsMutationReconciliationRequiredError) {
      return Response.json(
        {
          error:
            "The Ads API rollback outcome is uncertain and requires manual reconciliation. Do not retry this action.",
          code: "reconciliation_required",
          approvalId: error.approvalId,
          operation: error.operation,
          mustNotRetry: true,
          persistenceWarning: error.persistenceWarning,
        },
        { status: 409 },
      );
    }
    if (error instanceof AdsMutationRejectedError) {
      return Response.json(
        {
          error:
            "OpenAI Ads rejected the rollback. No successful rollback was recorded.",
          code: "provider_rejected",
          approvalId: error.approvalId,
        },
        { status: 502 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ApprovalStoreUnavailableError ||
      error instanceof AdvertiserCredentialUnavailableError ||
      error instanceof TenancyStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json(
      { error: "Unable to apply rollback safely." },
      { status: 400 },
    );
  }
}
