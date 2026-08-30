import type { LookupFunction } from "node:net";
import { Readable } from "node:stream";

import type { IncomingMessage } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dnsLookupMock, httpRequestMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpRequestMock: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));
vi.mock("node:http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:http")>()),
  request: httpRequestMock,
}));

import { auditStorefront } from "./audit.server";

describe("readiness audit network binding", () => {
  const connectedAddresses: string[] = [];
  const requestSignals: AbortSignal[] = [];
  const responsePlans: Array<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> = [];

  beforeEach(() => {
    connectedAddresses.length = 0;
    requestSignals.length = 0;
    responsePlans.splice(0, responsePlans.length, {
      status: 200,
      headers: { "content-type": "text/html" },
      body: "<html><head><title>Desk</title><meta name=\"description\" content=\"Desk\"></head></html>",
    });
    dnsLookupMock.mockReset();
    httpRequestMock.mockReset();

    httpRequestMock.mockImplementation(
      (
        url: URL,
        options: { lookup: LookupFunction; signal: AbortSignal },
        onResponse: (response: IncomingMessage) => void,
      ) => {
        requestSignals.push(options.signal);
        let onError: ((error: Error) => void) | undefined;
        const request = {
          once: vi.fn((event: string, listener: (error: Error) => void) => {
            if (event === "error") onError = listener;
            return request;
          }),
          end: vi.fn(() => {
            options.lookup(
              url.hostname,
              { all: false },
              (error, address) => {
                if (error) {
                  onError?.(error);
                  return;
                }
                connectedAddresses.push(address as string);
                const plan = responsePlans.shift();
                if (!plan) throw new Error("No response was planned for the request.");
                const response = Readable.from([
                  Buffer.from(plan.body),
                ]) as IncomingMessage;
                response.statusCode = plan.status;
                response.headers = plan.headers;
                onResponse(response);
              },
            );
          }),
        };
        return request;
      },
    );
  });

  it("never dials a private answer returned after public validation", async () => {
    dnsLookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    const audit = await auditStorefront(
      "http://rebind.example/products/desk",
    );

    expect(audit.finalUrl).toBe("http://rebind.example/products/desk");
    expect(connectedAddresses).toEqual(["93.184.216.34"]);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(dnsLookupMock).toHaveBeenCalledTimes(3);
    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0].aborted).toBe(false);
  });

  it("revalidates a redirect and refuses its rebound private answer", async () => {
    responsePlans.splice(0, responsePlans.length, {
      status: 302,
      headers: { location: "/private-target" },
      body: "",
    });
    dnsLookupMock
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }]);

    await expect(
      auditStorefront("http://rebind.example/start"),
    ).rejects.toThrow("did not resolve to a public web address");

    expect(connectedAddresses).toEqual(["93.184.216.34"]);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
    expect(dnsLookupMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the declared response-size limit on the pinned transport", async () => {
    responsePlans.splice(0, responsePlans.length, {
      status: 200,
      headers: {
        "content-length": "1500001",
        "content-type": "text/html",
      },
      body: "",
    });
    dnsLookupMock.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
    ]);

    await expect(
      auditStorefront("http://public.example/oversized"),
    ).rejects.toThrow("too large to audit safely");

    expect(connectedAddresses).toEqual(["93.184.216.34"]);
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });
});
