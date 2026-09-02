import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

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

  await page.goto("/", { waitUntil: "networkidle" });
  const agencyPortfolioLink = page.getByRole("link", {
    name: "Explore the five-client agency portfolio",
  });
  await expect(agencyPortfolioLink).toHaveAttribute("href", agencyEntryPath);
  await expect(
    page.getByRole("link", { name: "Apply for an agency pilot" }),
  ).toHaveAttribute(
    "href",
    /^mailto:support@maintainflow\.test\?subject=MaintainFlow%20agency%20pilot&body=/,
  );
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
  await expect(page.getByText("Budget Guard", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Projected overspend", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/applicable seven-day spending limit/i),
  ).toBeVisible();
  await expect(
    page.getByText("Confirmed spending limits", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Critical pacing risk", { exact: true }).first(),
  ).toBeVisible();
  const campaignScopedAction = page.getByRole("link", {
    name: "Review campaign row",
  });
  await expect(campaignScopedAction).toHaveAttribute(
    "href",
    "#budget-campaign-cmpn_northstar_101",
  );
  await campaignScopedAction.click();
  await expect(page).toHaveURL(/#budget-campaign-cmpn_northstar_101$/);
  await expect(
    page.locator("#budget-campaign-cmpn_northstar_101"),
  ).toBeInViewport();
  await expect(
    page.getByText("Agency exception queue", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("5 client accounts", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Ad account", exact: true }),
  ).toContainText("Northstar Home");
  expect(browserErrors).toEqual([]);
});

test("simulator exposes actionable attribution and monitoring evidence", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/app?tab=readiness&account=adacct_sim_northstar");
  await expect(
    page.getByText("Campaign-level URL tags", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Campaign template needs attention", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Campaign-level check, not effective-URL or attribution proof",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByText(/ad url, ad, and ad-group overrides are more specific/i),
  ).toBeVisible();
  await expect(
    page.getByText("Fix before launch", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Add a dynamic campaign identifier", { exact: true }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Experiments" }).click();
  await expect(page.getByText("Sample outcome", { exact: true })).toHaveCount(2);
  await expect(
    page.getByText("Within safeguard", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Rollback review", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(/no rollback or other external action was taken/i).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Client change assurance report" }),
  ).toBeVisible();
  await expect(page.getByText("Simulator evidence", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Durable approval history" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Illustrative approvals, rollback requests, monitoring/i),
  ).toBeVisible();

  const assuranceDownloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download assurance report" })
    .click();
  const assuranceDownload = await assuranceDownloadPromise;
  expect(assuranceDownload.suggestedFilename()).toMatch(
    /^maintainflow-change-assurance-northstar-home-\d{4}-\d{2}-\d{2}\.html$/,
  );
  const assurancePath = await assuranceDownload.path();
  expect(assurancePath).not.toBeNull();
  const assuranceHtml = await readFile(assurancePath!, "utf8");
  expect(assuranceHtml).toContain("SIMULATOR — NOT LIVE EVIDENCE");
  expect(assuranceHtml).toContain("Operator attention is still required");
  expect(assuranceHtml).toContain("Exact approved request");
  expect(assuranceHtml).not.toContain("demo-agency-operator");
  expect(browserErrors).toEqual([]);
});

test("agency exception queue opens the selected advertiser deep link", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto(agencyEntryPath);
  const alderRow = page.getByRole("row", { name: /Alder & Ash/ });
  await expect(alderRow).toContainText("Review needed");
  await alderRow.getByRole("button", { name: "Open account" }).click();

  await expect(page).toHaveURL((url) => {
    return (
      url.pathname === "/app" &&
      url.searchParams.get("tab") === "campaigns" &&
      url.searchParams.get("account") === "adacct_sim_alder"
    );
  });
  await expect(
    page.getByRole("combobox", { name: "Ad account", exact: true }),
  ).toContainText("Alder & Ash");
  const selectedAlderRow = page.getByRole("row", { name: /Alder & Ash/ });
  await expect(
    selectedAlderRow.getByRole("button", { name: "Current" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Entryway storage", { exact: true }).first(),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("agency operator can switch between isolated advertiser fixtures", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto(agencyEntryPath);
  await page
    .getByRole("combobox", { name: "Ad account", exact: true })
    .click();
  await page.getByRole("option", { name: "Alder & Ash" }).click();

  await expect(page).toHaveURL((url) => {
    return url.searchParams.get("account") === "adacct_sim_alder";
  });
  await expect(
    page.getByRole("combobox", { name: "Ad account", exact: true }),
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
  await expect(
    approvalDialog.getByRole("heading", { name: "Approve this change?" }),
  ).toBeFocused();
  await expect(approvalDialog).toContainText(
    "This is a simulator action. No external write will be made.",
  );
  await expect(approvalDialog).toContainText("Simulator approval only");
  await expect(approvalDialog).toContainText("Northstar Home");
  await expect(approvalDialog).toContainText("adacct_sim_northstar");
  await expect(approvalDialog).toContainText("API request");
  await expect(approvalDialog).toContainText("Stored rollback");
  await expect(approvalDialog).toContainText(
    "Safeguard and human rollback review",
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

  await page.getByRole("tab", { name: "Experiments" }).click();
  await expect(
    page.getByRole("row", { name: /Lower the CPA bid by 20%/ }).first(),
  ).toContainText("Applied");
  await expect(
    page.getByRole("button", { name: "Download assurance report" }),
  ).toBeEnabled();

  await page.getByRole("tab", { name: /^Review/ }).click();
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
    page.getByRole("combobox", { name: "Ad account", exact: true }),
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

test("mobile landing keeps the primary readiness action in view without overflow", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: /Deploy every ChatGPT Ads change/ }),
  ).toBeVisible();
  const primaryAction = page.getByRole("link", {
    name: "Audit your store · no Ads key",
  });
  await expect(primaryAction).toBeVisible();
  await expect(primaryAction).toBeInViewport({ ratio: 1 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(browserErrors).toEqual([]);
});

test("workspace labels every roadmap connection as future work", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/app?tab=workspace&account=adacct_sim_northstar");
  await expect(
    page.getByText("Connection roadmap", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/none are presented as connected before a paid design partner/i),
  ).toBeVisible();
  await expect(page.getByText("Shopify", { exact: true })).toBeVisible();
  await expect(page.getByText("Next connector", { exact: true })).toBeVisible();
  await expect(page.getByText("Google Ads", { exact: true })).toBeVisible();
  await expect(page.getByText("Meta Ads", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Design-partner gate", { exact: true }),
  ).toHaveCount(2);
  await expect(page.getByText("Slack / Teams", { exact: true })).toBeVisible();
  await expect(page.getByText("Planned", { exact: true })).toBeVisible();
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
  await expect(page.getByText("Storefront page score")).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: "Storefront page score" }),
  ).toHaveAttribute("aria-valuenow", "91");
  await expect(page.getByText("91/100", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Sample data", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Product structured data", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Open page" })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download partial report" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    /^maintainflow-partial-readiness-harbourhome-example-\d{4}-\d{2}-\d{2}\.html$/,
  );
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  const reportHtml = await readFile(downloadedPath!, "utf8");
  expect(reportHtml).toContain('class="partial-report"');
  expect(reportHtml).toContain("Partial report");
  expect(reportHtml).toContain("3 sections remain untested");
  expect(auditRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test("public, legal, and closed-access surfaces render deployment truth", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);

  await page.goto("/", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: /Deploy every ChatGPT Ads change/ }),
  ).toBeVisible();

  await page.goto("/privacy", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Privacy at MaintainFlow" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "privacy@maintainflow.test" }),
  ).toHaveAttribute("href", "mailto:privacy@maintainflow.test");

  await page.goto("/terms", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "MaintainFlow service terms" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "support@maintainflow.test" }),
  ).toHaveAttribute("href", "mailto:support@maintainflow.test");

  await page.goto("/auth/sign-up", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Account creation is not configured" }),
  ).toBeVisible();

  await page.goto("/auth/sign-in", { waitUntil: "networkidle" });
  await expect(
    page.getByRole("heading", { name: "Operator access is not configured" }),
  ).toBeVisible();
  expect(browserErrors).toEqual([]);
});

test("mobile workspace exposes a visible keyboard path into readiness", async ({
  browserName,
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app?tab=readiness");
  await expect(
    page.getByRole("textbox", { name: "Public landing-page URL" }),
  ).toBeVisible();
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  const focusNames: string[] = [];
  const requiredFocusNames = new Set([
    "Mobile ad account",
    "Public landing-page URL",
    "Run readiness audit",
  ]);
  const tabKey = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (let index = 0; index < 40 && requiredFocusNames.size > 0; index += 1) {
    await page.keyboard.press(tabKey);
    const focusState = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      const bounds = active?.getBoundingClientRect();
      return {
        name:
          active?.getAttribute("aria-label") ??
          active?.innerText?.trim().replace(/\s+/g, " ") ??
          "",
        visible:
          Boolean(bounds) &&
          (bounds?.width ?? 0) > 0 &&
          (bounds?.height ?? 0) > 0,
      };
    });
    expect(focusState.visible).toBe(true);
    focusNames.push(focusState.name);
    requiredFocusNames.delete(focusState.name);
  }

  expect(focusNames).toContain("Mobile ad account");
  expect(focusNames).toContain("Public landing-page URL");
  expect(focusNames).toContain("Run readiness audit");
  expect(browserErrors).toEqual([]);
});

test("readiness fails closed when the browser origin is not the public deployment origin", async ({
  page,
}) => {
  const browserErrors = collectBrowserErrors(page);
  const externalRequests: string[] = [];
  const readinessStatuses: number[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!new Set(["127.0.0.1", "localhost"]).has(url.hostname)) {
      externalRequests.push(request.url());
    }
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/api/readiness/audit") {
      readinessStatuses.push(response.status());
    }
  });

  await page.goto("/app?tab=readiness");
  await page
    .getByRole("textbox", { name: "Public landing-page URL" })
    .fill("http://127.0.0.1/internal-only");
  await page.getByRole("button", { name: "Run readiness audit" }).click();

  await expect(
    page.getByRole("heading", { name: "We could not audit that page" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("tabpanel", { name: "Readiness" })
      .getByText("Secure same-origin readiness requests are required."),
  ).toBeVisible();
  expect(externalRequests).toEqual([]);
  expect(readinessStatuses).toEqual([403]);
  expect(
    browserErrors.every(
      (message) => message.includes("403") || message.includes("Forbidden"),
    ),
  ).toBe(true);
});
