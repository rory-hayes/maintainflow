import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

import { describe, expect, it } from "vitest";

import {
  DatabaseTlsConfigurationError,
  hostedDatabaseTlsOptions,
  validateDatabaseCaCertificate,
} from "./database-tls.mjs";

const testCaCertificate = rootCertificates.find((pem) => {
  const certificate = new X509Certificate(pem);
  const now = Date.now();
  return (
    certificate.ca &&
    Date.parse(certificate.validFrom) <= now &&
    Date.parse(certificate.validTo) > now &&
    certificate.checkIssued(certificate) &&
    certificate.verify(certificate.publicKey)
  );
});

if (!testCaCertificate) throw new Error("No valid test root CA is available.");

describe("hosted database TLS options", () => {
  it("pins one valid root CA while retaining hostname verification", () => {
    expect(
      hostedDatabaseTlsOptions({
        hosted: true,
        environment: { MAINTAINFLOW_DATABASE_CA_CERT: testCaCertificate },
      }),
    ).toEqual({
      ssl: {
        ca: testCaCertificate,
        rejectUnauthorized: true,
      },
    });
  });

  it("does not require a CA for a local database", () => {
    expect(
      hostedDatabaseTlsOptions({ hosted: false, environment: {} }),
    ).toEqual({});
  });

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-certificate"],
    ["multiple", `${testCaCertificate}\n${testCaCertificate}`],
  ])("rejects a %s hosted root CA", (_label, certificate) => {
    expect(() =>
      hostedDatabaseTlsOptions({
        hosted: true,
        environment: { MAINTAINFLOW_DATABASE_CA_CERT: certificate },
      }),
    ).toThrow(DatabaseTlsConfigurationError);
  });

  it("can translate validation failures into an operation-specific error", () => {
    expect(() =>
      hostedDatabaseTlsOptions({
        hosted: true,
        environment: {},
        createError: (message) => new TypeError(`Operator: ${message}`),
      }),
    ).toThrow(/^Operator: MAINTAINFLOW_DATABASE_CA_CERT/);
  });

  it("binds an independent certificate key to a hosted connection", () => {
    expect(
      hostedDatabaseTlsOptions({
        hosted: true,
        certificateKey: "MAINTAINFLOW_RESTORE_DATABASE_CA_CERT",
        environment: {
          MAINTAINFLOW_RESTORE_DATABASE_CA_CERT: testCaCertificate,
          MAINTAINFLOW_DATABASE_CA_CERT: "not-the-selected-certificate",
        },
      }),
    ).toEqual({
      ssl: {
        ca: testCaCertificate,
        rejectUnauthorized: true,
      },
    });
  });

  it("returns a normalized PEM block", () => {
    expect(validateDatabaseCaCertificate(`\n${testCaCertificate}\n`)).toBe(
      testCaCertificate.trim(),
    );
  });
});
