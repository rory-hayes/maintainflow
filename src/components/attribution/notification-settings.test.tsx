// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NotificationSettings } from "./notification-settings";
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
const render = (mode = "live") =>
  act(async () =>
    root.render(
      <NotificationSettings workspaceId="workspace-id" mode={mode} />,
    ),
  );
it("labels sample email reports unavailable and does not call an account API", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await render("sample");
  expect(fetch).not.toHaveBeenCalled();
  expect(container.textContent).toContain("verified customer account");
});
it("shows default-off preferences for the verified recipient and saves explicit choices", async () => {
  const status = {
    available: true,
    canEnable: true,
    recipient: "verified@example.test",
    health: false,
    weekly: false,
    status: "off",
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(status))
    .mockResolvedValueOnce(
      Response.json({ ...status, health: true, status: "scheduled" }),
    );
  vi.stubGlobal("fetch", fetch);
  await render();
  const checkbox = container.querySelector<HTMLInputElement>(
    'input[type="checkbox"]',
  )!;
  expect(checkbox.checked).toBe(false);
  expect(container.textContent).toContain(status.recipient);
  await act(async () => checkbox.click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>("button")!.click(),
  );
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
    health: true,
    weekly: false,
    resume: false,
  });
  expect(container.textContent).toContain("Email preferences saved");
});
it("keeps opt-out usable without mail configuration and offers deliberate uncertainty recovery", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({
          available: false,
          canEnable: true,
          recipient: "verified@example.test",
          health: true,
          weekly: false,
          status: "needs_review",
        }),
      ),
  );
  await render();
  const inputs = container.querySelectorAll<HTMLInputElement>(
    'input[type="checkbox"]',
  );
  expect(inputs[0].disabled).toBe(false);
  expect(inputs[1].disabled).toBe(true);
  expect(container.textContent).toContain(
    "Automatic retries stopped to avoid duplicates",
  );
  expect(container.textContent).toContain("not configured yet");
});
