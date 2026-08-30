import type {
  MeasurementInstallation,
  ReadinessCheck,
  ReadinessCheckStatus,
} from "./schema";

const PIXEL_SDK_URL = "https://bzrcdn.openai.com/sdk/oaiq.min.js";
const PIXEL_EVENT_URL = "https://bzr.openai.com/v1/sdk/events";
const SUPPORTED_WEB_EVENTS = new Set([
  "appointment_scheduled",
  "checkout_started",
  "contents_viewed",
  "custom",
  "items_added",
  "lead_created",
  "order_created",
  "page_viewed",
  "registration_completed",
  "subscription_created",
  "trial_started",
]);

type CspRequirement = {
  directive: "script-src" | "connect-src" | "img-src";
  origin: string;
  label: string;
};

const CSP_REQUIREMENTS: CspRequirement[] = [
  {
    directive: "script-src",
    origin: "https://bzrcdn.openai.com",
    label: "script-src https://bzrcdn.openai.com",
  },
  {
    directive: "connect-src",
    origin: "https://bzr.openai.com",
    label: "connect-src https://bzr.openai.com",
  },
  {
    directive: "connect-src",
    origin: "https://bzrcdn.openai.com",
    label: "connect-src https://bzrcdn.openai.com",
  },
  {
    directive: "img-src",
    origin: "https://bzr.openai.com",
    label: "img-src https://bzr.openai.com",
  },
];

function check(
  id: string,
  title: string,
  status: ReadinessCheckStatus,
  evidence: string,
  recommendation: string,
): ReadinessCheck {
  return { id, title, status, weight: 0, evidence, recommendation };
}

function htmlAttribute(content: string, name: string): string | undefined {
  const expression = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return content.match(expression)?.[1]?.trim();
}

function contentSecurityPolicies(html: string, headers: Headers): string[] {
  const policies: string[] = [];
  const header = headers.get("content-security-policy")?.trim();
  if (header) policies.push(...header.split(/\s*,\s*(?=[a-z-]+\s)/i));

  const metaTags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of metaTags) {
    const httpEquiv = htmlAttribute(tag, "http-equiv")?.toLowerCase();
    if (httpEquiv !== "content-security-policy") continue;
    const content = htmlAttribute(tag, "content")?.trim();
    if (content) policies.push(content);
  }

  return policies;
}

function parseCsp(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [rawName, ...sources] = part.trim().split(/\s+/);
    if (!rawName) continue;
    directives.set(
      rawName.toLowerCase(),
      sources.map((source) => source.replace(/,$/, "")),
    );
  }
  return directives;
}

function directiveSources(
  directives: Map<string, string[]>,
  directive: CspRequirement["directive"],
): string[] | undefined {
  if (directive === "script-src") {
    return (
      directives.get("script-src-elem") ??
      directives.get("script-src") ??
      directives.get("default-src")
    );
  }
  return directives.get(directive) ?? directives.get("default-src");
}

function sourceAllowsOrigin(source: string, origin: string): boolean {
  const normalized = source.toLowerCase().replace(/\/$/, "");
  const target = new URL(origin);
  if (normalized === "*" || normalized === `${target.protocol}`) return true;
  if (normalized === origin.toLowerCase()) return true;

  const wildcard = normalized.match(/^(https?:\/\/)?\*\.([^/:]+)(?::\d+)?$/);
  if (!wildcard) return false;
  if (wildcard[1] && wildcard[1] !== `${target.protocol}//`) return false;
  return target.hostname.endsWith(`.${wildcard[2]}`);
}

function policyAllows(
  policy: string,
  requirement: CspRequirement,
): boolean {
  const sources = directiveSources(parseCsp(policy), requirement.directive);
  if (!sources) return true;
  return sources.some((source) => sourceAllowsOrigin(source, requirement.origin));
}

function staticPixelInitializations(html: string) {
  const calls = [
    ...html.matchAll(
      /oaiq\s*\(\s*["']init["']\s*,\s*\{([\s\S]*?)\}\s*\)/gi,
    ),
  ];
  const pixelValues = calls
    .map((match) =>
      match[1].match(/\bpixelId\s*:\s*["']([^"']+)["']/i)?.[1]?.trim(),
    )
    .filter((value): value is string => Boolean(value));
  const pixelIdDetected = pixelValues.some(
    (value) =>
      !/[<>]/.test(value) &&
      !/(?:your|replace|example|pixel)[-_\s]*(?:pixel[-_\s]*)?id/i.test(value),
  );

  return {
    initializationDetected: calls.length > 0,
    pixelIdDetected,
  };
}

function staticEventNames(scriptSource: string, imageSources: string[]): string[] {
  const names = new Set<string>();
  for (const match of scriptSource.matchAll(
    /oaiq\s*\(\s*["']measure["']\s*,\s*["']([^"']+)["']/gi,
  )) {
    const eventName = match[1].toLowerCase();
    if (SUPPORTED_WEB_EVENTS.has(eventName)) names.add(eventName);
  }
  for (const match of scriptSource.matchAll(
    /oaiq\s*\(\s*["']measureSingle["']\s*,\s*[^,]+,\s*["']([^"']+)["']/gi,
  )) {
    const eventName = match[1].toLowerCase();
    if (SUPPORTED_WEB_EVENTS.has(eventName)) names.add(eventName);
  }
  for (const source of imageSources) {
    const normalizedSource = source.replaceAll("&amp;", "&");
    for (const match of normalizedSource.matchAll(/[?&]event=([a-z_]+)/gi)) {
      const eventName = match[1].toLowerCase();
      if (SUPPORTED_WEB_EVENTS.has(eventName)) names.add(eventName);
    }
  }
  return [...names].sort();
}

export function analyzeMeasurementInstallation(
  html: string,
  headers = new Headers(),
): MeasurementInstallation {
  const scripts = [
    ...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi),
  ].map((match) => ({ attributes: match[1], body: match[2] }));
  const scriptSource = scripts.map((script) => script.body).join("\n");
  const sdkOccurrences = scripts.filter((script) => {
    const src = htmlAttribute(script.attributes, "src");
    return src === PIXEL_SDK_URL || script.body.includes(PIXEL_SDK_URL);
  }).length;
  const sdkDetected = sdkOccurrences > 0;
  const imageSources = (html.match(/<img\b[^>]*>/gi) ?? [])
    .map((tag) => htmlAttribute(tag, "src"))
    .filter((source): source is string =>
      typeof source === "string" && source.startsWith(PIXEL_EVENT_URL),
    );
  const imageTagDetected = imageSources.length > 0;
  const consentSignalDetected =
    /oaiq\s*\(\s*["']consent["']\s*,/i.test(scriptSource);
  const { initializationDetected, pixelIdDetected } =
    staticPixelInitializations(scriptSource);
  const eventNames = staticEventNames(scriptSource, imageSources);
  const policies = contentSecurityPolicies(html, headers);
  const missingSources = CSP_REQUIREMENTS.filter((requirement) =>
    policies.some((policy) => !policyAllows(policy, requirement)),
  ).map((requirement) => requirement.label);
  const cspPresent = policies.length > 0;
  const cspCompatible = missingSources.length === 0;
  const primaryPathDetected =
    (sdkDetected && initializationDetected && pixelIdDetected) ||
    imageTagDetected;
  const status: MeasurementInstallation["status"] = !sdkDetected && !imageTagDetected
    ? "not_detected"
    : primaryPathDetected && cspCompatible
      ? "detected"
      : "needs_attention";

  const pixelStatus: ReadinessCheckStatus = primaryPathDetected
    ? "pass"
    : sdkDetected || initializationDetected || imageTagDetected
      ? "warning"
      : "warning";
  const pixelEvidence = imageTagDetected && !sdkDetected
    ? "A documented OpenAI image event tag was found in the returned HTML."
    : sdkDetected && initializationDetected && pixelIdDetected
      ? "The exact OpenAI SDK URL and a non-placeholder Pixel ID initialization were found."
      : sdkDetected && initializationDetected
        ? "The OpenAI SDK and an init call were found, but a static non-placeholder Pixel ID was not visible."
        : sdkDetected
          ? "The OpenAI SDK URL was found, but a static init call was not visible."
          : "No OpenAI Measurement Pixel SDK or image event tag was visible in the returned HTML.";

  const eventEvidence = eventNames.length > 0
    ? `Static calls were found for: ${eventNames.join(", ")}.`
    : "No supported event name was visible in an inline Pixel call or image tag on this page.";
  const cspEvidence = !cspPresent
    ? "No Content-Security-Policy was returned, so this scan found no CSP source restriction on the Pixel."
    : cspCompatible
      ? "The returned CSP permits the documented OpenAI script, connection, and image origins."
      : `The returned CSP is missing ${missingSources.length} documented source ${missingSources.length === 1 ? "entry" : "entries"}.`;

  return {
    status,
    sdkDetected,
    initializationDetected,
    pixelIdDetected,
    imageTagDetected,
    consentSignalDetected,
    eventNames,
    csp: {
      present: cspPresent,
      compatible: cspCompatible,
      missingSources,
    },
    checks: [
      check(
        "measurement_pixel",
        "Measurement tag installation",
        pixelStatus,
        pixelEvidence,
        "Install the documented SDK once, initialize a Pixel ID from Ads Manager, or use the documented image tag for page-load events.",
      ),
      check(
        "measurement_events",
        "Supported event calls",
        eventNames.length > 0 ? "pass" : "warning",
        eventEvidence,
        "Use OpenAI's standard event taxonomy where it matches the conversion, and verify interaction or server events on the pages where they actually occur.",
      ),
      check(
        "measurement_consent",
        "Consent control signal",
        consentSignalDetected ? "pass" : "warning",
        consentSignalDetected
          ? "A static oaiq consent call was found before or alongside Pixel setup."
          : "No static oaiq consent call was visible; a consent manager may still control the Pixel dynamically.",
        "Where consent is required, set Pixel consent before initialization and enable it only after the user grants measurement consent.",
      ),
      check(
        "measurement_csp",
        "Content Security Policy compatibility",
        cspCompatible ? "pass" : primaryPathDetected ? "fail" : "warning",
        cspEvidence,
        "Merge the documented OpenAI origins into the existing CSP and retain the site's nonce or hash mechanism for the inline bootstrap; do not add unsafe-inline solely for the Pixel.",
      ),
    ],
  };
}

export const measurementDocumentation = {
  pixelSdkUrl: PIXEL_SDK_URL,
  eventUrl: PIXEL_EVENT_URL,
} as const;
