import type { ScopedAd } from "./schema";

export type CreativeTriageState =
  | "blocked"
  | "pending"
  | "delivery"
  | "clear";

export type CreativeTriageGuidance = {
  state: CreativeTriageState;
  needsReviewAttention: boolean;
  label: string;
  detail: string;
  providerSignal?: string;
  evidenceUrl?: string;
};

function readableCode(code: string) {
  return code
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function guidanceForReviewReason(reason: string) {
  if (reason === "robots_txt" || reason === "crawler_bot_blocked") {
    return {
      label: "Allow the OpenAI crawler",
      detail:
        "OpenAI reports that its crawler is blocked. Review robots.txt, bot protection, and allow-list rules before resubmitting.",
    };
  }
  if (reason === "crawler_captcha" || reason === "crawler_login_required") {
    return {
      label: "Remove the crawler gate",
      detail:
        "OpenAI reached a CAPTCHA or login wall. The advertised destination needs a publicly readable landing path.",
    };
  }
  if (/^crawler_(4\d\d|5\d\d)$/.test(reason) || reason === "crawl_failed") {
    return {
      label: "Restore landing-page access",
      detail:
        "OpenAI could not retrieve a usable landing-page response. Check availability, redirects, status codes, and edge-security rules.",
    };
  }
  if (reason === "unsupported_content_type") {
    return {
      label: "Serve a supported landing page",
      detail:
        "OpenAI reports an unsupported response type. Use a normal browser-readable HTML destination.",
    };
  }
  if (reason === "landing_page_image_processing_failed") {
    return {
      label: "Fix landing-page images",
      detail:
        "OpenAI could not process the landing-page imagery. Check image URLs, formats, permissions, and response status.",
    };
  }
  if (reason === "landing_page_unusable") {
    return {
      label: "Repair the landing page",
      detail:
        "OpenAI marked the destination unusable. Check the rendered page, navigation, product availability, and mobile experience.",
    };
  }
  if (reason === "missing_favicon") {
    return {
      label: "Add a valid favicon",
      detail:
        "OpenAI reports that the destination is missing a favicon. Publish one that its crawler can retrieve.",
    };
  }
  return {
    label: "Review the provider rejection",
    detail:
      "OpenAI returned a rejection reason that MaintainFlow has retained but does not yet map to an automated fix.",
  };
}

function guidanceForServingIssue(code: string) {
  if (code === "landing_page_crawl_issue") {
    return {
      label: "Fix landing-page access",
      detail:
        "OpenAI reports a landing-page crawl issue. Check the destination response and crawler access before launch.",
    };
  }
  if (code === "target_url_invalid") {
    return {
      label: "Fix the destination URL",
      detail:
        "OpenAI reports that the ad target URL is invalid. Verify the final HTTPS destination and redirect chain.",
    };
  }
  if (code === "reserved_query_params_present") {
    return {
      label: "Remove reserved URL parameters",
      detail:
        "OpenAI reports reserved query parameters in the destination. Remove or replace them before launch.",
    };
  }
  if (code === "image_or_favicon_missing" || code.endsWith("missing_favicon")) {
    return {
      label: "Add the missing brand image",
      detail:
        "OpenAI reports that a required ad image or destination favicon is unavailable.",
    };
  }
  if (code.includes("payment") || code.includes("budget_exhausted")) {
    return {
      label: "Resolve account funding",
      detail:
        "OpenAI reports a payment or budget blocker. Review the advertiser account before changing the creative.",
    };
  }
  if (code.includes("policy_country_targeting")) {
    return {
      label: "Review country targeting",
      detail:
        "OpenAI reports a policy restriction for at least one targeted country. Review the campaign’s eligible locations.",
    };
  }
  if (code === "product_feed_id_missing") {
    return {
      label: "Reconnect the product feed",
      detail:
        "OpenAI reports that the ad is missing its product-feed association.",
    };
  }
  return {
    label: "Resolve the serving blocker",
    detail:
      "OpenAI returned a serving issue that needs review before this ad can deliver normally.",
  };
}

/**
 * Provider reasons and serving issues are evidence, not inferred diagnoses.
 * MaintainFlow maps documented values to a practical next check while keeping
 * unknown future values visible for manual review.
 */
export function getCreativeTriageGuidance(
  ad: ScopedAd,
): CreativeTriageGuidance {
  const reason = ad.review.reason;
  const servingIssue = ad.serving_issues?.[0]?.code;
  const evidenceUrl = ad.review.screenshot_url;

  if (ad.appeal?.status === "requested") {
    return {
      state: "pending",
      needsReviewAttention: true,
      label: "Appeal pending",
      detail: "OpenAI has received an appeal and has not returned a final decision.",
      providerSignal: reason ? readableCode(reason) : "Appeal requested",
      evidenceUrl,
    };
  }

  if (ad.review_status === "rejected") {
    const guidance = reason
      ? guidanceForReviewReason(reason)
      : {
          label: "Review in Ads Manager",
          detail:
            "OpenAI rejected this creative without returning a reason in this response.",
        };
    return {
      state: "blocked",
      needsReviewAttention: true,
      ...guidance,
      providerSignal: reason ? readableCode(reason) : undefined,
      evidenceUrl,
    };
  }

  if (servingIssue && servingIssue !== "ad_in_review") {
    return {
      state: "blocked",
      needsReviewAttention: true,
      ...guidanceForServingIssue(servingIssue),
      providerSignal: readableCode(servingIssue),
      evidenceUrl,
    };
  }

  if (ad.review_status === "in_review") {
    return {
      state: "pending",
      needsReviewAttention: true,
      label: "Await OpenAI review",
      detail: "No final provider decision is available yet.",
      providerSignal: servingIssue ? readableCode(servingIssue) : undefined,
      evidenceUrl,
    };
  }

  if (ad.status === "paused") {
    return {
      state: "delivery",
      needsReviewAttention: false,
      label: "Review delivery state",
      detail: "The creative is approved but currently paused.",
    };
  }

  return {
    state: "clear",
    needsReviewAttention: false,
    label: "No review action",
    detail: "The creative is approved and active.",
  };
}

export function needsCreativeReviewAttention(ad: ScopedAd) {
  return getCreativeTriageGuidance(ad).needsReviewAttention;
}
