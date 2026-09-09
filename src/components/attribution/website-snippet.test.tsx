// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { defaultMapping, emptyWorkspace } from "@/lib/attribution/model";
import { Websites } from "./setup";

it.each([
  'form[name="contact"]',
  "form[data-label='customer']",
  "#contact\\:form",
])(
  "generates executable confirmation code preserving selector %s",
  (selector) => {
    const workspace = emptyWorkspace("workspace", "Test", "local");
    workspace.sites = [
      {
        id: "site",
        name: "Website",
        origin: "https://example.test",
        adapter: "html",
        consent: "required",
        formSelector: selector,
        retentionDays: 90,
        paused: false,
        mapping: defaultMapping,
      },
    ];
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      <Websites w={workspace} act={vi.fn()} />,
    );
    const snippet = container.querySelector(".mc-code-block")!.textContent!;
    const form = document.createElement("form");
    const querySelector = vi.fn(() => form);
    const confirm = vi.fn();
    // Execute only the rendered example against synthetic objects, never the
    // real document or tracker, to verify JS quoting and selector round-tripping.
    const run = new Function("window", "document", snippet);
    run({ MaintainCode: { setConsent: vi.fn(), confirm } }, { querySelector });
    expect(querySelector).toHaveBeenCalledWith(selector);
    expect(confirm).toHaveBeenCalledWith(form);
  },
);
