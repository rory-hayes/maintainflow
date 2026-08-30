import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  auditConversionsApiPayload,
  createConversionsApiSample,
} from "@/lib/readiness/conversions-api";

import {
  ConversionsApiAuditResult,
  ConversionsApiPreflight,
} from "./conversions-api-preflight";

describe("Conversions API preflight", () => {
  it("states the local-only credential boundary on the Readiness card", () => {
    const html = renderToStaticMarkup(<ConversionsApiPreflight />);

    expect(html).toContain("Conversions API preflight");
    expect(html).toContain("Local JSON check");
    expect(html).toContain("Never paste an API key, bearer token, or Pixel ID");
    expect(html).toContain("does not prove event receipt");
  });

  it("renders a clean static-contract result without overstating provider evidence", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    const result = auditConversionsApiPayload(createConversionsApiSample(now), now);
    const html = renderToStaticMarkup(
      <ConversionsApiAuditResult audit={result} />,
    );

    expect(html).toContain("Ready for validate_only");
    expect(html).toContain("order_created");
    expect(html).toContain("The documented static checks passed");
    expect(html).toContain("Evidence boundary");
    expect(html).toContain("does not prove receipt");
  });

  it("shows only safe finding metadata for a credential-like field", () => {
    const secret = "sk-sensitive-test-value";
    const now = new Date("2026-08-30T12:00:00.000Z");
    const payload = JSON.parse(createConversionsApiSample(now)) as {
      events: Array<{ data: Record<string, unknown> }>;
    };
    payload.events[0].data.api_key = secret;
    const result = auditConversionsApiPayload(JSON.stringify(payload), now);
    const html = renderToStaticMarkup(
      <ConversionsApiAuditResult audit={result} />,
    );

    expect(html).toContain("Credential-like field found");
    expect(html).toContain("events[].data.[field]");
    expect(html).not.toContain("api_key");
    expect(html).not.toContain(secret);
  });
});
