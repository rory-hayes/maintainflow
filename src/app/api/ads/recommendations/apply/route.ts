import {
  AdsMutationPreconditionFailedError,
  AdsMutationReconciliationRequiredError,
  AdsMutationRejectedError,
  applyAdsMutation,
  getAdsRuntimeMode,
  OpenAIAdsApiError,
  type AdsApiCredential,
} from "@/lib/openai-ads/client.server";
import {
  getLiveWorkbench,
  LiveSyncUnavailableError,
} from "@/lib/openai-ads/live-sync.server";
import { demoAccount, getDemoRecommendation } from "@/lib/openai-ads/demo-data";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  ApprovalStoreUnavailableError,
  ApprovalTransitionError,
} from "@/lib/audit/approval-store.server";
import { recommendationApprovalFingerprint } from "@/lib/audit/recommendation-decision";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsCredentialMaterialForAccount,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";
import type { AccountAccess } from "@/lib/tenancy/schema";
import { z, ZodError } from "zod";

const requestSchema = z
  .object({
    recommendationId: z.string().min(1),
    recommendationSource: z.enum(["demo", "live"]).optional(),
    accountId: z.string().min(1).max(200).optional(),
    recommendationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export async function POST(request: Request) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin approval is required." },
        { status: 403 },
      );
    }
    const body = requestSchema.parse(
      await readJsonBodyWithLimit(request, 4_096),
    );
    let runtime = getAdsRuntimeMode();
    let operatorId: string | undefined;
    let accountId = demoAccount.id;
    let recommendation = getDemoRecommendation(body.recommendationId);
    let access: AccountAccess | undefined;
    let credential: AdsApiCredential | undefined;
    let credentialGeneration: string | undefined;

    if (
      !body.accountId &&
      runtime.liveDataRequested &&
      runtime.liveReadStage &&
      body.recommendationSource !== "demo"
    ) {
      return Response.json(
        {
          error:
            "Select an authorized advertiser account before applying a live recommendation.",
        },
        { status: 422 },
      );
    }

    if (body.accountId) {
      operatorId = await requireOperatorId();
      access = await requireAccountAccess(
        operatorId,
        body.accountId,
        "write",
      );
      const credentialMaterial =
        await getAdsCredentialMaterialForAccount(body.accountId);
      credential = {
        kind: "account_api_key",
        secret: credentialMaterial.apiKey,
        expectedAccountId: body.accountId,
      };
      credentialGeneration = credentialMaterial.credentialGeneration;
      runtime = getAdsRuntimeMode({ hasAccountKey: true });
      accountId = body.accountId;
      if (runtime.dataSource === "live") {
        const live = (
          await getLiveWorkbench({
            accountId: body.accountId,
            credentialGeneration: credentialMaterial.credentialGeneration,
            credential,
            policy: "mutation",
          })
        ).data;
        recommendation = live.recommendations.find(
          (item) => item.id === body.recommendationId,
        );
      }
    }

    if (!recommendation) {
      return Response.json(
        { error: "Recommendation not found." },
        { status: 404 },
      );
    }
    if (
      body.recommendationSource &&
      body.recommendationSource !== recommendation.source
    ) {
      return Response.json(
        {
          error:
            "This recommendation source changed after it was displayed. Refresh before applying it.",
        },
        { status: 409 },
      );
    }
    if (
      body.recommendationFingerprint !==
      recommendationApprovalFingerprint(recommendation)
    ) {
      return Response.json(
        {
          error:
            "This recommendation changed after it was displayed. Refresh and review the exact proposed change before applying it.",
        },
        { status: 409 },
      );
    }

    const result = await applyAdsMutation(recommendation, {
      accountId,
      operatorId,
      access,
      credential,
      credentialGeneration,
    });
    return Response.json(result);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The recommendation request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "Enter a valid recommendation and optional Ads account." },
        { status: 422 },
      );
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
            ? "MaintainFlow could not verify the current OpenAI Ads state. No write was sent; retry after provider reads recover."
            : "OpenAI Ads changed after this recommendation was reviewed. No write was sent; refresh and review the current recommendation.",
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
            "The Ads API outcome is uncertain and requires manual reconciliation. Do not retry this action.",
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
            "OpenAI Ads rejected the approved change. No successful application was recorded.",
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
    if (error instanceof LiveSyncUnavailableError) {
      if (error.refreshFailure === "account_mismatch") {
        return Response.json(
          {
            error:
              "The stored credential does not match the selected Ads account.",
          },
          { status: 403 },
        );
      }
      const retryAfterSeconds = error.retryAfter
        ? Math.max(
            1,
            Math.ceil((error.retryAfter.getTime() - Date.now()) / 1_000),
          )
        : 30;
      return Response.json(
        {
          error:
            "A fresh OpenAI Ads snapshot is required before applying this recommendation. Retry after live sync recovers.",
        },
        {
          status: 503,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
    if (error instanceof OpenAIAdsApiError) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((error.retryAfterMs ?? 30_000) / 1_000),
      );
      return Response.json(
        {
          error:
            error.status === 401 || error.status === 403
              ? "OpenAI Ads rejected the connected credential. Reconnect the advertiser account before retrying."
              : "OpenAI Ads could not safely apply the approved change. No success has been recorded.",
        },
        {
          status: error.status === 429 || error.status >= 500 ? 503 : 502,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
    return Response.json(
      { error: "Unable to apply recommendation safely." },
      { status: 400 },
    );
  }
}
