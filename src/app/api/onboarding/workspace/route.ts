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
import { fetchLiveAdAccount } from "@/lib/openai-ads/data.server";
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
import { workspaceBootstrapSchema } from "@/lib/tenancy/schema";
import {
  AccountAccessForbiddenError,
  bootstrapWorkspace,
  TenancyStoreUnavailableError,
  verifyCredentialStore,
  verifyTenancyStore,
} from "@/lib/tenancy/store.server";

export async function POST(request: Request) {
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin setup is required." },
        { status: 403 },
      );
    }
    const [operatorId, input] = await Promise.all([
      requireOperatorId(),
      readJsonBodyWithLimit(request, 16_384).then((value) =>
        workspaceBootstrapSchema.parse(value),
      ),
    ]);
    if (!isWorkspaceAdmissionAllowed(operatorId)) {
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
      return Response.json({
        created: true,
        access,
        message: "Workspace created and the client Ads account was verified.",
      });
    }

    if (!isBootstrapOperator(operatorId)) {
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
    return Response.json({
      created: true,
      access,
      message: "Workspace created and connected account access verified.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The workspace setup request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof ZodError || error instanceof SyntaxError) {
      return Response.json(
        {
          error:
            "Enter a workspace name, choose advertiser or agency, and check the Ads key format.",
        },
        { status: 422 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof CredentialVaultUnavailableError
    ) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    return Response.json(
      { error: "Unable to create workspace safely." },
      { status: 400 },
    );
  }
}
