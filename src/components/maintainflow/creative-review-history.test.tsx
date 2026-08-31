import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CreativeReviewHistory } from "@/components/maintainflow/creative-review-history";
import { demoCreativeReviewEvents } from "@/lib/openai-ads/demo-data";

describe("creative review history", () => {
  it("renders deterministic UTC timestamps for server hydration", () => {
    const html = renderToStaticMarkup(
      <CreativeReviewHistory
        events={demoCreativeReviewEvents}
        dataSource="demo"
        ready
      />,
    );

    expect(html).toContain("29 Aug 2026, 14:20 UTC");
    expect(html).not.toContain("29 Aug 2026 at 14:20");
    expect(html).not.toContain("UTC UTC");
  });
});
