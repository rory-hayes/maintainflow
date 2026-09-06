// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttributionApp } from "./app";
import { emptyWorkspace } from "@/lib/attribution/model";

let root: Root;
let container: HTMLDivElement;
const workspace = (id: string, name: string) =>
  emptyWorkspace(id, name, "local");
const first = () => workspace("client-one", "First client");
const second = () => workspace("client-two", "Second client");
const response = (state = first()) => Response.json({ state, role: "owner" });
const list = () =>
  Response.json({
    workspaces: [first(), second()].map((w) => ({
      id: w.id,
      name: w.name,
      role: "owner",
    })),
  });
async function render() {
  await act(async () =>
    root.render(
      <AttributionApp local initialLive initialView="Workspace & billing" />,
    ),
  );
}
async function select(value: string) {
  await act(async () => {
    const element = container.querySelector<HTMLSelectElement>(
      'select[aria-label="Workspace"]',
    )!;
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function button(label: string) {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  )!;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // React forms use the page's FormData implementation, not Node's fetch one.
  vi.stubGlobal("FormData", window.FormData);
  history.replaceState(null, "", "/app?mode=live&workspace=client-one");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("discards unsaved client settings when selecting a different workspace", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/attribution/workspaces") return list();
    if (init?.method === "POST") return response(second());
    return response(url.endsWith("client-two") ? second() : first());
  });
  vi.stubGlobal("fetch", fetchMock);
  await render();
  const oldName =
    container.querySelector<HTMLInputElement>('input[name="name"]')!;
  expect(oldName.value).toBe("First client");
  oldName.value = "Unsaved first-client edit";
  await select("client-two");
  const newName =
    container.querySelector<HTMLInputElement>('input[name="name"]')!;
  expect(newName.value).toBe("Second client");
  expect(newName).not.toBe(oldName);
  await act(async () => button("Save settings").click());
  const saved = fetchMock.mock.calls.find(
    ([, init]) => init?.method === "POST",
  )!;
  expect(saved[0]).toBe("/api/attribution/workspaces/client-two");
  expect(JSON.parse(saved[1]!.body as string).name).toBe("Second client");
});

it("keeps a newly created client selected in its refreshable URL", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST")
        return Response.json(workspace("client-new", "New client"));
      return url === "/api/attribution/workspaces" ? list() : response();
    }),
  );
  await render();
  await select("new");
  container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
    "New client";
  await act(async () => button("Create workspace").click());
  expect(new URL(location.href).searchParams.get("workspace")).toBe(
    "client-new",
  );
  expect(new URL(location.href).searchParams.get("mode")).toBe("live");
  expect(container.textContent).toContain(
    "From first visit to a won customer.",
  );
});

it("ignores a slow client response after the user returns to sample data", async () => {
  let resolveSecond!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/attribution/workspaces") return list();
      if (url.endsWith("client-two"))
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      return response();
    }),
  );
  await render();
  await select("client-two");
  await select("sample");
  await act(async () => resolveSecond(response(second())));
  expect(container.textContent).toContain("Sample data");
  expect(
    container.querySelector<HTMLSelectElement>(
      'select[aria-label="Workspace"]',
    )!.value,
  ).toBe("sample");
  expect(new URL(location.href).searchParams.has("workspace")).toBe(false);
  expect(container.textContent).not.toContain("Loading workspace");
});

it("does not apply an earlier workspace save after selecting another client", async () => {
  let finishSave!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/attribution/workspaces") return list();
      if (init?.method === "POST")
        return new Promise<Response>((resolve) => {
          finishSave = resolve;
        });
      return response(url.endsWith("client-two") ? second() : first());
    }),
  );
  await render();
  await act(async () => button("Save settings").click());
  await select("client-two");
  await act(async () => finishSave(response(first())));
  expect(
    container.querySelector<HTMLInputElement>('input[name="name"]')!.value,
  ).toBe("Second client");
  expect(new URL(location.href).searchParams.get("workspace")).toBe(
    "client-two",
  );
  expect(container.textContent).not.toContain("Workspace updated.");
});
