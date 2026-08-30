import { z, ZodError } from "zod";

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
import { fetchLiveAdAccount } from "@/lib/openai-ads/data.server";
import { createServerLogger } from "@/lib/observability/logger.server";
import {
  AccountAccessForbiddenError,
  rotateAdsApiCredential,
  requireAccountAccess,
  TenancyStoreUnavailableError,
  verifyCredentialStore,
} from "@/lib/tenancy/store.server";

const requestSchema = z
  .object({ adsApiKey: z.string().trim().min(10).max(4096) })
  .strict();

class CredentialAccountMismatchError extends Error {
  constructor() {
    super("That key belongs to a different OpenAI Ads account.");
    this.name = "CredentialAccountMismatchError";
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ accountId: string }> },
) {
  const log = createServerLogger("api.connection.ads");
  try {
    if (!isSecureSameOriginRequest(request)) {
      return Response.json(
        { error: "Secure same-origin setup is required." },
        { status: 403 },
      );
    }

    const [operatorId, { accountId }, input] = await Promise.all([
      requireOperatorId(),
      context.params,
      readJsonBodyWithLimit(request, 16_384).then((value) =>
        requestSchema.parse(value),
      ),
    ]);
    const access = await requireAccountAccess(operatorId, accountId, "write");
    if (
      !isCredentialVaultConfigured() ||
      !(await verifyCredentialStore())
    ) {
      throw new CredentialVaultUnavailableError(
        "The encrypted advertiser credential vault is not ready.",
      );
    }

    const account = await fetchLiveAdAccount({
      kind: "account_api_key",
      secret: input.adsApiKey,
      expectedAccountId: accountId,
    });
    if (account.id !== accountId) throw new CredentialAccountMismatchError();
    const credential = encryptAdsApiKey({
      apiKey: input.adsApiKey,
      externalAccountId: account.id,
    });
    const result = await rotateAdsApiCredential({
      operatorId,
      accountId,
      access,
      credential,
      verifiedAt: new Date(),
    });
    log.info("connection.ads.rotated");

    return Response.json({
      rotated: true,
      credentialVersion: result.credentialVersion,
      message: "The client account key was verified and replaced.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "The connection request is too large." },
        { status: 413 },
      );
    }
    if (error instanceof OperatorUnauthorizedError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    if (error instanceof AccountAccessForbiddenError) {
      return Response.json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof ZodError ||
      error instanceof SyntaxError ||
      error instanceof CredentialAccountMismatchError
    ) {
      if (error instanceof CredentialAccountMismatchError) {
        log.warn("connection.ads.account_mismatch", { error });
      }
      return Response.json(
        {
          error:
            error instanceof CredentialAccountMismatchError
              ? error.message
              : "Enter a valid account-scoped Ads API key.",
        },
        { status: 422 },
      );
    }
    if (
      error instanceof OperatorAuthUnavailableError ||
      error instanceof TenancyStoreUnavailableError ||
      error instanceof CredentialVaultUnavailableError
    ) {
      log.error("connection.ads.unavailable", { error });
      return Response.json({ error: error.message }, { status: 503 });
    }
    log.error("connection.ads.failed", { error });
    return Response.json(
      { error: "The client account key could not be replaced." },
      { status: 400 },
    );
  }
}
