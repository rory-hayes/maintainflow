import { z, ZodError } from "zod";

import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  ApprovalStoreUnavailableError,
} from "@/lib/audit/approval-store.server";
import {
  RecommendationDecisionStoreUnavailableError,
  RecommendationDecisionTransitionError,
  dismissRecommendation,
  restoreRecommendation,
  verifyRecommendationDecisionStore,
} from "@/lib/audit/recommendation-decision-store.server";
import {
  recommendationDecisionActionSchema,
  recommendationDismissalReasonSchema,
  recommendationFingerprint,
} from "@/lib/audit/recommendation-decision";
import {
  RequestBodyTooLargeError,
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
} from "@/lib/http/request-security.server";
import {
  getAdsRuntimeMode,
  type AdsApiCredential,
} from "@/lib/openai-ads/client.server";
import {
  getLiveWorkbench,
  LiveSyncUnavailableError,
} from "@/lib/openai-ads/live-sync.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsCredentialMaterialForAccount,
  requireAccountAccess,
  TenancyStoreUnavailableError,
  withAuthorizedAdsWriteFence,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({
    accountId: z.string().min(1).max(200),
    recommendationId: z.string().min(1).max(200),
    recommendationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    action: recommendationDecisionActionSchema,
    reason: recommendationDismissalReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "dismiss" && !value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A dismissal reason is required.",
      });
    }
  });

class LiveRecommendationDecisionUnavailableError extends Error {
  constructor() {
    super("Live Ads data mode is required for durable recommendation decisions.");
    this.name = "LiveRecommendationDecisionUnavailableError";
  }
}

class RecommendationDecisionRequestInvalidError extends Error {
  constructor() {
    super("The recommendation decision request is invalid.");
    this.name = "RecommendationDecisionRequestInvalidError";
  }
}

async function readRecommendationDecisionRequest(request: Request) {
  try {
    const value = await readJsonBodyWithLimit(request, 4_096);
    return requestSchema.parse(value);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new RecommendationDecisionRequestInvalidError();
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const log = createServerLogger("api.ads.recommendation_decision");
  const startedAt = Date.now();
  const fields = (status: number, error?: unknown) => ({
    status,
    durationMs: Date.now() - startedAt,
    ...(error === undefined ? {} : { error }),
  });

  try {
    if (!isSecureSameOriginRequest(request)) {
      log.warn("ads.recommendation_decision.rejected", fields(403));
      return Response.json(
        { error: "Secure same-origin recommendation review is required." },
        { status: 403 },
      );
    }

    const [operatorId, input] = await Promise.all([
      requireOperatorId(),
      readRecommendationDecisionRequest(request),
    ]);
    const access = await requireAccountAccess(
      operatorId,
      input.accountId,
      "write",
    );
    if (!(await verifyRecommendationDecisionStore())) {
      throw new RecommendationDecisionStoreUnavailableError(
        "Apply the recommendation dismissal migration before recording live decisions.",
      );
    }

    const credentialMaterial =
      await getAdsCredentialMaterialForAccount(input.accountId);
    const credential: AdsApiCredential = {
      kind: "account_api_key",
      secret: credentialMaterial.apiKey,
      expectedAccountId: input.accountId,
    };
    const runtime = getAdsRuntimeMode({ hasAccountKey: true });
    if (runtime.dataSource !== "live") {
      throw new LiveRecommendationDecisionUnavailableError();
    }

    const live = (
      await getLiveWorkbench({
        accountId: input.accountId,
        credentialGeneration: credentialMaterial.credentialGeneration,
        credential,
        policy: "dashboard",
      })
    ).data;
    const recommendation = live.recommendations.find(
      (item) => item.id === input.recommendationId,
    );
    if (!recommendation) {
      log.warn("ads.recommendation_decision.rejected", fields(404));
      return Response.json(
        { error: "That recommendation is no longer present in the live account." },
        { status: 404 },
      );
    }
    if (
      input.recommendationFingerprint !==
      recommendationFingerprint(recommendation)
    ) {
      log.warn("ads.recommendation_decision.rejected", fields(409));
      return Response.json(
        {
          error:
            "This recommendation changed after it was displayed. Refresh and review the exact proposed change before recording a decision.",
        },
        { status: 409 },
      );
    }

    if (input.action === "dismiss") {
      const fenced = await withAuthorizedAdsWriteFence(
        {
          accountId: input.accountId,
          operatorId,
          access,
          expectedCredentialGeneration:
            credentialMaterial.credentialGeneration,
          requireClearProviderOperationLedger: false,
        },
        async ({ transaction, access: currentAccess }) =>
          dismissRecommendation({
            accountId: input.accountId,
            operatorId,
            access: currentAccess,
            recommendation,
            reason: input.reason!,
            transaction,
          }),
      );
      const result = fenced.value;
      log.info("ads.recommendation_decision.completed", fields(200));
      return Response.json({
        action: "dismissed",
        created: result.created,
        message: result.created
          ? "Recommendation dismissed with an auditable reason."
          : "This exact recommendation was already dismissed.",
      });
    }

    await withAuthorizedAdsWriteFence(
      {
        accountId: input.accountId,
        operatorId,
        access,
        expectedCredentialGeneration: credentialMaterial.credentialGeneration,
        requireClearProviderOperationLedger: false,
      },
      async ({ transaction, access: currentAccess }) =>
        restoreRecommendation({
          accountId: input.accountId,
          operatorId,
          access: currentAccess,
          recommendation,
          transaction,
        }),
    );
    log.info("ads.recommendation_decision.completed", fields(200));
    return Response.json({
      action: "restored",
      message: "Recommendation restored for review.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      log.warn("ads.recommendation_decision.rejected", fields(413, error));
      return Response.json(
        { error: "The recommendation decision request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      log.warn("ads.recommendation_decision.rejected", fields(401, error));
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      log.warn("ads.recommendation_decision.rejected", fields(403, error));
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof RecommendationDecisionRequestInvalidError) {
      log.warn("ads.recommendation_decision.rejected", fields(422, error));
      return Response.json(
        {
          error:
            "Choose dismiss or restore and enter a dismissal reason between 5 and 500 characters.",
        },
        { status: 422 },
      );
    }
    if (error instanceof RecommendationDecisionTransitionError) {
      log.warn("ads.recommendation_decision.rejected", fields(409, error));
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LiveRecommendationDecisionUnavailableError) {
      log.warn("ads.recommendation_decision.rejected", fields(409, error));
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LiveSyncUnavailableError) {
      if (error.refreshFailure === "account_mismatch") {
        log.warn("ads.recommendation_decision.rejected", fields(403, error));
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
      log.error(
        "ads.recommendation_decision.unavailable",
        fields(503, error),
      );
      return Response.json(
        {
          error:
            "A current cached OpenAI Ads snapshot is required before recording this decision. Retry after live sync recovers.",
        },
        {
          status: 503,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof AdvertiserCredentialUnavailableError ||
      error instanceof ApprovalStoreUnavailableError ||
      error instanceof RecommendationDecisionStoreUnavailableError
    ) {
      log.error(
        "ads.recommendation_decision.unavailable",
        fields(503, error),
      );
      return Response.json({ error: error.message }, { status: 503 });
    }
    log.error("ads.recommendation_decision.failed", fields(500, error));
    return Response.json(
      { error: "Unable to record the recommendation decision safely." },
      { status: 500 },
    );
  }
}
