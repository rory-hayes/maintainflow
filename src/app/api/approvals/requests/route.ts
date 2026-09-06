import { z, ZodError } from "zod";

import {
  ChangeApprovalRequestForbiddenError,
  ChangeApprovalRequestInvalidError,
  ChangeApprovalRequestStoreUnavailableError,
  ChangeApprovalRequestTransitionError,
  createLiveChangeApprovalRequest,
  createSimulatorChangeApprovalRequest,
  listChangeApprovalRequestPage,
} from "@/lib/approvals/change-request-store.server";
import { toChangeApprovalRequestDto } from "@/lib/approvals/change-request-schema";
import {
  approvalNotificationAttemptMessage,
  attemptApprovalNotificationDelivery,
} from "@/lib/approvals/notification-route.server";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperator,
} from "@/lib/auth/operator.server";
import { recommendationApprovalFingerprint } from "@/lib/audit/recommendation-decision";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";
import {
  getAdsRuntimeMode,
  OpenAIAdsApiError,
  type AdsApiCredential,
} from "@/lib/openai-ads/client.server";
import {
  getLiveWorkbench,
  LiveSyncUnavailableError,
} from "@/lib/openai-ads/live-sync.server";
import {
  listAgencySimulatedAccountIds,
  resolveSimulatedWorkspace,
} from "@/lib/openai-ads/simulated-workspaces";
import {
  AccountAccessForbiddenError,
  AdvertiserCredentialUnavailableError,
  getAdsCredentialMaterialForAccount,
  requireOrganizationAccountAccess,
  TenancyStoreUnavailableError,
} from "@/lib/tenancy/store.server";

const requestSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("simulator"),
      organizationId: z.string().uuid(),
      accountId: z.string().trim().min(1).max(255),
      recommendationId: z.string().trim().min(1).max(255),
      recommendationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      note: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
  z
    .object({
      source: z.literal("live"),
      organizationId: z.string().uuid(),
      accountId: z.string().trim().min(1).max(255),
      recommendationId: z.string().trim().min(1).max(255),
      recommendationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      note: z.string().trim().min(1).max(500).optional(),
    })
    .strict(),
]);

const listQuerySchema = z
  .object({
    organizationId: z.string().uuid(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export async function GET(request: Request) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin approval is required." },
        { status: 403 },
      );
    }
    const url = new URL(request.url);
    const allowedKeys = new Set(["organizationId", "cursor"]);
    if ([...url.searchParams.keys()].some((key) => !allowedKeys.has(key))) {
      throw new ZodError([]);
    }
    const organizationIds = url.searchParams.getAll("organizationId");
    const cursors = url.searchParams.getAll("cursor");
    if (organizationIds.length !== 1 || cursors.length > 1) {
      throw new ZodError([]);
    }
    const [operator, query] = await Promise.all([
      requireOperator(),
      Promise.resolve(
        listQuerySchema.parse({
          organizationId: organizationIds[0],
          cursor: cursors[0],
        }),
      ),
    ]);
    const page = await listChangeApprovalRequestPage({
      operatorId: operator.id,
      organizationId: query.organizationId,
      cursor: query.cursor,
      pageSize: 50,
    });
    return Response.json({
      requests: page.requests.map(toChangeApprovalRequestDto),
      nextCursor: page.nextCursor,
    });
  } catch (error) {
    if (error instanceof OperatorUnauthorizedError) {
      const status = error.status === 403 ? 403 : 401;
      return Response.json({ error: error.message }, { status });
    }
    if (
      error instanceof ZodError ||
      error instanceof ChangeApprovalRequestInvalidError
    ) {
      return Response.json(
        { error: "Enter a valid agency approval queue cursor." },
        { status: 422 },
      );
    }
    if (error instanceof ChangeApprovalRequestForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ChangeApprovalRequestStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json(
      { error: "Unable to load the approval queue safely." },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin approval is required." },
        { status: 403 },
      );
    }
    const [operator, body] = await Promise.all([
      requireOperator(),
      readJsonBodyWithLimit(request, 4_096).then((value) =>
        requestSchema.parse(value),
      ),
    ]);
    if (
      body.source === "simulator" &&
      !listAgencySimulatedAccountIds().some((id) => id === body.accountId)
    ) {
      return Response.json(
        { error: "Select a labelled agency simulator account." },
        { status: 422 },
      );
    }
    let recommendation;
    let createResult: Awaited<
      ReturnType<typeof createSimulatorChangeApprovalRequest>
    >;
    if (body.source === "simulator") {
      const workspace = resolveSimulatedWorkspace(body.accountId);
      recommendation = workspace.recommendations.find(
        (item) => item.id === body.recommendationId,
      );
      if (!recommendation) {
        return Response.json(
          { error: "Recommendation not found in this simulator account." },
          { status: 404 },
        );
      }
      if (
        recommendationApprovalFingerprint(recommendation) !==
        body.recommendationFingerprint
      ) {
        return Response.json(
          {
            error:
              "This recommendation changed after it was displayed. Refresh before requesting approval.",
          },
          { status: 409 },
        );
      }
      createResult = await createSimulatorChangeApprovalRequest({
        organizationId: body.organizationId,
        operator,
        account: workspace.account,
        recommendation,
        displayedFingerprint: body.recommendationFingerprint,
        note: body.note,
      });
    } else {
      const access = await requireOrganizationAccountAccess(
        operator.id,
        body.organizationId,
        body.accountId,
        "read",
      );
      if (access.organizationType !== "agency") {
        throw new ChangeApprovalRequestForbiddenError(
          "Live approval requests must belong to an active agency workspace.",
        );
      }
      const credentialMaterial = await getAdsCredentialMaterialForAccount(
        body.accountId,
      );
      const credential: AdsApiCredential = {
        kind: "account_api_key",
        secret: credentialMaterial.apiKey,
        expectedAccountId: body.accountId,
      };
      const runtime = getAdsRuntimeMode({ hasAccountKey: true });
      if (runtime.dataSource !== "live") {
        throw new ChangeApprovalRequestStoreUnavailableError(
          "Live Ads data must be enabled before requesting a live approval.",
        );
      }
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
      if (!recommendation) {
        return Response.json(
          { error: "Recommendation not found in the fresh live account snapshot." },
          { status: 404 },
        );
      }
      if (
        recommendationApprovalFingerprint(recommendation) !==
        body.recommendationFingerprint
      ) {
        return Response.json(
          {
            error:
              "This live recommendation changed after it was displayed. Refresh before requesting approval.",
          },
          { status: 409 },
        );
      }
      createResult = await createLiveChangeApprovalRequest({
        operator,
        access,
        recommendation,
        displayedFingerprint: body.recommendationFingerprint,
        note: body.note,
      });
    }
    const notificationAttempt = createResult.created
      ? await attemptApprovalNotificationDelivery(
          createResult.notificationDeliveryIds,
        )
      : { queued: 0, summary: null, operatorAttentionRequired: false };
    const notificationMessage = approvalNotificationAttemptMessage(
      notificationAttempt,
      "reviewer",
    );
    const responseResult = {
      id: createResult.id,
      created: createResult.created,
      eligibleReviewerCount: createResult.eligibleReviewerCount,
    };
    return Response.json(
      {
        ...responseResult,
        notification: notificationAttempt,
        message: createResult.created
          ? body.source === "live"
            ? `Approval requested. Waiting for another agency owner or admin. ${notificationMessage} No external change was sent.`
            : createResult.eligibleReviewerCount > 0
              ? `Approval packet created in the shared agency queue for a different owner or admin to review. ${notificationMessage} No external change was sent.`
              : "Approval packet created in the shared agency queue, but no other owner or admin is currently eligible to decide it. Add a reviewer before continuing; no notification or external change was sent."
          : body.source === "live"
            ? "This exact live change already has an unconsumed approval packet. No duplicate was created and no change was sent."
            : "This exact packet is already awaiting approval. No duplicate was created and no notification or external change was sent.",
      },
      { status: createResult.created ? 201 : 200 },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The approval request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      const status = error.status === 403 ? 403 : 401;
      return Response.json({ error: error.message }, { status });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        { error: "Enter a valid agency, recommendation source, account, and note." },
        { status: 422 },
      );
    }
    if (error instanceof ChangeApprovalRequestForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof ChangeApprovalRequestInvalidError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ChangeApprovalRequestTransitionError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof ChangeApprovalRequestStoreUnavailableError ||
      error instanceof AdvertiserCredentialUnavailableError ||
      error instanceof TenancyStoreUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof LiveSyncUnavailableError) {
      const retryAfterSeconds = error.retryAfter
        ? Math.max(
            1,
            Math.ceil((error.retryAfter.getTime() - Date.now()) / 1_000),
          )
        : 30;
      return Response.json(
        {
          error:
            "A fresh OpenAI Ads snapshot is required before requesting approval. No request was created.",
        },
        {
          status: 503,
          headers: { "Retry-After": String(retryAfterSeconds) },
        },
      );
    }
    if (error instanceof OpenAIAdsApiError) {
      return Response.json(
        {
          error:
            "OpenAI Ads could not provide a fresh recommendation snapshot. No approval request was created.",
        },
        { status: error.status === 429 || error.status >= 500 ? 503 : 502 },
      );
    }
    return Response.json(
      { error: "Unable to create the approval request safely." },
      { status: 500 },
    );
  }
}
