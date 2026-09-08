// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyWorkspace, type Workspace } from "@/lib/attribution/model";
import { sampleWorkspace } from "@/lib/attribution/sample";
import { Reporting } from "./reporting";

let root: Root;
let container: HTMLDivElement;
let exported: Blob | undefined;
const originalCreate = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
const originalRevoke = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-09-08T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  exported = undefined;
  Object.defineProperties(URL, {
    createObjectURL: {
      configurable: true,
      value: (body: Blob) => {
        exported = body;
        return "blob:report-download";
      },
    },
    revokeObjectURL: { configurable: true, value: vi.fn() },
  });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [key, descriptor] of [
    ["createObjectURL", originalCreate],
    ["revokeObjectURL", originalRevoke],
  ] as const) {
    if (descriptor) Object.defineProperty(URL, key, descriptor);
    else Reflect.deleteProperty(URL, key);
  }
});

async function render(w: Workspace, campaigns = false) {
  await act(async () => {
    root.render(
      <Reporting
        w={w}
        campaigns={campaigns}
        onLead={() => {}}
        onView={() => {}}
      />,
    );
  });
}

function metric(label: string) {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(".mc-metrics button"),
  ].find((button) => button.querySelector("span")?.textContent === label)!;
}

async function select(label: string, value: string) {
  await act(async () => {
    const input = container.querySelector<HTMLSelectElement>(
      `select[aria-label="${label}"]`,
    )!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function exportCSV() {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Export report",
  )!;
  await act(async () => button.click());
  expect(exported).toBeDefined();
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsText(exported!);
  });
  // These controlled sample cells contain no embedded commas or line breaks.
  return text
    .split("\n")
    .map((line) =>
      line.split(",").map((cell) => cell.slice(1, -1).replaceAll('""', '"')),
    );
}

it.each([false, true])(
  "shows the full opportunity funnel and contributing deal IDs (campaigns=%s)",
  async (campaigns) => {
    const w = sampleWorkspace();
    await render(w, campaigns);
    expect(metric("Enquiries").querySelector("strong")?.textContent).toBe(
      "128",
    );
    expect(metric("Qualified leads").querySelector("strong")?.textContent).toBe(
      "42",
    );
    expect(metric("Opportunities").querySelector("strong")?.textContent).toBe(
      "25",
    );
    expect(metric("Won deals").querySelector("strong")?.textContent).toBe("12");
    expect(
      metric("Booked deal value").querySelector("strong")?.textContent,
    ).toBe("€38,400");
    const headers = [...container.querySelectorAll("thead th")].map(
      (th) => th.textContent,
    );
    const index = headers.indexOf("Opportunities");
    expect(index).toBeGreaterThan(-1);
    expect(
      [...container.querySelectorAll("tbody tr")].map((row) =>
        Number(row.children[index].textContent),
      ),
    ).toEqual([9, 5, 5, 4, 2]);
    await act(async () => metric("Opportunities").click());
    const evidence = container.querySelector('[aria-label="Report evidence"]')!;
    expect(evidence.textContent).toContain("across all stages and currencies");
    const openDeal = w.deals.find((deal) => !deal.closedAt)!;
    expect(evidence.textContent).toContain(openDeal.id);
    expect(evidence.textContent).toContain("distinct opportunities");
  },
);

it("keeps UI and CSV opportunity counts aligned across currency, period and model changes", async () => {
  const w = sampleWorkspace();
  await render(w, true);
  await select("Currency", "USD");
  expect(metric("Opportunities").querySelector("strong")?.textContent).toBe(
    "25",
  );
  expect(metric("Won deals").querySelector("strong")?.textContent).toBe("0");
  await select("Reporting period", "sales");
  await select("Attribution model", "latest");
  expect(metric("Opportunities").querySelector("strong")?.textContent).toBe(
    "17",
  );
  expect(
    container.querySelector(".mc-report-definition")?.textContent,
  ).toContain("deals without a close date are excluded");
  const [headers, ...rows] = await exportCSV();
  expect(headers).toEqual([
    "data_mode",
    "channel",
    "campaign_id",
    "enquiries",
    "qualified_contacts",
    "opportunities",
    "won_deals",
    "booked_value",
    "currency",
    "observed_spend",
    "model",
    "period",
    "from",
    "to",
  ]);
  const at = (row: string[], key: string) => row[headers.indexOf(key)];
  expect(
    rows.reduce((sum, row) => sum + Number(at(row, "opportunities")), 0),
  ).toBe(17);
  expect(
    rows.every(
      (row) =>
        at(row, "currency") === "USD" &&
        at(row, "model") === "latest" &&
        at(row, "period") === "sales" &&
        at(row, "won_deals") === "0" &&
        at(row, "booked_value") === "0",
    ),
  ).toBe(true);

  // Overview has no reporting-period control and must not retain a hidden
  // calendar filter from the Campaigns view of the same component.
  await render(w, false);
  expect(metric("Opportunities").querySelector("strong")?.textContent).toBe(
    "25",
  );
  const [overviewHeaders, ...overviewRows] = await exportCSV();
  expect(
    overviewRows.every(
      (row) => row[overviewHeaders.indexOf("period")] === "cohort",
    ),
  ).toBe(true);
  expect(
    overviewRows.reduce(
      (sum, row) => sum + Number(row[overviewHeaders.indexOf("opportunities")]),
      0,
    ),
  ).toBe(25);
});

it("shows zero opportunities and exports no fabricated rows for an empty live workspace", async () => {
  await render(emptyWorkspace("owned-empty", "Empty live workspace", "live"));
  expect(metric("Opportunities").querySelector("strong")?.textContent).toBe(
    "0",
  );
  const csv = await exportCSV();
  expect(csv).toHaveLength(1);
  expect(csv[0]).toContain("opportunities");
});
