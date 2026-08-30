import { z, ZodError } from "zod";

import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  ApprovalStoreUnavailableError,
  listActiveApprovalRecords,
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
  fetchLiveAdAccount,
  fetchLiveWorkbenchData,
} from "@/lib/openai-ads/data.server";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsApiKeyForAccount,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({
    accountId: z.string().min(1).max(200),
    recommendationId: z.string().min(1).max(200),
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

    const credential: AdsApiCredential = {
      kind: "account_api_key",
      secret: await getAdsApiKeyForAccount(input.accountId),
      expectedAccountId: input.accountId,
    };
    const runtime = getAdsRuntimeMode({ hasAccountKey: true });
    if (runtime.dataSource !== "live") {
      throw new LiveRecommendationDecisionUnavailableError();
    }

    const account = await fetchLiveAdAccount(credential);
    if (account.id !== input.accountId) {
      throw new AccountAccessForbiddenError(
        "The stored credential does not match the selected Ads account.",
      );
    }
    const live = await fetchLiveWorkbenchData(account, credential);
    const recommendation = live.recommendations.find(
      (item) => item.id === input.recommendationId,
    );
    if (!recommendation) {
      return Response.json(
        { error: "That recommendation is no longer present in the live account." },
        { status: 404 },
      );
    }

    if (input.action === "dismiss") {
      const activeApproval = (await listActiveApprovalRecords(
        input.accountId,
      )).find(
        (record) =>
          record.recommendationId === recommendation.id &&
          record.entityId === recommendation.entityId,
      );
      if (activeApproval) {
        throw new RecommendationDecisionTransitionError(
          "This recommendation already has an active or unresolved approval and cannot be dismissed.",
        );
      }
      const result = await dismissRecommendation({
        accountId: input.accountId,
        operatorId,
        access,
        recommendation,
        reason: input.reason!,
      });
      return Response.json({
        action: "dismissed",
        created: result.created,
        message: result.created
          ? "Recommendation dismissed with an auditable reason."
          : "This exact recommendation was already dismissed.",
      });
    }

    await restoreRecommendation({
      accountId: input.accountId,
      operatorId,
      access,
      recommendation,
    });
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
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof AdvertiserCredentialUnavailableError ||
      error instanceof ApprovalStoreUnavailableError ||
      error instanceof RecommendationDecisionStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof Error
        ? error.message
        : "Unable to record the recommendation decision.";
    return Response.json({ error: message }, { status: 400 });
  }
}
