import { describe, expect, it } from "vitest";

import {
  CONVERSIONS_MAX_EVENTS,
  CONVERSIONS_PAYLOAD_MAX_BYTES,
  auditConversionsApiPayload,
  createConversionsApiSample,
  type ConversionPayloadAudit,
} from "./conversions-api";

const NOW = new Date("2026-08-30T12:00:00.000Z");

function samplePayload() {
  return JSON.parse(createConversionsApiSample(NOW)) as {
    validate_only?: unknown;
    integration_source?: unknown;
    events: Array<Record<string, unknown>>;
  };
}

function audit(value: unknown): ConversionPayloadAudit {
  return auditConversionsApiPayload(JSON.stringify(value), NOW);
}

function issueCodes(result: ConversionPayloadAudit) {
  return result.issues.map((issue) => issue.code);
}

describe("OpenAI Conversions API local payload preflight", () => {
  it("marks the generated dry-run sample ready for an OpenAI validate_only request", () => {
    const result = auditConversionsApiPayload(createConversionsApiSample(NOW), NOW);

    expect(result).toMatchObject({
      verdict: "ready_for_validation",
      eventCount: 1,
      readyEventCount: 1,
      blockerCount: 0,
      warningCount: 0,
      validateOnly: true,
      integrationSourcePresent: true,
      eventTypes: [{ name: "order_created", count: 1 }],
      issues: [],
    });
  });

  it("reports malformed JSON without returning pasted input", () => {
    const pastedSecret = "sk-sensitive-example";
    const result = auditConversionsApiPayload(
      `{"events":[],"api_key":"${pastedSecret}"`,
      NOW,
    );

    expect(result.verdict).toBe("invalid");
    expect(issueCodes(result)).toEqual(["invalid_json"]);
    expect(JSON.stringify(result)).not.toContain(pastedSecret);
  });

  it.each([undefined, false])(
    "warns when validate_only is not safely enabled (%s)",
    (validateOnly) => {
      const payload = samplePayload();
      if (validateOnly === undefined) delete payload.validate_only;
      else payload.validate_only = validateOnly;

      const result = audit(payload);

      expect(result.verdict).toBe("needs_attention");
      expect(result.blockerCount).toBe(0);
      expect(issueCodes(result)).toContain("validate_only_off");
    },
  );

  it("blocks batches larger than the documented 1,000-event limit", () => {
    const payload = samplePayload();
    const event = payload.events[0];
    payload.events = Array.from({ length: CONVERSIONS_MAX_EVENTS + 1 }, (_, index) => ({
      ...event,
      id: `event_${index}`,
    }));

    const result = audit(payload);

    expect(result.eventCount).toBe(1_001);
    expect(result.readyEventCount).toBe(0);
    expect(issueCodes(result)).toContain("events_count");
  });

  it.each([
    ["string", "2026-08-30T12:00:00Z", "timestamp_type"],
    ["older than seven days", NOW.getTime() - 7 * 86_400_000 - 1, "timestamp_window"],
    ["over ten minutes ahead", NOW.getTime() + 10 * 60_000 + 1, "timestamp_window"],
  ])("blocks a %s timestamp", (_label, timestamp, code) => {
    const payload = samplePayload();
    payload.events[0].timestamp_ms = timestamp;

    expect(issueCodes(audit(payload))).toContain(code);
  });

  it("enforces the event-specific data shape and monetary minor-unit contract", () => {
    const payload = samplePayload();
    payload.events[0].data = {
      type: "customer_action",
      amount: 25.99,
    };
    payload.events.push({
      ...payload.events[0],
      id: "order_without_item_currency",
      data: {
        type: "contents",
        contents: [{ id: "sku_123", amount: 500 }],
      },
    });

    const result = audit(payload);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "data_type",
        "event_amount",
        "event_currency_required",
        "content_currency_required",
      ]),
    );
  });

  it("requires complete source URLs for web events and mobile_app for app lifecycle events", () => {
    const payload = samplePayload();
    payload.events = [
      { ...payload.events[0], source_url: "/checkout" },
      {
        id: "app_open_1",
        type: "app_opened",
        timestamp_ms: NOW.getTime(),
        action_source: "web",
        source_url: "https://example.com/app",
        data: { type: "customer_action" },
      },
    ];

    const result = audit(payload);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["source_url_required", "app_action_source"]),
    );
  });

  it("validates custom names, reports canonical casing, and allows custom data fields", () => {
    const base = samplePayload().events[0];
    const payload = samplePayload();
    payload.events = [
      {
        ...base,
        id: "custom_collision",
        type: "custom",
        custom_event_name: "order_created",
        data: { type: "custom", loyalty_tier: "gold" },
      },
      {
        ...base,
        id: "custom_case",
        type: "custom",
        custom_event_name: "BookedNow",
        data: { type: "custom", loyalty_tier: "gold" },
      },
    ];

    const result = audit(payload);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["custom_event_name", "custom_event_case"]),
    );
    expect(issueCodes(result)).not.toContain("unknown_field");
  });

  it("rejects raw or uppercase identifiers and never echoes their values", () => {
    const payload = samplePayload();
    const rawEmail = "customer@example.com";
    const uppercaseHash = "A".repeat(64);
    payload.events[0].user = {
      emails_sha256: [rawEmail, uppercaseHash],
      external_ids_sha256: [
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "d".repeat(64),
      ],
    };

    const result = audit(payload);
    const serialized = JSON.stringify(result);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining(["hash_format", "hash_list_limit"]),
    );
    expect(serialized).not.toContain(rawEmail);
    expect(serialized).not.toContain(uppercaseHash);
  });

  it("blocks credential-like fields even in custom data without echoing the value", () => {
    const payload = samplePayload();
    const secret = "sk-never-return-this";
    payload.events[0] = {
      ...payload.events[0],
      type: "custom",
      custom_event_name: "loyalty_upgrade",
      data: { type: "custom", api_key: secret, loyalty_tier: "gold" },
    };

    const result = audit(payload);

    expect(issueCodes(result)).toContain("secret_field");
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("enforces contents, plan enrollment, and user-field shapes", () => {
    const payload = samplePayload();
    payload.events = [
      {
        ...payload.events[0],
        id: "lead_1",
        type: "lead_created",
        data: { type: "customer_action", contents: [] },
      },
      {
        ...payload.events[0],
        id: "subscription_1",
        type: "subscription_created",
        data: { type: "plan_enrollment", plan_id: "" },
        user: { countries: ["Ireland"], android_advertising_id: "not-a-uuid" },
      },
    ];

    const result = audit(payload);

    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        "contents_shape",
        "plan_id",
        "user_value_format",
        "android_id",
      ]),
    );
  });

  it("warns only when the same event name and ID repeat", () => {
    const payload = samplePayload();
    const base = payload.events[0];
    payload.events = [
      base,
      { ...base },
      {
        ...base,
        type: "checkout_started",
        data: { type: "contents" },
      },
    ];

    const result = audit(payload);
    const duplicate = result.issues.find((issue) => issue.code === "duplicate_event_id");

    expect(duplicate).toMatchObject({ count: 1, affectedEvents: [2] });
    expect(JSON.stringify(result)).not.toContain(String(base.id));
  });

  it("rejects oversized local input before parsing it", () => {
    const result = auditConversionsApiPayload(
      " ".repeat(CONVERSIONS_PAYLOAD_MAX_BYTES + 1),
      NOW,
    );

    expect(issueCodes(result)).toEqual(["payload_size"]);
  });
});
