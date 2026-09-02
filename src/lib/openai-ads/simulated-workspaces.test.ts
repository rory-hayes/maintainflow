import { describe, expect, it } from "vitest";

import { approvalRecordDtoSchema } from "../audit/approval-schema";
import { parseAdsResourcePath } from "./resource-path";
import {
  adAccountSchema,
  adSchema,
  campaignSchema,
} from "./schema";
import {
  agencySimulatorEntryAccountId,
  listAgencySimulatedAccountIds,
  resolveSimulatedWorkspace,
} from "./simulated-workspaces";

describe("simulated sales workspaces", () => {
  it("keeps the direct-merchant simulator as the safe default", () => {
    const direct = resolveSimulatedWorkspace();
    const unknown = resolveSimulatedWorkspace("adacct_not_a_fixture");

    expect(direct.portfolioKind).toBe("direct");
    expect(direct.accountOptions).toHaveLength(1);
    expect(direct.account.name).toBe("Harbour Home Ireland");
    expect(direct.account.currency_code).toBe("EUR");
    expect(unknown.account.id).toBe(direct.account.id);
    expect(direct.recommendations.every((item) => item.source === "demo")).toBe(
      true,
    );
  });

  it("provides five distinct, schema-valid agency advertiser accounts", () => {
    const accountIds = listAgencySimulatedAccountIds();
    const workspaces = accountIds.map(resolveSimulatedWorkspace);

    expect(accountIds).toHaveLength(5);
    expect(new Set(accountIds).size).toBe(5);
    expect(
      new Set(workspaces.map((workspace) => workspace.account.name)).size,
    ).toBe(5);
    expect(
      new Set(
        workspaces.map((workspace) =>
          workspace.performance.reduce((total, row) => total + row.spend, 0),
        ),
      ).size,
    ).toBe(5);

    for (const workspace of workspaces) {
      expect(adAccountSchema.parse(workspace.account)).toBeTruthy();
      expect(workspace.account.currency_code).toBe("EUR");
      expect(workspace.accountOptions).toHaveLength(5);
      expect(workspace.portfolioKind).toBe("agency");
      expect(
        workspace.campaigns.map((campaign) => campaignSchema.parse(campaign)),
      ).toHaveLength(3);
      expect(workspace.ads.map((ad) => adSchema.parse(ad))).toHaveLength(5);
      expect(
        workspace.recommendations.every(
          (recommendation) => recommendation.source === "demo",
        ),
      ).toBe(true);
      expect(
        workspace.approvalHistory.map((record) =>
          approvalRecordDtoSchema.parse(record),
        ),
      ).toHaveLength(2);
      expect(
        workspace.approvalHistory.every(
          (record) => record.accountId === workspace.account.id,
        ),
      ).toBe(true);
      expect(workspace.approvalHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "reconciliation_required" }),
          expect.objectContaining({
            status: "applied",
            monitoringOutcome: "within_safeguard",
          }),
        ]),
      );
    }
  });

  it("keeps portfolio severity aligned with the Budget Guard pacing thresholds", () => {
    const workspace = resolveSimulatedWorkspace(agencySimulatorEntryAccountId);
    const statusByAccount = Object.fromEntries(
      workspace.accountOptions.map((account) => [
        account.accountName,
        account.portfolioSummary?.status,
      ]),
    );

    expect(statusByAccount).toEqual({
      "Northstar Home": "critical",
      "Alder & Ash": "attention",
      "Nook Living": "critical",
      Hearthline: "attention",
      TidyNest: "critical",
    });
  });

  it("keeps every simulated entity and mutation scoped to its selected account", () => {
    for (const accountId of listAgencySimulatedAccountIds()) {
      const workspace = resolveSimulatedWorkspace(accountId);
      const campaignIds = new Set(
        workspace.campaigns.map((campaign) => campaign.id),
      );
      const adIds = new Set(workspace.ads.map((ad) => ad.id));
      const adGroupIds = new Set(workspace.ads.map((ad) => ad.ad_group_id));

      for (const row of workspace.performance) {
        expect(campaignIds.has(row.campaignId)).toBe(true);
      }
      for (const event of workspace.creativeReviewHistory) {
        expect(event.accountId).toBe(workspace.account.id);
        expect(adIds.has(event.adId)).toBe(true);
        expect(adGroupIds.has(event.adGroupId)).toBe(true);
      }
      for (const recommendation of workspace.recommendations) {
        for (const mutation of [
          recommendation.mutation,
          recommendation.rollback,
        ]) {
          const target = parseAdsResourcePath(mutation.path);
          expect(
            target.resource === "ads"
              ? adIds.has(target.entityId)
              : adGroupIds.has(target.entityId),
          ).toBe(true);
        }
      }
    }
  });

  it("starts the agency link on a roughly twenty-thousand-euro advertiser", () => {
    const workspace = resolveSimulatedWorkspace(
      agencySimulatorEntryAccountId,
    );
    const spend = workspace.performance.reduce(
      (total, row) => total + row.spend,
      0,
    );

    expect(spend).toBeGreaterThanOrEqual(19_000);
    expect(spend).toBeLessThanOrEqual(21_000);
  });
});
