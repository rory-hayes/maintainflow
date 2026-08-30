import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { z } from "zod";

const ALGORITHM = "aes-256-gcm";
const INITIALIZATION_VECTOR_BYTES = 12;
const AUTHENTICATION_TAG_BYTES = 16;

type CredentialProvider = "openai_ads" | "openai_conversions";

const keyringSchema = z.record(z.string().min(1).max(64), z.string().min(1));

export type EncryptedCredential = {
  id: string;
  provider: "openai_ads";
  algorithm: "aes-256-gcm";
  keyId: string;
  ciphertext: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
};

export type EncryptedConversionsApiCredential = {
  id: string;
  provider: "openai_conversions";
  algorithm: "aes-256-gcm";
  keyId: string;
  ciphertext: Buffer;
  initializationVector: Buffer;
  authenticationTag: Buffer;
};

export type ConversionsApiCredential = {
  pixelId: string;
  apiKey: string;
};

const conversionsCredentialSchema = z
  .object({
    v: z.literal(1),
    pixelId: z.string().min(1).max(4096),
    apiKey: z.string().min(1).max(4096),
  })
  .strict();

export class CredentialVaultUnavailableError extends Error {
  constructor(message = "The credential vault is not configured.") {
    super(message);
    this.name = "CredentialVaultUnavailableError";
  }
}

export class CredentialDecryptionError extends Error {
  constructor() {
    super("The stored advertiser credential could not be decrypted safely.");
    this.name = "CredentialDecryptionError";
  }
}

function decodeEncryptionKey(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new CredentialVaultUnavailableError(
      "A credential keyring entry is not valid base64.",
    );
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new CredentialVaultUnavailableError(
      "Every credential keyring entry must decode to exactly 32 bytes.",
    );
  }
  return key;
}

function getKeyring() {
  const serialized = process.env.MAINTAINFLOW_CREDENTIAL_KEYRING;
  const activeKeyId = process.env.MAINTAINFLOW_ACTIVE_CREDENTIAL_KEY_ID;
  if (!serialized || !activeKeyId) throw new CredentialVaultUnavailableError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CredentialVaultUnavailableError(
      "The credential keyring must be valid JSON.",
    );
  }

  const encodedKeys = keyringSchema.parse(parsed);
  const keys = new Map(
    Object.entries(encodedKeys).map(([keyId, value]) => [
      keyId,
      decodeEncryptionKey(value),
    ]),
  );
  if (!keys.has(activeKeyId)) {
    throw new CredentialVaultUnavailableError(
      "The active credential key ID is not present in the keyring.",
    );
  }
  return { activeKeyId, keys };
}

function additionalAuthenticatedData(options: {
  credentialId: string;
  externalAccountId: string;
  keyId: string;
  provider: CredentialProvider;
}) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      provider: options.provider,
      credentialId: options.credentialId,
      externalAccountId: options.externalAccountId,
      keyId: options.keyId,
    }),
    "utf8",
  );
}

function encryptCredential(options: {
  plaintext: string;
  externalAccountId: string;
  provider: CredentialProvider;
}) {
  const { activeKeyId, keys } = getKeyring();
  const key = keys.get(activeKeyId);
  if (!key) throw new CredentialVaultUnavailableError();

  const credentialId = randomUUID();
  const initializationVector = randomBytes(INITIALIZATION_VECTOR_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, initializationVector, {
    authTagLength: AUTHENTICATION_TAG_BYTES,
  });
  cipher.setAAD(
    additionalAuthenticatedData({
      credentialId,
      externalAccountId: options.externalAccountId,
      keyId: activeKeyId,
      provider: options.provider,
    }),
  );
  const ciphertext = Buffer.concat([
    cipher.update(options.plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    id: credentialId,
    provider: options.provider,
    algorithm: ALGORITHM,
    keyId: activeKeyId,
    ciphertext,
    initializationVector,
    authenticationTag: cipher.getAuthTag(),
  };
}

function decryptCredential(
  credential: EncryptedCredential | EncryptedConversionsApiCredential,
  externalAccountId: string,
  provider: CredentialProvider,
) {
  try {
    const { keys } = getKeyring();
    const key = keys.get(credential.keyId);
    if (
      !key ||
      credential.algorithm !== ALGORITHM ||
      credential.provider !== provider
    ) {
      throw new CredentialDecryptionError();
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      credential.initializationVector,
      { authTagLength: AUTHENTICATION_TAG_BYTES },
    );
    decipher.setAAD(
      additionalAuthenticatedData({
        credentialId: credential.id,
        externalAccountId,
        keyId: credential.keyId,
        provider,
      }),
    );
    decipher.setAuthTag(credential.authenticationTag);
    return Buffer.concat([
      decipher.update(credential.ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof CredentialVaultUnavailableError) throw error;
    throw new CredentialDecryptionError();
  }
}

export function isCredentialVaultConfigured() {
  try {
    getKeyring();
    return true;
  } catch {
    return false;
  }
}

export function encryptAdsApiKey(options: {
  apiKey: string;
  externalAccountId: string;
}): EncryptedCredential {
  return encryptCredential({
    plaintext: options.apiKey,
    externalAccountId: options.externalAccountId,
    provider: "openai_ads",
  }) as EncryptedCredential;
}

export function decryptAdsApiKey(
  credential: EncryptedCredential,
  externalAccountId: string,
) {
  return decryptCredential(credential, externalAccountId, "openai_ads");
}

export function encryptConversionsApiCredential(options: {
  credential: ConversionsApiCredential;
  externalAccountId: string;
}): EncryptedConversionsApiCredential {
  const plaintext = JSON.stringify({
    v: 1,
    pixelId: options.credential.pixelId,
    apiKey: options.credential.apiKey,
  });
  return encryptCredential({
    plaintext,
    externalAccountId: options.externalAccountId,
    provider: "openai_conversions",
  }) as EncryptedConversionsApiCredential;
}

export function decryptConversionsApiCredential(
  credential: EncryptedConversionsApiCredential,
  externalAccountId: string,
): ConversionsApiCredential {
  try {
    const plaintext = decryptCredential(
      credential,
      externalAccountId,
      "openai_conversions",
    );
    const parsed = conversionsCredentialSchema.parse(JSON.parse(plaintext));
    return { pixelId: parsed.pixelId, apiKey: parsed.apiKey };
  } catch (error) {
    if (
      error instanceof CredentialVaultUnavailableError ||
      error instanceof CredentialDecryptionError
    ) {
      throw error;
    }
    throw new CredentialDecryptionError();
  }
}
