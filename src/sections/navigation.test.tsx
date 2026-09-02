import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Navigation from "./navigation";

describe("landing navigation", () => {
  it("uses a semantic list and a single interactive element for the demo link", () => {
    const html = renderToStaticMarkup(<Navigation />);

    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("How it works");
    expect(html).toContain("API readiness");
    expect(html).toMatch(/<a[^>]*>Open demo<\/a>/);
    expect(html).not.toMatch(/<a[^>]*>\s*<button/);
  });
});
