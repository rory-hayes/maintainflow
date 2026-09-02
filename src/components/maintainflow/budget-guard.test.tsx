import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({
    children,
    className,
    href,
  }: {
    children: ReactNode;
    className?: string;
    href: string;
  }) => (
    <a className={className} data-next-link="true" href={href}>
      {children}
    </a>
  ),
}));

import { BudgetGuard } from "./budget-guard";
import { demoCampaigns } from "@/lib/openai-ads/demo-data";
import {
  OPENAI_BUDGET_POLICY_VERSION,
  type BudgetGuardEvidence,
} from "@/lib/openai-ads/budget-guard";

const evidence: BudgetGuardEvidence[] = demoCampaigns
  .filter((campaign) => campaign.status === "active")
  .map((campaign, index) => ({
    campaignId: campaign.id,
    source: "demo",
    policyVersion: OPENAI_BUDGET_POLICY_VERSION,
    rangeStart: 1_787_526_000,
    rangeEnd: 1_787_958_000,
    periodStart: 1_787_526_000,
    periodEnd: 1_788_130_800,
    calculatedAt: "2026-08-29T08:00:00.000Z",
    accountTimeZone: "Europe/Dublin",
    isComplete: true,
    budgetHistoryConfirmed: true,
    spendMicros: index === 0 ? 2_000_000_000 : 1_300_000_000,
    applicableSpendLimitMicros:
      (campaign.budget.daily_spend_limit_micros ?? 0) * 7,
  }));

describe("BudgetGuard", () => {
  it("turns simulator evidence into explicit exposure and next checks", () => {
    const markup = renderToStaticMarkup(
      <BudgetGuard
        campaigns={demoCampaigns}
        evidence={evidence}
        currencyCode="EUR"
        dataSource="demo"
      />,
    );

    expect(markup).toContain("Budget Guard");
    expect(markup).toContain("Illustrative simulator");
    expect(markup).toContain("Projected overspend");
    expect(markup).toContain("Critical pacing risk");
    expect(markup).toContain("Underpacing");
    expect(markup).toContain("Review campaign row");
    expect(markup).toContain('data-next-link="true"');
    expect(markup).toContain('href="#budget-campaign-cmpn_101"');
    expect(markup).toContain("seven-day spending limit");
  });

  it("fails closed when there is no compatible evidence", () => {
    const markup = renderToStaticMarkup(
      <BudgetGuard
        campaigns={demoCampaigns}
        evidence={[]}
        currencyCode="EUR"
        dataSource="live"
      />,
    );

    expect(markup).toContain("Budget decisions remain locked");
    expect(markup).toContain("Live history required");
    expect(markup).toContain("Needs evidence");
    expect(markup).not.toContain("Review campaign row");
  });

  it("fails closed when a campaign has duplicate evidence windows", () => {
    const markup = renderToStaticMarkup(
      <BudgetGuard
        campaigns={demoCampaigns}
        evidence={[evidence[0], evidence[0], evidence[1]]}
        currencyCode="EUR"
        dataSource="demo"
      />,
    );

    expect(markup).toContain("Needs evidence");
    expect(markup).not.toContain("#budget-campaign-cmpn_101");
  });

  it("surfaces a confirmed individual-day maximum breach separately", () => {
    const dailySpend = [700, 300, 300, 300, 400].map((millions, index) => ({
      accountLocalDate: `2026-08-${24 + index}`,
      spendMicros: millions * 1_000_000,
      maximumDailySpendMicros: 660_000_000,
      isComplete: true,
    }));
    const markup = renderToStaticMarkup(
      <BudgetGuard
        campaigns={demoCampaigns}
        evidence={[
          { ...evidence[0], dailySpend },
          evidence[1],
        ]}
        currencyCode="EUR"
        dataSource="demo"
      />,
    );

    expect(markup).toContain("exceeded its documented daily maximum");
    expect(markup).toContain("Daily maximum exceeded");
    expect(markup).toContain("2026-08-24");
  });
});
