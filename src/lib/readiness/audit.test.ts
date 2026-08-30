import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  analyzeHtml,
  classifyReadiness,
  createPinnedLookup,
  evaluateOpenAICrawlerAccess,
  isCrawlerAllowed,
  isPrivateAddress,
  normalizeAuditUrl,
  parseRobotsTxt,
  resolvePublicAddresses,
} from "./audit.server";

describe("readiness URL safety", () => {
  it("normalizes a bare hostname to HTTPS", () => {
    expect(normalizeAuditUrl("shop.example.com/products/1").toString()).toBe(
      "https://shop.example.com/products/1",
    );
  });

  it("rejects unsupported schemes and non-standard ports", () => {
    expect(() => normalizeAuditUrl("file:///etc/passwd")).toThrow();
    expect(() => normalizeAuditUrl("https://example.com:3000")).toThrow();
  });

  it("identifies private and reserved network addresses", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.20.30.40")).toBe(true);
    expect(isPrivateAddress("192.168.1.2")).toBe(true);
    expect(isPrivateAddress("192.88.99.1")).toBe(true);
    expect(isPrivateAddress("224.0.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true);
    expect(isPrivateAddress("[fc00::1]")).toBe(true);
    expect(isPrivateAddress("ff02::1")).toBe(true);
    expect(isPrivateAddress("100:0:0:1::1")).toBe(true);
    expect(isPrivateAddress("3fff::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
  });

  it("accepts a literal public IPv6 target without a second resolver", async () => {
    const resolver = vi.fn();

    await expect(
      resolvePublicAddresses(
        new URL("https://[2606:4700:4700::1111]/products/desk"),
        resolver,
      ),
    ).resolves.toEqual([
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects an IPv4-mapped loopback literal", async () => {
    await expect(
      resolvePublicAddresses(new URL("https://[::ffff:7f00:1]/")),
    ).rejects.toThrow("Private and local network addresses");
  });

  it("pins the validated public DNS answer for the connection", async () => {
    const resolver = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const url = new URL("https://rebind.example/products/desk");
    const validated = await resolvePublicAddresses(url, resolver);
    const connectionLookup = createPinnedLookup(url.hostname, validated);

    const connectedAddress = await new Promise<{ address: string; family: number }>(
      (resolve, reject) => {
        connectionLookup(url.hostname, { all: false }, (error, address, family) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ address: address as string, family: family ?? 0 });
        });
      },
    );

    expect(connectedAddress).toEqual({ address: "93.184.216.34", family: 4 });
    expect(resolver).toHaveBeenCalledTimes(1);

    const rebound = await resolver(url.hostname, { all: true, verbatim: true });
    expect(rebound).toEqual([{ address: "127.0.0.1", family: 4 }]);

    const connectionAfterRebind = await new Promise<string>((resolve, reject) => {
      connectionLookup(url.hostname, { all: false }, (error, address) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address as string);
      });
    });
    expect(connectionAfterRebind).toBe("93.184.216.34");
  });

  it("rejects a DNS answer set containing a private connection target", async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.7", family: 4 },
    ]);

    await expect(
      resolvePublicAddresses(new URL("https://mixed.example"), resolver),
    ).rejects.toThrow("did not resolve to a public web address");
  });
});

describe("robots rules", () => {
  const robots = `
User-agent: *
Disallow: /checkout

User-agent: OAI-AdsBot
Disallow: /
Allow: /products/

User-agent: OAI-SearchBot
Allow: /
`;

  it("parses crawler groups", () => {
    expect(parseRobotsTxt(robots)).toHaveLength(3);
  });

  it("uses the most specific matching rule", () => {
    expect(isCrawlerAllowed(robots, "oai-adsbot", "/products/desk")).toBe(true);
    expect(isCrawlerAllowed(robots, "oai-adsbot", "/collections/desks")).toBe(false);
    expect(isCrawlerAllowed(robots, "oai-searchbot", "/collections/desks")).toBe(true);
  });

  it("falls back to wildcard rules when no crawler-specific group exists", () => {
    const wildcard = "User-agent: *\nDisallow: /private";
    expect(isCrawlerAllowed(wildcard, "oai-adsbot", "/private/item")).toBe(false);
    expect(isCrawlerAllowed(wildcard, "oai-adsbot", "/products/item")).toBe(true);
  });

  it("preserves wildcard, prefix, and terminal-anchor semantics", () => {
    const wildcard = [
      "User-agent: *",
      "Disallow: /private/*/end$",
      "Disallow: /draft*",
    ].join("\n");

    expect(isCrawlerAllowed(wildcard, "oai-adsbot", "/private/item/end")).toBe(
      false,
    );
    expect(
      isCrawlerAllowed(wildcard, "oai-adsbot", "/private/item/end/more"),
    ).toBe(true);
    expect(isCrawlerAllowed(wildcard, "oai-adsbot", "/draft-copy/page")).toBe(
      false,
    );
  });

  it("evaluates a wildcard-heavy near miss without regex backtracking", () => {
    const pattern = `/${"*a".repeat(120)}b$`;
    const path = `/${"a".repeat(120)}c`;
    const robotsTxt = `User-agent: *\nDisallow: ${pattern}`;

    expect(isCrawlerAllowed(robotsTxt, "oai-adsbot", path)).toBe(true);
  });

  it("rejects robots files outside the bounded evaluation contract", () => {
    const tooManyWildcards = `User-agent: *\nDisallow: /${"*".repeat(129)}`;
    const tooLong = `User-agent: *\nDisallow: /${"x".repeat(2_048)}`;
    const tooManyRules = [
      "User-agent: *",
      ...Array.from({ length: 1_001 }, (_, index) => `Disallow: /${index}`),
    ].join("\n");

    for (const robotsTxt of [tooManyWildcards, tooLong, tooManyRules]) {
      expect(() => parseRobotsTxt(robotsTxt)).toThrow(
        "robots.txt is too complex to evaluate safely",
      );
      expect(isCrawlerAllowed(robotsTxt, "oai-adsbot", "/products/item")).toBe(
        false,
      );
    }

    expect(
      evaluateOpenAICrawlerAccess(tooManyRules, "/products/item"),
    ).toEqual({
      adsBotAllowed: false,
      searchBotAllowed: false,
      evaluationLimited: true,
    });
  });
});

describe("HTML evidence", () => {
  it("finds metadata and complete Product offer JSON-LD", () => {
    const html = `
      <html><head>
        <title>Desk Lamp</title>
        <meta name="description" content="A useful desk lamp">
        <link rel="canonical" href="https://shop.example/products/lamp">
        <script type="application/ld+json">
          {"@context":"https://schema.org","@type":"Product","name":"Desk Lamp","offers":{"@type":"Offer","price":"49.00","availability":"https://schema.org/InStock"}}
        </script>
      </head></html>
    `;

    expect(analyzeHtml(html)).toEqual({
      hasTitle: true,
      hasDescription: true,
      hasCanonical: true,
      hasNoIndex: false,
      hasProductSchema: true,
      hasOfferFacts: true,
    });
  });

  it("detects noindex and does not accept incomplete offers", () => {
    const html = `
      <meta name="robots" content="noindex, follow">
      <script type="application/ld+json">{"@type":"Product","offers":{"@type":"Offer","price":"49"}}</script>
    `;

    expect(analyzeHtml(html)).toMatchObject({
      hasNoIndex: true,
      hasProductSchema: true,
      hasOfferFacts: false,
    });
  });
});

describe("readiness verdict", () => {
  const baseChecks = [
    { id: "landing_page", title: "Page", status: "pass" as const, weight: 20, evidence: "", recommendation: "" },
    { id: "oai_adsbot", title: "Ads bot", status: "pass" as const, weight: 25, evidence: "", recommendation: "" },
    { id: "indexability", title: "Index", status: "pass" as const, weight: 10, evidence: "", recommendation: "" },
    { id: "product_schema", title: "Product", status: "pass" as const, weight: 10, evidence: "", recommendation: "" },
    { id: "offer_facts", title: "Offer", status: "pass" as const, weight: 8, evidence: "", recommendation: "" },
    { id: "page_metadata", title: "Metadata", status: "pass" as const, weight: 4, evidence: "", recommendation: "" },
  ];

  it("does not label a high score ready without commerce signals", () => {
    const checks = baseChecks.map((item) =>
      item.id === "product_schema" ? { ...item, status: "warning" as const } : item,
    );
    expect(classifyReadiness(checks, 92)).toBe("needs_work");
  });

  it("treats an AdsBot block as not ready regardless of score", () => {
    const checks = baseChecks.map((item) =>
      item.id === "oai_adsbot" ? { ...item, status: "fail" as const } : item,
    );
    expect(classifyReadiness(checks, 90)).toBe("not_ready");
  });

  it("only labels complete high-scoring evidence ready", () => {
    expect(classifyReadiness(baseChecks, 90)).toBe("ready");
  });
});
