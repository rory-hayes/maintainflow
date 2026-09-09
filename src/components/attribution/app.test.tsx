// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AttributionApp } from "./app";
import { defaultMapping, emptyWorkspace } from "@/lib/attribution/model";

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

it("updates the workspace selector immediately after a saved rename", async () => {
  const renamed = workspace("client-one", "Renamed client");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/attribution/workspaces") return list();
      if (init?.method === "POST") return response(renamed);
      return response(url.endsWith("client-two") ? second() : first());
    }),
  );
  await render();
  container.querySelector<HTMLInputElement>('input[name="name"]')!.value =
    renamed.name;
  await act(async () => button("Save settings").click());
  const selector = container.querySelector<HTMLSelectElement>(
    'select[aria-label="Workspace"]',
  )!;
  expect(selector.selectedOptions[0].textContent).toBe(renamed.name);
  expect(
    selector.querySelector('option[value="client-two"]')?.textContent,
  ).toBe("Second client");
  expect(selector.value).toBe(renamed.id);
  expect(container.textContent).toContain("Workspace updated.");
});

it("explains an external downgrade and lets the owner pause extra sites without deleting data", async () => {
  const downgraded = first();
  downgraded.sites = ["main-site", "extra-site"].map((id) => ({
    id,
    name: id,
    origin: "https://example.test",
    consent: "required",
    retentionDays: 90,
    adapter: "html",
    formSelector: "form",
    mapping: defaultMapping,
    paused: false,
  }));
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/attribution/workspaces") return list();
    if (init?.method === "POST") {
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({
        action: "pause",
        siteId: "main-site",
        paused: true,
      });
      downgraded.sites[0].paused = true;
    }
    return response(structuredClone(downgraded));
  });
  vi.stubGlobal("fetch", fetchMock);
  await render();
  expect(container.textContent).toContain("New tracking is suspended.");
  expect(container.textContent).toContain("Your saved data is unchanged.");
  expect(container.textContent).toContain("Pause extra websites");
  await act(async () => button("Manage active websites").click());
  await act(async () => button("Pause").click());
  expect(container.textContent).not.toContain("New tracking is suspended.");
  expect(container.textContent).toContain("main-site");
  expect(container.textContent).toContain("extra-site");
  expect(button("Resume")).toBeDefined();
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

function expectNoWorkspaceAccess() {
  expect(container.textContent).not.toContain("owner access");
  expect(container.textContent).not.toContain("Customer workspace");
  expect(container.querySelector('option[value="new"]')).toBeNull();
  expect(button("Create workspace")).toBeUndefined();
}

it("shows a signed-out shell after the live workspace endpoint rejects access", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        { error: "Sign in to open your workspace." },
        { status: 401 },
      ),
    ),
  );
  await act(async () => root.render(<AttributionApp initialLive />));
  expectNoWorkspaceAccess();
  expect(container.textContent).toContain("Signed out");
  expect(container.textContent).toContain("No workspace loaded");
  expect(container.querySelector('option[value="sample"]')).not.toBeNull();
  await select("sample");
  expect(container.textContent).toContain("Sample workspace");
  expect(container.textContent).toContain("Example data only");
});

it("does not invent workspace access while an authenticated list is loading or failed", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  await act(async () => root.render(<AttributionApp initialLive signedIn />));
  expectNoWorkspaceAccess();
  expect(container.textContent).toContain("Checking workspace access…");
  await act(async () =>
    finish(Response.json({ error: "Workspace unavailable." }, { status: 503 })),
  );
  expectNoWorkspaceAccess();
  expect(container.textContent).toContain("Workspace access unverified");
});

it("waits for the selected workspace before displaying its actual membership", async () => {
  let finish!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/attribution/workspaces"
        ? list()
        : new Promise<Response>((resolve) => {
            finish = resolve;
          }),
    ),
  );
  await act(async () => root.render(<AttributionApp initialLive signedIn />));
  expectNoWorkspaceAccess();
  const live = emptyWorkspace("client-one", "First client", "live");
  await act(async () =>
    finish(Response.json({ state: live, role: "analyst" })),
  );
  expect(container.textContent).toContain("analyst access");
  expect(container.textContent).toContain("Customer workspace");
  expect(container.textContent).not.toContain("owner access");
  expect(container.querySelector('option[value="new"]')).not.toBeNull();
});

it("does not show membership or client creation after a selected workspace fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/attribution/workspaces"
        ? list()
        : Response.json({ error: "Workspace unavailable." }, { status: 403 }),
    ),
  );
  await act(async () => root.render(<AttributionApp initialLive signedIn />));
  expectNoWorkspaceAccess();
  expect(container.textContent).toContain("Workspace access unverified");
});

it("keeps the verified list available to recover from a failed workspace selection", async () => {
  let finishFirst!: (value: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/attribution/workspaces") return list();
      if (url.endsWith("client-one")) {
        return new Promise<Response>((resolve) => {
          finishFirst = resolve;
        });
      }
      return Response.json({
        state: emptyWorkspace("client-two", "Second client", "live"),
        role: "admin",
      });
    }),
  );
  await act(async () => root.render(<AttributionApp initialLive signedIn />));
  expectNoWorkspaceAccess();
  expect(container.querySelector('option[value="client-two"]')).not.toBeNull();
  await act(async () =>
    finishFirst(
      Response.json({ error: "First client unavailable." }, { status: 403 }),
    ),
  );
  expectNoWorkspaceAccess();
  expect(container.querySelector('option[value="client-two"]')).not.toBeNull();
  await select("client-two");
  expect(container.textContent).toContain("admin access");
  expect(container.textContent).toContain("Customer workspace");
  expect(container.textContent).not.toContain("First client unavailable.");
  expect(new URL(location.href).searchParams.get("workspace")).toBe(
    "client-two",
  );
  expect(
    container.querySelector<HTMLSelectElement>(
      'select[aria-label="Workspace"]',
    )!.value,
  ).toBe("client-two");
});

it("allows a verified new customer to create their first workspace without claiming a role", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ workspaces: [] })),
  );
  await act(async () => root.render(<AttributionApp initialLive signedIn />));
  expect(button("Create workspace")).toBeDefined();
  expect(container.querySelector('option[value="new"]')).not.toBeNull();
  expect(container.textContent).not.toContain("owner access");
  expect(container.textContent).not.toContain("Customer workspace");
});
