import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

vi.mock("server-only", () => ({}));

const databaseMocks = vi.hoisted(() => {
  const end = vi.fn(async () => undefined);
  const client = { end };
  return {
    client,
    end,
    create: vi.fn(() => client),
  };
});

vi.mock("postgres", () => ({ default: databaseMocks.create }));

import {
  closeRuntimeDatabase,
  getRuntimeDatabase,
  RuntimeDatabaseConfigurationError,
} from "./client.server";

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

beforeEach(async () => {
  await closeRuntimeDatabase();
  databaseMocks.create.mockClear();
  databaseMocks.end.mockClear();
  vi.unstubAllEnvs();
});

afterEach(async () => {
  await closeRuntimeDatabase();
  vi.unstubAllEnvs();
});

describe("shared runtime PostgreSQL client", () => {
  it("shares one bounded pool with an explicit public search path", () => {
    const url = "postgres://user:secret@localhost/maintainflow";

    const first = getRuntimeDatabase(url);
    const second = getRuntimeDatabase(url);

    expect(first).toBe(second);
    expect(databaseMocks.create).toHaveBeenCalledOnce();
    expect(databaseMocks.create).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        max: 4,
        prepare: false,
        connection: {
          application_name: "maintainflow-ads",
          search_path: "public",
        },
      }),
    );
  });

  it.each(["0", "11", "1.5", "many"])(
    "rejects an invalid per-instance pool limit: %s",
    (value) => {
      vi.stubEnv("MAINTAINFLOW_DATABASE_POOL_MAX", value);
      expect(() =>
        getRuntimeDatabase("postgres://user:secret@localhost/maintainflow"),
      ).toThrow("integer from 1 through 10");
      expect(databaseMocks.create).not.toHaveBeenCalled();
    },
  );

  it("accepts a valid explicit pool limit", () => {
    vi.stubEnv("MAINTAINFLOW_DATABASE_POOL_MAX", "7");

    getRuntimeDatabase("postgres://user:secret@localhost/maintainflow");

    expect(databaseMocks.create).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ max: 7 }),
    );
  });

  it.each([
    "postgres://db.example/maintainflow",
    "postgres://db.example/maintainflow?sslmode=require",
    "postgres://db.example/maintainflow?sslmode=verify-full&sslmode=require",
    "postgres://db.example/maintainflow?SSLMODE=verify-full",
  ])("fails closed on unsafe production TLS configuration", (url) => {
    vi.stubEnv("NODE_ENV", "production");

    expect(() => getRuntimeDatabase(url)).toThrow(
      "exactly one sslmode=verify-full",
    );
    expect(databaseMocks.create).not.toHaveBeenCalled();
  });

  it("pins certificate verification even after validating the URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MAINTAINFLOW_DATABASE_CA_CERT", testCaCertificate);
    const url =
      "postgres://user:secret@db.example/maintainflow?sslmode=verify-full";

    getRuntimeDatabase(url);

    expect(databaseMocks.create).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        ssl: {
          ca: testCaCertificate,
          rejectUnauthorized: true,
        },
      }),
    );
  });

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-certificate"],
    ["multiple", `${testCaCertificate}\n${testCaCertificate}`],
  ])("rejects a %s production database CA certificate", (_label, certificate) => {
    vi.stubEnv("NODE_ENV", "production");
    if (certificate === undefined) {
      vi.stubEnv("MAINTAINFLOW_DATABASE_CA_CERT", "");
    } else {
      vi.stubEnv("MAINTAINFLOW_DATABASE_CA_CERT", certificate);
    }

    expect(() =>
      getRuntimeDatabase(
        "postgres://user:secret@db.example/maintainflow?sslmode=verify-full",
      ),
    ).toThrow("MAINTAINFLOW_DATABASE_CA_CERT");
    expect(databaseMocks.create).not.toHaveBeenCalled();
  });

  it.each(["search_path=other", "options=-c%20search_path%3Dother"])(
    "rejects a URL-level search path override: %s",
    (query) => {
      expect(() =>
        getRuntimeDatabase(
          `postgres://user:secret@localhost/maintainflow?${query}`,
        ),
      ).toThrow("must not override");
    },
  );

  it("requires a restart rather than switching databases in one runtime", () => {
    getRuntimeDatabase("postgres://user:secret@localhost/first");

    expect(() =>
      getRuntimeDatabase("postgres://user:secret@localhost/second"),
    ).toThrow(RuntimeDatabaseConfigurationError);
    expect(databaseMocks.create).toHaveBeenCalledOnce();
  });

  it("closes once and permits a clean recreation without leaking secrets", async () => {
    const secret = "do-not-print-this-password";
    getRuntimeDatabase(`postgres://user:${secret}@localhost/first`);
    await closeRuntimeDatabase();
    getRuntimeDatabase(`postgres://user:${secret}@localhost/second`);

    expect(databaseMocks.end).toHaveBeenCalledOnce();
    expect(databaseMocks.create).toHaveBeenCalledTimes(2);

    let caught: unknown;
    try {
      getRuntimeDatabase(`postgres://user:${secret}@localhost/third`);
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).not.toContain(secret);
  });
});
