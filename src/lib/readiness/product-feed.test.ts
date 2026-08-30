import { describe, expect, it } from "vitest";

import {
  auditProductFeedText,
  parseDelimitedProductFeed,
  PRODUCT_FEED_MAX_BYTES,
} from "./product-feed";

const header = [
  "id",
  "title",
  "description",
  "link",
  "image_link",
  "availability",
  "price",
  "brand",
  "gtin",
  "is_ads_eligible",
].join(",");

describe("product feed readiness", () => {
  it("accepts a documented Google-compatible Ads feed", () => {
    const audit = auditProductFeedText(
      `${header}\nSKU-1,Oak bench,Storage bench,https://shop.example/p/1,https://shop.example/1.jpg,in_stock,79.99 USD,Harbour Home,12345678,true`,
      "catalog.csv",
      { now: new Date("2026-08-30T00:00:00.000Z") },
    );

    expect(audit).toMatchObject({
      verdict: "ready",
      rowCount: 1,
      adsEligibleRows: 1,
      blockedRows: 0,
      issues: [],
    });
  });

  it("parses quoted commas, escaped quotes, and quoted newlines", () => {
    expect(
      parseDelimitedProductFeed(
        'id,title,description\r\n1,"Bench, oak","Line one\nLine ""two"""',
        ",",
      ),
    ).toEqual([
      ["id", "title", "description"],
      ["1", "Bench, oak", 'Line one\nLine "two"'],
    ]);
  });

  it("aggregates row blockers without exposing feed contents", () => {
    const audit = auditProductFeedText(
      `${header}\nSKU-1,Oak bench,Storage bench,ftp://shop.example/p/1,not-a-url,preorder,0 usd,${"H".repeat(71)},,false\nSKU-1,Second bench,Description,https://shop.example/p/2,https://shop.example/2.jpg,unknown,59 USD,Harbour Home,,true`,
      "catalog.csv",
      { now: new Date("2026-08-30T00:00:00.000Z") },
    );

    expect(audit.verdict).toBe("needs_work");
    expect(audit.blockedRows).toBe(2);
    expect(audit.adsEligibleRows).toBe(0);
    expect(audit.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        "invalid_url:link",
        "invalid_url:image_link",
        "availability_date_missing",
        "price",
        "brand_length",
        "identifier",
        "ads_eligibility",
        "duplicate_id",
        "availability",
      ]),
    );
    expect(JSON.stringify(audit)).not.toContain("Oak bench");
  });

  it("accepts the legacy Ads eligibility alias but warns to migrate", () => {
    const legacyHeader = header.replace("is_ads_eligible", "is_eligible_ads");
    const audit = auditProductFeedText(
      `${legacyHeader}\nSKU-1,Oak bench,Storage bench,https://shop.example/p/1,https://shop.example/1.jpg,in_stock,79.99 USD,Harbour Home,12345678,true`,
      "catalog.csv",
    );

    expect(audit.verdict).toBe("ready");
    expect(audit.issues).toEqual([
      expect.objectContaining({
        severity: "warning",
        code: "legacy_ads_eligibility",
      }),
    ]);
  });

  it("fails the file when required columns or supported formats are absent", () => {
    const missing = auditProductFeedText(
      "id,title\nSKU-1,Oak bench",
      "catalog.csv",
    );

    expect(missing.verdict).toBe("invalid");
    expect(missing.issues[0]).toMatchObject({ code: "missing_columns" });
    expect(() => auditProductFeedText("id\n1", "catalog.xlsx")).toThrow(
      "UTF-8 .csv, .tsv, or .txt",
    );
  });

  it("rejects unsafe limits and malformed quoted input", () => {
    expect(() =>
      auditProductFeedText(`${header}\n"unclosed`, "catalog.csv"),
    ).toThrow("unclosed quoted value");
    expect(() =>
      auditProductFeedText(`${header}\nrow`, "catalog.csv", {
        byteLength: PRODUCT_FEED_MAX_BYTES + 1,
      }),
    ).toThrow("up to 5 MB");
  });
});
