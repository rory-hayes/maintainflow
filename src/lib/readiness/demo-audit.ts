import type { ReadinessAudit } from "./schema";

const SAMPLE_STOREFRONT_URL =
  "https://harbourhome.example/products/modular-storage";

const sampleAudit = {
  requestedUrl: SAMPLE_STOREFRONT_URL,
  finalUrl: SAMPLE_STOREFRONT_URL,
  score: 91,
  verdict: "needs_work",
  checks: [
    {
      id: "landing_page",
      title: "Landing page can be fetched",
      status: "pass",
      weight: 20,
      evidence: "Received HTTP 200 with crawlable HTML.",
      recommendation:
        "Return a successful HTML response without login, CAPTCHA, or JavaScript-only interstitials.",
    },
    {
      id: "oai_adsbot",
      title: "OAI-AdsBot is allowed",
      status: "pass",
      weight: 25,
      evidence: "No blocking rule applies to /products/modular-storage.",
      recommendation:
        "Explicitly allow OAI-AdsBot for the landing-page path; OpenAI identifies it as required for ads review.",
    },
    {
      id: "oai_searchbot",
      title: "OAI-SearchBot is allowed",
      status: "pass",
      weight: 15,
      evidence: "No blocking rule applies to /products/modular-storage.",
      recommendation:
        "Allow OAI-SearchBot so public content can be discovered and cited in ChatGPT search.",
    },
    {
      id: "indexability",
      title: "Page is indexable",
      status: "pass",
      weight: 10,
      evidence: "No noindex directive was found.",
      recommendation:
        "Remove noindex from pages that should be eligible for discovery, while keeping private pages excluded.",
    },
    {
      id: "https",
      title: "Secure destination",
      status: "pass",
      weight: 5,
      evidence: "The final URL uses HTTPS.",
      recommendation:
        "Serve the final landing page over HTTPS and redirect HTTP requests permanently.",
    },
    {
      id: "product_schema",
      title: "Product structured data",
      status: "warning",
      weight: 10,
      evidence: "No Product type was found in valid JSON-LD.",
      recommendation:
        "Add valid Product JSON-LD that reflects the visible product name, description, image, brand, and identifiers.",
    },
    {
      id: "offer_facts",
      title: "Price and availability are machine-readable",
      status: "warning",
      weight: 8,
      evidence:
        "A complete machine-readable offer with price and availability was not found.",
      recommendation:
        "Expose current price, currency, and availability in Product/Offer JSON-LD and keep it aligned with visible content.",
    },
    {
      id: "page_metadata",
      title: "Core page metadata",
      status: "pass",
      weight: 4,
      evidence: "Title; description; canonical URL.",
      recommendation:
        "Provide a unique title, useful description, and canonical URL that match the landing page.",
    },
    {
      id: "sitemap",
      title: "Sitemap is discoverable",
      status: "pass",
      weight: 3,
      evidence: "/sitemap.xml returned a successful response.",
      recommendation:
        "Publish an XML sitemap and declare its URL in robots.txt.",
    },
  ],
  measurement: {
    status: "needs_attention",
    sdkDetected: true,
    initializationDetected: true,
    pixelIdDetected: true,
    imageTagDetected: false,
    consentSignalDetected: false,
    eventNames: ["contents_viewed", "page_viewed"],
    csp: {
      present: true,
      compatible: false,
      missingSources: ["connect-src https://bzr.openai.com"],
    },
    checks: [
      {
        id: "measurement_pixel",
        title: "Measurement tag installation",
        status: "pass",
        weight: 0,
        evidence:
          "The exact OpenAI SDK URL and a non-placeholder Pixel ID initialization were found.",
        recommendation:
          "Install the documented SDK once, initialize a Pixel ID from Ads Manager, or use the documented image tag for page-load events.",
      },
      {
        id: "measurement_events",
        title: "Supported event calls",
        status: "pass",
        weight: 0,
        evidence: "Static calls were found for: contents_viewed, page_viewed.",
        recommendation:
          "Use OpenAI's standard event taxonomy where it matches the conversion, and verify interaction or server events on the pages where they actually occur.",
      },
      {
        id: "measurement_consent",
        title: "Consent control signal",
        status: "warning",
        weight: 0,
        evidence:
          "No static oaiq consent call was visible; a consent manager may still control the Pixel dynamically.",
        recommendation:
          "Where consent is required, set Pixel consent before initialization and enable it only after the user grants measurement consent.",
      },
      {
        id: "measurement_csp",
        title: "Content Security Policy compatibility",
        status: "fail",
        weight: 0,
        evidence: "The returned CSP is missing 1 documented source entry.",
        recommendation:
          "Merge the documented OpenAI origins into the existing CSP and retain the site's nonce or hash mechanism for the inline bootstrap; do not add unsafe-inline solely for the Pixel.",
      },
    ],
  },
  limitations: [
    "This is an illustrative MaintainFlow fixture. No website was requested and no provider evidence was created.",
    "A real scan evaluates one public URL plus its origin-level robots.txt and sitemap; it is not a full-site crawl.",
    "Structured-data presence does not prove policy compliance or ad approval, which remain OpenAI decisions.",
    "Static measurement checks do not execute JavaScript, fire an event, or prove conversion attribution.",
  ],
} as const satisfies Omit<ReadinessAudit, "scannedAt">;

export function createSampleStorefrontAudit(
  now: Date = new Date(),
): ReadinessAudit {
  return {
    ...sampleAudit,
    checks: sampleAudit.checks.map((check) => ({ ...check })),
    measurement: {
      ...sampleAudit.measurement,
      eventNames: [...sampleAudit.measurement.eventNames],
      csp: {
        ...sampleAudit.measurement.csp,
        missingSources: [...sampleAudit.measurement.csp.missingSources],
      },
      checks: sampleAudit.measurement.checks.map((check) => ({ ...check })),
    },
    limitations: [...sampleAudit.limitations],
    scannedAt: now.toISOString(),
  };
}
