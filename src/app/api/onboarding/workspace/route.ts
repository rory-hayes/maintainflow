import { ZodError } from "zod";

import {
  isBootstrapOperator,
  isWorkspaceAdmissionAllowed,
} from "@/lib/auth/config";
import {
  OperatorAuthUnavailableError,
  OperatorUnauthorizedError,
  requireOperatorId,
} from "@/lib/auth/operator.server";
import {
  CredentialVaultUnavailableError,
  encryptAdsApiKey,
  isCredentialVaultConfigured,
} from "@/lib/credentials/crypto.server";
import {
  isSecureSameOriginRequest,
  readJsonBodyWithLimit,
  RequestBodyTooLargeError,
} from "@/lib/http/request-security.server";
import { OpenAIAdsApiError } from "@/lib/openai-ads/client.server";
import { fetchLiveAdAccount } from "@/lib/openai-ads/data.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import { workspaceBootstrapSchema } from "@/lib/tenancy/schema";
import {
  AccountAccessForbiddenError,
  bootstrapWorkspace,
  TenancyStoreUnavailableError,
  verifyCredentialStore,
  verifyTenancyStore,
} from "@/lib/tenancy/store.server";

class WorkspaceRequestInvalidError extends Error {
  constructor() {
    super("The workspace setup request is invalid.");
    this.name = "WorkspaceRequestInvalidError";
  }
}

async function readWorkspaceRequest(request: Request) {
  try {
    const value = await readJsonBodyWithLimit(request, 16_384);
    return workspaceBootstrapSchema.parse(value);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new WorkspaceRequestInvalidError();
    }
    throw error;
  }
}

export async function POST(request: Request) {
  const log = createServerLogger("api.onboarding.workspace");
  const startedAt = Date.now();
  const fields = (status: number, error?: unknown) => ({
    status,
    durationMs: Date.now() - startedAt,
    ...(error === undefined ? {} : { error }),
  });

  try {
    if (!isSecureSameOriginRequest(request)) {
      log.warn("onboarding.workspace.rejected", fields(403));
      return Response.json(
        { error: "Secure same-origin setup is required." },
        { status: 403 },
      );
    }
    const [operatorId, input] = await Promise.all([
      requireOperatorId(),
      readWorkspaceRequest(request),
    ]);
    if (!isWorkspaceAdmissionAllowed(operatorId)) {
      log.warn("onboarding.workspace.rejected", fields(403));
      return Response.json(
        {
          error:
            "This account is not admitted to the MaintainFlow private beta yet.",
        },
        { status: 403 },
      );
    }
    if (!(await verifyTenancyStore())) {
      throw new TenancyStoreUnavailableError(
        "The customer tenancy database migration is not ready.",
      );
    }

    if (input.adsApiKey) {
      if (
        !isCredentialVaultConfigured() ||
        !(await verifyCredentialStore())
      ) {
        throw new CredentialVaultUnavailableError(
          "The encrypted advertiser credential vault is not ready.",
        );
      }
      const account = await fetchLiveAdAccount({ apiKey: input.adsApiKey });
      const encryptedCredential = encryptAdsApiKey({
        apiKey: input.adsApiKey,
        externalAccountId: account.id,
      });
      const access = await bootstrapWorkspace({
        operatorId,
        organizationName: input.organizationName,
        organizationType: input.organizationType,
        accountId: account.id,
        accountName: account.name,
        connection: {
          mode: "vault",
          credential: encryptedCredential,
          verifiedAt: new Date(),
        },
      });
      log.info("onboarding.workspace.completed", fields(200));
      return Response.json({
        created: true,
        access,
        message: "Workspace created and the client Ads account was verified.",
      });
    }

    if (!isBootstrapOperator(operatorId)) {
      log.warn("onboarding.workspace.rejected", fields(403));
      return Response.json(
        {
          error:
            "Enter the client account key, or use an authorized pilot connection.",
        },
        { status: 403 },
      );
    }
    const account = await fetchLiveAdAccount();
    const access = await bootstrapWorkspace({
      operatorId,
      organizationName: input.organizationName,
      organizationType: input.organizationType,
      accountId: account.id,
      accountName: account.name,
      connection: { mode: "environment" },
    });
    log.info("onboarding.workspace.completed", fields(200));
    return Response.json({
      created: true,
      access,
      message: "Workspace created and connected account access verified.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      log.warn("onboarding.workspace.rejected", fields(413, error));
      return Response.json(
        { error: "The workspace setup request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      log.warn("onboarding.workspace.rejected", fields(401, error));
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      log.warn("onboarding.workspace.rejected", fields(409, error));
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof WorkspaceRequestInvalidError) {
      log.warn("onboarding.workspace.rejected", fields(422, error));
      return Response.json(
        {
          error:
            "Enter a workspace name, choose advertiser or agency, and check the Ads key format.",
        },
        { status: 422 },
      );
    }
    if (error instanceof OpenAIAdsApiError) {
      log.warn("onboarding.workspace.rejected", fields(400, error));
      return Response.json(
        { error: "Unable to create workspace safely." },
        { status: 400 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof CredentialVaultUnavailableError
    ) {
      log.error("onboarding.workspace.unavailable", fields(503, error));
      return Response.json({ error: error.message }, { status: 503 });
    }
    log.error("onboarding.workspace.failed", fields(500, error));
    return Response.json(
      { error: "Unable to create workspace safely." },
      { status: 500 },
    );
  }
}
