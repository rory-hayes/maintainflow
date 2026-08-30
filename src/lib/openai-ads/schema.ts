import { z } from "zod";

/**
 * Wire contracts follow the official OpenAI Ads OpenAPI document (2.3.0,
 * checked 2026-08-30). Response objects intentionally allow unknown fields so
 * additive provider changes do not discard data before the contract drift job
 * can report them. Request objects remain strict.
 */

export const adsObjectStatusSchema = z.enum(["active", "paused", "archived"]);
const reversibleAdsObjectStatusSchema = z.enum(["active", "paused"]);
const providerStringSchema = z.string().min(1);
const unixTimestampSchema = z.number().int();
const requestTimestampSchema = z.number().int().min(946_684_800).max(4_102_444_800);
function nonBlankStringSchema(minLength: number, maxLength: number) {
  return z
    .string()
    .min(minLength)
    .max(maxLength)
    .regex(/\S/, "Must contain at least one non-whitespace character.");
}

export const reviewStatusSchema = z.enum([
  "in_review",
  "rejected",
  "approved",
]);

export const knownReviewReasonCodes = [
  "crawl_failed",
  "crawler_bot_blocked",
  "crawler_captcha",
  "crawler_login_required",
  "crawler_400",
  "crawler_401",
  "crawler_403",
  "crawler_404",
  "crawler_408",
  "crawler_410",
  "crawler_429",
  "crawler_500",
  "crawler_502",
  "crawler_503",
  "crawler_504",
  "robots_txt",
  "unsupported_content_type",
  "landing_page_image_processing_failed",
  "landing_page_unusable",
  "missing_favicon",
] as const;

// ReviewReasonCode explicitly permits arbitrary strings in addition to the
// documented values, so unknown reasons must survive parsing.
export const reviewReasonSchema = z.string().min(1);

export const reviewSchema = z
  .object({
    status: reviewStatusSchema,
    reason: reviewReasonSchema.optional(),
    screenshot_url: z.string().optional(),
  })
  .passthrough();

const accountIntegrityReviewDetailsSchema = z
  .object({
    decision: z.string().optional(),
    reason: z.string().optional(),
    status_updated_at: z.string().optional(),
  })
  .passthrough();

const accountIntegrityReviewSchema = z
  .object({
    review: reviewSchema,
    details: accountIntegrityReviewDetailsSchema.optional(),
  })
  .passthrough();

export const adAccountSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    url: z.string(),
    preview_url: z.string().nullable(),
    status: z.string().optional(),
    timezone: z.string(),
    currency_code: z.string(),
    negative_keywords: z.array(z.string()).optional(),
    review: reviewSchema,
    account_integrity_review: accountIntegrityReviewSchema.optional(),
  })
  .passthrough();

export const campaignBudgetSchema = z
  .object({
    lifetime_spend_limit_micros: z.number().int().optional(),
    daily_spend_limit_micros: z.number().int().optional(),
  })
  .passthrough();

export const campaignBudgetInputSchema = z
  .object({
    lifetime_spend_limit_micros: z.number().int().min(1_000_000).optional(),
    daily_spend_limit_micros: z.number().int().min(1_000_000).optional(),
  })
  .strict();

const landingPageConfigurationSchema = z
  .object({ query_string_template: z.string().nullable() })
  .passthrough();

const landingPageConfigurationInputSchema = z
  .object({ query_string_template: z.string().optional() })
  .strict();

const geoLocationSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    country_code: z.string(),
    region_code: z.string().nullable(),
  })
  .passthrough();

const geoLocationsSchema = z
  .object({
    countries: z.array(z.string()).optional(),
    include: z.array(geoLocationSchema).optional(),
  })
  .passthrough();

const targetingSchema = z
  .object({
    locations: geoLocationsSchema.optional(),
    excluded_locations: geoLocationsSchema.optional(),
    custom_audiences: z.object({ ids: z.array(z.string()) }).passthrough().optional(),
    excluded_custom_audiences: z
      .object({ ids: z.array(z.string()) })
      .passthrough()
      .optional(),
    platforms: z
      .object({ included: z.array(z.string()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const geoLocationInputSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    type: z.string().optional(),
    country_code: z.string().optional(),
    region_code: z.string().optional(),
  })
  .strict();

const geoLocationsInputSchema = z
  .object({
    countries: z.array(z.string()).optional(),
    include: z.array(geoLocationInputSchema).max(2_500).optional(),
  })
  .strict();

const targetingInputSchema = z
  .object({
    locations: geoLocationsInputSchema.optional(),
    excluded_locations: geoLocationsInputSchema.optional(),
    custom_audiences: z.object({ ids: z.array(z.string()).optional() }).strict().optional(),
    excluded_custom_audiences: z
      .object({ ids: z.array(z.string()).optional() })
      .strict()
      .optional(),
    platforms: z
      .object({ included: z.array(z.string()).optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const knownCampaignServingIssueCodes = [
  "ad_account_suspended",
  "ad_account_brand_review_missing_favicon",
  "ad_account_brand_review_escalated_review",
  "ad_account_brand_review_rejected",
  "ad_account_brand_review_in_progress",
  "ad_account_payment_method_missing_or_unauthorized",
  "ad_account_threshold_payment_failed",
  "ad_account_persona_verification_not_approved",
  "ad_account_persona_verification_step_up_required",
  "campaign_not_active",
  "campaign_not_started",
  "campaign_ended",
  "campaign_has_no_ad_groups",
  "campaign_has_no_serving_ready_ad_groups",
  "ad_group_not_active",
  "ad_group_has_no_ads",
  "campaign_budget_exhausted",
  "ad_account_budget_exhausted",
  "review_not_approved",
  "landing_page_crawl_issue",
  "ad_in_review",
  "partial_serving_review_not_approved",
  "partial_serving_landing_page_crawl_issue",
  "partial_serving_ad_in_review",
] as const;

export const knownAdGroupServingIssueCodes = [
  ...knownCampaignServingIssueCodes.filter(
    (code) =>
      code !== "campaign_has_no_ad_groups" &&
      code !== "campaign_has_no_serving_ready_ad_groups",
  ),
  "ad_group_has_no_serving_ready_ads",
] as const;

export const knownAdServingIssueCodes = [
  "ad_account_suspended",
  "ad_account_brand_review_missing_favicon",
  "ad_account_brand_review_escalated_review",
  "ad_account_brand_review_rejected",
  "ad_account_brand_review_in_progress",
  "ad_account_payment_method_missing_or_unauthorized",
  "ad_account_threshold_payment_failed",
  "ad_account_persona_verification_not_approved",
  "ad_account_persona_verification_step_up_required",
  "campaign_not_active",
  "campaign_not_started",
  "campaign_ended",
  "ad_group_not_active",
  "campaign_budget_exhausted",
  "ad_account_budget_exhausted",
  "ad_not_active",
  "review_not_approved",
  "landing_page_crawl_issue",
  "ad_in_review",
  "ad_over_18_only",
  "policy_country_targeting_blocked",
  "policy_country_targeting_limited",
  "title_missing",
  "advertiser_name_missing",
  "image_or_favicon_missing",
  "target_url_invalid",
  "reserved_query_params_present",
  "product_feed_id_missing",
] as const;

const servingIssueSchema = z.object({ code: z.string().min(1) }).passthrough();

export const campaignSchema = z
  .object({
    id: z.string(),
    created_at: unixTimestampSchema,
    updated_at: unixTimestampSchema,
    name: z.string(),
    description: z.string().nullable(),
    status: adsObjectStatusSchema,
    mode: z.enum(["product_feed", "business_agent"]).nullable().optional(),
    product_feed_id: z.string().nullable(),
    business_agent_id: z.string().nullable().optional(),
    start_time: unixTimestampSchema.nullable(),
    end_time: unixTimestampSchema.nullable(),
    budget: campaignBudgetSchema,
    bidding_type: z.enum(["impressions", "clicks", "conversions"]),
    objective: z.enum(["reach", "clicks", "conversions"]).optional(),
    billing_event_type: z.enum(["impression", "click"]).optional(),
    conversion_event_setting_ids: z.array(z.string()).optional().default([]),
    targeting: targetingSchema.optional(),
    landing_page_configuration: landingPageConfigurationSchema.nullable().optional(),
    serving_issues: z.array(servingIssueSchema).optional(),
  })
  .passthrough();

export const biddingConfigSchema = z
  .object({
    billing_event_type: z.enum(["impression", "click"]),
    strategy: z
      .enum(["fixed_bid", "automated_bid", "maximize_clicks", "maximize_conversions"])
      .optional(),
    max_bid_micros: z.number().int().optional(),
    custom_audience_bid_multipliers: z
      .array(
        z
          .object({
            custom_audience_id: z.string(),
            bid_multiplier_micros: z.number().int(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export const biddingConfigInputSchema = z
  .object({
    billing_event_type: z.enum(["impression", "click"]),
    strategy: z.enum(["fixed_bid", "maximize_clicks", "maximize_conversions"]).optional(),
    max_bid_micros: z.number().int().min(1).max(30_400_000_000_000).optional(),
    custom_audience_bid_multipliers: z
      .array(
        z
          .object({
            custom_audience_id: z.string(),
            bid_multiplier_micros: z.number().int().min(100_000).max(10_000_000),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const productSetFilterInputSchema = z
  .object({
    field: z.string(),
    operator: z.enum([
      "in",
      "not_in",
      "gt",
      "gte",
      "lt",
      "lte",
      "contains",
      "not_contains",
      "starts_with",
    ]),
    values: z.array(z.string()),
  })
  .strict();

const productSetInputSchema = z
  .object({
    product_feed_id: z.string(),
    filters: z.array(productSetFilterInputSchema).optional(),
  })
  .strict();

const productSetSchema = z
  .object({
    product_feed_id: z.string(),
    filters: z.array(
      z
        .object({
          field: z.string(),
          operator: z.string(),
          values: z.array(z.string()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const adGroupSchema = z
  .object({
    id: z.string(),
    // List responses are scoped by campaign_id but do not always echo it.
    campaign_id: z.string().optional(),
    created_at: unixTimestampSchema,
    updated_at: unixTimestampSchema,
    name: z.string(),
    description: z.string().nullable(),
    context_hints: z.array(z.string()),
    product_set: productSetSchema.nullable().optional(),
    status: adsObjectStatusSchema,
    bidding_config: biddingConfigSchema,
    landing_page_configuration: landingPageConfigurationSchema.nullable().optional(),
    serving_issues: z.array(servingIssueSchema).optional(),
  })
  .passthrough();

const adImageCropSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .passthrough();

const adImageCropInputSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  })
  .strict();

export const adCreativeSchema = z
  .object({
    type: z.enum(["chat_card", "product_ad_template"]),
    title: z.string(),
    body: z.string(),
    price: z.string().optional(),
    target_url: z.string().nullable(),
    file_id: z.string().optional(),
    image_url: z.string().nullable().optional(),
    image_crop: adImageCropSchema.optional(),
  })
  .passthrough();

function adCreativeInputSchema(titleMinLength: number) {
  return z
    .object({
      type: z.enum(["chat_card", "product_ad_template"]),
      title: nonBlankStringSchema(titleMinLength, 50),
      body: z.string().max(100),
      price: z.string().max(100).optional(),
      target_url: z.string().max(2_048).optional(),
      file_id: z.string().optional(),
      image_crop: adImageCropInputSchema.optional(),
    })
    .strict();
}

export const createAdCreativeInputSchema = adCreativeInputSchema(3);
export const updateAdCreativeInputSchema = adCreativeInputSchema(1);

export const appealSchema = z
  .object({
    status: z.enum(["requested", "approved", "rejected", "superseded", "failed"]),
    requested_at: unixTimestampSchema,
    resolved_at: unixTimestampSchema.nullable(),
  })
  .passthrough();

export const adSchema = z
  .object({
    id: z.string(),
    // List responses are scoped by ad_group_id but do not always echo it.
    ad_group_id: z.string().optional(),
    name: z.string(),
    created_at: unixTimestampSchema,
    updated_at: unixTimestampSchema,
    creative: adCreativeSchema,
    status: adsObjectStatusSchema,
    review_status: reviewStatusSchema,
    landing_page_configuration: landingPageConfigurationSchema.nullable().optional(),
    appeal: appealSchema.nullable().optional(),
    review: reviewSchema,
    serving_issues: z.array(servingIssueSchema).optional(),
  })
  .passthrough();

export const insightRowSchema = z
  .object({
    id: z.string(),
    start_time: unixTimestampSchema,
    end_time: unixTimestampSchema,
    readable_time: z.string().optional(),
    campaign_id: z.string().nullable().optional(),
    campaign_name: z.string().nullable().optional(),
    ad_group_id: z.string().nullable().optional(),
    ad_id: z.string().nullable().optional(),
    impressions: z.number().nonnegative().optional(),
    clicks: z.number().nonnegative().optional(),
    spend: z.number().nonnegative().optional(),
    ctr: z.number().nonnegative().optional(),
    cpc: z.number().nonnegative().optional(),
    cpm: z.number().nonnegative().optional(),
  })
  .passthrough();

export const conversionInsightRowSchema = z
  .object({
    entity_id: z.string(),
    date: z.string().optional(),
    device: z.string().optional(),
    country: z.string().optional(),
    conversions: z.number().int().nonnegative(),
    click_through_conversions: z.number().int().nonnegative().optional(),
    view_through_conversions: z.number().int().nonnegative().optional(),
  })
  .passthrough()
  .refine(
    (row) =>
      row.click_through_conversions === undefined ||
      row.conversions === row.click_through_conversions,
    "OpenAI documents conversions as equal to click-through conversions when that field is present.",
  );

const listEnvelopeFields = {
  object: providerStringSchema,
  first_id: z.string().nullable(),
  last_id: z.string().nullable(),
  has_more: z.boolean(),
};

export const campaignListResponseSchema = z
  .object({ ...listEnvelopeFields, data: z.array(campaignSchema) })
  .passthrough();

export const adGroupListResponseSchema = z
  .object({ ...listEnvelopeFields, data: z.array(adGroupSchema) })
  .passthrough();

export const adListResponseSchema = z
  .object({ ...listEnvelopeFields, data: z.array(adSchema) })
  .passthrough();

export const insightListResponseSchema = z
  .object({
    ...listEnvelopeFields,
    count: z.number().int().nonnegative(),
    data: z.array(insightRowSchema),
  })
  .passthrough();

export const conversionInsightResponseSchema = z
  .object({
    object: providerStringSchema,
    count: z.number().int().nonnegative(),
    data: z.array(conversionInsightRowSchema),
  })
  .passthrough();

export const conversionEventSettingSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    event_type: z.string(),
    custom_event_name: z.string().nullable(),
    attribution_window_days: z.number().int(),
    ad_account_id: z.string(),
    source_ids: z.array(z.string()),
    sources: z.array(
      z.object({ id: z.string(), name: z.string().nullable() }).passthrough(),
    ),
    campaigns: z.array(z.unknown()),
    archived: z.boolean(),
    version: z.number().int(),
  })
  .passthrough();

export const conversionEventSettingListResponseSchema = z
  .object({ ...listEnvelopeFields, data: z.array(conversionEventSettingSchema) })
  .passthrough();

export const createCampaignInputSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000),
    description: z.string().optional(),
    start_time: requestTimestampSchema.optional(),
    end_time: requestTimestampSchema.optional(),
    status: reversibleAdsObjectStatusSchema,
    budget: campaignBudgetInputSchema,
    bidding_type: z.enum(["impressions", "clicks", "conversions"]).optional(),
    objective: z.enum(["reach", "clicks", "conversions"]).optional(),
    billing_event_type: z.enum(["impression", "click"]).optional(),
    mode: z.enum(["product_feed", "business_agent"]).optional(),
    product_feed_id: z.string().optional(),
    business_agent_id: z.string().optional(),
    targeting: targetingInputSchema.nullable().optional(),
    landing_page_configuration: landingPageConfigurationInputSchema.optional(),
    conversion_event_setting_ids: z.array(z.string()).optional(),
  })
  .strict();

export const updateCampaignInputSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000).optional(),
    description: z.string().nullable().optional(),
    start_time: requestTimestampSchema.nullable().optional(),
    end_time: requestTimestampSchema.nullable().optional(),
    status: adsObjectStatusSchema.optional(),
    budget: campaignBudgetInputSchema.optional(),
    targeting: targetingInputSchema.nullable().optional(),
    landing_page_configuration: landingPageConfigurationInputSchema.nullable().optional(),
    conversion_event_setting_ids: z.array(z.string()).optional(),
  })
  .strict();

export const createAdGroupInputSchema = z
  .object({
    campaign_id: z.string(),
    name: nonBlankStringSchema(3, 1_000),
    description: z.string().optional(),
    context_hints: z.array(z.string()).max(2_000).optional(),
    status: reversibleAdsObjectStatusSchema,
    bidding_config: biddingConfigInputSchema,
    product_set: productSetInputSchema.nullable().optional(),
    landing_page_configuration: landingPageConfigurationInputSchema.optional(),
  })
  .strict();

export const updateAdGroupInputSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000).optional(),
    description: z.string().nullable().optional(),
    context_hints: z.array(z.string()).max(2_000).optional(),
    status: adsObjectStatusSchema.optional(),
    bidding_config: biddingConfigInputSchema.optional(),
    product_set: productSetInputSchema.nullable().optional(),
    landing_page_configuration: landingPageConfigurationInputSchema.nullable().optional(),
  })
  .strict();

export const createAdInputSchema = z
  .object({
    ad_group_id: z.string(),
    name: nonBlankStringSchema(3, 1_000),
    creative: createAdCreativeInputSchema,
    status: reversibleAdsObjectStatusSchema,
    landing_page_configuration: landingPageConfigurationInputSchema.optional(),
  })
  .strict();

export const updateAdInputSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000).optional(),
    creative: updateAdCreativeInputSchema.optional(),
    status: adsObjectStatusSchema.optional(),
    landing_page_configuration: landingPageConfigurationInputSchema.nullable().optional(),
  })
  .strict();

// MaintainFlow's current live-write surface deliberately remains reversible
// and smaller than the provider contract until live account testing is complete.
export const campaignUpdateSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000).optional(),
    description: z.string().nullable().optional(),
    start_time: requestTimestampSchema.nullable().optional(),
    end_time: requestTimestampSchema.nullable().optional(),
    status: reversibleAdsObjectStatusSchema.optional(),
    budget: campaignBudgetInputSchema.optional(),
  })
  .strict();

export const adGroupUpdateSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000).optional(),
    description: z.string().nullable().optional(),
    context_hints: z.array(z.string()).max(2_000).optional(),
    status: reversibleAdsObjectStatusSchema.optional(),
    bidding_config: biddingConfigInputSchema.optional(),
  })
  .strict();

export const adUpdateSchema = z
  .object({
    name: nonBlankStringSchema(3, 1_000).optional(),
    creative: updateAdCreativeInputSchema.optional(),
    status: reversibleAdsObjectStatusSchema.optional(),
  })
  .strict();

export type AdAccount = z.infer<typeof adAccountSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type AdGroup = z.infer<typeof adGroupSchema>;
export type Ad = z.infer<typeof adSchema>;
export type ScopedAd = Ad & { ad_group_id: string };
export type InsightRow = z.infer<typeof insightRowSchema>;
export type ConversionInsightRow = z.infer<typeof conversionInsightRowSchema>;
export type ConversionEventSetting = z.infer<typeof conversionEventSettingSchema>;
export type CreateCampaignInput = z.infer<typeof createCampaignInputSchema>;
export type UpdateCampaignInput = z.infer<typeof updateCampaignInputSchema>;
export type CreateAdGroupInput = z.infer<typeof createAdGroupInputSchema>;
export type UpdateAdGroupInput = z.infer<typeof updateAdGroupInputSchema>;
export type CreateAdInput = z.infer<typeof createAdInputSchema>;
export type UpdateAdInput = z.infer<typeof updateAdInputSchema>;
