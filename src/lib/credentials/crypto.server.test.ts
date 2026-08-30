import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CredentialDecryptionError,
  CredentialVaultUnavailableError,
  decryptAdsApiKey,
  decryptConversionsApiCredential,
  encryptAdsApiKey,
  encryptConversionsApiCredential,
  isCredentialVaultConfigured,
} from "./crypto.server";

const originalKeyring = process.env.MAINTAINFLOW_CREDENTIAL_KEYRING;
const originalActiveKeyId =
  process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID;

beforeEach(() => {
  process.env.MAINTAINFLOW_CREDENTIAL_KEYRING = JSON.stringify({
    v1: Buffer.alloc(32, 7).toString("base64"),
  });
  process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID = "v1";
});

afterEach(() => {
  if (originalKeyring === undefined) {
    delete process.env.MAINTAINFLOW_CREDENTIAL_KEYRING;
  } else {
    process.env.MAINTAINFLOW_CREDENTIAL_KEYRING = originalKeyring;
  }
  if (originalActiveKeyId === undefined) {
    delete process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID;
  } else {
    process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID = originalActiveKeyId;
  }
});

describe("advertiser credential encryption", () => {
  it("round-trips an account-bound Ads API key without plaintext persistence", () => {
    const apiKey = "ads_live_secret_value_123";
    const encrypted = encryptAdsApiKey({
      apiKey,
      externalAccountId: "adacct_123",
    });

    expect(encrypted.keyId).toBe("v1");
    expect(encrypted.algorithm).toBe("aes-256-gcm");
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(apiKey);
    expect(decryptAdsApiKey(encrypted, "adacct_123")).toBe(apiKey);
  });

  it("rejects ciphertext replayed against another advertiser account", () => {
    const encrypted = encryptAdsApiKey({
      apiKey: "ads_live_secret_value_123",
      externalAccountId: "adacct_123",
    });

    expect(() => decryptAdsApiKey(encrypted, "adacct_456")).toThrow(
      CredentialDecryptionError,
    );
  });

  it("retains old key IDs for decryption after an active-key rotation", () => {
    const encrypted = encryptAdsApiKey({
      apiKey: "ads_live_secret_value_123",
      externalAccountId: "adacct_123",
    });
    process.env.MAINTAINFLOW_CREDENTIAL_KEYRING = JSON.stringify({
      v1: Buffer.alloc(32, 7).toString("base64"),
      v2: Buffer.alloc(32, 9).toString("base64"),
    });
    process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID = "v2";

    expect(decryptAdsApiKey(encrypted, "adacct_123")).toBe(
      "ads_live_secret_value_123",
    );
    expect(
      encryptAdsApiKey({
        apiKey: "ads_new_secret_value_456",
        externalAccountId: "adacct_123",
      }).keyId,
    ).toBe("v2");
  });

  it("fails closed when the active key is absent or malformed", () => {
    process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID = "missing";
    expect(isCredentialVaultConfigured()).toBe(false);
    expect(() =>
      encryptAdsApiKey({ apiKey: "secret", externalAccountId: "adacct_123" }),
    ).toThrow(CredentialVaultUnavailableError);
  });

  it("round-trips an account-bound Pixel and CAPI key without plaintext persistence", () => {
    const credential = {
      pixelId: "pixel_private_123",
      apiKey: "capi_private_secret_456",
    };
    const encrypted = encryptConversionsApiCredential({
      credential,
      externalAccountId: "adacct_123",
    });

    expect(encrypted.provider).toBe("openai_conversions");
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(
      credential.pixelId,
    );
    expect(encrypted.ciphertext.toString("utf8")).not.toContain(
      credential.apiKey,
    );
    expect(
      decryptConversionsApiCredential(encrypted, "adacct_123"),
    ).toEqual(credential);
  });

  it("rejects conversion credentials replayed across accounts or purposes", () => {
    const encrypted = encryptConversionsApiCredential({
      credential: {
        pixelId: "pixel_private_123",
        apiKey: "capi_private_secret_456",
      },
      externalAccountId: "adacct_123",
    });

    expect(() =>
      decryptConversionsApiCredential(encrypted, "adacct_456"),
    ).toThrow(CredentialDecryptionError);
    expect(() =>
      decryptAdsApiKey(
        { ...encrypted, provider: "openai_ads" },
        "adacct_123",
      ),
    ).toThrow(CredentialDecryptionError);
  });
});
