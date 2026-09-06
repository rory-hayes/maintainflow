import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { PortfolioActionItem } from "@/lib/openai-ads/action-queue";
import { PortfolioActionQueue } from "./portfolio-action-queue";

const items: PortfolioActionItem[] = [
  {
    id: "adacct_client:budget:cmpn_one",
    source: "live",
    accountId: "adacct_client",
    accountName: "Client One",
    category: "budget_pacing",
    severity: "critical",
    title: "Contain critical pacing risk",
    detail: "The confirmed budget window projects above its applicable limit.",
    evidenceLabel: "Confirmed Ads budget window",
    evidenceAt: "2026-09-03T12:00:00.000Z",
    freshness: "current",
    deliveryImpact: "not_observed",
    moneyAtRisk: {
      state: "known",
      amountMicros: 1_250_000_000,
      currencyCode: "EUR",
      basis: "Projected spend above the confirmed applicable limit",
    },
    occurrenceCount: 1,
    targetTab: "campaigns",
  },
  {
    id: "adacct_other:reconciliation",
    source: "live",
    accountId: "adacct_other",
    accountName: "Client Two",
    category: "reconciliation",
    severity: "critical",
    title: "Resolve unknown provider outcome",
    detail: "Check Ads Manager before attempting another write.",
    evidenceLabel: "Current durable workflow state",
    evidenceAt: "2026-09-03T11:00:00.000Z",
    freshness: "current",
    deliveryImpact: "unknown",
    moneyAtRisk: {
      state: "unknown",
      reason: "Portfolio workflow records do not include comparable spend.",
    },
    occurrenceCount: 2,
    targetTab: "experiments",
  },
];

describe("PortfolioActionQueue", () => {
  it("shows ranked evidence, known exposure, and an explicit unknown amount without write controls", () => {
    const markup = renderToStaticMarkup(
      <PortfolioActionQueue
        items={items}
        accountCount={2}
        currentAccountId="adacct_client"
        organizationId="org_agency"
        source="live"
      />,
    );

    expect(markup).toContain("Portfolio action queue");
    expect(markup).toContain("Live portfolio");
    expect(markup).toContain("Ranked by severity");
    expect(markup).toContain("Currencies are not");
    expect(markup).toContain("converted; unknown amounts stay unknown");
    expect(markup).toContain("Projected budget exposure");
    expect(markup).toContain(
      "Calculated from confirmed budget evidence across 1 ranked action",
    );
    expect(markup).toContain("€1,250");
    expect(markup).toContain("Unknown — not zero");
    expect(markup).toContain("Delivery blocked");
    expect(markup).toContain("Review evidence");
    expect(markup).toContain(
      "/app?tab=experiments&amp;account=adacct_other&amp;organization=org_agency",
    );
    expect(markup).not.toContain(">Apply<");
    expect(markup).not.toContain("Approve change");
  });

  it("keeps every action and its review step visible in an ordered mobile card list", () => {
    const markup = renderToStaticMarkup(
      <PortfolioActionQueue
        items={items}
        accountCount={2}
        currentAccountId="adacct_client"
        organizationId="org_agency"
        source="live"
      />,
    );
    const mobileStart = markup.indexOf(
      'data-testid="portfolio-action-queue-mobile"',
    );
    const desktopStart = markup.indexOf('<div class="hidden md:block">');
    const mobileMarkup = markup.slice(mobileStart, desktopStart);
    const desktopMarkup = markup.slice(desktopStart);

    expect(mobileStart).toBeGreaterThan(-1);
    expect(desktopStart).toBeGreaterThan(mobileStart);
    expect(mobileMarkup.match(/<li/g)).toHaveLength(2);
    expect(mobileMarkup).toContain("Priority 1");
    expect(mobileMarkup).toContain("Priority 2");
    expect(mobileMarkup).toContain(">Evidence<");
    expect(mobileMarkup).toContain(">Delivery<");
    expect(mobileMarkup).toContain(">Projected exposure<");
    expect(mobileMarkup).toContain("Unknown — not zero");
    expect(mobileMarkup).toContain(
      'aria-label="Review evidence for Client One: Contain critical pacing risk"',
    );
    expect(mobileMarkup).toContain(
      'aria-label="Review evidence for Client Two: Resolve unknown provider outcome"',
    );
    expect(mobileMarkup).not.toContain("overflow-auto");
    expect(markup).toContain('class="hidden md:block"');
    expect(desktopMarkup).toContain(
      "Projected spend above the confirmed applicable limit",
    );
    expect(desktopMarkup).toContain(
      "Portfolio workflow records do not include comparable spend.",
    );
  });

  it("keeps partial live portfolio failures visible without hiding available actions", () => {
    const markup = renderToStaticMarkup(
      <PortfolioActionQueue
        items={items}
        accountCount={1}
        currentAccountId="adacct_client"
        source="live"
        error="Stored client evidence could not be loaded."
      />,
    );

    expect(markup).toContain("Some portfolio evidence is unavailable");
    expect(markup).toContain("Stored client evidence could not be loaded.");
    expect(markup).toContain("Contain critical pacing risk");
    expect(markup).toContain("missing accounts are not counted as healthy");
  });

  it("does not present a failed empty live load as a healthy zero-account portfolio", () => {
    const markup = renderToStaticMarkup(
      <PortfolioActionQueue
        items={[]}
        accountCount={0}
        currentAccountId=""
        source="live"
        error="Stored client evidence could not be loaded."
      />,
    );

    expect(markup).toContain("Account count unavailable");
    expect(markup).toContain("Portfolio action status unavailable");
    expect(markup).toContain(
      "No healthy or zero-action conclusion can be made until live client evidence loads.",
    );
    expect(markup).not.toContain("0 client accounts");
    expect(markup).not.toContain("No exception in available evidence");
    expect(markup).not.toContain("Actions requiring attention");
  });
});
