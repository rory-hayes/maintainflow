import { expect, test, type Page } from "@playwright/test";

const agencyEntryPath = "/app?tab=campaigns&account=adacct_sim_northstar";

function collectBrowserErrors(page: Page) {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  return errors;
}

test("landing page opens the five-client agency portfolio", async ({ page }) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/");
  const agencyPortfolioLink = page.getByRole("link", {
    name: "Explore the five-client agency portfolio",
  });
  await expect(agencyPortfolioLink).toHaveAttribute("href", agencyEntryPath);
  await agencyPortfolioLink.press("Enter");

  await expect(page).toHaveURL((url) => {
    return (
      url.pathname === "/app" &&
      url.searchParams.get("tab") === "campaigns" &&
      url.searchParams.get("account") === "adacct_sim_northstar"
    );
  });
  await expect(
    page.getByText("Simulator data", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Campaign health" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Ad account" }),
  ).toContainText("Northstar Home");
  expect(browserErrors).toEqual([]);
});

test("agency operator can switch between isolated advertiser fixtures", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto(agencyEntryPath);
  await page.getByRole("combobox", { name: "Ad account" }).click();
  await page.getByRole("option", { name: "Alder & Ash" }).click();

  await expect(page).toHaveURL((url) => {
    return url.searchParams.get("account") === "adacct_sim_alder";
  });
  await expect(
    page.getByRole("combobox", { name: "Ad account" }),
  ).toContainText("Alder & Ash");
  await expect(
    page.getByText("Entryway storage", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Modular storage");
  expect(browserErrors).toEqual([]);
});

test("simulator approval is local-only and reload restores the fixture", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const mutationRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/ads/recommendations/apply"
    ) {
      mutationRequests.push(request.url());
    }
  });

  await page.goto("/app?tab=review&account=adacct_sim_northstar");
  await page.getByRole("button", { name: "Approve in simulator" }).click();

  const approvalDialog = page.getByRole("dialog", {
    name: "Approve this change?",
  });
  await expect(approvalDialog).toContainText(
    "This is a simulator action. No external write will be made.",
  );
  await approvalDialog
    .getByRole("button", { name: "Record simulator approval" })
    .click();

  await expect(
    page.getByRole("button", { name: "Monitoring", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Simulator approval recorded", { exact: true }),
  ).toBeVisible();
  expect(mutationRequests).toEqual([]);

  await page.reload();
  await expect(
    page.getByRole("button", { name: "Approve in simulator" }),
  ).toBeVisible();
  expect(mutationRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("unknown deep links fall back to the direct simulator safely", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/app?tab=billing&account=adacct_not_a_fixture");

  await expect(
    page.getByRole("combobox", { name: "Ad account" }),
  ).toContainText("Harbour Home Ireland");
  await expect(page.getByRole("tab", { name: /^Review/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("main")).not.toContainText(
    "adacct_not_a_fixture",
  );
  expect(browserErrors).toEqual([]);
});

test("agency portfolio remains operable at a 390 by 844 viewport", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(agencyEntryPath);
  const mobileAccount = page.getByRole("combobox", {
    name: "Mobile ad account",
  });
  await expect(mobileAccount).toContainText("Northstar Home");
  await mobileAccount.click();
  await page.getByRole("option", { name: "Nook Living" }).click();

  await expect(page).toHaveURL((url) => {
    return url.searchParams.get("account") === "adacct_sim_nook";
  });
  await expect(
    page.getByRole("combobox", { name: "Mobile ad account" }),
  ).toContainText("Nook Living");
  await page.getByRole("tab", { name: "Readiness" }).click();
  await expect(
    page.getByRole("heading", {
      name: "Is your commerce stack ready for ChatGPT?",
    }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("storefront sample demonstrates a report without making a network audit", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const auditRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/readiness/audit"
    ) {
      auditRequests.push(request.url());
    }
  });

  await page.goto("/app?tab=readiness");
  await page.getByRole("button", { name: "Load sample audit" }).click();

  await expect(
    page.getByRole("heading", { name: "Illustrative storefront result" }),
  ).toBeVisible();
  await expect(page.getByText("91/100", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Product structured data", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download client report" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^maintainflow-readiness-harbourhome-example-\d{4}-\d{2}-\d{2}\.html$/,
  );
  expect(auditRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
