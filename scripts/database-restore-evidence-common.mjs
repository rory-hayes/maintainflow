import { createHash } from "node:crypto";
import { constants as fsConstants, open } from "node:fs/promises";

export const EVIDENCE_SCHEMA_VERSION = 2;
export const MAX_EVIDENCE_MANIFEST_BYTES = 256 * 1024;
export const FULL_GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;
export const RECOVERY_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export class RestoreVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = "RestoreVerificationError";
  }
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(
        ([key, entry]) =>
          `${JSON.stringify(key)}:${canonicalJson(entry)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function withManifestChecksum(manifestWithoutChecksum) {
  return {
    ...manifestWithoutChecksum,
    manifestSha256: sha256(canonicalJson(manifestWithoutChecksum)),
  };
}

export function verifyManifestChecksum(manifest, label = "evidence") {
  if (!SHA256_PATTERN.test(manifest?.manifestSha256 ?? "")) {
    throw new RestoreVerificationError(
      `The ${label} manifest is malformed.`,
    );
  }
  const { manifestSha256, ...unsigned } = manifest;
  if (sha256(canonicalJson(unsigned)) !== manifestSha256) {
    throw new RestoreVerificationError(
      `The ${label} manifest checksum is invalid.`,
    );
  }
}

function targetReference(value) {
  const normalized = value?.trim();
  if (
    !normalized ||
    normalized.length < 8 ||
    normalized.length > 256 ||
    /[\r\n]/.test(normalized)
  ) {
    throw new RestoreVerificationError(
      "The provider database target reference must be an 8- to 256-character single-line value.",
    );
  }
  return normalized;
}

function canonicalHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized.endsWith(".") && !normalized.startsWith("[")
    ? normalized.slice(0, -1)
    : normalized;
}

function isLoopback(hostname) {
  return new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(
    canonicalHostname(hostname),
  );
}

export function databaseTargetIdentity(databaseUrl, instanceReference) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new RestoreVerificationError(
      "The database target URL must be a valid PostgreSQL URL.",
    );
  }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol)) {
    throw new RestoreVerificationError(
      "The database target URL must use PostgreSQL.",
    );
  }
  if (!parsed.hostname || isLoopback(parsed.hostname)) {
    throw new RestoreVerificationError(
      "Backup and restore evidence requires a distinct hosted PostgreSQL target.",
    );
  }
  const sslModes = parsed.searchParams.getAll("sslmode");
  if (sslModes.length !== 1 || sslModes[0] !== "verify-full") {
    throw new RestoreVerificationError(
      "Hosted evidence URLs must include exactly one sslmode=verify-full parameter.",
    );
  }
  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new RestoreVerificationError(
      "The database target URL contains an invalid database name.",
    );
  }
  if (
    !databaseName ||
    databaseName.includes("/") ||
    /[\u0000-\u001f\u007f]/.test(databaseName)
  ) {
    throw new RestoreVerificationError(
      "The database target URL must name exactly one database.",
    );
  }
  const canonicalEndpoint = `${canonicalHostname(parsed.hostname)}:${parsed.port || "5432"}/${databaseName}`;
  const reference = targetReference(instanceReference);
  return {
    databaseName,
    endpointIdentitySha256: sha256(canonicalEndpoint),
    referenceSha256: sha256(reference),
    // Preserve the existing reviewed composite identity while also exposing
    // independently comparable endpoint and provider-reference hashes.
    identitySha256: sha256(`${canonicalEndpoint}\n${reference}`),
  };
}

export async function writeEvidenceManifest(filePath, manifest) {
  let fileHandle;
  try {
    fileHandle = await open(
      filePath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    await fileHandle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
    });
    await fileHandle.sync();
    const fileStatus = await fileHandle.stat();
    if (!fileStatus.isFile() || (fileStatus.mode & 0o777) !== 0o600) {
      throw new RestoreVerificationError(
        "The evidence manifest must be a mode-0600 regular file.",
      );
    }
  } finally {
    await fileHandle?.close();
  }
}

export async function readEvidenceManifest(filePath, label = "evidence") {
  let fileHandle;
  let contents;
  try {
    fileHandle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const fileStatus = await fileHandle.stat();
    if (
      !fileStatus.isFile() ||
      (fileStatus.mode & 0o777) !== 0o600 ||
      fileStatus.size <= 0 ||
      fileStatus.size > MAX_EVIDENCE_MANIFEST_BYTES
    ) {
      throw new RestoreVerificationError(
        `The ${label} must be a bounded mode-0600 regular file.`,
      );
    }
    contents = await fileHandle.readFile("utf8");
  } catch (error) {
    if (error instanceof RestoreVerificationError) throw error;
    throw new RestoreVerificationError(
      `The ${label} could not be opened as a no-follow regular file.`,
    );
  } finally {
    await fileHandle?.close();
  }
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new RestoreVerificationError(
      `The ${label} manifest is not valid JSON.`,
    );
  }
  verifyManifestChecksum(parsed, label);
  return parsed;
}
