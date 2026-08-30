import { z } from "zod";

export const OPENAI_ADS_PRODUCT_FEED_OPENAPI_VERSION = "2.3.0" as const;
export const OPENAI_ADS_PRODUCT_FEED_BASE_URL =
  "https://api.ads.openai.com/v1" as const;
export const OPENAI_AD_ACCOUNT_HEADER = "OpenAI-Ad-Account" as const;

export const productFeedCapabilityStateSchema = z.enum([
  "documented_schema_only",
  "unverified_doc_conflict",
  "live_verified",
]);

export type ProductFeedCapabilityState = z.infer<
  typeof productFeedCapabilityStateSchema
>;

export const productFeedCapabilityNameSchema = z.enum([
  "feed_create",
  "feed_list",
  "feed_archive",
  "feed_uploads_list",
  "feed_sftp",
  "product_query",
  "product_delta",
]);

export type ProductFeedCapabilityName = z.infer<
  typeof productFeedCapabilityNameSchema
>;

type ProductFeedOperation = {
  readonly method: "GET" | "POST" | "PATCH";
  readonly path: string;
};

type ProductFeedCapability = {
  readonly state: ProductFeedCapabilityState;
  readonly operations: readonly ProductFeedOperation[];
  readonly reason: string;
};

const schemaOnlyReason =
  "OpenAPI v2.3.0 is modeled, but this operation has not been live-verified with an eligible advertiser account.";
const documentationConflictReason =
  "OpenAPI v2.3.0 models this operation, but the documentation and available-account behavior have not been reconciled or live-verified.";

export const productFeedCapabilities: Readonly<Record<
  ProductFeedCapabilityName,
  ProductFeedCapability
>> = {
  feed_create: {
    state: "unverified_doc_conflict",
    operations: [{ method: "POST", path: "/feeds" }],
    reason: documentationConflictReason,
  },
  feed_list: {
    state: "unverified_doc_conflict",
    operations: [{ method: "GET", path: "/feeds" }],
    reason: documentationConflictReason,
  },
  feed_archive: {
    state: "documented_schema_only",
    operations: [{ method: "POST", path: "/feeds/{feed_id}/archive" }],
    reason: schemaOnlyReason,
  },
  feed_uploads_list: {
    state: "documented_schema_only",
    operations: [{ method: "GET", path: "/feeds/uploads" }],
    reason: schemaOnlyReason,
  },
  feed_sftp: {
    state: "unverified_doc_conflict",
    operations: [
      { method: "GET", path: "/feeds/{feed_id}/sftp_access" },
      { method: "POST", path: "/feeds/{feed_id}/sftp_access" },
      { method: "POST", path: "/feeds/{feed_id}/sftp_access/activate" },
      { method: "POST", path: "/feeds/{feed_id}/sftp_access/pause" },
    ],
    reason: documentationConflictReason,
  },
  product_query: {
    state: "documented_schema_only",
    operations: [
      { method: "POST", path: "/feeds/{feed_id}/products/query" },
    ],
    reason: schemaOnlyReason,
  },
  product_delta: {
    state: "documented_schema_only",
    operations: [{ method: "PATCH", path: "/feeds/{feed_id}/products" }],
    reason: schemaOnlyReason,
  },
};

export class ProductFeedCapabilityUnavailableError extends Error {
  readonly capability: ProductFeedCapabilityName;
  readonly state: ProductFeedCapabilityState;

  constructor(
    capability: ProductFeedCapabilityName,
    state: ProductFeedCapabilityState,
  ) {
    super(
      `OpenAI Ads product-feed capability ${capability} is ${state} and is not enabled for network use.`,
    );
    this.name = "ProductFeedCapabilityUnavailableError";
    this.capability = capability;
    this.state = state;
  }
}

export function assertProductFeedCapabilityEnabled(
  capability: ProductFeedCapabilityName,
) {
  const state = productFeedCapabilities[capability].state;
  if (state !== "live_verified") {
    throw new ProductFeedCapabilityUnavailableError(capability, state);
  }
}

const responseStringSchema = z.string();
const responseTimestampSchema = z.string();
const providerEnumFallbackSchema = z.string().min(1);

const productFeedResourceFields = {
  name: z.string(),
  feed_id: z.string(),
  countries: z.array(z.string()),
  currencies: z.array(z.string()),
  created_at: responseTimestampSchema,
  updated_at: responseTimestampSchema,
};

export const createProductFeedBodySchema = z
  .object({
    name: z.string().max(255),
    countries: z.array(z.string()).optional(),
  })
  .strict();

export const productFeedsListIncludeParamSchema = z.literal("product_count");

export const listProductFeedsQuerySchema = z
  .object({
    include: z.array(productFeedsListIncludeParamSchema).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    after: z.string().optional(),
    before: z.string().optional(),
  })
  .strict();

export const productFeedResourceSchema = z
  .object(productFeedResourceFields)
  .passthrough();

export const listProductFeedBodySchema = z
  .object({
    ...productFeedResourceFields,
    product_count: z.number().int().optional(),
    campaign_count: z.number().int().optional(),
    hosted_url_configured: z.boolean().optional(),
    sftp_configured: z.boolean().optional(),
  })
  .passthrough();

export const listProductFeedsResourceSchema = z
  .object({
    object: responseStringSchema,
    data: z.array(listProductFeedBodySchema),
    first_id: z.string().nullable(),
    last_id: z.string().nullable(),
    has_more: z.boolean(),
  })
  .passthrough();

export const archivedProductFeedResourceSchema = z
  .object({
    feed_id: z.string(),
    archived_at: responseTimestampSchema,
  })
  .passthrough();

export const KNOWN_PRODUCT_FEED_UPLOAD_STATUSES = [
  "scanning",
  "received",
  "processing",
  "completed",
  "completed_with_errors",
  "skipped",
  "failed",
] as const;

export const knownProductFeedUploadStatusSchema = z.enum(
  KNOWN_PRODUCT_FEED_UPLOAD_STATUSES,
);
export const productFeedUploadStatusSchema = z.union([
  knownProductFeedUploadStatusSchema,
  providerEnumFallbackSchema,
]);

export const KNOWN_PRODUCT_FEED_DIAGNOSTIC_CODES = [
  "missing_required_column",
  "invalid_value",
  "unsupported_file_type",
  "invalid_sftp_directory_layout",
] as const;

export const knownProductFeedDiagnosticCodeSchema = z.enum(
  KNOWN_PRODUCT_FEED_DIAGNOSTIC_CODES,
);
export const productFeedDiagnosticCodeSchema = z.union([
  knownProductFeedDiagnosticCodeSchema,
  providerEnumFallbackSchema,
]);

export const KNOWN_PRODUCT_FEED_DIAGNOSTIC_SEVERITIES = [
  "warning",
  "error",
] as const;

export const knownProductFeedDiagnosticSeveritySchema = z.enum(
  KNOWN_PRODUCT_FEED_DIAGNOSTIC_SEVERITIES,
);
export const productFeedDiagnosticSeveritySchema = z.union([
  knownProductFeedDiagnosticSeveritySchema,
  providerEnumFallbackSchema,
]);

function includesProviderValue<const Values extends readonly string[]>(
  values: Values,
  value: string,
): value is Values[number] {
  return values.includes(value);
}

export function isKnownProductFeedUploadStatus(
  value: string,
): value is (typeof KNOWN_PRODUCT_FEED_UPLOAD_STATUSES)[number] {
  return includesProviderValue(KNOWN_PRODUCT_FEED_UPLOAD_STATUSES, value);
}

export function isKnownProductFeedDiagnosticCode(
  value: string,
): value is (typeof KNOWN_PRODUCT_FEED_DIAGNOSTIC_CODES)[number] {
  return includesProviderValue(KNOWN_PRODUCT_FEED_DIAGNOSTIC_CODES, value);
}

export function isKnownProductFeedDiagnosticSeverity(
  value: string,
): value is (typeof KNOWN_PRODUCT_FEED_DIAGNOSTIC_SEVERITIES)[number] {
  return includesProviderValue(KNOWN_PRODUCT_FEED_DIAGNOSTIC_SEVERITIES, value);
}

export const productFeedUploadDiagnosticSchema = z
  .object({
    code: productFeedDiagnosticCodeSchema,
    severity: productFeedDiagnosticSeveritySchema,
    field: z.string().nullable(),
    rows_affected: z.number().int().nullable(),
  })
  .passthrough();

export const productFeedUploadSchema = z
  .object({
    feed_id: z.string(),
    upload_id: z.string(),
    status: productFeedUploadStatusSchema,
    uploaded_at: responseTimestampSchema,
    completed_at: responseTimestampSchema.nullable(),
    rows_accepted: z.number().int().nullable(),
    rows_rejected: z.number().int().nullable(),
    rows_ads_eligible: z.number().int().nullable().optional(),
    diagnostics: z.array(productFeedUploadDiagnosticSchema),
  })
  .passthrough();

export const listProductFeedUploadsResourceSchema = z
  .object({
    uploads: z.array(productFeedUploadSchema),
    latest_uploads: z.array(productFeedUploadSchema),
    truncated: z.boolean(),
    first_id: z.string().nullable().optional(),
    last_id: z.string().nullable().optional(),
    has_more: z.boolean().optional(),
  })
  .passthrough();

export const listProductFeedUploadsQuerySchema = z
  .object({
    paginate: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    after: z.string().optional(),
    before: z.string().optional(),
  })
  .strict();

export const PRODUCT_SET_FILTER_OPERATORS = [
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "starts_with",
] as const;

export const productSetFilterOperatorSchema = z.enum(
  PRODUCT_SET_FILTER_OPERATORS,
);

export const productSetFilterParamsSchema = z
  .object({
    field: z.string(),
    operator: productSetFilterOperatorSchema,
    values: z.array(z.string()),
  })
  .strict();

export const queryProductFeedProductsBodySchema = z
  .object({
    filters: z.array(productSetFilterParamsSchema).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    after: z.string().optional(),
  })
  .strict();

export const productFeedProductSchema = z
  .object({
    product_id: z.string(),
    item_id: z.string().nullable(),
    offer_id: z.string().nullable(),
    brand: z.string().nullable(),
    title: z.string().nullable(),
    body: z.string().nullable(),
    target_url: z.string().nullable(),
    image_url: z.string().nullable(),
    price: z.string().nullable(),
    filter_values: z.record(z.string(), z.unknown()),
  })
  .passthrough();

export const queryProductFeedProductsResourceSchema = z
  .object({
    object: responseStringSchema,
    data: z.array(productFeedProductSchema),
    total_count: z.number().int(),
    matched_count: z.number().int(),
    first_id: z.string().nullable(),
    last_id: z.string().nullable(),
    has_more: z.boolean(),
  })
  .passthrough();

export const productFeedDeltaPriceBodySchema = z
  .object({
    amount: z.number().int().min(0),
    currency: z.string().length(3),
  })
  .strict();

export const productFeedDeltaAvailabilityBodySchema = z
  .object({
    available: z.boolean().optional(),
    status: z.string().optional(),
  })
  .strict();

export const productFeedDeltaVariantBodySchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    price: productFeedDeltaPriceBodySchema.optional(),
    availability: productFeedDeltaAvailabilityBodySchema.optional(),
  })
  .strict();

export const productFeedDeltaProductBodySchema = z
  .object({
    id: z.string().min(1),
    variants: z.array(productFeedDeltaVariantBodySchema).min(1),
  })
  .strict();

export const patchProductFeedProductsBodySchema = z
  .object({
    products: z.array(productFeedDeltaProductBodySchema).min(1),
  })
  .strict();

export const productFeedDeltaResourceSchema = z
  .object({
    id: z.string(),
    accepted: z.boolean(),
  })
  .passthrough();

export const KNOWN_PRODUCT_FEED_SFTP_AUTHENTICATION_METHODS = [
  "password",
  "ssh_key",
] as const;

export const productFeedSftpAuthenticationMethodParamSchema = z.enum(
  KNOWN_PRODUCT_FEED_SFTP_AUTHENTICATION_METHODS,
);
export const productFeedSftpAuthenticationMethodResourceSchema = z.union([
  productFeedSftpAuthenticationMethodParamSchema,
  providerEnumFallbackSchema,
]);

export const postProductFeedSftpAccessBodySchema = z
  .object({
    authentication_method: productFeedSftpAuthenticationMethodParamSchema,
    ssh_public_key: z.string().optional(),
  })
  .strict();

export const productFeedSftpAccessResourceSchema = z
  .object({
    enabled: z.boolean(),
    connection_uri: z.string(),
    authentication_method:
      productFeedSftpAuthenticationMethodResourceSchema.nullable(),
  })
  .passthrough();

export const productFeedSftpAccessCredentialsResourceSchema = z
  .object({
    enabled: z.boolean(),
    connection_uri: z.string(),
    authentication_method: productFeedSftpAuthenticationMethodResourceSchema,
    password: z.string().optional(),
  })
  .passthrough();

export type ProductFeed = z.infer<typeof productFeedResourceSchema>;
export type ProductFeedListItem = z.infer<typeof listProductFeedBodySchema>;
export type ProductFeedUpload = z.infer<typeof productFeedUploadSchema>;
export type ProductFeedUploadDiagnostic = z.infer<
  typeof productFeedUploadDiagnosticSchema
>;
export type ProductFeedProduct = z.infer<typeof productFeedProductSchema>;
export type QueryProductFeedProductsBody = z.infer<
  typeof queryProductFeedProductsBodySchema
>;
export type PatchProductFeedProductsBody = z.infer<
  typeof patchProductFeedProductsBodySchema
>;
