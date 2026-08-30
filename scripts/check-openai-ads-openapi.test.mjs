import { describe, expect, it } from "vitest";

import { validateOpenAiAdsSpec } from "./check-openai-ads-openapi.mjs";

function fixture() {
  const specification = {
    openapi: "3.1.0",
    info: { version: "test-version" },
    servers: [{ url: "https://api.ads.openai.com/v1" }],
    paths: {
      "/campaigns": {
        post: {
          operationId: "CreateCampaignMethod",
          parameters: [
            { in: "header", name: "Idempotency-Key" },
            { in: "header", name: "OpenAI-Ad-Account" },
          ],
          responses: { 200: { description: "Success" } },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "http", scheme: "bearer", in: "header" },
        AdsOAuth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl:
                "https://auth.openai.com/api/accounts/authorize",
              tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
              scopes: {
                "ads.admin.all.read": "Read",
                "ads.admin.all.write": "Write",
              },
            },
          },
        },
      },
      schemas: {
        ExampleResource: {
          type: "object",
          required: ["id", "optional_value"],
          properties: {
            id: { type: "string", minLength: 1 },
            optional_value: {
              anyOf: [{ type: "string" }, { type: "null" }],
            },
          },
        },
      },
    },
  };

  const manifest = {
    source: { sha256: "reviewed-sha256" },
    expected: {
      openapiVersion: "3.1.0",
      documentVersion: "test-version",
      baseUrl: "https://api.ads.openai.com/v1",
      operationCount: 1,
      advertiserOperationResponseCodesExact: ["200"],
      openAiAdAccountHeaderOperationCount: 1,
      idempotencyKeyOperations: ["POST /campaigns"],
      criticalOperations: [
        {
          key: "POST /campaigns",
          operationId: "CreateCampaignMethod",
        },
      ],
      security: {
        apiKeyScheme: "ApiKeyAuth",
        oauthScheme: "AdsOAuth",
        oauthAuthorizationUrl:
          "https://auth.openai.com/api/accounts/authorize",
        oauthTokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
        oauthScopes: ["ads.admin.all.read", "ads.admin.all.write"],
      },
      schemas: [
        {
          name: "ExampleResource",
          requiredExact: ["id", "optional_value"],
          propertiesExact: ["id", "optional_value"],
          nullableProperties: ["optional_value"],
          propertyConstraints: { id: { minLength: 1 } },
        },
      ],
    },
    operationCoverage: [
      {
        status: "implemented",
        reason: "Test fixture",
        operations: ["POST /campaigns"],
      },
    ],
  };

  return { manifest, specification };
}

describe("OpenAI Ads OpenAPI drift checker", () => {
  it("accepts a specification that matches the reviewed manifest", () => {
    const { manifest, specification } = fixture();

    expect(validateOpenAiAdsSpec(specification, manifest)).toEqual([]);
  });

  it("detects version and operation-coverage drift", () => {
    const { manifest, specification } = fixture();
    specification.info.version = "changed-version";
    manifest.operationCoverage[0].operations = [];

    const errors = validateOpenAiAdsSpec(specification, manifest);

    expect(errors).toContain(
      "info.version: expected test-version, received changed-version",
    );
    expect(errors.some((error) => error.startsWith("operationCoverage:"))).toBe(
      true,
    );
  });

  it("detects an unreviewed source checksum", () => {
    const { manifest, specification } = fixture();

    expect(
      validateOpenAiAdsSpec(specification, manifest, {
        sha256: "changed-sha256",
      }),
    ).toContain(
      "source.sha256: expected reviewed-sha256, received changed-sha256",
    );
  });

  it("detects required, nullability, and constraint drift", () => {
    const { manifest, specification } = fixture();
    const schema = specification.components.schemas.ExampleResource;
    schema.required = ["id"];
    schema.properties.optional_value = { type: "string" };
    schema.properties.id.minLength = 2;

    const errors = validateOpenAiAdsSpec(specification, manifest);

    expect(
      errors.some((error) => error.startsWith("schema.ExampleResource.required:")),
    ).toBe(true);
    expect(errors).toContain(
      "schema.ExampleResource.optional_value: expected nullable",
    );
    expect(errors).toContain(
      "schema.ExampleResource.id.minLength: expected 1, received 2",
    );
  });
});
