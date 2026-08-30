import { describe, expect, it } from "vitest";

import {
  archivedProductFeedResourceSchema,
  assertProductFeedCapabilityEnabled,
  createProductFeedBodySchema,
  isKnownProductFeedDiagnosticCode,
  isKnownProductFeedDiagnosticSeverity,
  isKnownProductFeedUploadStatus,
  KNOWN_PRODUCT_FEED_UPLOAD_STATUSES,
  listProductFeedUploadsQuerySchema,
  listProductFeedUploadsResourceSchema,
  listProductFeedsQuerySchema,
  listProductFeedsResourceSchema,
  OPENAI_AD_ACCOUNT_HEADER,
  OPENAI_ADS_PRODUCT_FEED_BASE_URL,
  OPENAI_ADS_PRODUCT_FEED_OPENAPI_VERSION,
  patchProductFeedProductsBodySchema,
  postProductFeedSftpAccessBodySchema,
  productFeedCapabilities,
  ProductFeedCapabilityUnavailableError,
  productFeedDeltaResourceSchema,
  productFeedResourceSchema,
  productFeedSftpAccessCredentialsResourceSchema,
  productFeedSftpAccessResourceSchema,
  productFeedUploadSchema,
  queryProductFeedProductsBodySchema,
  queryProductFeedProductsResourceSchema,
} from "./product-feed-contract";

describe("OpenAI Ads product-feed capability gates", () => {
  it("pins the official v2.3.0 contract without enabling network operations", () => {
    expect(OPENAI_ADS_PRODUCT_FEED_OPENAPI_VERSION).toBe("2.3.0");
    expect(OPENAI_ADS_PRODUCT_FEED_BASE_URL).toBe(
      "https://api.ads.openai.com/v1",
    );
    expect(OPENAI_AD_ACCOUNT_HEADER).toBe("OpenAI-Ad-Account");

    expect(productFeedCapabilities.feed_create).toMatchObject({
      state: "unverified_doc_conflict",
      operations: [{ method: "POST", path: "/feeds" }],
    });
    expect(productFeedCapabilities.feed_list).toMatchObject({
      state: "unverified_doc_conflict",
      operations: [{ method: "GET", path: "/feeds" }],
    });
    expect(productFeedCapabilities.feed_sftp.state).toBe(
      "unverified_doc_conflict",
    );
    expect(productFeedCapabilities.product_query).toMatchObject({
      state: "documented_schema_only",
      operations: [
        { method: "POST", path: "/feeds/{feed_id}/products/query" },
      ],
    });
    expect(productFeedCapabilities.product_delta).toMatchObject({
      state: "documented_schema_only",
      operations: [
        { method: "PATCH", path: "/feeds/{feed_id}/products" },
      ],
    });

    for (const capability of ["feed_create", "feed_list", "feed_sftp"] as const) {
      expect(() => assertProductFeedCapabilityEnabled(capability)).toThrow(
        ProductFeedCapabilityUnavailableError,
      );
    }
  });
});

describe("OpenAI Ads product-feed resources", () => {
  it("models create, item, list, and archive shapes without loosening requests", () => {
    expect(
      createProductFeedBodySchema.parse({
        name: "Ireland summer catalogue",
        countries: ["IE", "GB"],
      }),
    ).toEqual({
      name: "Ireland summer catalogue",
      countries: ["IE", "GB"],
    });
    expect(() =>
      createProductFeedBodySchema.parse({
        name: "Catalogue",
        undocumented: true,
      }),
    ).toThrow();
    expect(
      listProductFeedsQuerySchema.parse({
        include: ["product_count"],
        limit: 500,
        after: "feed_100",
      }),
    ).toEqual({
      include: ["product_count"],
      limit: 500,
      after: "feed_100",
    });
    expect(() => listProductFeedsQuerySchema.parse({ limit: 501 })).toThrow();

    const feed = productFeedResourceSchema.parse({
      name: "Ireland summer catalogue",
      feed_id: "feed_123",
      countries: ["IE"],
      currencies: ["EUR"],
      created_at: "2026-08-30T10:00:00Z",
      updated_at: "2026-08-30T11:00:00Z",
      provider_extension: "preserved",
    });
    expect(feed.provider_extension).toBe("preserved");

    const list = listProductFeedsResourceSchema.parse({
      object: "list",
      data: [
        {
          ...feed,
          product_count: 250,
          campaign_count: 2,
          hosted_url_configured: true,
          sftp_configured: false,
        },
      ],
      first_id: "feed_123",
      last_id: "feed_123",
      has_more: false,
    });
    expect(list.data[0]).toMatchObject({
      feed_id: "feed_123",
      product_count: 250,
      campaign_count: 2,
    });

    expect(
      archivedProductFeedResourceSchema.parse({
        feed_id: "feed_123",
        archived_at: "2026-08-30T12:00:00Z",
      }),
    ).toEqual({
      feed_id: "feed_123",
      archived_at: "2026-08-30T12:00:00Z",
    });
  });
});

describe("OpenAI Ads product-feed uploads", () => {
  it.each(KNOWN_PRODUCT_FEED_UPLOAD_STATUSES)(
    "accepts the documented %s upload status",
    (status) => {
      expect(
        productFeedUploadSchema.parse({
          feed_id: "feed_123",
          upload_id: `upload_${status}`,
          status,
          uploaded_at: "2026-08-30T10:00:00Z",
          completed_at: null,
          rows_accepted: null,
          rows_rejected: null,
          diagnostics: [],
        }).status,
      ).toBe(status);
      expect(isKnownProductFeedUploadStatus(status)).toBe(true);
    },
  );

  it("preserves future status, diagnostic code, and severity values", () => {
    const upload = productFeedUploadSchema.parse({
      feed_id: "feed_123",
      upload_id: "upload_future",
      status: "queued_for_review",
      uploaded_at: "2026-08-30T10:00:00Z",
      completed_at: null,
      rows_accepted: 19,
      rows_rejected: 1,
      rows_ads_eligible: 17,
      diagnostics: [
        {
          code: "new_provider_diagnostic",
          severity: "notice",
          field: "availability",
          rows_affected: 1,
          provider_detail: "kept",
        },
      ],
    });

    expect(upload.status).toBe("queued_for_review");
    expect(upload.diagnostics[0]).toMatchObject({
      code: "new_provider_diagnostic",
      severity: "notice",
      provider_detail: "kept",
    });
    expect(isKnownProductFeedUploadStatus(upload.status)).toBe(false);
    expect(isKnownProductFeedDiagnosticCode(upload.diagnostics[0].code)).toBe(
      false,
    );
    expect(
      isKnownProductFeedDiagnosticSeverity(upload.diagnostics[0].severity),
    ).toBe(false);
  });

  it("models both paginated and latest upload collections", () => {
    const upload = {
      feed_id: "feed_123",
      upload_id: "upload_123",
      status: "completed",
      uploaded_at: "2026-08-30T10:00:00Z",
      completed_at: "2026-08-30T10:05:00Z",
      rows_accepted: 20,
      rows_rejected: 0,
      diagnostics: [],
    };
    const result = listProductFeedUploadsResourceSchema.parse({
      uploads: [upload],
      latest_uploads: [upload],
      truncated: false,
      first_id: "upload_123",
      last_id: "upload_123",
      has_more: false,
    });

    expect(result.uploads).toHaveLength(1);
    expect(result.latest_uploads[0].status).toBe("completed");
    expect(
      listProductFeedUploadsQuerySchema.parse({
        paginate: true,
        limit: 100,
        after: "upload_100",
      }),
    ).toEqual({ paginate: true, limit: 100, after: "upload_100" });
    expect(() =>
      listProductFeedUploadsQuerySchema.parse({ limit: 101 }),
    ).toThrow();
  });
});

describe("OpenAI Ads product query contract", () => {
  it("models documented filters, cursor pagination, and the 500-row limit", () => {
    expect(queryProductFeedProductsBodySchema.parse({})).toEqual({});
    expect(
      queryProductFeedProductsBodySchema.parse({
        filters: [
          { field: "brand", operator: "in", values: ["MaintainFlow"] },
        ],
        limit: 500,
        after: "product_500",
      }),
    ).toMatchObject({ limit: 500, after: "product_500" });

    expect(() =>
      queryProductFeedProductsBodySchema.parse({ limit: 501 }),
    ).toThrow();
    expect(() =>
      queryProductFeedProductsBodySchema.parse({
        filters: [
          { field: "brand", operator: "future_operator", values: ["x"] },
        ],
      }),
    ).toThrow();

    const result = queryProductFeedProductsResourceSchema.parse({
      object: "list",
      data: [
        {
          product_id: "product_1",
          item_id: "item_1",
          offer_id: null,
          brand: "MaintainFlow",
          title: "Launch planner",
          body: null,
          target_url: "https://shop.example/products/launch-planner",
          image_url: "https://shop.example/images/launch-planner.jpg",
          price: "49.00 EUR",
          filter_values: { colour: "navy", sizes: ["S", "M"] },
          provider_extension: 1,
        },
      ],
      total_count: 100,
      matched_count: 1,
      first_id: "product_1",
      last_id: "product_1",
      has_more: false,
    });

    expect(result.data[0]).toMatchObject({
      product_id: "product_1",
      provider_extension: 1,
      filter_values: { colour: "navy", sizes: ["S", "M"] },
    });
  });
});

describe("OpenAI Ads product delta contract", () => {
  it("models price and availability updates without inventing status enums", () => {
    const request = patchProductFeedProductsBodySchema.parse({
      products: [
        {
          id: "product_1",
          variants: [
            {
              id: "variant_1",
              title: "Navy / M",
              price: { amount: 4999, currency: "EUR" },
              availability: {
                available: true,
                status: "provider_defined_status",
              },
            },
          ],
        },
      ],
    });
    expect(request.products[0].variants[0]).toMatchObject({
      price: { amount: 4999, currency: "EUR" },
      availability: {
        available: true,
        status: "provider_defined_status",
      },
    });

    expect(() =>
      patchProductFeedProductsBodySchema.parse({ products: [] }),
    ).toThrow();
    expect(() =>
      patchProductFeedProductsBodySchema.parse({
        products: [{ id: "product_1", variants: [] }],
      }),
    ).toThrow();
    expect(() =>
      patchProductFeedProductsBodySchema.parse({
        products: [
          {
            id: "product_1",
            variants: [
              { id: "variant_1", price: { amount: -1, currency: "EURO" } },
            ],
          },
        ],
      }),
    ).toThrow();

    expect(
      productFeedDeltaResourceSchema.parse({
        id: "delta_123",
        accepted: true,
      }),
    ).toEqual({ id: "delta_123", accepted: true });
  });
});

describe("OpenAI Ads product-feed SFTP shapes", () => {
  it("keeps request auth strict while preserving future response methods", () => {
    expect(
      postProductFeedSftpAccessBodySchema.parse({
        authentication_method: "ssh_key",
        ssh_public_key: "ssh-ed25519 public-key-material",
      }),
    ).toMatchObject({ authentication_method: "ssh_key" });
    expect(() =>
      postProductFeedSftpAccessBodySchema.parse({
        authentication_method: "future_method",
      }),
    ).toThrow();

    const access = productFeedSftpAccessResourceSchema.parse({
      enabled: false,
      connection_uri: "sftp://uploads.example/feed_123",
      authentication_method: "certificate",
    });
    expect(access.authentication_method).toBe("certificate");

    expect(
      productFeedSftpAccessCredentialsResourceSchema.parse({
        enabled: true,
        connection_uri: "sftp://uploads.example/feed_123",
        authentication_method: "ssh_key",
      }),
    ).not.toHaveProperty("password");
  });
});
