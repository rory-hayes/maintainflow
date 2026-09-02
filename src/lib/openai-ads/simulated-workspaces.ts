import {
  demoAccount,
  demoAds,
  demoCampaignPerformance,
  demoCampaigns,
  demoCreativeReviewEvents,
  demoRecommendations,
  type CampaignPerformance,
  type Recommendation,
} from "./demo-data";
import type { CreativeReviewEvent } from "./creative-history";
import type { ApprovalRecordDto } from "../audit/approval-schema";
import {
  OPENAI_BUDGET_POLICY_VERSION,
  type BudgetGuardEvidence,
} from "./budget-guard";
import type { AdAccount, Campaign, ScopedAd } from "./schema";
import { evaluateMonitoringObservation } from "./monitoring";
import { agencySimulatorEntryAccountId } from "./simulator-links";

export { agencySimulatorEntryAccountId } from "./simulator-links";

export type SimulatedAccountOption = {
  accountId: string;
  accountName: string;
  portfolioSummary?: {
    projectedExposure: number;
    openReviews: number;
    campaignTemplateFixes: number;
    status: "critical" | "attention" | "clear";
  };
};

export type SimulatedWorkspace = {
  account: AdAccount;
  ads: ScopedAd[];
  campaigns: Campaign[];
  performance: CampaignPerformance[];
  budgetGuardEvidence: BudgetGuardEvidence[];
  recommendations: Recommendation[];
  creativeReviewHistory: CreativeReviewEvent[];
  approvalHistory: ApprovalRecordDto[];
  accountOptions: SimulatedAccountOption[];
  portfolioKind: "direct" | "agency";
  simulatorLabel: string;
  operator: { id: string; name: string; initials: string };
};

const simulatorBudgetPeriod = {
  rangeStart: 1_787_526_000,
  rangeEnd: 1_787_958_000,
  periodStart: 1_787_526_000,
  periodEnd: 1_788_130_800,
  calculatedAt: "2026-08-29T08:00:00.000Z",
  accountTimeZone: "Europe/Dublin",
} as const;

type AgencyAccountConfig = {
  slug: string;
  accountId: string;
  accountName: string;
  host: string;
  campaignNames: readonly [string, string, string];
  spendMultiplier: number;
  budgetMultipliers: readonly [number, number, number];
  recommendationIndexes: readonly number[];
};

const agencyAccountConfigs = [
  {
    slug: "northstar",
    accountId: agencySimulatorEntryAccountId,
    accountName: "Northstar Home",
    host: "northstar-home.example",
    campaignNames: [
      "Modular storage",
      "Small-room discovery",
      "Seasonal clearance",
    ],
    spendMultiplier: 1,
    budgetMultipliers: [1, 1, 1],
    recommendationIndexes: [0, 1, 3],
  },
  {
    slug: "alder",
    accountId: "adacct_sim_alder",
    accountName: "Alder & Ash",
    host: "alder-and-ash.example",
    campaignNames: [
      "Entryway storage",
      "Compact dining",
      "Seasonal outlet",
    ],
    spendMultiplier: 0.76,
    budgetMultipliers: [1.6, 0.8, 1],
    recommendationIndexes: [1, 2],
  },
  {
    slug: "nook",
    accountId: "adacct_sim_nook",
    accountName: "Nook Living",
    host: "nook-living.example",
    campaignNames: [
      "Apartment storage",
      "Renter essentials",
      "End-of-line feed",
    ],
    spendMultiplier: 1.34,
    budgetMultipliers: [1.1, 0.5, 1],
    recommendationIndexes: [3],
  },
  {
    slug: "hearthline",
    accountId: "adacct_sim_hearthline",
    accountName: "Hearthline",
    host: "hearthline.example",
    campaignNames: [
      "Kitchen organisers",
      "Small-space dining",
      "Warehouse clearance",
    ],
    spendMultiplier: 0.58,
    budgetMultipliers: [1.25, 0.7, 1],
    recommendationIndexes: [0],
  },
  {
    slug: "tidynest",
    accountId: "adacct_sim_tidynest",
    accountName: "TidyNest",
    host: "tidynest.example",
    campaignNames: [
      "Modular wardrobes",
      "Utility-room storage",
      "Outlet feed",
    ],
    spendMultiplier: 1.16,
    budgetMultipliers: [1, 2, 1],
    recommendationIndexes: [],
  },
] as const satisfies readonly AgencyAccountConfig[];

const baseCampaignNames = demoCampaigns.map((campaign) => campaign.name);

function remapProviderId(value: string, slug: string) {
  const match = /^(adacct|cmpn|adgrp|ad|file)_(.+)$/.exec(value);
  return match ? `${match[1]}_${slug}_${match[2]}` : value;
}

function rewriteText(value: string, config: AgencyAccountConfig) {
  let result = value
    .replaceAll("harbourhome.example", config.host)
    .replaceAll("Harbour Home", config.accountName)
    .replaceAll("$", "\u20ac");

  for (const [index, campaignName] of baseCampaignNames.entries()) {
    result = result.replaceAll(campaignName, config.campaignNames[index]);
  }

  for (const prefix of ["cmpn", "adgrp", "ad", "file"] as const) {
    const pattern = new RegExp(`\\b${prefix}_([0-9]+)\\b`, "g");
    result = result.replace(pattern, `${prefix}_${config.slug}_$1`);
  }

  return result;
}

function rewriteValue(value: unknown, config: AgencyAccountConfig): unknown {
  if (typeof value === "string") return rewriteText(value, config);
  if (Array.isArray(value)) {
    return value.map((item) => rewriteValue(item, config));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        rewriteValue(item, config),
      ]),
    );
  }
  return value;
}

function scaled(value: number, multiplier: number) {
  return Math.round(value * multiplier * 100) / 100;
}

function projectedBudgetRatio(config: AgencyAccountConfig, campaignIndex: number) {
  const baseProjectedRatio = campaignIndex === 0 ? 1.22 : 0.74;
  return Math.max(
    0.55,
    Math.min(
      1.35,
      baseProjectedRatio / config.budgetMultipliers[campaignIndex],
    ),
  );
}

function createAgencyWorkspace(
  config: AgencyAccountConfig,
  accountOptions: SimulatedAccountOption[],
): SimulatedWorkspace {
  const account: AdAccount = {
    ...structuredClone(demoAccount),
    id: config.accountId,
    name: config.accountName,
    url: `https://${config.host}`,
    timezone: "Europe/Dublin",
    currency_code: "EUR",
  };
  const campaigns: Campaign[] = structuredClone(demoCampaigns).map((campaign, index) => ({
    ...campaign,
    id: remapProviderId(campaign.id, config.slug),
    name: config.campaignNames[index],
    budget: Object.fromEntries(
      Object.entries(campaign.budget).map(([key, value]) => [
        key,
        typeof value === "number"
          ? Math.round(
              value *
                config.spendMultiplier *
                config.budgetMultipliers[index],
            )
          : value,
      ]),
    ) as Campaign["budget"],
  }));
  const ads = structuredClone(demoAds).map((ad) => ({
    ...ad,
    id: remapProviderId(ad.id, config.slug),
    ad_group_id: remapProviderId(ad.ad_group_id, config.slug),
    creative: rewriteValue(ad.creative, config) as ScopedAd["creative"],
  }));
  const performance = structuredClone(demoCampaignPerformance).map((row) => ({
    ...row,
    campaignId: remapProviderId(row.campaignId, config.slug),
    spend: scaled(row.spend, config.spendMultiplier),
    impressions: Math.round(row.impressions * config.spendMultiplier),
    clicks: Math.round(row.clicks * config.spendMultiplier),
    conversions: Math.round(row.conversions * config.spendMultiplier),
  }));
  const budgetGuardEvidence = campaigns.flatMap((campaign, index) => {
    const dailyBudgetMicros = campaign.budget.daily_spend_limit_micros;
    if (campaign.status !== "active" || dailyBudgetMicros == null) {
      return [];
    }
    const projectedRatio = projectedBudgetRatio(config, index);

    return [
      {
        campaignId: campaign.id,
        source: "demo" as const,
        policyVersion: OPENAI_BUDGET_POLICY_VERSION,
        ...simulatorBudgetPeriod,
        isComplete: true,
        budgetHistoryConfirmed: true,
        spendMicros: Math.round(
          dailyBudgetMicros * projectedRatio * 5,
        ),
        applicableSpendLimitMicros: dailyBudgetMicros * 7,
      },
    ];
  });
  const recommendations = config.recommendationIndexes.map((index) => {
    const recommendation = structuredClone(demoRecommendations[index]);
    const rewritten = rewriteValue(
      recommendation,
      config,
    ) as Recommendation;
    const monitoringPlan = rewritten.monitoringPlan;
    return {
      ...rewritten,
      id: `${rewritten.id}_${config.slug}`,
      source: "demo" as const,
      ...(monitoringPlan
        ? {
            monitoringPlan: {
              ...monitoringPlan,
              baseline: {
                ...monitoringPlan.baseline,
                spend: scaled(
                  monitoringPlan.baseline.spend,
                  config.spendMultiplier,
                ),
                clickAttributedConversions: Math.max(
                  1,
                  Math.round(
                    monitoringPlan.baseline.clickAttributedConversions *
                      config.spendMultiplier,
                  ),
                ),
                currencyCode: "EUR",
              },
            },
          }
        : {}),
    };
  });
  const creativeReviewHistory = structuredClone(demoCreativeReviewEvents).map(
    (event) => ({
      ...event,
      id: `${event.id}_${config.slug}`,
      accountId: config.accountId,
      adId: remapProviderId(event.adId, config.slug),
      adGroupId: remapProviderId(event.adGroupId, config.slug),
      adName: rewriteText(event.adName, config),
    }),
  );
  const workspaceOrdinal =
    agencyAccountConfigs.findIndex((item) => item.slug === config.slug) + 1;
  const approvalId = (offset: number) =>
    `00000000-0000-4000-8000-${String(1_000 + workspaceOrdinal * 10 + offset).padStart(12, "0")}`;
  const monitoredSource = rewriteValue(
    demoRecommendations.find((recommendation) => recommendation.monitoringPlan)!,
    config,
  ) as Recommendation;
  const uncertainSource = rewriteValue(
    demoRecommendations.find(
      (recommendation) => recommendation.id === "rec_creative_test",
    )!,
    config,
  ) as Recommendation;
  const sourceMonitoringPlan = monitoredSource.monitoringPlan!;
  const monitoringPlan = {
    ...sourceMonitoringPlan,
    baseline: {
      ...sourceMonitoringPlan.baseline,
      spend: scaled(
        sourceMonitoringPlan.baseline.spend,
        config.spendMultiplier,
      ),
      clickAttributedConversions: Math.max(
        1,
        Math.round(
          sourceMonitoringPlan.baseline.clickAttributedConversions *
            config.spendMultiplier,
        ),
      ),
      currencyCode: "EUR",
    },
  };
  const observedConversions = Math.max(
    1,
    Math.round(monitoringPlan.baseline.clickAttributedConversions * 0.93),
  );
  const observed = evaluateMonitoringObservation({
    plan: monitoringPlan,
    rangeStart: monitoringPlan.baseline.rangeEnd + 3_600,
    rangeEnd:
      monitoringPlan.baseline.rangeEnd +
      monitoringPlan.windowDays * 24 * 60 * 60,
    spend: scaled(monitoringPlan.baseline.spend, 0.96),
    clickAttributedConversions: observedConversions,
  });
  const approvalHistory: ApprovalRecordDto[] = [
    {
      id: approvalId(1),
      accountId: config.accountId,
      organizationName: "Harbour Growth demo",
      membershipRole: "admin",
      accountRole: "manager",
      recommendationId: `${monitoredSource.id}_historical_demo`,
      recommendationTitle: monitoredSource.title,
      entityId: monitoredSource.entityId,
      mutation: monitoredSource.mutation,
      rollbackMethod: monitoredSource.rollback.method,
      rollbackPath: monitoredSource.rollback.path,
      rollbackBody: monitoredSource.rollback.body,
      evidence: monitoredSource.evidence,
      safeguard: monitoredSource.safeguard,
      status: "applied",
      errorMessage: null,
      reconciliationNote: null,
      monitoringPlan,
      monitoringStartedAt: "2026-08-20T00:00:00.000Z",
      monitoringEndsAt: "2026-08-27T00:00:00.000Z",
      monitoringOutcome: observed.outcome,
      monitoringObservation: observed.observation,
      monitoringEvaluatedAt: "2026-08-29T01:00:00.000Z",
      createdAt: "2026-08-19T16:30:00.000Z",
      updatedAt: "2026-08-29T01:00:00.000Z",
      appliedAt: "2026-08-19T16:35:00.000Z",
      rolledBackAt: null,
    },
    {
      id: approvalId(2),
      accountId: config.accountId,
      organizationName: "Harbour Growth demo",
      membershipRole: "admin",
      accountRole: "manager",
      recommendationId: `${uncertainSource.id}_historical_demo`,
      recommendationTitle: uncertainSource.title,
      entityId: uncertainSource.entityId,
      mutation: uncertainSource.mutation,
      rollbackMethod: uncertainSource.rollback.method,
      rollbackPath: uncertainSource.rollback.path,
      rollbackBody: uncertainSource.rollback.body,
      evidence: uncertainSource.evidence,
      safeguard: uncertainSource.safeguard,
      status: "reconciliation_required",
      errorMessage:
        "The simulator models a transport ending before the provider outcome was confirmed.",
      reconciliationNote: null,
      monitoringPlan: null,
      monitoringStartedAt: null,
      monitoringEndsAt: null,
      monitoringOutcome: null,
      monitoringObservation: null,
      monitoringEvaluatedAt: null,
      createdAt: "2026-08-31T09:00:00.000Z",
      updatedAt: "2026-08-31T09:01:00.000Z",
      appliedAt: null,
      rolledBackAt: null,
    },
  ];

  return {
    account,
    ads,
    campaigns,
    performance,
    budgetGuardEvidence,
    recommendations,
    creativeReviewHistory,
    approvalHistory,
    accountOptions,
    portfolioKind: "agency",
    simulatorLabel: "Agency portfolio simulator",
    operator: {
      id: "demo-agency-operator",
      name: "Harbour Growth demo",
      initials: "HG",
    },
  };
}

const agencyAccountOptions = agencyAccountConfigs.map((config) => {
  const projectedBudget = demoCampaigns.reduce((summary, campaign, index) => {
    const baseDailyBudget = campaign.budget.daily_spend_limit_micros;
    if (campaign.status !== "active" || baseDailyBudget === undefined) {
      return summary;
    }
    const applicableLimit =
      baseDailyBudget *
      config.spendMultiplier *
      config.budgetMultipliers[index] *
      7;
    const projectedRatio = projectedBudgetRatio(config, index);
    return {
      exposure:
        summary.exposure +
        Math.max(0, applicableLimit * (projectedRatio - 1)) / 1_000_000,
      highestRatio: Math.max(summary.highestRatio, projectedRatio),
    };
  }, { exposure: 0, highestRatio: 0 });
  const projectedExposure = projectedBudget.exposure;
  const openReviews = config.recommendationIndexes.length;

  return {
    accountId: config.accountId,
    accountName: config.accountName,
    portfolioSummary: {
      projectedExposure: Math.round(projectedExposure),
      openReviews,
      campaignTemplateFixes: 2,
      status:
        projectedBudget.highestRatio >= 1.2
          ? ("critical" as const)
          : projectedExposure > 0 || openReviews > 0
            ? ("attention" as const)
            : ("clear" as const),
    },
  };
});

const agencyWorkspaces = new Map<string, SimulatedWorkspace>(
  agencyAccountConfigs.map((config) => [
    config.accountId,
    createAgencyWorkspace(config, agencyAccountOptions),
  ]),
);

const directAccountName = "Harbour Home Ireland";
const directWorkspaceBase = createAgencyWorkspace(
  {
    slug: "harbour",
    accountId: demoAccount.id,
    accountName: directAccountName,
    host: "harbourhome.example",
    campaignNames: [
      "Summer storage",
      "Small-space living",
      "Clearance feed",
    ],
    spendMultiplier: 1,
    budgetMultipliers: [1, 1, 1],
    recommendationIndexes: [0, 1, 2, 3],
  },
  [{ accountId: demoAccount.id, accountName: directAccountName }],
);

const directWorkspace: SimulatedWorkspace = {
  ...directWorkspaceBase,
  approvalHistory: directWorkspaceBase.approvalHistory.map((record) => ({
    ...record,
    organizationName: "Harbour Home demo",
    membershipRole: "owner",
    accountRole: "owner",
  })),
  portfolioKind: "direct",
  simulatorLabel: "Direct merchant simulator",
  operator: {
    id: "demo-merchant-operator",
    name: "Harbour Home demo",
    initials: "HH",
  },
};

export function resolveSimulatedWorkspace(
  requestedAccountId?: string,
): SimulatedWorkspace {
  return agencyWorkspaces.get(requestedAccountId ?? "") ?? directWorkspace;
}

export function listAgencySimulatedAccountIds() {
  return agencyAccountConfigs.map((config) => config.accountId);
}
