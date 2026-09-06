import type {
  MeasurementInstallation,
  ReadinessCheck,
  ReadinessCheckStatus,
} from "./schema";
import {
  scanReadinessHtml,
  type ReadinessHtmlEvidence,
} from "./html-evidence";

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
const MAX_OAIQ_CALLS = 256;
const MAX_OAIQ_CALL_CHARACTERS = 16_384;

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

function contentSecurityPolicies(
  evidence: ReadinessHtmlEvidence,
  headers: Headers,
): string[] {
  const policies: string[] = [];
  const header = headers.get("content-security-policy")?.trim();
  if (header) policies.push(...header.split(/\s*,\s*(?=[a-z-]+\s)/i));
  policies.push(...evidence.cspMetaPolicies);
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

type PixelCallEvidence = {
  consentSignalDetected: boolean;
  eventNames: Set<string>;
  initializationDetected: boolean;
  pixelIdDetected: boolean;
};

type ParsedCall =
  | { arguments: string[]; complete: true; end: number }
  | { complete: false; end: number };

function isIdentifierStart(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z_$]/.test(character));
}

function isIdentifierPart(character: string | undefined): boolean {
  return Boolean(character && /[A-Za-z0-9_$]/.test(character));
}

function skipQuotedSource(source: string, start: number, limit = source.length) {
  const quote = source[start];
  let escaped = false;
  for (let index = start + 1; index < limit; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index + 1;
    }
  }
  return limit;
}

function skipComment(source: string, start: number, limit = source.length) {
  if (source[start + 1] === "/") {
    const newline = source.indexOf("\n", start + 2);
    return newline === -1 || newline >= limit ? limit : newline + 1;
  }
  if (source[start + 1] === "*") {
    const close = source.indexOf("*/", start + 2);
    return close === -1 || close + 2 > limit ? limit : close + 2;
  }
  return start;
}

function skipTrivia(source: string, start: number, limit = source.length) {
  let index = start;
  while (index < limit) {
    if (/\s/.test(source[index])) {
      index += 1;
      continue;
    }
    if (source[index] === "/" && ["/", "*"].includes(source[index + 1])) {
      const next = skipComment(source, index, limit);
      if (next === index) break;
      index = next;
      continue;
    }
    break;
  }
  return index;
}

function parseCall(source: string, openParenthesis: number): ParsedCall {
  const limit = Math.min(
    source.length,
    openParenthesis + MAX_OAIQ_CALL_CHARACTERS,
  );
  const argumentsFound: string[] = [];
  let argumentStart = openParenthesis + 1;
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenthesisDepth = 1;
  let index = argumentStart;

  while (index < limit) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuotedSource(source, index, limit);
      continue;
    }
    if (character === "/" && ["/", "*"].includes(source[index + 1])) {
      const next = skipComment(source, index, limit);
      index = next === index ? index + 1 : next;
      continue;
    }
    if (character === "(") parenthesisDepth += 1;
    else if (character === ")") {
      parenthesisDepth -= 1;
      if (parenthesisDepth === 0) {
        if (braceDepth !== 0 || bracketDepth !== 0) {
          return { complete: false, end: index + 1 };
        }
        argumentsFound.push(source.slice(argumentStart, index).trim());
        return { arguments: argumentsFound, complete: true, end: index + 1 };
      }
    } else if (character === "{") braceDepth += 1;
    else if (character === "}") {
      braceDepth -= 1;
      if (braceDepth < 0) return { complete: false, end: index + 1 };
    } else if (character === "[") bracketDepth += 1;
    else if (character === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) return { complete: false, end: index + 1 };
    } else if (
      character === "," &&
      parenthesisDepth === 1 &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      argumentsFound.push(source.slice(argumentStart, index).trim());
      argumentStart = index + 1;
    }
    index += 1;
  }

  return { complete: false, end: Math.max(openParenthesis + 1, limit) };
}

function staticString(argument: string | undefined): string | undefined {
  if (!argument) return;
  const source = argument.trim();
  const quote = source[0];
  if ((quote !== '"' && quote !== "'") || source.length < 2) return;
  let value = "";
  let escaped = false;
  for (let index = 1; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === quote) {
      return index === source.length - 1 ? value : undefined;
    } else {
      value += character;
    }
  }
}

function staticProperty(source: string, property: string): string | undefined {
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuotedSource(source, index);
      continue;
    }
    if (character === "/" && ["/", "*"].includes(source[index + 1])) {
      const next = skipComment(source, index);
      index = next === index ? index + 1 : next;
      continue;
    }
    if (!isIdentifierStart(character)) {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (isIdentifierPart(source[index])) index += 1;
    if (source.slice(start, index).toLowerCase() !== property.toLowerCase()) continue;
    const colon = skipTrivia(source, index);
    if (source[colon] !== ":") continue;
    const valueStart = skipTrivia(source, colon + 1);
    if (source[valueStart] !== '"' && source[valueStart] !== "'") continue;
    const valueEnd = skipQuotedSource(source, valueStart);
    if (valueEnd <= valueStart || valueEnd > source.length) continue;
    return staticString(source.slice(valueStart, valueEnd));
  }
}

function scanPixelCalls(source: string): PixelCallEvidence {
  const evidence: PixelCallEvidence = {
    consentSignalDetected: false,
    eventNames: new Set(),
    initializationDetected: false,
    pixelIdDetected: false,
  };
  let calls = 0;
  let index = 0;

  while (index < source.length && calls < MAX_OAIQ_CALLS) {
    const character = source[index];
    if (character === '"' || character === "'" || character === "`") {
      index = skipQuotedSource(source, index);
      continue;
    }
    if (character === "/" && ["/", "*"].includes(source[index + 1])) {
      const next = skipComment(source, index);
      index = next === index ? index + 1 : next;
      continue;
    }
    if (!isIdentifierStart(character)) {
      index += 1;
      continue;
    }

    const identifierStart = index;
    index += 1;
    while (isIdentifierPart(source[index])) index += 1;
    if (source.slice(identifierStart, index).toLowerCase() !== "oaiq") continue;
    const openParenthesis = skipTrivia(source, index);
    if (source[openParenthesis] !== "(") continue;

    calls += 1;
    const call = parseCall(source, openParenthesis);
    index = Math.max(index, call.end);
    if (!call.complete) continue;
    const action = staticString(call.arguments[0])?.toLowerCase();
    if (action === "consent" && call.arguments.length > 1) {
      evidence.consentSignalDetected = true;
    } else if (action === "init") {
      const configuration = call.arguments[1]?.trim();
      if (!configuration?.startsWith("{") || !configuration.endsWith("}")) continue;
      evidence.initializationDetected = true;
      const pixelId = staticProperty(configuration, "pixelId")?.trim();
      if (
        pixelId &&
        !/[<>]/.test(pixelId) &&
        !/(?:your|replace|example|pixel)[-_\s]*(?:pixel[-_\s]*)?id/i.test(
          pixelId,
        )
      ) {
        evidence.pixelIdDetected = true;
      }
    } else if (action === "measure") {
      const eventName = staticString(call.arguments[1])?.toLowerCase();
      if (eventName && SUPPORTED_WEB_EVENTS.has(eventName)) {
        evidence.eventNames.add(eventName);
      }
    } else if (action === "measuresingle") {
      const eventName = staticString(call.arguments[2])?.toLowerCase();
      if (eventName && SUPPORTED_WEB_EVENTS.has(eventName)) {
        evidence.eventNames.add(eventName);
      }
    }
  }

  return evidence;
}

function imageEventNames(sources: readonly string[]) {
  const names = new Set<string>();
  for (const source of sources) {
    try {
      const eventName = new URL(source).searchParams.get("event")?.toLowerCase();
      if (eventName && SUPPORTED_WEB_EVENTS.has(eventName)) names.add(eventName);
    } catch {
      // A malformed image URL is not measurement evidence.
    }
  }
  return names;
}

export function analyzeMeasurementInstallation(
  html: string,
  headers = new Headers(),
  htmlEvidence = scanReadinessHtml(html),
): MeasurementInstallation {
  const sdkOccurrences = htmlEvidence.scripts.filter(
    (script) =>
      script.src === PIXEL_SDK_URL || script.body?.includes(PIXEL_SDK_URL),
  ).length;
  const sdkDetected = sdkOccurrences > 0;
  const imageSources = htmlEvidence.measurementImageSources;
  const imageTagDetected = imageSources.length > 0;
  let consentSignalDetected = false;
  let initializationDetected = false;
  let pixelIdDetected = false;
  const eventNameSet = imageEventNames(imageSources);
  for (const script of htmlEvidence.scripts) {
    if (script.body === undefined) continue;
    const calls = scanPixelCalls(script.body);
    consentSignalDetected ||= calls.consentSignalDetected;
    initializationDetected ||= calls.initializationDetected;
    pixelIdDetected ||= calls.pixelIdDetected;
    calls.eventNames.forEach((eventName) => eventNameSet.add(eventName));
  }
  const eventNames = [...eventNameSet].sort();
  const policies = contentSecurityPolicies(htmlEvidence, headers);
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
