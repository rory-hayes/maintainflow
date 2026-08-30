import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { demoAds } from "@/lib/openai-ads/demo-data";

import { CreativeReviewTable } from "./creative-review-table";

function textContent(markup: string) {
  return markup
    .replace(/<[^>]*>/g, " ")
    .replace(/<!-- -->/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("creative review table", () => {
  it("surfaces provider diagnostics and evidence in the default watchlist", () => {
    const html = renderToStaticMarkup(<CreativeReviewTable ads={demoAds} />);
    const text = textContent(html);

    expect(text).toContain(
      "Provider reasons, screenshots, appeals, and serving issues are shown when returned.",
    );
    expect(text).toContain("Allow the OpenAI crawler");
    expect(text).toContain("Robots Txt");
    expect(text).toContain("Provider screenshot");
    expect(html).toContain(
      'href="https://cdn.openai.com/ads/reviews/ad_505.png"',
    );
  });
});
