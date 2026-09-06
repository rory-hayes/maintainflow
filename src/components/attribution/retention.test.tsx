// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultMapping, emptyWorkspace } from "@/lib/attribution/model";

vi.mock("./notification-settings", () => ({ NotificationSettings: () => null }));
import { Settings } from "./setup";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  { saved: 7, site: undefined, expected: "7" },
  { saved: 7, site: 90, expected: "7" },
  { saved: undefined, site: 14, expected: "14" },
  { saved: undefined, site: undefined, expected: "90" },
])("shows the saved or legacy retention default: %j", async ({ saved, site, expected }) => {
  const w = emptyWorkspace("workspace", "Test", "local");
  w.retentionDays = saved;
  if (site !== undefined) w.sites = [{
    id: "site", name: "Website", origin: "https://example.test",
    consent: "required", adapter: "html", formSelector: "form",
    mapping: defaultMapping, paused: false, retentionDays: site,
  }];
  await act(async () => root.render(<Settings w={w} act={vi.fn()} />));
  expect(container.querySelector<HTMLInputElement>('input[name="retention"]')?.value).toBe(expected);
});
