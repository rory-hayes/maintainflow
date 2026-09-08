import { chromium } from "playwright";
import { expect } from "@playwright/test";
import { verifyUnsubscribeNativeForm } from "./verify-maintaincode-unsubscribe.mjs";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1536, height: 1024 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
try {
  await verifyUnsubscribeNativeForm(browser, "http://127.0.0.1:3217");
  await page.goto("http://127.0.0.1:3217/app");
  await expect(
    page.getByRole("button", { name: "Enquiries 128", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Opportunities 25", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Won deals 12", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/maintaincode-desktop-verified.png" });
  await page
    .getByRole("button", { name: "Enquiries 128", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "lead-0001", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Leads", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search leads" })
    .fill("no-match-for-qa");
  await expect(
    page.getByText("No leads match this view.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search leads" }).fill("lead-0081");
  await expect(page.locator("tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "lead-0081", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Acquisition timeline" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/maintaincode-lead-verified.png" });
  for (const name of [
    "Campaigns",
    "Websites & forms",
    "Tracking health",
    "Integrations",
    "Setup",
    "Workspace & billing",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator("h1")).toBeVisible();
    console.log(name + ": rendered");
  }
  await page.getByRole("button", { name: "Campaigns", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Attribution model", exact: true })
    .selectOption("latest");
  await page
    .getByRole("combobox", { name: "Reporting period", exact: true })
    .selectOption("sales");
  await page
    .getByRole("combobox", { name: "Currency", exact: true })
    .selectOption("USD");
  await expect(
    page.getByRole("button", { name: "Booked deal value US$0", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Opportunities 17", exact: true }),
  ).toBeVisible();
  await page
    .getByText("How opportunities are counted", { exact: true })
    .click();
  await expect(
    page.getByText(/deals without a close date are excluded/).first(),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export report", exact: true })
    .click();
  const exported = await download;
  const stream = await exported.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const [headers, ...rows] = Buffer.concat(chunks)
    .toString("utf8")
    .split("\n")
    .map((line) =>
      [...line.matchAll(/"(?:[^"]|"")*"/g)].map(([cell]) =>
        cell.slice(1, -1).replaceAll('""', '"'),
      ),
    );
  const opportunityIndex = headers.indexOf("opportunities");
  expect(opportunityIndex).toBeGreaterThan(-1);
  expect(
    rows.reduce((sum, row) => sum + Number(row[opportunityIndex]), 0),
  ).toBe(17);
  expect(
    rows.every((row) =>
      row[headers.indexOf("opportunity_definition")].includes("CRM close date"),
    ),
  ).toBe(true);
  console.log("Export:", exported.suggestedFilename(), "17 opportunities");
  await page.getByRole("button", { name: "Overview", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Opportunities 25", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: "/tmp/maintaincode-mobile-opportunities-verified.png",
  });
  await expect(
    page.getByRole("button", { name: "Toggle navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: "Leads", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "Search leads" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  await page.screenshot({ path: "/tmp/maintaincode-mobile-verified.png" });
  await page.getByRole("textbox", { name: "Search leads" }).focus();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("combobox", { name: "Filter channel" }),
  ).toBeFocused();
  expect(errors).toEqual([]);
  console.log(
    "PASS: sample evidence, filters, detail, six views, models, currency, export, mobile, keyboard; no page errors.",
  );
} finally {
  await browser.close();
}
