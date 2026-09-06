// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installTracker } from "./tracker";
import { defaultMapping } from "./model";
let tracker: ReturnType<typeof installTracker>;
const config = () => ({
  siteId: "site",
  endpoint: location.origin,
  origin: location.origin,
  consent: "required" as const,
  retentionDays: 90,
  formSelector: "form[data-attribution]",
  adapter: "html" as const,
  mapping: defaultMapping,
});
const form = () => document.querySelector("form")!;
beforeEach(() => {
  const memory = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    get length() {
      return memory.size;
    },
    clear: () => memory.clear(),
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => memory.set(k, v),
    removeItem: (k: string) => memory.delete(k),
  });
  localStorage.clear();
  history.replaceState(
    null,
    "",
    "/?utm_source=google&utm_medium=cpc&utm_campaign=first",
  );
  document.body.innerHTML =
    '<form id="demo" data-attribution><input name="email" value="never-collected@example.test"><input name="manual" value="preserve"><button>Send</button></form>';
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ received: true }, { status: 202 })),
  );
});
afterEach(() => {
  tracker?.destroy();
  delete window.HubSpotFormsV4;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("fail-open HTML adapter", () => {
  it("retains failed delivery through navigation and requires renewed consent before retry", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("offline"));
    tracker = installTracker(config());
    tracker.setConsent(true);
    tracker.confirm(form());
    await new Promise((r) => setTimeout(r, 0));
    const first = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    tracker.destroy();
    history.replaceState(null, "", "/thanks");
    vi.mocked(fetch)
      .mockClear()
      .mockResolvedValue(Response.json({ received: true }));
    tracker = installTracker(config());
    expect(fetch).not.toHaveBeenCalled();
    tracker.setConsent(true);
    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 0));
    const retry = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(retry).toEqual(first);
    expect(localStorage.getItem("mc_delivery:site")).toBeNull();
  });
  it("does not lose a confirmation when an older attempt completes in flight", async () => {
    let complete!: (response: Response) => void;
    vi.mocked(fetch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    tracker = installTracker(config());
    tracker.setConsent(true);
    form().dispatchEvent(new Event("submit", { bubbles: true }));
    tracker.confirm(form());
    form().dispatchEvent(new Event("submit", { bubbles: true }));
    complete(Response.json({ received: true }));
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(sent.map((item) => item.status)).toEqual(["attempted", "confirmed"]);
    expect(sent[1].id).toBe(sent[0].id);
    expect(sent[1].at).toBe(sent[0].at);
  });
  it("keeps submission evidence stable when the page source changes before confirmation", async () => {
    tracker = installTracker(config());
    tracker.setConsent(true);
    form().dispatchEvent(new Event("submit", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    history.replaceState(null, "", "/?utm_source=mail&utm_medium=email");
    tracker.refresh();
    tracker.confirm(form());
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(sent[1].evidence).toEqual(sent[0].evidence);
  });
  it("discards terminal failures so another form can deliver its valid record", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 400 }));
    tracker = installTracker(config());
    tracker.setConsent(true);
    tracker.confirm(form());
    await new Promise((r) => setTimeout(r, 0));
    const second = document.createElement("form");
    second.id = "second";
    second.setAttribute("data-attribution", "");
    document.body.appendChild(second);
    tracker.refresh();
    tracker.confirm(second);
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(sent.map((item) => item.formId)).toEqual(["demo", "second"]);
    expect(localStorage.getItem("mc_delivery:site")).toBeNull();
  });
  it("backs off retryable errors without blocking later captures", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429 }));
    tracker = installTracker(config());
    tracker.setConsent(true);
    tracker.confirm(form());
    await new Promise((r) => setTimeout(r, 0));
    tracker.newSubmission(form());
    tracker.confirm(form());
    await new Promise((r) => setTimeout(r, 0));
    const sent = vi
      .mocked(fetch)
      .mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(sent).toHaveLength(2);
    expect(sent[1].id).not.toBe(sent[0].id);
    expect(JSON.parse(localStorage.getItem("mc_delivery:site")!)).toHaveLength(
      1,
    );
  });
  it("aborts in-flight collection and clears durable retries on consent withdrawal", async () => {
    vi.mocked(fetch).mockImplementation(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request!.signal!.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    tracker = installTracker(config());
    tracker.setConsent(true);
    tracker.confirm(form());
    const request = vi.mocked(fetch).mock.calls[0][1]!;
    tracker.setConsent(false);
    expect(request.signal!.aborted).toBe(true);
    expect(localStorage.length).toBe(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(localStorage.length).toBe(0);
  });
  it("does not read, fill, store or transmit attribution before consent", () => {
    tracker = installTracker(config());
    expect(form().querySelector('[name="mc_first_source"]')).toBeNull();
    form().dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });
  it("fills dedicated hidden fields and preserves first source across direct navigation", () => {
    tracker = installTracker(config());
    tracker.setConsent(true);
    expect(
      form().querySelector<HTMLInputElement>('[name="mc_first_source"]')!.value,
    ).toBe("google");
    history.replaceState(null, "", "/contact");
    tracker.refresh();
    expect(
      form().querySelector<HTMLInputElement>('[name="mc_first_source"]')!.value,
    ).toBe("google");
    expect(
      form().querySelector<HTMLInputElement>('[name="mc_latest_source"]')!
        .value,
    ).toBe("google");
    expect(
      form().querySelector<HTMLInputElement>('[name="manual"]')!.value,
    ).toBe("preserve");
  });
  it("does not prevent form submission when delivery fails and retries the same ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network unavailable")),
    );
    tracker = installTracker(config());
    tracker.setConsent(true);
    const event = new Event("submit", { bubbles: true, cancelable: true });
    form().dispatchEvent(event);
    await new Promise((r) => setTimeout(r, 0));
    expect(event.defaultPrevented).toBe(false);
    const first = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    expect(first.status).toBe("attempted");
    expect(JSON.stringify(first)).not.toContain("never-collected");
    window.dispatchEvent(new Event("online"));
    await new Promise((r) => setTimeout(r, 0));
    const retry = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
    expect(retry.id).toBe(first.id);
  });
  it("confirms only from success callback and withdrawal clears fields and collection", async () => {
    tracker = installTracker(config());
    tracker.setConsent(true);
    tracker.confirm(form());
    await new Promise((r) => setTimeout(r, 0));
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).status,
    ).toBe("confirmed");
    tracker.setConsent(false);
    expect(localStorage.length).toBe(0);
    expect(
      form().querySelector<HTMLInputElement>('[name="mc_first_source"]')!.value,
    ).toBe("");
    vi.mocked(fetch).mockClear();
    tracker.confirm(form());
    expect(fetch).not.toHaveBeenCalled();
  });
  it("continues filling when browser storage is unavailable", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    tracker = installTracker(config());
    expect(() => tracker.setConsent(true)).not.toThrow();
    expect(
      form().querySelector<HTMLInputElement>('[name="mc_first_source"]')!.value,
    ).toBe("google");
  });
  it("leaves visible mapped inputs untouched", () => {
    document.body.innerHTML =
      '<form data-attribution><input name="mc_first_source" value="manual correction"></form>';
    tracker = installTracker(config());
    tracker.setConsent(true);
    expect(form().querySelector<HTMLInputElement>("input")!.value).toBe(
      "manual correction",
    );
  });
});
describe("documented HubSpot V4 adapter", () => {
  it("does not clear a manual source correction when consent is withdrawn", async () => {
    const fields = new Map<string, string[]>();
    const hs = {
      getFormId: () => "hs-form",
      getInstanceId: () => "instance",
      setFieldValue: (name: string, value: string[]) => {
        fields.set(name, value);
      },
      getFieldValue: async (name: string) => fields.get(name) ?? [],
    };
    window.HubSpotFormsV4 = {
      getForms: () => [hs],
      getFormFromEvent: () => hs,
    };
    tracker = installTracker({ ...config(), adapter: "hubspot_v4" });
    tracker.setConsent(true);
    await new Promise((r) => setTimeout(r, 0));
    fields.set("0-1/mc_first_source", ["manual correction"]);
    tracker.setConsent(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fields.get("0-1/mc_first_source")).toEqual(["manual correction"]);
    expect(fields.get("0-1/mc_latest_source")).toEqual([]);
  });
  it("sets mapped hidden fields through public methods and records success once with stable identity", async () => {
    const set = vi.fn();
    const hs = {
      getFormId: () => "hs-form",
      getInstanceId: () => "instance",
      setFieldValue: set,
      getFieldValue: async () => [],
    };
    window.HubSpotFormsV4 = {
      getForms: () => [hs],
      getFormFromEvent: () => hs,
    };
    tracker = installTracker({ ...config(), adapter: "hubspot_v4" });
    tracker.setConsent(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(set).toHaveBeenCalledWith("0-1/mc_first_source", ["google"]);
    window.dispatchEvent(
      new CustomEvent("hs-form-event:on-submission:success"),
    );
    await new Promise((r) => setTimeout(r, 0));
    const first = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
    window.dispatchEvent(
      new CustomEvent("hs-form-event:on-submission:success"),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(
      JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string).id,
    ).toBe(first.id);
    expect(first.formId).toBe("hs-form");
  });
});

it("preserves a manual correction to a tracker-populated source", () => {
  tracker = installTracker(config());
  tracker.setConsent(true);
  const source = form().querySelector<HTMLInputElement>(
    '[name="mc_first_source"]',
  )!;
  source.value = "Sales correction";
  tracker.refresh();
  expect(source.value).toBe("Sales correction");
});
it("uses a new identity only when a form is explicitly reset for another enquiry", () => {
  tracker = installTracker(config());
  tracker.setConsent(true);
  const field = () =>
    form().querySelector<HTMLInputElement>('[name="mc_submission_id"]')!.value;
  const first = field();
  tracker.refresh();
  expect(field()).toBe(first);
  tracker.newSubmission(form());
  expect(field()).not.toBe(first);
});
it("does not overwrite prepopulated HubSpot first source", async () => {
  const set = vi.fn();
  const hs = {
    getFormId: () => "hs",
    getInstanceId: () => "instance",
    setFieldValue: set,
    getFieldValue: async (name: string) =>
      name.endsWith("mc_first_source") ? ["manual"] : [],
  };
  window.HubSpotFormsV4 = { getForms: () => [hs], getFormFromEvent: () => hs };
  tracker = installTracker({ ...config(), adapter: "hubspot_v4" });
  tracker.setConsent(true);
  await new Promise((r) => setTimeout(r, 0));
  expect(set.mock.calls.some((call) => call[0] === "0-1/mc_first_source")).toBe(
    false,
  );
});
