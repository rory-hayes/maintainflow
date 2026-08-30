import {
  applyAdsMutation,
  getAdsRuntimeMode,
  type AdsApiCredential,
} from "@/lib/openai-ads/client.server";
import {
  fetchLiveAdAccount,
  fetchLiveWorkbenchData,
} from "@/lib/openai-ads/data.server";
import { demoAccount, getDemoRecommendation } from "@/lib/openai-ads/demo-data";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import { ApprovalStoreUnavailableError } from "@/lib/audit/approval-store.server";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsApiKeyForAccount,
  requireAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";
import type { AccountAccess } from "@/lib/tenancy/schema";
import { z, ZodError } from "zod";

const requestSchema = z
  .object({
    recommendationId: z.string().min(1),
    accountId: z.string().min(1).max(200).optional(),
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

    if (body.accountId) {
      operatorId = await requireOperatorId();
      access = await requireAccountAccess(
        operatorId,
        body.accountId,
        "write",
      );
      credential = {
        kind: "account_api_key",
        secret: await getAdsApiKeyForAccount(body.accountId),
        expectedAccountId: body.accountId,
      };
      runtime = getAdsRuntimeMode({ hasAccountKey: true });
      accountId = body.accountId;
      if (runtime.dataSource === "live") {
        const connectedAccount = await fetchLiveAdAccount(credential);
        if (connectedAccount.id !== body.accountId) {
          throw new AccountAccessForbiddenError(
            "The stored credential does not match the selected Ads account.",
          );
        }
        const live = await fetchLiveWorkbenchData(
          connectedAccount,
          credential,
        );
        recommendation = live.recommendations.find(
          (item) => item.id === body.recommendationId,
        );
      }
    } else if (runtime.dataSource === "live") {
      operatorId = await requireOperatorId();
      const connectedAccount = await fetchLiveAdAccount();
      access = await requireAccountAccess(
        operatorId,
        connectedAccount.id,
        "write",
      );
      const live = await fetchLiveWorkbenchData(connectedAccount);
      accountId = live.account.id;
      recommendation = live.recommendations.find(
        (item) => item.id === body.recommendationId,
      );
    }

    if (!recommendation) {
      return Response.json(
        { error: "Recommendation not found." },
        { status: 404 },
      );
    }

    const result = await applyAdsMutation(recommendation, {
      accountId,
      operatorId,
      access,
      credential,
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
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ApprovalStoreUnavailableError ||
      error instanceof AdvertiserCredentialUnavailableError ||
      error instanceof TenancyStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    const message =
      error instanceof Error ? error.message : "Unable to apply recommendation.";
    return Response.json({ error: message }, { status: 400 });
  }
}
