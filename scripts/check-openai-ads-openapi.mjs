#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HTTP_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

const DEFAULT_MANIFEST_URL = new URL(
  "../docs/openai-ads/contract-manifest.json",
  import.meta.url,
);

function sortedUnique(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function sameStringSet(actual, expected) {
  const sortedActual = sortedUnique(actual);
  const sortedExpected = sortedUnique(expected);

  return (
    sortedActual.length === sortedExpected.length &&
    sortedActual.every((value, index) => value === sortedExpected[index])
  );
}

function formatValues(values) {
  return `[${sortedUnique(values).join(", ")}]`;
}

export function collectOperations(specification) {
  const operations = [];

  for (const [path, pathItem] of Object.entries(specification.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem ?? {})) {
      if (!HTTP_METHODS.has(method.toLowerCase())) {
        continue;
      }

      operations.push({
        key: `${method.toUpperCase()} ${path}`,
        method: method.toLowerCase(),
        operation,
        path,
        pathItem,
      });
    }
  }

  return operations.sort((left, right) => left.key.localeCompare(right.key));
}

export function collectOperationKeys(specification) {
  return collectOperations(specification).map(({ key }) => key);
}

function resolveLocalReference(specification, value, errors, label) {
  const seen = new Set();
  while (value && typeof value === "object" && typeof value.$ref === "string") {
    const reference = value.$ref;
    if (!reference.startsWith("#/") || seen.has(reference) || seen.size >= 32) {
      errors.push(`${label}: unsupported or circular reference ${reference}`);
      return {};
    }
    seen.add(reference);
    let parts;
    try {
      parts = decodeURIComponent(reference.slice(2))
        .split("/")
        .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
    } catch {
      errors.push(`${label}: invalid reference ${reference}`);
      return {};
    }
    let target = specification;
    for (const part of parts)
      target = target && Object.hasOwn(target, part) ? target[part] : undefined;
    if (!target || typeof target !== "object") {
      errors.push(`${label}: unresolved reference ${reference}`);
      return {};
    }
    value = target;
  }
  return value;
}

function operationParameters(record, specification, errors) {
  return [
    ...(Array.isArray(record.pathItem?.parameters)
      ? record.pathItem.parameters
      : []),
    ...(Array.isArray(record.operation?.parameters)
      ? record.operation.parameters
      : []),
  ].map((parameter) =>
    resolveLocalReference(
      specification,
      parameter,
      errors,
      `${record.key}.parameters`,
    ),
  );
}

function hasHeader(parameters, headerName) {
  return parameters.some(
    (parameter) =>
      parameter &&
      typeof parameter === "object" &&
      parameter.in === "header" &&
      typeof parameter.name === "string" &&
      parameter.name.toLowerCase() === headerName.toLowerCase(),
  );
}

function collectEnums(value, output = []) {
  if (!value || typeof value !== "object") {
    return output;
  }

  if (Array.isArray(value.enum)) {
    output.push(...value.enum.filter((entry) => typeof entry === "string"));
  }

  for (const child of Object.values(value)) {
    if (child && typeof child === "object") {
      collectEnums(child, output);
    }
  }

  return output;
}

function isNullable(schema) {
  if (!schema || typeof schema !== "object") {
    return false;
  }

  if (schema.nullable === true || schema.type === "null") {
    return true;
  }

  if (Array.isArray(schema.type) && schema.type.includes("null")) {
    return true;
  }

  return ["allOf", "anyOf", "oneOf"].some(
    (keyword) =>
      Array.isArray(schema[keyword]) && schema[keyword].some(isNullable),
  );
}

function checkExact(errors, label, actual, expected) {
  if (!sameStringSet(actual, expected)) {
    errors.push(
      `${label}: expected ${formatValues(expected)}, received ${formatValues(actual)}`,
    );
  }
}

function validateSecurity(specification, expectation, errors) {
  const schemes = specification.components?.securitySchemes ?? {};
  const apiKeyScheme = schemes[expectation.apiKeyScheme];
  const oauthScheme = schemes[expectation.oauthScheme];

  if (!apiKeyScheme) {
    errors.push(`security: missing ${expectation.apiKeyScheme}`);
  } else {
    if (apiKeyScheme.type !== "http") {
      errors.push(
        `security.${expectation.apiKeyScheme}.type: expected http, received ${String(apiKeyScheme.type)}`,
      );
    }
    if (apiKeyScheme.scheme !== "bearer") {
      errors.push(
        `security.${expectation.apiKeyScheme}.scheme: expected bearer, received ${String(apiKeyScheme.scheme)}`,
      );
    }
    if (apiKeyScheme.in !== "header") {
      errors.push(
        `security.${expectation.apiKeyScheme}.in: expected header, received ${String(apiKeyScheme.in)}`,
      );
    }
  }

  if (!oauthScheme) {
    errors.push(`security: missing ${expectation.oauthScheme}`);
    return;
  }

  if (oauthScheme.type !== "oauth2") {
    errors.push(
      `security.${expectation.oauthScheme}.type: expected oauth2, received ${String(oauthScheme.type)}`,
    );
  }

  const authorizationCode = oauthScheme.flows?.authorizationCode;
  if (!authorizationCode) {
    errors.push(
      `security.${expectation.oauthScheme}: missing authorizationCode flow`,
    );
    return;
  }

  checkExact(
    errors,
    `security.${expectation.oauthScheme}.scopes`,
    Object.keys(authorizationCode.scopes ?? {}),
    expectation.oauthScopes,
  );

  if (
    expectation.oauthAuthorizationUrl &&
    authorizationCode.authorizationUrl !== expectation.oauthAuthorizationUrl
  ) {
    errors.push(
      `security.${expectation.oauthScheme}.authorizationUrl: expected ${expectation.oauthAuthorizationUrl}, received ${String(authorizationCode.authorizationUrl)}`,
    );
  }

  if (
    expectation.oauthTokenUrl &&
    authorizationCode.tokenUrl !== expectation.oauthTokenUrl
  ) {
    errors.push(
      `security.${expectation.oauthScheme}.tokenUrl: expected ${expectation.oauthTokenUrl}, received ${String(authorizationCode.tokenUrl)}`,
    );
  }
}

function validateSchemas(specification, expectations, errors) {
  const schemas = specification.components?.schemas ?? {};

  for (const expectation of expectations) {
    const schema = schemas[expectation.name];
    const label = `schema.${expectation.name}`;

    if (!schema) {
      errors.push(`${label}: missing`);
      continue;
    }

    if (expectation.requiredExact) {
      checkExact(
        errors,
        `${label}.required`,
        Array.isArray(schema.required) ? schema.required : [],
        expectation.requiredExact,
      );
    }

    const propertyNames = Object.keys(schema.properties ?? {});
    if (expectation.propertiesExact) {
      checkExact(
        errors,
        `${label}.properties`,
        propertyNames,
        expectation.propertiesExact,
      );
    }

    for (const propertyName of expectation.propertiesInclude ?? []) {
      if (!propertyNames.includes(propertyName)) {
        errors.push(`${label}.properties: missing ${propertyName}`);
      }
    }

    const enumValues = sortedUnique(collectEnums(schema));
    if (expectation.enumExact) {
      checkExact(errors, `${label}.enum`, enumValues, expectation.enumExact);
    }

    for (const enumValue of expectation.enumIncludes ?? []) {
      if (!enumValues.includes(enumValue)) {
        errors.push(`${label}.enum: missing ${enumValue}`);
      }
    }

    for (const propertyName of expectation.nullableProperties ?? []) {
      const property = schema.properties?.[propertyName];
      if (!property) {
        errors.push(`${label}.${propertyName}: missing property`);
      } else if (!isNullable(property)) {
        errors.push(`${label}.${propertyName}: expected nullable`);
      }
    }

    for (const [propertyName, constraints] of Object.entries(
      expectation.propertyConstraints ?? {},
    )) {
      const property = schema.properties?.[propertyName];
      if (!property) {
        errors.push(`${label}.${propertyName}: missing property`);
        continue;
      }

      for (const [constraint, expectedValue] of Object.entries(constraints)) {
        if (property[constraint] !== expectedValue) {
          errors.push(
            `${label}.${propertyName}.${constraint}: expected ${JSON.stringify(expectedValue)}, received ${JSON.stringify(property[constraint])}`,
          );
        }
      }
    }
    for (const [propertyName, reference] of Object.entries(
      expectation.propertyItemReferences ?? {},
    )) {
      const actual = schema.properties?.[propertyName]?.items?.$ref;
      if (actual !== reference)
        errors.push(
          `${label}.${propertyName}.items.$ref: expected ${reference}, received ${String(actual)}`,
        );
    }
  }
}

function validateCoverage(operations, coverage, errors) {
  const actualKeys = operations.map(({ key }) => key);
  const coveredKeys = [];
  const duplicates = new Set();
  const firstSeen = new Set();

  for (const group of coverage ?? []) {
    if (!group.reason || typeof group.reason !== "string") {
      errors.push(`operationCoverage.${String(group.status)}: missing reason`);
    }

    for (const key of group.operations ?? []) {
      if (firstSeen.has(key)) {
        duplicates.add(key);
      }
      firstSeen.add(key);
      coveredKeys.push(key);
    }
  }

  if (duplicates.size > 0) {
    errors.push(
      `operationCoverage: duplicate operations ${formatValues([...duplicates])}`,
    );
  }

  checkExact(errors, "operationCoverage", actualKeys, coveredKeys);
}

function validateReadContract(
  specification,
  record,
  expected,
  parameters,
  errors,
) {
  if (expected.responseSchemaRef) {
    const response = resolveLocalReference(
      specification,
      record.operation?.responses?.["200"],
      errors,
      `${record.key}.responses.200`,
    );
    const actual = response?.content?.["application/json"]?.schema?.$ref;
    if (actual !== expected.responseSchemaRef)
      errors.push(
        `${record.key}.responseSchemaRef: expected ${expected.responseSchemaRef}, received ${String(actual)}`,
      );
  }
  for (const parameter of expected.queryParameters ?? []) {
    const actual = parameters.find(
      (item) => item?.in === "query" && item.name === parameter.name,
    );
    const label = `${record.key}.query.${parameter.name}`;
    if (!actual) {
      errors.push(`${label}: missing`);
      continue;
    }
    const schema = resolveLocalReference(
      specification,
      actual.schema,
      errors,
      label,
    );
    for (const [key, value] of Object.entries(parameter.schema ?? {})) {
      if (schema?.[key] !== value)
        errors.push(
          `${label}.${key}: expected ${JSON.stringify(value)}, received ${JSON.stringify(schema?.[key])}`,
        );
    }
    if (parameter.itemsType && schema?.items?.type !== parameter.itemsType)
      errors.push(
        `${label}.items.type: expected ${parameter.itemsType}, received ${String(schema?.items?.type)}`,
      );
    if (Boolean(actual.required) !== Boolean(parameter.required))
      errors.push(
        `${label}.required: expected ${Boolean(parameter.required)}, received ${Boolean(actual.required)}`,
      );
  }
  if (expected.securityRequirements) {
    const canonical = (requirements) =>
      (requirements ?? []).map((requirement) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(requirement)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([scheme, scopes]) => [scheme, sortedUnique(scopes)]),
          ),
        ),
      );
    checkExact(
      errors,
      `${record.key}.security`,
      canonical(record.operation.security ?? specification.security),
      canonical(expected.securityRequirements),
    );
  }
}

export function validateOpenAiAdsSpec(
  specification,
  manifest,
  { sha256 } = {},
) {
  const errors = [];
  const expected = manifest.expected;
  const operations = collectOperations(specification);
  const operationsByKey = new Map(
    operations.map((record) => [record.key, record]),
  );

  if (!expected || typeof expected !== "object") {
    return ["manifest.expected: missing"];
  }

  if (specification.openapi !== expected.openapiVersion) {
    errors.push(
      `openapi: expected ${expected.openapiVersion}, received ${String(specification.openapi)}`,
    );
  }

  if (specification.info?.version !== expected.documentVersion) {
    errors.push(
      `info.version: expected ${expected.documentVersion}, received ${String(specification.info?.version)}`,
    );
  }

  if (
    !(specification.servers ?? []).some(
      (server) => server?.url === expected.baseUrl,
    )
  ) {
    errors.push(`servers: missing ${expected.baseUrl}`);
  }

  if (operations.length !== expected.operationCount) {
    errors.push(
      `operations: expected ${expected.operationCount}, received ${operations.length}`,
    );
  }

  if (sha256 && sha256 !== manifest.source?.sha256) {
    errors.push(
      `source.sha256: expected ${String(manifest.source?.sha256)}, received ${sha256}`,
    );
  }

  validateCoverage(operations, manifest.operationCoverage, errors);
  const parametersByOperation = new Map(
    operations.map((record) => [
      record.key,
      operationParameters(record, specification, errors),
    ]),
  );

  for (const critical of expected.criticalOperations ?? []) {
    const record = operationsByKey.get(critical.key);
    if (!record) {
      errors.push(`critical operation: missing ${critical.key}`);
    } else {
      if (record.operation?.operationId !== critical.operationId) {
        errors.push(
          `${critical.key}.operationId: expected ${critical.operationId}, received ${String(record.operation?.operationId)}`,
        );
      }
      validateReadContract(
        specification,
        record,
        critical,
        parametersByOperation.get(record.key),
        errors,
      );
    }
  }

  for (const record of operations) {
    checkExact(
      errors,
      `${record.key}.responses`,
      Object.keys(record.operation?.responses ?? {}),
      expected.advertiserOperationResponseCodesExact,
    );
  }

  const adAccountHeaderOperations = operations.filter((record) =>
    hasHeader(parametersByOperation.get(record.key), "OpenAI-Ad-Account"),
  );
  if (
    adAccountHeaderOperations.length !==
    expected.openAiAdAccountHeaderOperationCount
  ) {
    errors.push(
      `OpenAI-Ad-Account operations: expected ${expected.openAiAdAccountHeaderOperationCount}, received ${adAccountHeaderOperations.length}`,
    );
  }

  const idempotencyOperations = operations
    .filter((record) =>
      hasHeader(parametersByOperation.get(record.key), "Idempotency-Key"),
    )
    .map(({ key }) => key);
  checkExact(
    errors,
    "Idempotency-Key operations",
    idempotencyOperations,
    expected.idempotencyKeyOperations,
  );

  validateSecurity(specification, expected.security, errors);
  validateSchemas(specification, expected.schemas ?? [], errors);

  return errors;
}

function parseArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--manifest" || argument === "--spec") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${argument} requires a value`);
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

async function readText(location, { timeoutMs = 30_000 } = {}) {
  if (/^https?:\/\//u.test(location)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(location, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `GET ${location} returned ${response.status} ${response.statusText}`,
        );
      }
      return await response.text();
    } finally {
      clearTimeout(timeout);
    }
  }

  return readFile(resolve(location), "utf8");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const manifestLocation = options.manifest
    ? resolve(options.manifest)
    : fileURLToPath(DEFAULT_MANIFEST_URL);
  const manifest = JSON.parse(await readText(manifestLocation));
  const specificationLocation = options.spec ?? manifest.source?.url;

  if (!specificationLocation) {
    throw new Error("The manifest does not define source.url");
  }

  const sourceText = await readText(specificationLocation);
  const specification = JSON.parse(sourceText);
  const sourceHash = sha256(sourceText);
  const errors = validateOpenAiAdsSpec(specification, manifest, {
    sha256: sourceHash,
  });

  if (errors.length > 0) {
    console.error(
      `OpenAI Ads OpenAPI drift detected (${errors.length} issue${errors.length === 1 ? "" : "s"}):`,
    );
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `OpenAI Ads OpenAPI ${specification.info.version} matches the checked-in contract: ${collectOperations(specification).length} operations, sha256 ${sourceHash}.`,
  );
}

const entrypoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;

if (entrypoint === import.meta.url) {
  main().catch((error) => {
    console.error(
      `Unable to check the OpenAI Ads OpenAPI contract: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
