import { ZodError } from "zod";

import { isWorkspaceAdmissionAllowed } from "@/lib/auth/config";
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
import {
  advertiserAccountAttachSchema,
  organizationIdSchema,
} from "@/lib/tenancy/schema";
import {
  AccountAccessForbiddenError,
  AdvertiserAccountAttachConflictError,
  attachAdvertiserAccountToAgency,
  requireAgencyAccountAttachAuthorization,
  TenancyStoreUnavailableError,
  verifyAdvertiserAccountAttachStore,
} from "@/lib/tenancy/store.server";

class AdvertiserAccountAttachRequestInvalidError extends Error {
  constructor() {
    super("The advertiser account connection request is invalid.");
    this.name = "AdvertiserAccountAttachRequestInvalidError";
  }
}

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

async function readAdvertiserAccountAttachRequest(
  request: Request,
  params: Promise<{ organizationId: string }>,
) {
  try {
    const [value, resolvedParams] = await Promise.all([
      readJsonBodyWithLimit(request, 16_384),
      params,
    ]);
    return {
      organizationId: organizationIdSchema.parse(
        resolvedParams.organizationId,
      ),
      input: advertiserAccountAttachSchema.parse(value),
    };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error;
    if (error instanceof ZodError || error instanceof SyntaxError) {
      throw new AdvertiserAccountAttachRequestInvalidError();
    }
    throw error;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ organizationId: string }> },
) {
  const log = createServerLogger("api.agency.account_attach");
  const startedAt = Date.now();
  const fields = (status: number, error?: unknown) => ({
    status,
    durationMs: Date.now() - startedAt,
    ...(error === undefined ? {} : { error }),
  });

  try {
    if (!isSecureSameOriginRequest(request)) {
      log.warn("agency.account_attach.rejected", fields(403));
      return Response.json(
        { error: "Secure same-origin setup is required." },
        { status: 403 },
      );
    }

    const [operatorId, parsed] = await Promise.all([
      requireOperatorId(),
      readAdvertiserAccountAttachRequest(request, context.params),
    ]);
    if (!isWorkspaceAdmissionAllowed(operatorId)) {
      log.warn("agency.account_attach.rejected", fields(403));
      return Response.json(
        {
          error:
            "This account is not admitted to the MaintainFlow private beta yet.",
        },
        { status: 403 },
      );
    }
    const agency = await requireAgencyAccountAttachAuthorization(
      operatorId,
      parsed.organizationId,
    );
    if (
      !isCredentialVaultConfigured() ||
      !(await verifyAdvertiserAccountAttachStore())
    ) {
      throw new CredentialVaultUnavailableError(
        "The encrypted advertiser credential vault is not ready.",
      );
    }

    const account = await fetchLiveAdAccount({
      apiKey: parsed.input.adsApiKey,
    });
    if (parsed.input.action === "verify") {
      log.info("agency.account_verify.completed", fields(200));
      return Response.json(
        {
          verified: true,
          account: { id: account.id, name: account.name },
          organization: {
            id: agency.organizationId,
            name: agency.organizationName,
          },
        },
        { status: 200, headers: NO_STORE_HEADERS },
      );
    }
    if (parsed.input.expectedAccountId !== account.id) {
      log.warn("agency.account_attach.rejected", fields(409));
      return Response.json(
        {
          error:
            "The advertiser key now resolves to a different account. Verify it again before connecting.",
        },
        { status: 409, headers: NO_STORE_HEADERS },
      );
    }
    const credential = encryptAdsApiKey({
      apiKey: parsed.input.adsApiKey,
      externalAccountId: account.id,
    });
    const result = await attachAdvertiserAccountToAgency({
      operatorId,
      organizationId: parsed.organizationId,
      accountId: account.id,
      accountName: account.name,
      credential,
      verifiedAt: new Date(),
    });
    const status = result.created ? 201 : 200;
    log.info("agency.account_attach.completed", fields(status));
    return Response.json(
      {
        created: result.created,
        credentialUpdated: result.credentialUpdated,
        access: result.access,
        message: result.created
          ? "Advertiser account connected to the agency workspace."
          : "Advertiser account is already connected. Its existing encrypted credential was retained; use credential rotation to replace it.",
      },
      { status, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      log.warn("agency.account_attach.rejected", fields(413, error));
      return Response.json(
        { error: "The advertiser account connection request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      log.warn("agency.account_attach.rejected", fields(401, error));
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      log.warn("agency.account_attach.rejected", fields(403, error));
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (error instanceof AdvertiserAccountAttachConflictError) {
      log.warn("agency.account_attach.rejected", fields(409, error));
      return Response.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof AdvertiserAccountAttachRequestInvalidError) {
      log.warn("agency.account_attach.rejected", fields(422, error));
      return Response.json(
        { error: "Enter a valid account-scoped Ads API key." },
        { status: 422 },
      );
    }
    if (error instanceof OpenAIAdsApiError) {
      log.warn("agency.account_attach.rejected", fields(400, error));
      return Response.json(
        { error: "The advertiser account could not be verified." },
        { status: 400 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof CredentialVaultUnavailableError
    ) {
      log.error("agency.account_attach.unavailable", fields(503, error));
      return Response.json({ error: error.message }, { status: 503 });
    }
    log.error("agency.account_attach.failed", fields(500, error));
    return Response.json(
      { error: "The advertiser account could not be connected safely." },
      { status: 500 },
    );
  }
}
