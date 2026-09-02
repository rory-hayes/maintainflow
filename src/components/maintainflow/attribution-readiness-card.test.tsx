import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AttributionReadinessCard } from "./attribution-readiness-card";
import { buildCampaignAttributionReadiness } from "@/lib/openai-ads/attribution-readiness";
import { demoCampaigns } from "@/lib/openai-ads/demo-data";

describe("AttributionReadinessCard", () => {
  it("shows prioritized simulator fixes without claiming attribution proof", () => {
    const markup = renderToStaticMarkup(
      <AttributionReadinessCard
        readiness={buildCampaignAttributionReadiness({
          campaigns: demoCampaigns,
        })}
        dataSource="demo"
      />,
    );

    expect(markup).toContain("Campaign-level URL tags");
    expect(markup).toContain("Simulator evidence");
    expect(markup).toContain("Fix before launch");
    expect(markup).toContain("Small-space living");
    expect(markup).toContain("Add a dynamic campaign identifier");
    expect(markup).toContain(
      "Campaign-level check, not effective-URL or attribution proof",
    );
    expect(markup).toContain("ad-group overrides");
    expect(markup).toContain("not an OpenAI rule");
  });
});
