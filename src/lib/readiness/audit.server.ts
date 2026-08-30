import "server-only";

import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import {
  readinessAuditSchema,
  type ReadinessAudit,
  type ReadinessCheck,
  type ReadinessCheckStatus,
} from "./schema";
import { analyzeMeasurementInstallation } from "./measurement";

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1_500_000;
const MAX_REDIRECTS = 4;
const AUDITOR_USER_AGENT =
  "MaintainFlow-Readiness/0.1 (+https://maintainflow.io)";

type FetchedDocument = {
  url: URL;
  status: number;
  contentType: string;
  headers: Headers;
  body: string;
};

type RobotsRule = {
  directive: "allow" | "disallow";
  pattern: string;
};

type RobotsGroup = {
  userAgents: string[];
  rules: RobotsRule[];
};

type HtmlSignals = {
  hasTitle: boolean;
  hasDescription: boolean;
  hasCanonical: boolean;
  hasNoIndex: boolean;
  hasProductSchema: boolean;
  hasOfferFacts: boolean;
};

type AddressResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupAddress[]>;

const nonPublicIpv4Addresses = new BlockList();
nonPublicIpv4Addresses.addSubnet("0.0.0.0", 8, "ipv4");
nonPublicIpv4Addresses.addSubnet("10.0.0.0", 8, "ipv4");
nonPublicIpv4Addresses.addSubnet("100.64.0.0", 10, "ipv4");
nonPublicIpv4Addresses.addSubnet("127.0.0.0", 8, "ipv4");
nonPublicIpv4Addresses.addSubnet("169.254.0.0", 16, "ipv4");
nonPublicIpv4Addresses.addSubnet("172.16.0.0", 12, "ipv4");
nonPublicIpv4Addresses.addSubnet("192.0.0.0", 24, "ipv4");
nonPublicIpv4Addresses.addSubnet("192.0.2.0", 24, "ipv4");
nonPublicIpv4Addresses.addSubnet("192.88.99.0", 24, "ipv4");
nonPublicIpv4Addresses.addSubnet("192.168.0.0", 16, "ipv4");
nonPublicIpv4Addresses.addSubnet("198.18.0.0", 15, "ipv4");
nonPublicIpv4Addresses.addSubnet("198.51.100.0", 24, "ipv4");
nonPublicIpv4Addresses.addSubnet("203.0.113.0", 24, "ipv4");
nonPublicIpv4Addresses.addSubnet("224.0.0.0", 4, "ipv4");
nonPublicIpv4Addresses.addSubnet("240.0.0.0", 4, "ipv4");

const nonPublicIpv6Addresses = new BlockList();
nonPublicIpv6Addresses.addSubnet("::", 96, "ipv6");
nonPublicIpv6Addresses.addSubnet("::ffff:0:0", 96, "ipv6");
nonPublicIpv6Addresses.addSubnet("64:ff9b::", 96, "ipv6");
nonPublicIpv6Addresses.addSubnet("64:ff9b:1::", 48, "ipv6");
nonPublicIpv6Addresses.addSubnet("100::", 64, "ipv6");
nonPublicIpv6Addresses.addSubnet("100:0:0:1::", 64, "ipv6");
nonPublicIpv6Addresses.addSubnet("2001::", 23, "ipv6");
nonPublicIpv6Addresses.addSubnet("2001:db8::", 32, "ipv6");
nonPublicIpv6Addresses.addSubnet("2002::", 16, "ipv6");
nonPublicIpv6Addresses.addSubnet("3fff::", 20, "ipv6");
nonPublicIpv6Addresses.addSubnet("5f00::", 16, "ipv6");
nonPublicIpv6Addresses.addSubnet("fc00::", 7, "ipv6");
nonPublicIpv6Addresses.addSubnet("fe80::", 10, "ipv6");
nonPublicIpv6Addresses.addSubnet("fec0::", 10, "ipv6");
nonPublicIpv6Addresses.addSubnet("ff00::", 8, "ipv6");

function check(
  id: string,
  title: string,
  status: ReadinessCheckStatus,
  weight: number,
  evidence: string,
  recommendation: string,
): ReadinessCheck {
  return { id, title, status, weight, evidence, recommendation };
}

export function normalizeAuditUrl(input: string): URL {
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(input.trim())
    ? input.trim()
    : `https://${input.trim()}`;
  const url = new URL(candidate);

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("Use a public HTTP or HTTPS landing-page URL.");
  }
  if (url.username || url.password) {
    throw new Error("URLs containing a username or password are not supported.");
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error("Only standard web ports 80 and 443 can be audited.");
  }

  url.hash = "";
  return url;
}

export function isPrivateAddress(address: string): boolean {
  const candidate = address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;

  if (candidate === "::" || candidate === "::1") return true;

  const mappedV4 = candidate.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (mappedV4) return isPrivateAddress(mappedV4);

  if (isIP(candidate) === 6) {
    return nonPublicIpv6Addresses.check(candidate, "ipv6");
  }

  if (isIP(candidate) !== 4) return true;
  return nonPublicIpv4Addresses.check(candidate, "ipv4");
}

function normalizedHostname(urlOrHostname: URL | string): string {
  const hostname = typeof urlOrHostname === "string"
    ? urlOrHostname
    : urlOrHostname.hostname;
  const withoutIpv6Brackets = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  return withoutIpv6Brackets.toLowerCase().replace(/\.$/, "");
}

export async function resolvePublicAddresses(
  url: URL,
  resolveHostname: AddressResolver = lookup,
): Promise<LookupAddress[]> {
  const hostname = normalizedHostname(url);
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    throw new Error("Private and local network addresses cannot be audited.");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error("Private and local network addresses cannot be audited.");
    }
    return [{ address: hostname, family: isIP(hostname) }];
  }

  const addresses = await resolveHostname(hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      isIP(address) !== family || isPrivateAddress(address))
  ) {
    throw new Error("The hostname did not resolve to a public web address.");
  }

  return addresses;
}

export function createPinnedLookup(
  expectedHostname: string,
  publicAddresses: readonly LookupAddress[],
): LookupFunction {
  const hostname = normalizedHostname(expectedHostname);
  const addresses = publicAddresses.map(({ address, family }) => ({
    address,
    family,
  }));

  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) =>
      isIP(address) !== family || isPrivateAddress(address))
  ) {
    throw new Error("A connection can only use validated public addresses.");
  }

  return (requestedHostname, options, callback) => {
    if (normalizedHostname(requestedHostname) !== hostname) {
      const error = new Error("The connection hostname changed after validation.") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }

    const requestedFamily = options.family === "IPv4"
      ? 4
      : options.family === "IPv6"
        ? 6
        : options.family;
    const eligible = requestedFamily === 4 || requestedFamily === 6
      ? addresses.filter(({ family }) => family === requestedFamily)
      : addresses;

    if (eligible.length === 0) {
      const error = new Error("No validated public address matches the requested family.") as NodeJS.ErrnoException;
      error.code = "ENOTFOUND";
      callback(error, "", 0);
      return;
    }

    if (options.all) {
      callback(null, eligible);
      return;
    }

    callback(null, eligible[0].address, eligible[0].family);
  };
}

async function readLimitedBody(response: IncomingMessage): Promise<string> {
  const declaredLength = Number(response.headers["content-length"] ?? "0");
  if (declaredLength > MAX_BODY_BYTES) {
    response.destroy();
    throw new Error("The page is too large to audit safely.");
  }
  const decoder = new TextDecoder();
  let received = 0;
  let body = "";

  for await (const chunk of response) {
    const value = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    received += value.byteLength;
    if (received > MAX_BODY_BYTES) {
      response.destroy();
      throw new Error("The page is too large to audit safely.");
    }
    body += decoder.decode(value, { stream: true });
  }

  return body + decoder.decode();
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      value.forEach((item) => headers.append(name, item));
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

async function requestPinnedDocument(
  url: URL,
  publicAddresses: readonly LookupAddress[],
): Promise<Omit<FetchedDocument, "url" | "body"> & { response: IncomingMessage }> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      url,
      {
        agent: false,
        headers: {
          Accept: "text/html,application/xhtml+xml,text/plain,application/xml;q=0.8,*/*;q=0.5",
          "Accept-Encoding": "identity",
          "User-Agent": AUDITOR_USER_AGENT,
        },
        lookup: createPinnedLookup(url.hostname, publicAddresses),
        method: "GET",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      resolve,
    );
    request.once("error", reject);
    request.end();
  });
  const headers = responseHeaders(response);

  return {
    status: response.statusCode ?? 0,
    contentType: headers.get("content-type") ?? "",
    headers,
    response,
  };
}

async function fetchDocument(startUrl: URL): Promise<FetchedDocument> {
  let currentUrl = new URL(startUrl);

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const publicAddresses = await resolvePublicAddresses(currentUrl);
    const response = await requestPinnedDocument(currentUrl, publicAddresses);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      response.response.destroy();
      if (!location) throw new Error("The site returned a redirect without a destination.");
      currentUrl = normalizeAuditUrl(new URL(location, currentUrl).toString());
      continue;
    }

    return {
      url: currentUrl,
      status: response.status,
      contentType: response.contentType,
      headers: response.headers,
      body: await readLimitedBody(response.response),
    };
  }

  throw new Error("The landing page redirected too many times.");
}

function htmlAttribute(content: string, name: string): string | undefined {
  const expression = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return content.match(expression)?.[1]?.trim();
}

function metaContent(html: string, names: string[]): string | undefined {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const name = (htmlAttribute(tag, "name") ?? htmlAttribute(tag, "property"))?.toLowerCase();
    if (name && names.includes(name)) return htmlAttribute(tag, "content");
  }
}

function collectJsonLdTypes(value: unknown, types: Set<string>) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectJsonLdTypes(item, types));
    return;
  }
  if (!value || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const rawType = record["@type"];
  const typeValues = Array.isArray(rawType) ? rawType : [rawType];
  typeValues.forEach((type) => {
    if (typeof type === "string") types.add(type.toLowerCase());
  });
  Object.values(record).forEach((item) => collectJsonLdTypes(item, types));
}

function jsonLdDocuments(html: string): unknown[] {
  const documents: unknown[] = [];
  const expression = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(expression)) {
    try {
      documents.push(JSON.parse(match[1].trim()));
    } catch {
      // An invalid JSON-LD block is treated as absent evidence.
    }
  }
  return documents;
}

function containsOfferFacts(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsOfferFacts);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const types = (Array.isArray(type) ? type : [type]).filter(
    (item): item is string => typeof item === "string",
  );
  if (
    types.some((item) => ["offer", "aggregateoffer"].includes(item.toLowerCase())) &&
    (record.price !== undefined || record.lowPrice !== undefined || record.highPrice !== undefined) &&
    record.availability !== undefined
  ) {
    return true;
  }
  return Object.values(record).some(containsOfferFacts);
}

export function analyzeHtml(html: string, headers = new Headers()): HtmlSignals {
  const jsonLd = jsonLdDocuments(html);
  const types = new Set<string>();
  jsonLd.forEach((document) => collectJsonLdTypes(document, types));
  const robotsMeta = metaContent(html, ["robots", "oai-searchbot", "oai-adsbot"]);
  const xRobotsTag = headers.get("x-robots-tag") ?? "";

  return {
    hasTitle: /<title\b[^>]*>\s*[^<]+\s*<\/title>/i.test(html),
    hasDescription: Boolean(metaContent(html, ["description", "og:description"])),
    hasCanonical: /<link\b[^>]*rel\s*=\s*["'][^"']*canonical[^"']*["'][^>]*>/i.test(html),
    hasNoIndex: /(?:^|[,\s])noindex(?:$|[,\s])/i.test(
      `${robotsMeta ?? ""},${xRobotsTag}`,
    ),
    hasProductSchema: types.has("product"),
    hasOfferFacts:
      jsonLd.some(containsOfferFacts) ||
      Boolean(metaContent(html, ["product:price:amount"])) &&
        Boolean(metaContent(html, ["product:availability"])),
  };
}

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (directive === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { userAgents: [], rules: [] };
        groups.push(current);
      }
      current.userAgents.push(value.toLowerCase());
      continue;
    }
    if ((directive === "allow" || directive === "disallow") && current) {
      current.rules.push({ directive, pattern: value });
    }
  }

  return groups;
}

function ruleMatches(path: string, pattern: string): boolean {
  if (!pattern) return false;
  const anchored = pattern.endsWith("$");
  const source = pattern
    .replace(/\$$/, "")
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
}

export function isCrawlerAllowed(
  robotsText: string,
  userAgent: "oai-adsbot" | "oai-searchbot",
  pathname: string,
): boolean {
  const groups = parseRobotsTxt(robotsText);
  const exact = groups.filter((group) => group.userAgents.includes(userAgent));
  const applicable = exact.length > 0
    ? exact
    : groups.filter((group) => group.userAgents.includes("*"));
  const matches = applicable
    .flatMap((group) => group.rules)
    .filter((rule) => ruleMatches(pathname, rule.pattern))
    .sort((left, right) => {
      if (right.pattern.length !== left.pattern.length) {
        return right.pattern.length - left.pattern.length;
      }
      return left.directive === "allow" ? -1 : 1;
    });
  return matches[0]?.directive !== "disallow";
}

function scoreChecks(checks: ReadinessCheck[]): number {
  return Math.round(
    checks.reduce((total, item) => {
      if (item.status === "pass") return total + item.weight;
      if (item.status === "warning") return total + item.weight * 0.5;
      return total;
    }, 0),
  );
}

export function classifyReadiness(
  checks: ReadinessCheck[],
  score = scoreChecks(checks),
): ReadinessAudit["verdict"] {
  const byId = new Map(checks.map((item) => [item.id, item]));
  const hardBlocker = ["landing_page", "oai_adsbot", "indexability"].some(
    (id) => byId.get(id)?.status === "fail",
  );
  if (hardBlocker || score < 60) return "not_ready";

  const commerceSignalsReady = ["product_schema", "offer_facts"].every(
    (id) => byId.get(id)?.status === "pass",
  );
  const metadataReady = byId.get("page_metadata")?.status !== "fail";
  return score >= 85 && commerceSignalsReady && metadataReady
    ? "ready"
    : "needs_work";
}

export async function auditStorefront(input: string): Promise<ReadinessAudit> {
  const requestedUrl = normalizeAuditUrl(input);
  const page = await fetchDocument(requestedUrl);
  const origin = page.url.origin;
  const robotsUrl = new URL("/robots.txt", origin);
  const defaultSitemapUrl = new URL("/sitemap.xml", origin);
  const [robotsResult, sitemapResult] = await Promise.allSettled([
    fetchDocument(robotsUrl),
    fetchDocument(defaultSitemapUrl),
  ]);

  const robots = robotsResult.status === "fulfilled" ? robotsResult.value : null;
  const sitemap = sitemapResult.status === "fulfilled" ? sitemapResult.value : null;
  const html = page.contentType.includes("html") ? page.body : "";
  const signals = analyzeHtml(html, page.headers);
  const measurement = analyzeMeasurementInstallation(html, page.headers);
  const pageSucceeded = page.status >= 200 && page.status < 300 && Boolean(html);
  const robotsAvailable = robots && robots.status >= 200 && robots.status < 300;
  const robotsAbsent = robots?.status === 404;
  const adsBotAllowed = robotsAvailable
    ? isCrawlerAllowed(robots.body, "oai-adsbot", page.url.pathname)
    : robotsAbsent;
  const searchBotAllowed = robotsAvailable
    ? isCrawlerAllowed(robots.body, "oai-searchbot", page.url.pathname)
    : robotsAbsent;
  const sitemapDeclared = robotsAvailable && /(?:^|\n)\s*sitemap\s*:/i.test(robots.body);
  const sitemapReachable = Boolean(
    sitemap && sitemap.status >= 200 && sitemap.status < 300 && sitemap.body.trim(),
  );

  const checks: ReadinessCheck[] = [
    check(
      "landing_page",
      "Landing page can be fetched",
      pageSucceeded ? "pass" : "fail",
      20,
      pageSucceeded
        ? `Received HTTP ${page.status} with crawlable HTML.`
        : `Received HTTP ${page.status}${html ? "" : " without crawlable HTML"}.`,
      "Return a successful HTML response without login, CAPTCHA, or JavaScript-only interstitials.",
    ),
    check(
      "oai_adsbot",
      "OAI-AdsBot is allowed",
      adsBotAllowed ? "pass" : robots ? "fail" : "warning",
      25,
      robotsAvailable
        ? `${adsBotAllowed ? "No blocking rule applies" : "A blocking rule applies"} to ${page.url.pathname}.`
        : robotsAbsent
          ? "robots.txt returned 404, so no robots exclusion rules were found."
          : "robots.txt could not be verified.",
      "Explicitly allow OAI-AdsBot for the landing-page path; OpenAI identifies it as required for ads review.",
    ),
    check(
      "oai_searchbot",
      "OAI-SearchBot is allowed",
      searchBotAllowed ? "pass" : robots ? "fail" : "warning",
      15,
      robotsAvailable
        ? `${searchBotAllowed ? "No blocking rule applies" : "A blocking rule applies"} to ${page.url.pathname}.`
        : robotsAbsent
          ? "robots.txt returned 404, so no robots exclusion rules were found."
          : "robots.txt could not be verified.",
      "Allow OAI-SearchBot so public content can be discovered and cited in ChatGPT search.",
    ),
    check(
      "indexability",
      "Page is indexable",
      pageSucceeded && !signals.hasNoIndex ? "pass" : signals.hasNoIndex ? "fail" : "warning",
      10,
      signals.hasNoIndex
        ? "A noindex directive was found in page metadata or response headers."
        : pageSucceeded
          ? "No noindex directive was found."
          : "Indexability could not be confirmed because the page was not crawlable.",
      "Remove noindex from pages that should be eligible for discovery, while keeping private pages excluded.",
    ),
    check(
      "https",
      "Secure destination",
      page.url.protocol === "https:" ? "pass" : "warning",
      5,
      page.url.protocol === "https:" ? "The final URL uses HTTPS." : "The final URL uses HTTP.",
      "Serve the final landing page over HTTPS and redirect HTTP requests permanently.",
    ),
    check(
      "product_schema",
      "Product structured data",
      signals.hasProductSchema ? "pass" : "warning",
      10,
      signals.hasProductSchema
        ? "A Product type was found in JSON-LD."
        : "No Product type was found in valid JSON-LD.",
      "Add valid Product JSON-LD that reflects the visible product name, description, image, brand, and identifiers.",
    ),
    check(
      "offer_facts",
      "Price and availability are machine-readable",
      signals.hasOfferFacts ? "pass" : "warning",
      8,
      signals.hasOfferFacts
        ? "Machine-readable price and availability signals were found."
        : "A complete machine-readable offer with price and availability was not found.",
      "Expose current price, currency, and availability in Product/Offer JSON-LD and keep it aligned with visible content.",
    ),
    check(
      "page_metadata",
      "Core page metadata",
      signals.hasTitle && signals.hasDescription && signals.hasCanonical
        ? "pass"
        : signals.hasTitle && signals.hasDescription
          ? "warning"
          : "fail",
      4,
      `${signals.hasTitle ? "Title" : "No title"}; ${signals.hasDescription ? "description" : "no description"}; ${signals.hasCanonical ? "canonical URL" : "no canonical URL"}.`,
      "Provide a unique title, useful description, and canonical URL that match the landing page.",
    ),
    check(
      "sitemap",
      "Sitemap is discoverable",
      sitemapReachable || sitemapDeclared ? "pass" : "warning",
      3,
      sitemapReachable
        ? "/sitemap.xml returned a successful response."
        : sitemapDeclared
          ? "robots.txt declares a sitemap."
          : "No sitemap was found at /sitemap.xml or declared in robots.txt.",
      "Publish an XML sitemap and declare its URL in robots.txt.",
    ),
  ];

  const score = scoreChecks(checks);
  return readinessAuditSchema.parse({
    requestedUrl: requestedUrl.toString(),
    finalUrl: page.url.toString(),
    scannedAt: new Date().toISOString(),
    score,
    verdict: classifyReadiness(checks, score),
    checks,
    measurement,
    limitations: [
      "This scan evaluates one public URL and its origin-level robots.txt and sitemap; it is not a full-site crawl.",
      "A successful MaintainFlow request cannot prove that every CDN, WAF, geographic rule, or bot challenge will allow OpenAI's crawler infrastructure.",
      "Structured-data presence is checked, but policy compliance and ad approval remain OpenAI decisions.",
      "Measurement checks inspect only returned HTML and response policy. They do not execute JavaScript, fire an event, inspect tag-manager configuration, or prove that the Pixel received or attributed a conversion.",
      "The server-side Conversions API cannot be observed from a public page. Validate it separately with validate_only before sending production events.",
    ],
  });
}
