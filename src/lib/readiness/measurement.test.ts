import { describe, expect, it } from "vitest";

import { analyzeMeasurementInstallation } from "./measurement";

describe("OpenAI Ads measurement installation evidence", () => {
  it("detects a documented SDK installation without exposing its Pixel ID", () => {
    const result = analyzeMeasurementInstallation(`
      <script>
        (function (w, d, s, u) {
          var js = d.createElement(s);
          js.src = u;
        })(window, document, "script", "https://bzrcdn.openai.com/sdk/oaiq.min.js");
        oaiq("consent", false);
        oaiq("init", { pixelId: "px_live_123" });
        oaiq("measure", "page_viewed", { type: "contents" });
      </script>
    `);

    expect(result).toMatchObject({
      status: "detected",
      sdkDetected: true,
      initializationDetected: true,
      pixelIdDetected: true,
      imageTagDetected: false,
      consentSignalDetected: true,
      eventNames: ["page_viewed"],
      csp: { present: false, compatible: true, missingSources: [] },
    });
    expect(JSON.stringify(result)).not.toContain("px_live_123");
  });

  it("does not accept the documentation placeholder as connection evidence", () => {
    const result = analyzeMeasurementInstallation(`
      <script src="https://bzrcdn.openai.com/sdk/oaiq.min.js"></script>
      <script>oaiq("init", { pixelId: "<YOUR-PIXEL-ID>" });</script>
    `);

    expect(result.status).toBe("needs_attention");
    expect(result.initializationDetected).toBe(true);
    expect(result.pixelIdDetected).toBe(false);
    expect(result.checks[0].evidence).toContain("non-placeholder Pixel ID");
  });

  it("recognizes the documented image tag as a static measurement path", () => {
    const result = analyzeMeasurementInstallation(`
      <img
        src="https://bzr.openai.com/v1/sdk/events?pid=px_123&event=order_created&data[type]=contents"
        width="1"
        height="1"
        alt=""
      />
    `);

    expect(result.status).toBe("detected");
    expect(result.imageTagDetected).toBe(true);
    expect(result.eventNames).toEqual(["order_created"]);
  });

  it("reports every documented CSP origin missing from an active installation", () => {
    const headers = new Headers({
      "content-security-policy":
        "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'",
    });
    const result = analyzeMeasurementInstallation(
      `
        <script src="https://bzrcdn.openai.com/sdk/oaiq.min.js"></script>
        <script>oaiq("init", { pixelId: "px_live_123" });</script>
      `,
      headers,
    );

    expect(result.status).toBe("needs_attention");
    expect(result.csp.compatible).toBe(false);
    expect(result.csp.missingSources).toEqual([
      "script-src https://bzrcdn.openai.com",
      "connect-src https://bzr.openai.com",
      "connect-src https://bzrcdn.openai.com",
      "img-src https://bzr.openai.com",
    ]);
    expect(result.checks.at(-1)?.status).toBe("fail");
  });

  it("accepts exact and wildcard CSP sources without recommending unsafe-inline", () => {
    const headers = new Headers({
      "content-security-policy":
        "default-src 'self'; script-src https://bzrcdn.openai.com; connect-src https://*.openai.com; img-src https://bzr.openai.com",
    });
    const result = analyzeMeasurementInstallation(
      `
        <script src="https://bzrcdn.openai.com/sdk/oaiq.min.js"></script>
        <script>oaiq("init", { pixelId: "px_live_123" });</script>
      `,
      headers,
    );

    expect(result.status).toBe("detected");
    expect(result.csp).toMatchObject({
      present: true,
      compatible: true,
      missingSources: [],
    });
    expect(result.checks.at(-1)?.recommendation).not.toContain("'unsafe-inline'");
  });

  it("keeps no static tag distinct from a broken installation", () => {
    const result = analyzeMeasurementInstallation(
      "<html><head><title>Shop</title></head></html>",
    );

    expect(result.status).toBe("not_detected");
    expect(result.sdkDetected).toBe(false);
    expect(result.imageTagDetected).toBe(false);
    expect(result.eventNames).toEqual([]);
  });

  it("does not mistake explanatory text or unrelated query parameters for installation", () => {
    const result = analyzeMeasurementInstallation(`
      <p>Install https://bzrcdn.openai.com/sdk/oaiq.min.js later.</p>
      <a href="/calendar?event=order_created">Calendar</a>
    `);

    expect(result.status).toBe("not_detected");
    expect(result.sdkDetected).toBe(false);
    expect(result.eventNames).toEqual([]);
  });
});
