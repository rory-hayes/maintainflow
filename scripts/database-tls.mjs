import { X509Certificate } from "node:crypto";

export const DATABASE_CA_CERT_KEY = "MAINTAINFLOW_DATABASE_CA_CERT";
export function databaseCaCertificateError(
  certificateKey = DATABASE_CA_CERT_KEY,
) {
  return `${certificateKey} must contain one currently valid self-signed CA certificate for hosted database connections.`;
}
export const DATABASE_CA_CERT_ERROR = databaseCaCertificateError();

export class DatabaseTlsConfigurationError extends Error {
  constructor(message = DATABASE_CA_CERT_ERROR) {
    super(message);
    this.name = "DatabaseTlsConfigurationError";
  }
}

export function validateDatabaseCaCertificate(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DatabaseTlsConfigurationError();
  }

  const certificateBlocks = value.match(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
  );
  if (
    certificateBlocks?.length !== 1 ||
    certificateBlocks[0].trim() !== value.trim()
  ) {
    throw new DatabaseTlsConfigurationError();
  }

  try {
    const certificate = new X509Certificate(certificateBlocks[0]);
    const now = Date.now();
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (
      !certificate.ca ||
      !Number.isFinite(validFrom) ||
      !Number.isFinite(validTo) ||
      validFrom > now ||
      validTo <= now ||
      !certificate.checkIssued(certificate) ||
      !certificate.verify(certificate.publicKey)
    ) {
      throw new Error("The configured certificate is not a valid root CA.");
    }
  } catch {
    throw new DatabaseTlsConfigurationError();
  }

  return certificateBlocks[0];
}

export function hostedDatabaseTlsOptions({
  hosted,
  environment = process.env,
  certificateKey = DATABASE_CA_CERT_KEY,
  createError = (message) => new DatabaseTlsConfigurationError(message),
}) {
  if (!hosted) return {};

  try {
    return {
      ssl: {
        ca: validateDatabaseCaCertificate(environment[certificateKey]),
        rejectUnauthorized: true,
      },
    };
  } catch {
    throw createError(databaseCaCertificateError(certificateKey));
  }
}
