import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";

const MAX_HTML_CHARACTERS = 1_500_000;
const MAX_OPEN_TAGS = 100_000;
const MAX_RELEVANT_TAGS = 8_192;
const MAX_SCRIPT_ELEMENTS = 256;
const MAX_SCRIPT_CHARACTERS = 128_000;
const MAX_CAPTURED_SCRIPT_CHARACTERS = 512_000;
const MAX_ATTRIBUTE_CHARACTERS = 8_192;
const MAX_NAME_CHARACTERS = 64;

const CAPTURED_ATTRIBUTES = new Set([
  "content",
  "http-equiv",
  "name",
  "property",
  "rel",
  "src",
  "type",
]);

const RELEVANT_META_NAMES = new Set([
  "description",
  "oai-adsbot",
  "oai-searchbot",
  "og:description",
  "product:availability",
  "product:price:amount",
  "robots",
]);

export class ReadinessHtmlComplexityExceededError extends Error {
  constructor() {
    super("The landing-page HTML is too complex to evaluate safely.");
    this.name = "ReadinessHtmlComplexityExceededError";
  }
}

export type ReadinessScriptEvidence = {
  body?: string;
  src?: string;
  type?: string;
};

export type ReadinessHtmlEvidence = {
  cspMetaPolicies: string[];
  hasCanonical: boolean;
  hasTitle: boolean;
  measurementImageSources: string[];
  metaEntries: { content: string; name: string }[];
  scripts: ReadinessScriptEvidence[];
};

type ActiveScript = {
  body: string;
  capture: boolean;
  src?: string;
  type?: string;
};

function boundedAttribute(value: string | undefined): string | undefined {
  if (value === undefined || value.length > MAX_ATTRIBUTE_CHARACTERS) return;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Extract only the storefront evidence MaintainFlow needs with a forward-only
 * tokenizer. Captures are deliberately bounded even though the fetched body is
 * already capped, so later JSON and JavaScript evidence checks also have a
 * fixed work budget.
 */
export function scanReadinessHtml(html: string): ReadinessHtmlEvidence {
  if (html.length > MAX_HTML_CHARACTERS) {
    throw new ReadinessHtmlComplexityExceededError();
  }

  const metaEntries: { content: string; name: string }[] = [];
  const cspMetaPolicies: string[] = [];
  const measurementImageSources: string[] = [];
  const scripts: ReadinessScriptEvidence[] = [];
  let activeScript: ActiveScript | undefined;
  let activeTitle = false;
  let activeTitleHasText = false;
  let capturedScriptCharacters = 0;
  let hasCanonical = false;
  let hasTitle = false;
  let openTags = 0;
  let relevantTags = 0;
  let scriptElements = 0;

  const countRelevantTag = () => {
    relevantTags += 1;
    if (relevantTags > MAX_RELEVANT_TAGS) {
      throw new ReadinessHtmlComplexityExceededError();
    }
  };

  let currentAttributeCapture = false;
  let currentAttributeName = "";
  let currentAttributeValue = "";
  let currentAttributeValueOversized = false;
  let currentAttributes: Record<string, string> = {};
  let currentTagName = "";

  const handleOpenTag = (name: string, attributes: Record<string, string>) => {
    openTags += 1;
    if (openTags > MAX_OPEN_TAGS) {
      throw new ReadinessHtmlComplexityExceededError();
    }

    if (name === "title") {
      countRelevantTag();
      activeTitle = true;
      activeTitleHasText = false;
      return;
    }

    if (name === "meta") {
      countRelevantTag();
      const key = boundedAttribute(attributes.name ?? attributes.property)
        ?.toLowerCase();
      const content = boundedAttribute(attributes.content);
      if (key && content && RELEVANT_META_NAMES.has(key)) {
        metaEntries.push({ content, name: key });
      }

      const httpEquiv = boundedAttribute(attributes["http-equiv"])
        ?.toLowerCase();
      if (httpEquiv === "content-security-policy" && content) {
        cspMetaPolicies.push(content);
      }
      return;
    }

    if (name === "link") {
      countRelevantTag();
      const rel = boundedAttribute(attributes.rel)?.toLowerCase();
      if (rel?.split(/\s+/).includes("canonical")) hasCanonical = true;
      return;
    }

    if (name === "img") {
      countRelevantTag();
      const src = boundedAttribute(attributes.src);
      if (src?.startsWith("https://bzr.openai.com/v1/sdk/events")) {
        measurementImageSources.push(src);
      }
      return;
    }

    if (name !== "script") return;
    countRelevantTag();
    scriptElements += 1;
    if (scriptElements > MAX_SCRIPT_ELEMENTS) {
      throw new ReadinessHtmlComplexityExceededError();
    }
    activeScript = {
      body: "",
      capture: capturedScriptCharacters < MAX_CAPTURED_SCRIPT_CHARACTERS,
      src: boundedAttribute(attributes.src),
      type: boundedAttribute(attributes.type)?.toLowerCase(),
    };
  };

  const finishOpenTag = () => {
    handleOpenTag(currentTagName, currentAttributes);
    currentTagName = "";
    currentAttributes = {};
    currentAttributeCapture = false;
    currentAttributeName = "";
    currentAttributeValue = "";
    currentAttributeValueOversized = false;
  };

  const appendScriptRange = (start: number, end: number) => {
    if (!activeScript || !activeScript.capture || end <= start) return;
    const length = end - start;
    const nextScriptCharacters = activeScript.body.length + length;
    const nextTotalCharacters = capturedScriptCharacters + length;
    if (
      nextScriptCharacters > MAX_SCRIPT_CHARACTERS ||
      nextTotalCharacters > MAX_CAPTURED_SCRIPT_CHARACTERS
    ) {
      activeScript.body = "";
      activeScript.capture = false;
      return;
    }
    activeScript.body += html.slice(start, end);
    capturedScriptCharacters = nextTotalCharacters;
  };

  const closeTag = (name: string) => {
    if (name === "title") {
      if (activeTitleHasText) hasTitle = true;
      activeTitle = false;
      activeTitleHasText = false;
      return;
    }
    if (name !== "script" || !activeScript) return;
    scripts.push({
      body: activeScript.capture ? activeScript.body : undefined,
      src: activeScript.src,
      type: activeScript.type,
    });
    activeScript = undefined;
  };

  const callbacks: TokenizerCallbacks = {
    onattribdata(start, end) {
      if (!currentAttributeCapture || currentAttributeValueOversized) return;
      const length = end - start;
      if (currentAttributeValue.length + length > MAX_ATTRIBUTE_CHARACTERS) {
        currentAttributeValue = "";
        currentAttributeValueOversized = true;
        return;
      }
      currentAttributeValue += html.slice(start, end);
    },
    onattribentity(codepoint) {
      if (!currentAttributeCapture || currentAttributeValueOversized) return;
      const value = String.fromCodePoint(codepoint);
      if (currentAttributeValue.length + value.length > MAX_ATTRIBUTE_CHARACTERS) {
        currentAttributeValue = "";
        currentAttributeValueOversized = true;
        return;
      }
      currentAttributeValue += value;
    },
    onattribend() {
      if (
        currentAttributeCapture &&
        !currentAttributeValueOversized &&
        !Object.hasOwn(currentAttributes, currentAttributeName)
      ) {
        currentAttributes[currentAttributeName] = currentAttributeValue;
      }
      currentAttributeCapture = false;
      currentAttributeName = "";
      currentAttributeValue = "";
      currentAttributeValueOversized = false;
    },
    onattribname(start, end) {
      currentAttributeValue = "";
      currentAttributeValueOversized = false;
      if (end - start > MAX_NAME_CHARACTERS) {
        currentAttributeCapture = false;
        currentAttributeName = "";
        return;
      }
      currentAttributeName = html.slice(start, end).toLowerCase();
      currentAttributeCapture = CAPTURED_ATTRIBUTES.has(currentAttributeName);
    },
    oncdata() {},
    onclosetag(start, end) {
      if (end - start > MAX_NAME_CHARACTERS) return;
      closeTag(html.slice(start, end).toLowerCase());
    },
    oncomment() {},
    ondeclaration() {},
    onend() {},
    onopentagend() {
      finishOpenTag();
    },
    onopentagname(start, end) {
      currentAttributes = {};
      currentTagName = end - start <= MAX_NAME_CHARACTERS
        ? html.slice(start, end).toLowerCase()
        : "";
    },
    onprocessinginstruction() {},
    onselfclosingtag() {
      finishOpenTag();
    },
    ontext(start, end) {
      if (activeTitle && !activeTitleHasText) {
        for (let index = start; index < end; index += 1) {
          if (!/\s/.test(html[index])) {
            activeTitleHasText = true;
            break;
          }
        }
      }
      appendScriptRange(start, end);
    },
    ontextentity(codepoint) {
      if (activeTitle && !/\s/.test(String.fromCodePoint(codepoint))) {
        activeTitleHasText = true;
      }
      if (!activeScript?.capture) return;
      const value = String.fromCodePoint(codepoint);
      const nextScriptCharacters = activeScript.body.length + value.length;
      const nextTotalCharacters = capturedScriptCharacters + value.length;
      if (
        nextScriptCharacters > MAX_SCRIPT_CHARACTERS ||
        nextTotalCharacters > MAX_CAPTURED_SCRIPT_CHARACTERS
      ) {
        activeScript.body = "";
        activeScript.capture = false;
        return;
      }
      activeScript.body += value;
      capturedScriptCharacters = nextTotalCharacters;
    },
  };

  const tokenizer = new Tokenizer(
    { decodeEntities: true, recognizeSelfClosing: false, xmlMode: false },
    callbacks,
  );
  tokenizer.write(html);
  tokenizer.end();

  return {
    cspMetaPolicies,
    hasCanonical,
    hasTitle,
    measurementImageSources,
    metaEntries,
    scripts,
  };
}

export function firstMetaContent(
  evidence: ReadinessHtmlEvidence,
  names: readonly string[],
): string | undefined {
  const targets = new Set(names.map((name) => name.toLowerCase()));
  for (const entry of evidence.metaEntries) {
    if (targets.has(entry.name)) return entry.content;
  }
}
