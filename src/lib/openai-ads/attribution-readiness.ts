import type { Campaign } from "./schema";

export const OPENAI_ADS_ATTRIBUTION_MACROS = [
  "{campaign_id}",
  "{ad_group_id}",
  "{ad_id}",
  "{ad_account_id}",
] as const;

export const SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE =
  "utm_source=chatgpt&utm_medium=paid&utm_campaign={campaign_id}&utm_content={ad_id}";

export const ATTRIBUTION_NAMING_CONVENTION_NOTE =
  "OpenAI supports the listed dynamic macros, but does not mandate these UTM parameter names or values.";

export type AttributionReadinessStatus =
  | "ready"
  | "needs_attention"
  | "not_applicable";

export type AttributionIssueCode =
  | "reserved_oppref"
  | "malformed_query"
  | "unsupported_macro"
  | "missing_configuration"
  | "missing_utm_source"
  | "missing_utm_medium"
  | "missing_dynamic_campaign_id"
  | "missing_dynamic_ad_or_ad_group_id";

export type AttributionIssue = {
  code: AttributionIssueCode;
  /** Lower numbers are more urgent. */
  priority: number;
  title: string;
  detail: string;
};

export type CampaignAttributionCheck = {
  campaignId: string;
  campaignName: string;
  campaignStatus: Campaign["status"];
  status: AttributionReadinessStatus;
  queryStringTemplate: string | null;
  recommendedTemplate: string | null;
  issues: AttributionIssue[];
};

export type AttributionActionableCheck = AttributionIssue & {
  campaignId: string;
  campaignName: string;
  recommendedTemplate: string;
};

export type CampaignAttributionReadiness = {
  status: AttributionReadinessStatus;
  counts: {
    totalCampaigns: number;
    activeCampaigns: number;
    readyCampaigns: number;
    needsAttentionCampaigns: number;
    notApplicableCampaigns: number;
    actionableChecks: number;
  };
  supportedMacros: readonly (typeof OPENAI_ADS_ATTRIBUTION_MACROS)[number][];
  safeRecommendedTemplate: string;
  namingConventionNote: string;
  checks: CampaignAttributionCheck[];
  actionableChecks: AttributionActionableCheck[];
  message: string;
};

type ParsedParameter = {
  rawSegment: string;
  rawValue: string;
  decodedKey: string;
  decodedValue: string;
  normalizedKey: string;
  supportedValueMacros: Set<string>;
  safeToPreserve: boolean;
};

type ParsedTemplate = {
  parameters: ParsedParameter[];
  syntaxErrors: string[];
  unsupportedMacros: string[];
};

const supportedMacroSet = new Set<string>(OPENAI_ADS_ATTRIBUTION_MACROS);
const managedRecommendationKeys = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
]);

const issuePriority: Record<AttributionIssueCode, number> = {
  reserved_oppref: 1,
  malformed_query: 2,
  unsupported_macro: 2,
  missing_configuration: 3,
  missing_utm_source: 4,
  missing_utm_medium: 5,
  missing_dynamic_campaign_id: 6,
  missing_dynamic_ad_or_ad_group_id: 7,
};

function inspectBraces(value: string) {
  const supported = new Set<string>();
  const unsupported: string[] = [];
  let malformed = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "}") {
      malformed = true;
      continue;
    }
    if (character !== "{") continue;

    const closingIndex = value.indexOf("}", index + 1);
    if (closingIndex === -1) {
      malformed = true;
      break;
    }

    const token = value.slice(index, closingIndex + 1);
    if (token.slice(1, -1).includes("{")) malformed = true;
    if (supportedMacroSet.has(token)) supported.add(token);
    else unsupported.push(token);
    index = closingIndex;
  }

  return { supported, unsupported, malformed };
}

function decodeQueryComponent(value: string) {
  return decodeURIComponent(value.replaceAll("+", " "));
}

function parseTemplate(template: string): ParsedTemplate {
  const body = template.startsWith("?") ? template.slice(1) : template;
  const parameters: ParsedParameter[] = [];
  const syntaxErrors: string[] = [];
  const unsupportedMacros = new Set<string>();

  for (const [index, rawSegmentValue] of body.split("&").entries()) {
    const rawSegment = rawSegmentValue.trim();
    const equalsIndex = rawSegment.indexOf("=");
    const segmentErrors: string[] = [];

    if (rawSegment.length === 0) {
      syntaxErrors.push(`Parameter ${index + 1} is empty.`);
      continue;
    }
    if (equalsIndex <= 0) {
      syntaxErrors.push(
        `Parameter ${index + 1} must use a non-empty key=value pair.`,
      );
      continue;
    }
    if (/\s/.test(rawSegment)) {
      segmentErrors.push(`Parameter ${index + 1} contains unencoded whitespace.`);
    }
    if (rawSegment.includes("#")) {
      segmentErrors.push(`Parameter ${index + 1} contains a URL fragment.`);
    }

    const rawKey = rawSegment.slice(0, equalsIndex);
    const rawValue = rawSegment.slice(equalsIndex + 1);
    let decodedKey = "";
    let decodedValue = "";
    try {
      decodedKey = decodeQueryComponent(rawKey);
      decodedValue = decodeQueryComponent(rawValue);
    } catch {
      segmentErrors.push(`Parameter ${index + 1} has invalid percent encoding.`);
    }
    if (decodedKey.trim().length === 0) {
      segmentErrors.push(`Parameter ${index + 1} has an empty key.`);
    }

    const keyBraces = inspectBraces(rawKey);
    const valueBraces = inspectBraces(rawValue);
    for (const macro of [...keyBraces.unsupported, ...valueBraces.unsupported]) {
      unsupportedMacros.add(macro);
    }
    if (keyBraces.malformed || valueBraces.malformed) {
      segmentErrors.push(`Parameter ${index + 1} has unmatched or nested braces.`);
    }
    if (keyBraces.supported.size > 0) {
      segmentErrors.push(
        `Parameter ${index + 1} uses a dynamic macro as a parameter name.`,
      );
    }

    syntaxErrors.push(...segmentErrors);
    parameters.push({
      rawSegment,
      rawValue,
      decodedKey,
      decodedValue,
      normalizedKey: decodedKey.trim().toLowerCase(),
      supportedValueMacros: valueBraces.supported,
      safeToPreserve:
        segmentErrors.length === 0 &&
        keyBraces.unsupported.length === 0 &&
        valueBraces.unsupported.length === 0,
    });
  }

  return {
    parameters,
    syntaxErrors: [...new Set(syntaxErrors)],
    unsupportedMacros: [...unsupportedMacros],
  };
}

function usableParameters(parsed: ParsedTemplate) {
  return parsed.parameters.filter(
    (parameter) =>
      parameter.safeToPreserve && parameter.normalizedKey !== "oppref",
  );
}

function hasNonBlankParameter(
  parameters: ParsedParameter[],
  normalizedKey: string,
) {
  return parameters.some(
    (parameter) =>
      parameter.normalizedKey === normalizedKey &&
      parameter.decodedValue.trim().length > 0,
  );
}

function hasMacro(parameters: ParsedParameter[], macro: string) {
  return parameters.some((parameter) =>
    parameter.supportedValueMacros.has(macro),
  );
}

function recommendedValue(
  parameters: ParsedParameter[],
  normalizedKey: string,
  fallback: string,
  requiredMacros?: ReadonlySet<string>,
) {
  const existing = parameters.find(
    (parameter) =>
      parameter.normalizedKey === normalizedKey &&
      parameter.decodedValue.trim().length > 0 &&
      (requiredMacros === undefined ||
        [...requiredMacros].some((macro) =>
          parameter.supportedValueMacros.has(macro),
        )),
  );
  return existing?.rawValue ?? fallback;
}

function buildRecommendedTemplate(parsed: ParsedTemplate) {
  const usable = usableParameters(parsed);
  const standardParameters = [
    `utm_source=${recommendedValue(usable, "utm_source", "chatgpt")}`,
    `utm_medium=${recommendedValue(usable, "utm_medium", "paid")}`,
    `utm_campaign=${recommendedValue(
      usable,
      "utm_campaign",
      "{campaign_id}",
      new Set(["{campaign_id}"]),
    )}`,
    `utm_content=${recommendedValue(
      usable,
      "utm_content",
      "{ad_id}",
      new Set(["{ad_id}", "{ad_group_id}"]),
    )}`,
  ];
  const providerParameters = usable
    .filter(
      (parameter) => !managedRecommendationKeys.has(parameter.normalizedKey),
    )
    .map((parameter) => parameter.rawSegment);

  return [...standardParameters, ...providerParameters].join("&");
}

function issue(
  code: AttributionIssueCode,
  details?: { unsupportedMacros?: string[]; syntaxErrors?: string[] },
): AttributionIssue {
  if (code === "reserved_oppref") {
    return {
      code,
      priority: issuePriority[code],
      title: "Remove the reserved oppref parameter",
      detail:
        "oppref is reserved for OpenAI attribution and must not be supplied manually by the advertiser.",
    };
  }
  if (code === "malformed_query") {
    return {
      code,
      priority: issuePriority[code],
      title: "Repair the query-string syntax",
      detail: details?.syntaxErrors?.join(" ") ?? "Use valid key=value pairs.",
    };
  }
  if (code === "unsupported_macro") {
    return {
      code,
      priority: issuePriority[code],
      title: "Replace unsupported brace macros",
      detail: `Unsupported: ${details?.unsupportedMacros?.join(", ")}. Supported macros are ${OPENAI_ADS_ATTRIBUTION_MACROS.join(", ")}.`,
    };
  }
  if (code === "missing_configuration") {
    return {
      code,
      priority: issuePriority[code],
      title: "Add a landing-page query template",
      detail:
        "This active campaign has no usable landing_page_configuration.query_string_template.",
    };
  }
  if (code === "missing_utm_source") {
    return {
      code,
      priority: issuePriority[code],
      title: "Add a source label",
      detail:
        "Add a non-empty source parameter such as utm_source=chatgpt. This is a recommended convention, not an OpenAI-mandated value.",
    };
  }
  if (code === "missing_utm_medium") {
    return {
      code,
      priority: issuePriority[code],
      title: "Add a medium label",
      detail:
        "Add a non-empty medium parameter such as utm_medium=paid. This is a recommended convention, not an OpenAI-mandated value.",
    };
  }
  if (code === "missing_dynamic_campaign_id") {
    return {
      code,
      priority: issuePriority[code],
      title: "Add a dynamic campaign identifier",
      detail:
        "Include {campaign_id} in a parameter value so campaign-level attribution does not depend on a manual label.",
    };
  }
  return {
    code,
    priority: issuePriority[code],
    title: "Add a dynamic ad or ad-group identifier",
    detail:
      "Include {ad_id} or {ad_group_id} in a parameter value so results can be traced below campaign level.",
  };
}

function checkActiveCampaign(campaign: Campaign): CampaignAttributionCheck {
  const templateValue =
    campaign.landing_page_configuration?.query_string_template;
  const template = templateValue?.trim() ?? "";

  if (template.length === 0) {
    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      campaignStatus: campaign.status,
      status: "needs_attention",
      queryStringTemplate: templateValue ?? null,
      recommendedTemplate: SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE,
      issues: [issue("missing_configuration")],
    };
  }

  const parsed = parseTemplate(template);
  const usable = usableParameters(parsed);
  const issues: AttributionIssue[] = [];

  if (
    parsed.parameters.some(
      (parameter) => parameter.normalizedKey === "oppref",
    )
  ) {
    issues.push(issue("reserved_oppref"));
  }
  if (parsed.syntaxErrors.length > 0) {
    issues.push(
      issue("malformed_query", { syntaxErrors: parsed.syntaxErrors }),
    );
  }
  if (parsed.unsupportedMacros.length > 0) {
    issues.push(
      issue("unsupported_macro", {
        unsupportedMacros: parsed.unsupportedMacros,
      }),
    );
  }
  if (!hasNonBlankParameter(usable, "utm_source")) {
    issues.push(issue("missing_utm_source"));
  }
  if (!hasNonBlankParameter(usable, "utm_medium")) {
    issues.push(issue("missing_utm_medium"));
  }
  if (!hasMacro(usable, "{campaign_id}")) {
    issues.push(issue("missing_dynamic_campaign_id"));
  }
  if (
    !hasMacro(usable, "{ad_id}") &&
    !hasMacro(usable, "{ad_group_id}")
  ) {
    issues.push(issue("missing_dynamic_ad_or_ad_group_id"));
  }

  return {
    campaignId: campaign.id,
    campaignName: campaign.name,
    campaignStatus: campaign.status,
    status: issues.length === 0 ? "ready" : "needs_attention",
    queryStringTemplate: templateValue ?? null,
    recommendedTemplate: buildRecommendedTemplate(parsed),
    issues: issues.sort((left, right) => left.priority - right.priority),
  };
}

/**
 * Produces a credential-independent review of campaign landing-page tracking.
 * It recommends a conservative UTM baseline without treating that convention
 * as an OpenAI requirement.
 */
export function buildCampaignAttributionReadiness(options: {
  campaigns: Campaign[];
}): CampaignAttributionReadiness {
  const checks = options.campaigns.map((campaign) =>
    campaign.status === "active"
      ? checkActiveCampaign(campaign)
      : {
          campaignId: campaign.id,
          campaignName: campaign.name,
          campaignStatus: campaign.status,
          status: "not_applicable" as const,
          queryStringTemplate:
            campaign.landing_page_configuration?.query_string_template ?? null,
          recommendedTemplate: null,
          issues: [],
        },
  );
  const campaignOrder = new Map(
    options.campaigns.map((campaign, index) => [campaign.id, index]),
  );
  const actionableChecks = checks
    .flatMap((check) =>
      check.issues.map((campaignIssue) => ({
        ...campaignIssue,
        campaignId: check.campaignId,
        campaignName: check.campaignName,
        recommendedTemplate:
          check.recommendedTemplate ?? SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE,
      })),
    )
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        (campaignOrder.get(left.campaignId) ?? 0) -
          (campaignOrder.get(right.campaignId) ?? 0),
    );
  const activeCampaigns = checks.filter(
    (check) => check.campaignStatus === "active",
  ).length;
  const readyCampaigns = checks.filter(
    (check) => check.status === "ready",
  ).length;
  const needsAttentionCampaigns = checks.filter(
    (check) => check.status === "needs_attention",
  ).length;
  const notApplicableCampaigns = checks.filter(
    (check) => check.status === "not_applicable",
  ).length;
  const status =
    activeCampaigns === 0
      ? "not_applicable"
      : needsAttentionCampaigns > 0
        ? "needs_attention"
        : "ready";

  return {
    status,
    counts: {
      totalCampaigns: checks.length,
      activeCampaigns,
      readyCampaigns,
      needsAttentionCampaigns,
      notApplicableCampaigns,
      actionableChecks: actionableChecks.length,
    },
    supportedMacros: OPENAI_ADS_ATTRIBUTION_MACROS,
    safeRecommendedTemplate: SAFE_ATTRIBUTION_QUERY_STRING_TEMPLATE,
    namingConventionNote: ATTRIBUTION_NAMING_CONVENTION_NOTE,
    checks,
    actionableChecks,
    message:
      status === "ready"
        ? "Every active campaign has source and medium labels plus supported dynamic campaign and ad or ad-group identifiers."
        : status === "not_applicable"
          ? "No active campaign requires an attribution-template review."
          : `${needsAttentionCampaigns} active campaign${needsAttentionCampaigns === 1 ? "" : "s"} need attribution-template changes.`,
  };
}
