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

export async function POST(request: Request) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin recommendation review is required." },
        { status: 403 },
      );
    }

    const [operatorId, input] = await Promise.all([
      requireOperatorId(),
      readJsonBodyWithLimit(request, 4_096).then((value) =>
        requestSchema.parse(value),
      ),
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
      return Response.json(
        { error: "That recommendation is no longer present in the live account." },
        { status: 404 },
      );
    }
    if (
      input.recommendationFingerprint !==
      recommendationFingerprint(recommendation)
    ) {
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
    return Response.json({
      action: "restored",
      message: "Recommendation restored for review.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The recommendation decision request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        {
          error:
            "Choose dismiss or restore and enter a dismissal reason between 5 and 500 characters.",
        },
        { status: 422 },
      );
    }
    if (error instanceof RecommendationDecisionTransitionError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof LiveRecommendationDecisionUnavailableError) {
      return Response.json({ error: error.message }, { status: 409 });
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
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json(
      { error: "Unable to record the recommendation decision safely." },
      { status: 400 },
    );
  }
}
