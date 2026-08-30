export const CONVERSIONS_PAYLOAD_MAX_BYTES = 1_000_000;
export const CONVERSIONS_MAX_EVENTS = 1_000;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const INTEGRATION_SOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CUSTOM_EVENT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?$/;
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;
const COUNTRY_PATTERN = /^[A-Za-z]{2}$/;
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9 -]{1,32}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_DATA_TYPES = {
  app_installed: "customer_action",
  app_opened: "customer_action",
  appointment_scheduled: "customer_action",
  checkout_started: "contents",
  contents_viewed: "contents",
  custom: "custom",
  items_added: "contents",
  lead_created: "customer_action",
  order_created: "contents",
  page_viewed: "contents",
  registration_completed: "customer_action",
  subscription_created: "plan_enrollment",
  trial_started: "plan_enrollment",
} as const;

const ACTION_SOURCES = new Set([
  "web",
  "mobile_app",
  "offline",
  "physical_store",
  "phone_call",
  "email",
  "other",
]);
const HASH_LIST_FIELDS = [
  "phone_numbers_sha256",
  "emails_sha256",
  "external_ids_sha256",
  "first_names_sha256",
  "last_names_sha256",
] as const;
const RAW_LIST_FIELDS = [
  "regions",
  "postal_codes",
  "cities",
  "countries",
] as const;
const TOP_LEVEL_FIELDS = new Set([
  "validate_only",
  "integration_source",
  "events",
]);
const EVENT_FIELDS = new Set([
  "id",
  "type",
  "timestamp_ms",
  "custom_event_name",
  "oppref",
  "source_url",
  "action_source",
  "user",
  "opt_out",
  "data",
]);
const USER_FIELDS = new Set([
  ...HASH_LIST_FIELDS,
  ...RAW_LIST_FIELDS,
  "android_advertising_id",
  "obref",
  "ip_address",
  "user_agent",
]);
const DATA_FIELDS = new Set([
  "type",
  "amount",
  "currency",
  "contents",
  "plan_id",
]);
const CONTENT_FIELDS = new Set([
  "id",
  "group_id",
  "name",
  "content_type",
  "quantity",
  "amount",
  "currency",
  "variant_dict",
]);

type EventName = keyof typeof EVENT_DATA_TYPES;
type DataType = (typeof EVENT_DATA_TYPES)[EventName];

export type ConversionPayloadIssueSeverity = "blocker" | "warning";

export type ConversionPayloadIssue = {
  code: string;
  severity: ConversionPayloadIssueSeverity;
  title: string;
  field: string;
  detail: string;
  count: number;
  affectedEvents: number[];
};

export type ConversionPayloadAudit = {
  verdict: "ready_for_validation" | "needs_attention" | "invalid";
  eventCount: number;
  readyEventCount: number;
  blockerCount: number;
  warningCount: number;
  validateOnly: boolean | null;
  integrationSourcePresent: boolean;
  eventTypes: Array<{ name: string; count: number }>;
  issues: ConversionPayloadIssue[];
  limitations: string[];
};

type RawIssue = Omit<ConversionPayloadIssue, "count" | "affectedEvents"> & {
  eventIndex?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function addIssue(
  issues: RawIssue[],
  issue: Omit<RawIssue, "severity"> & {
    severity?: ConversionPayloadIssueSeverity;
  },
) {
  issues.push({ severity: issue.severity ?? "blocker", ...issue });
}

function aggregateIssues(issues: RawIssue[]): ConversionPayloadIssue[] {
  const groups = new Map<string, ConversionPayloadIssue>();
  for (const issue of issues) {
    const key = [issue.code, issue.severity, issue.field, issue.detail].join("|");
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (
        issue.eventIndex !== undefined &&
        existing.affectedEvents.length < 20 &&
        !existing.affectedEvents.includes(issue.eventIndex + 1)
      ) {
        existing.affectedEvents.push(issue.eventIndex + 1);
      }
      continue;
    }
    groups.set(key, {
      code: issue.code,
      severity: issue.severity,
      title: issue.title,
      field: issue.field,
      detail: issue.detail,
      count: 1,
      affectedEvents:
        issue.eventIndex === undefined ? [] : [issue.eventIndex + 1],
    });
  }
  return [...groups.values()].sort((left, right) => {
    if (left.severity !== right.severity) {
      return left.severity === "blocker" ? -1 : 1;
    }
    return right.count - left.count || left.field.localeCompare(right.field);
  });
}

function isValidUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isValidIpAddress(value: string): boolean {
  const parts = value.split(".");
  if (
    parts.length === 4 &&
    parts.every(
      (part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    )
  ) {
    return true;
  }
  return value.includes(":") && /^[0-9a-f:.]+$/i.test(value);
}

function validateKnownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  issues: RawIssue[],
  options: { field: string; eventIndex?: number; customAllowed?: boolean },
) {
  for (const key of Object.keys(record)) {
    if (allowed.has(key)) continue;
    const looksSecret = /(?:authorization|api[_-]?key|secret|token)/i.test(key);
    if (options.customAllowed && !looksSecret) continue;
    addIssue(issues, {
      code: looksSecret ? "secret_field" : "unknown_field",
      title: looksSecret ? "Credential-like field found" : "Undocumented field",
      field: `${options.field}.${key}`,
      detail: looksSecret
        ? "Remove credentials from the JSON body. Keys belong only in the server-side Authorization header and are never needed for this local check."
        : "Remove the field or confirm a newer OpenAI schema before relying on it.",
      eventIndex: options.eventIndex,
    });
  }
}

function validateHashList(
  user: Record<string, unknown>,
  field: (typeof HASH_LIST_FIELDS)[number],
  eventIndex: number,
  issues: RawIssue[],
) {
  const value = user[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    addIssue(issues, {
      code: "hash_list_type",
      title: "Hashed identifier list is malformed",
      field: `events[].user.${field}`,
      detail: "Use an array of lowercase SHA-256 strings.",
      eventIndex,
    });
    return;
  }
  if (value.some((item) => !HASH_PATTERN.test(item))) {
    addIssue(issues, {
      code: "hash_format",
      title: "Hashed identifier is not normalized",
      field: `events[].user.${field}`,
      detail: "Every value must be a lowercase, 64-character SHA-256 hexadecimal string; do not send raw identifiers.",
      eventIndex,
    });
  }
  if (value.length > 3) {
    addIssue(issues, {
      code: "hash_list_limit",
      severity: "warning",
      title: "Only the first three identifiers are used",
      field: `events[].user.${field}`,
      detail: "OpenAI uses the first three valid unique values and ignores additional entries.",
      eventIndex,
    });
  }
}

function validateRawStringList(
  user: Record<string, unknown>,
  field: (typeof RAW_LIST_FIELDS)[number],
  eventIndex: number,
  issues: RawIssue[],
) {
  const value = user[field];
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    addIssue(issues, {
      code: "user_list_type",
      title: "User matching field is malformed",
      field: `events[].user.${field}`,
      detail: "Use an array of strings for this user matching field.",
      eventIndex,
    });
    return;
  }
  if (value.length > 3) {
    addIssue(issues, {
      code: "user_list_limit",
      severity: "warning",
      title: "Only the first three matching values are used",
      field: `events[].user.${field}`,
      detail: "OpenAI uses the first three valid unique values and ignores additional entries.",
      eventIndex,
    });
  }
  if (
    field === "regions" ||
    field === "cities"
      ? value.some((item) => item.trim().length === 0 || item.trim().length > 128)
      : field === "postal_codes"
        ? value.some((item) => !POSTAL_CODE_PATTERN.test(item))
        : value.some((item) => !COUNTRY_PATTERN.test(item))
  ) {
    addIssue(issues, {
      code: "user_value_format",
      title: "User matching value has the wrong format",
      field: `events[].user.${field}`,
      detail:
        field === "countries"
          ? "Use two-letter country codes."
          : field === "postal_codes"
            ? "Use 1–32 letters, numbers, spaces, or hyphens."
            : "Use a non-empty value no longer than 128 characters.",
      eventIndex,
    });
  }
}

function validateUser(
  value: unknown,
  eventIndex: number,
  issues: RawIssue[],
) {
  if (value === undefined) return;
  if (!isRecord(value)) {
    addIssue(issues, {
      code: "user_object",
      title: "User data must be an object",
      field: "events[].user",
      detail: "Put optional conversion-matching fields inside one user object per event.",
      eventIndex,
    });
    return;
  }

  validateKnownFields(value, USER_FIELDS, issues, {
    field: "events[].user",
    eventIndex,
  });
  HASH_LIST_FIELDS.forEach((field) =>
    validateHashList(value, field, eventIndex, issues),
  );
  RAW_LIST_FIELDS.forEach((field) =>
    validateRawStringList(value, field, eventIndex, issues),
  );

  const simpleStrings = ["obref", "user_agent"] as const;
  for (const field of simpleStrings) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || value[field].trim().length === 0)
    ) {
      addIssue(issues, {
        code: "user_string",
        title: "User matching value is empty",
        field: `events[].user.${field}`,
        detail: "Use a non-empty string or omit the field.",
        eventIndex,
      });
    }
  }

  if (
    value.ip_address !== undefined &&
    (typeof value.ip_address !== "string" ||
      !isValidIpAddress(value.ip_address))
  ) {
    addIssue(issues, {
      code: "ip_address",
      title: "IP address is malformed",
      field: "events[].user.ip_address",
      detail: "Use a valid IPv4 or IPv6 address or omit the field.",
      eventIndex,
    });
  }
  if (
    value.android_advertising_id !== undefined &&
    (typeof value.android_advertising_id !== "string" ||
      !UUID_PATTERN.test(value.android_advertising_id))
  ) {
    addIssue(issues, {
      code: "android_id",
      title: "Android advertising ID is malformed",
      field: "events[].user.android_advertising_id",
      detail: "Use a valid Android GAID in UUID format or omit the field; IDFA is not supported.",
      eventIndex,
    });
  }
}

function validateContentItem(
  value: unknown,
  eventIndex: number,
  itemIndex: number,
  eventCurrencyPresent: boolean,
  issues: RawIssue[],
) {
  if (!isRecord(value)) {
    addIssue(issues, {
      code: "content_item",
      title: "Content item must be an object",
      field: "events[].data.contents[]",
      detail: "Use the documented Content object for every item.",
      eventIndex,
    });
    return;
  }
  validateKnownFields(value, CONTENT_FIELDS, issues, {
    field: `events[].data.contents[${itemIndex}]`,
    eventIndex,
  });

  for (const field of ["id", "group_id", "name", "content_type"] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" ||
        (field === "content_type" && value[field].trim().length === 0))
    ) {
      addIssue(issues, {
        code: "content_string",
        title: "Content field has the wrong type",
        field: `events[].data.contents[].${field}`,
        detail: "Use a string for this content field.",
        eventIndex,
      });
    }
  }
  for (const field of ["quantity", "amount"] as const) {
    if (value[field] !== undefined && !Number.isInteger(value[field])) {
      addIssue(issues, {
        code: "content_integer",
        title: "Content amount must be an integer",
        field: `events[].data.contents[].${field}`,
        detail: "Use an integer; monetary amounts use the currency's standard minor unit.",
        eventIndex,
      });
    }
  }
  if (
    value.currency !== undefined &&
    (typeof value.currency !== "string" || !CURRENCY_PATTERN.test(value.currency))
  ) {
    addIssue(issues, {
      code: "content_currency",
      title: "Item currency is malformed",
      field: "events[].data.contents[].currency",
      detail: "Use a three-letter ISO 4217 currency code.",
      eventIndex,
    });
  }
  if (value.amount !== undefined && !value.currency && !eventCurrencyPresent) {
    addIssue(issues, {
      code: "content_currency_required",
      title: "Item amount has no currency",
      field: "events[].data.contents[].currency",
      detail: "Add an item currency or provide one event-level currency for the batch item.",
      eventIndex,
    });
  }
  if (value.variant_dict !== undefined) {
    if (
      !isRecord(value.variant_dict) ||
      Object.values(value.variant_dict).some((item) => typeof item !== "string")
    ) {
      addIssue(issues, {
        code: "variant_dict",
        title: "Variant dictionary is malformed",
        field: "events[].data.contents[].variant_dict",
        detail: "Use an object with string keys and string values.",
        eventIndex,
      });
    }
  }
}

function validateEventData(
  value: unknown,
  expectedType: DataType | undefined,
  eventIndex: number,
  issues: RawIssue[],
) {
  if (!isRecord(value)) {
    addIssue(issues, {
      code: "data_object",
      title: "Event data is missing",
      field: "events[].data",
      detail: "Every event needs a data object with the documented type.",
      eventIndex,
    });
    return;
  }

  const dataType = typeof value.type === "string" ? value.type : undefined;
  validateKnownFields(value, DATA_FIELDS, issues, {
    field: "events[].data",
    eventIndex,
    customAllowed: dataType === "custom",
  });
  if (!dataType || dataType !== expectedType) {
    addIssue(issues, {
      code: "data_type",
      title: "Event data type does not match",
      field: "events[].data.type",
      detail: expectedType
        ? `Use ${expectedType} for this event type.`
        : "Use the data type documented for the supported event.",
      eventIndex,
    });
  }

  if (value.amount !== undefined && !Number.isInteger(value.amount)) {
    addIssue(issues, {
      code: "event_amount",
      title: "Event amount must be an integer",
      field: "events[].data.amount",
      detail: "Use an integer in the currency's standard minor unit.",
      eventIndex,
    });
  }
  if (value.amount !== undefined && value.currency === undefined) {
    addIssue(issues, {
      code: "event_currency_required",
      title: "Event amount has no currency",
      field: "events[].data.currency",
      detail: "Add a three-letter ISO 4217 currency code whenever amount is present.",
      eventIndex,
    });
  }
  if (
    value.currency !== undefined &&
    (typeof value.currency !== "string" || !CURRENCY_PATTERN.test(value.currency))
  ) {
    addIssue(issues, {
      code: "event_currency",
      title: "Event currency is malformed",
      field: "events[].data.currency",
      detail: "Use a three-letter ISO 4217 currency code.",
      eventIndex,
    });
  }
  if (
    value.plan_id !== undefined &&
    (typeof value.plan_id !== "string" || value.plan_id.trim().length === 0)
  ) {
    addIssue(issues, {
      code: "plan_id",
      title: "Plan identifier is malformed",
      field: "events[].data.plan_id",
      detail: "Use a non-empty string or omit the plan identifier.",
      eventIndex,
    });
  }
  if (
    value.plan_id !== undefined &&
    dataType !== "plan_enrollment" &&
    dataType !== "custom"
  ) {
    addIssue(issues, {
      code: "plan_id_shape",
      title: "Plan identifier is not allowed for this shape",
      field: "events[].data.plan_id",
      detail: "plan_id is available only for plan_enrollment and custom data.",
      eventIndex,
    });
  }
  if (value.contents !== undefined) {
    if (dataType === "customer_action") {
      addIssue(issues, {
        code: "contents_shape",
        title: "Contents are not allowed for customer actions",
        field: "events[].data.contents",
        detail: "Remove contents or use the event's documented data shape.",
        eventIndex,
      });
    } else if (!Array.isArray(value.contents)) {
      addIssue(issues, {
        code: "contents_array",
        title: "Contents must be an array",
        field: "events[].data.contents",
        detail: "Use an array of documented Content objects.",
        eventIndex,
      });
    } else {
      value.contents.forEach((item, itemIndex) =>
        validateContentItem(
          item,
          eventIndex,
          itemIndex,
          typeof value.currency === "string" &&
            CURRENCY_PATTERN.test(value.currency),
          issues,
        ),
      );
    }
  }
}

function validateEvent(
  value: unknown,
  eventIndex: number,
  nowMs: number,
  issues: RawIssue[],
  eventTypeCounts: Map<string, number>,
  eventIds: Map<string, number>,
) {
  if (!isRecord(value)) {
    addIssue(issues, {
      code: "event_object",
      title: "Event must be an object",
      field: "events[]",
      detail: "Use one documented event object for every batch entry.",
      eventIndex,
    });
    return;
  }
  validateKnownFields(value, EVENT_FIELDS, issues, {
    field: "events[]",
    eventIndex,
  });

  if (typeof value.id !== "string" || value.id.trim().length === 0) {
    addIssue(issues, {
      code: "event_id",
      title: "Event ID is missing",
      field: "events[].id",
      detail: "Use a stable non-empty ID and reuse it for Pixel/API deduplication and retries.",
      eventIndex,
    });
  } else {
    const eventIdentity =
      typeof value.type === "string"
        ? value.type === "custom" && typeof value.custom_event_name === "string"
          ? `${value.type}:${value.custom_event_name.toLowerCase()}`
          : value.type
        : "unknown";
    const duplicateKey = `${eventIdentity}:${value.id}`;
    const duplicateOf = eventIds.get(duplicateKey);
    if (duplicateOf !== undefined) {
      addIssue(issues, {
        code: "duplicate_event_id",
        severity: "warning",
        title: "Event ID is repeated in this batch",
        field: "events[].id",
        detail: "Confirm the repeated ID represents the same conversion and event name; OpenAI deduplicates with Pixel ID, event name, and ID.",
        eventIndex,
      });
    } else {
      eventIds.set(duplicateKey, eventIndex);
    }
  }

  const eventType =
    typeof value.type === "string" && value.type in EVENT_DATA_TYPES
      ? (value.type as EventName)
      : undefined;
  if (!eventType) {
    addIssue(issues, {
      code: "event_type",
      title: "Event type is unsupported",
      field: "events[].type",
      detail: "Use a standard OpenAI event name or custom.",
      eventIndex,
    });
  } else {
    eventTypeCounts.set(eventType, (eventTypeCounts.get(eventType) ?? 0) + 1);
  }

  if (!Number.isInteger(value.timestamp_ms)) {
    addIssue(issues, {
      code: "timestamp_type",
      title: "Timestamp must be an integer",
      field: "events[].timestamp_ms",
      detail: "Use an integer Unix timestamp in milliseconds.",
      eventIndex,
    });
  } else if (
    (value.timestamp_ms as number) < nowMs - SEVEN_DAYS_MS ||
    (value.timestamp_ms as number) > nowMs + TEN_MINUTES_MS
  ) {
    addIssue(issues, {
      code: "timestamp_window",
      title: "Timestamp is outside OpenAI's window",
      field: "events[].timestamp_ms",
      detail: "Use an event time within the last seven days and no more than ten minutes in the future.",
      eventIndex,
    });
  }

  if (eventType === "custom") {
    if (
      typeof value.custom_event_name !== "string" ||
      !CUSTOM_EVENT_PATTERN.test(value.custom_event_name) ||
      value.custom_event_name.length > 64 ||
      Object.prototype.hasOwnProperty.call(
        EVENT_DATA_TYPES,
        value.custom_event_name.toLowerCase(),
      )
    ) {
      addIssue(issues, {
        code: "custom_event_name",
        title: "Custom event name is invalid",
        field: "events[].custom_event_name",
        detail: "Use 1–64 letters, digits, underscores, or hyphens; start and end with a letter or digit and do not reuse a standard event name.",
        eventIndex,
      });
    } else if (value.custom_event_name !== value.custom_event_name.toLowerCase()) {
      addIssue(issues, {
        code: "custom_event_case",
        severity: "warning",
        title: "Custom event name will be normalized",
        field: "events[].custom_event_name",
        detail: "Use lowercase to match the documented canonical event name.",
        eventIndex,
      });
    }
  } else if (value.custom_event_name !== undefined) {
    addIssue(issues, {
      code: "unexpected_custom_event_name",
      severity: "warning",
      title: "Custom event name is unnecessary",
      field: "events[].custom_event_name",
      detail: "Remove custom_event_name from standard events.",
      eventIndex,
    });
  }

  const actionSource =
    typeof value.action_source === "string" && ACTION_SOURCES.has(value.action_source)
      ? value.action_source
      : undefined;
  if (value.action_source !== undefined && !actionSource) {
    addIssue(issues, {
      code: "action_source",
      title: "Action source is unsupported",
      field: "events[].action_source",
      detail: "Use web, mobile_app, offline, physical_store, phone_call, email, or other.",
      eventIndex,
    });
  }
  if (
    (eventType === "app_installed" || eventType === "app_opened") &&
    actionSource !== "mobile_app"
  ) {
    addIssue(issues, {
      code: "app_action_source",
      title: "App lifecycle event needs mobile_app",
      field: "events[].action_source",
      detail: "Use mobile_app for app_installed and app_opened events.",
      eventIndex,
    });
  }
  if (actionSource === "web" && !isValidUrl(value.source_url)) {
    addIssue(issues, {
      code: "source_url_required",
      title: "Web event needs a source URL",
      field: "events[].source_url",
      detail: "Use a complete HTTP or HTTPS URL with a scheme and host.",
      eventIndex,
    });
  } else if (value.source_url !== undefined && !isValidUrl(value.source_url)) {
    addIssue(issues, {
      code: "source_url",
      title: "Source URL is malformed",
      field: "events[].source_url",
      detail: "Use a complete HTTP or HTTPS URL or omit the field when it is not required.",
      eventIndex,
    });
  }
  if (
    value.oppref !== undefined &&
    (typeof value.oppref !== "string" || value.oppref.trim().length === 0)
  ) {
    addIssue(issues, {
      code: "oppref",
      title: "Attribution identifier is empty",
      field: "events[].oppref",
      detail: "Pass the original non-empty OpenAI value without modification or omit it.",
      eventIndex,
    });
  }
  if (value.opt_out !== undefined && typeof value.opt_out !== "boolean") {
    addIssue(issues, {
      code: "opt_out",
      title: "Opt-out flag must be boolean",
      field: "events[].opt_out",
      detail: "Use true or false.",
      eventIndex,
    });
  }

  validateUser(value.user, eventIndex, issues);
  validateEventData(
    value.data,
    eventType ? EVENT_DATA_TYPES[eventType] : undefined,
    eventIndex,
    issues,
  );
}

function emptyAudit(issue: RawIssue): ConversionPayloadAudit {
  return {
    verdict: "invalid",
    eventCount: 0,
    readyEventCount: 0,
    blockerCount: 1,
    warningCount: 0,
    validateOnly: null,
    integrationSourcePresent: false,
    eventTypes: [],
    issues: aggregateIssues([issue]),
    limitations: [...conversionPayloadLimitations],
  };
}

export const conversionPayloadLimitations = [
  "This local check does not send a request, include a Pixel ID, or accept a Conversions API key.",
  "A clean result means the documented static contract is ready for an OpenAI validate_only request; it does not prove receipt, deduplication, matching, attribution, optimization, or billing.",
  "OpenAI remains the authority for currency registries, attribution identifiers, consent compliance, account enablement, and any schema change after this documentation snapshot.",
] as const;

export function auditConversionsApiPayload(
  input: string,
  now = new Date(),
): ConversionPayloadAudit {
  if (new TextEncoder().encode(input).byteLength > CONVERSIONS_PAYLOAD_MAX_BYTES) {
    return emptyAudit({
      code: "payload_size",
      severity: "blocker",
      title: "Payload is too large for this preflight",
      field: "payload",
      detail: "Keep the local JSON sample at or below 1 MB and split oversized test fixtures.",
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return emptyAudit({
      code: "invalid_json",
      severity: "blocker",
      title: "Payload is not valid JSON",
      field: "payload",
      detail: "Paste only the JSON request body, without curl syntax, comments, or trailing commas.",
    });
  }
  if (!isRecord(parsed)) {
    return emptyAudit({
      code: "payload_object",
      severity: "blocker",
      title: "Payload must be a JSON object",
      field: "payload",
      detail: "Use a top-level object containing validate_only and events.",
    });
  }

  const issues: RawIssue[] = [];
  validateKnownFields(parsed, TOP_LEVEL_FIELDS, issues, { field: "payload" });
  const validateOnly =
    typeof parsed.validate_only === "boolean" ? parsed.validate_only : null;
  if (parsed.validate_only !== undefined && validateOnly === null) {
    addIssue(issues, {
      code: "validate_only_type",
      title: "validate_only must be boolean",
      field: "payload.validate_only",
      detail: "Use true for a no-save validation request or false for a production send.",
    });
  } else if (validateOnly !== true) {
    addIssue(issues, {
      code: "validate_only_off",
      severity: "warning",
      title: "Dry-run mode is not enabled",
      field: "payload.validate_only",
      detail: "Set validate_only to true for the first controlled OpenAI request so events are checked without being saved.",
    });
  }

  const integrationSourcePresent = parsed.integration_source !== undefined;
  if (
    integrationSourcePresent &&
    (typeof parsed.integration_source !== "string" ||
      !INTEGRATION_SOURCE_PATTERN.test(parsed.integration_source))
  ) {
    addIssue(issues, {
      code: "integration_source",
      title: "Integration source is malformed",
      field: "payload.integration_source",
      detail: "Use 1–64 ASCII letters, digits, periods, underscores, or hyphens and start with a letter or digit.",
    });
  } else if (
    typeof parsed.integration_source === "string" &&
    parsed.integration_source !== parsed.integration_source.toLowerCase()
  ) {
    addIssue(issues, {
      code: "integration_source_case",
      severity: "warning",
      title: "Integration source will be normalized",
      field: "payload.integration_source",
      detail: "Use lowercase to match the documented canonical integration source.",
    });
  }

  if (!Array.isArray(parsed.events)) {
    addIssue(issues, {
      code: "events_array",
      title: "Events array is missing",
      field: "payload.events",
      detail: "Add an events array containing at least one event.",
    });
  } else if (parsed.events.length === 0 || parsed.events.length > CONVERSIONS_MAX_EVENTS) {
    addIssue(issues, {
      code: "events_count",
      title: "Batch size is outside OpenAI's limit",
      field: "payload.events",
      detail: "Send between 1 and 1,000 events; one invalid event rejects the full batch.",
    });
  }

  const events = Array.isArray(parsed.events)
    ? parsed.events.slice(0, CONVERSIONS_MAX_EVENTS)
    : [];
  const eventTypeCounts = new Map<string, number>();
  const eventIds = new Map<string, number>();
  events.forEach((event, eventIndex) =>
    validateEvent(
      event,
      eventIndex,
      now.getTime(),
      issues,
      eventTypeCounts,
      eventIds,
    ),
  );

  const blockerCount = issues.filter((issue) => issue.severity === "blocker").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const topLevelBlocker = issues.some(
    (issue) => issue.severity === "blocker" && issue.eventIndex === undefined,
  );
  const blockedEvents = new Set(
    issues
      .filter(
        (issue) =>
          issue.severity === "blocker" && issue.eventIndex !== undefined,
      )
      .map((issue) => issue.eventIndex),
  );
  const readyEventCount = topLevelBlocker
    ? 0
    : events.length - blockedEvents.size;

  return {
    verdict:
      blockerCount > 0
        ? "invalid"
        : warningCount > 0
          ? "needs_attention"
          : "ready_for_validation",
    eventCount: Array.isArray(parsed.events) ? parsed.events.length : 0,
    readyEventCount,
    blockerCount,
    warningCount,
    validateOnly,
    integrationSourcePresent,
    eventTypes: [...eventTypeCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
    issues: aggregateIssues(issues),
    limitations: [...conversionPayloadLimitations],
  };
}

export function createConversionsApiSample(now = new Date()): string {
  return JSON.stringify(
    {
      validate_only: true,
      integration_source: "maintainflow_preflight",
      events: [
        {
          id: "order_demo_123",
          type: "order_created",
          timestamp_ms: now.getTime(),
          source_url: "https://shop.example.com/orders/demo",
          action_source: "web",
          data: {
            type: "contents",
            amount: 2599,
            currency: "EUR",
            contents: [
              {
                id: "sku_demo_123",
                name: "Starter bundle",
                content_type: "product",
                quantity: 1,
              },
            ],
          },
        },
      ],
    },
    null,
    2,
  );
}
