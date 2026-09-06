import type { ApprovalRecordDto } from "../audit/approval-schema";
import type { ReadinessAuditHistoryEntry } from "../readiness/history";
import { buildCampaignAttributionReadiness } from "./attribution-readiness";
import { buildSimulatedChangeIntegrityEventPage } from "./change-integrity-demo";
import type { ChangeIntegrityEventDto } from "./change-integrity-schema";
import {
  evaluateBudgetGuards,
  type BudgetGuardEvidence,
  type BudgetGuardResult,
} from "./budget-guard";
import { getCreativeTriageGuidance } from "./creative-triage";
import type { Recommendation } from "./demo-data";
import type { ConversionMeasurementReadiness } from "./measurement-readiness";
import type { MonitoringWindowDto } from "./monitoring";
import type { LivePortfolioAccount } from "./live-portfolio";
import type { Campaign, ScopedAd } from "./schema";
import type { SimulatedWorkspace } from "./simulated-workspaces";

export type ActionQueueSeverity = "critical" | "high" | "medium";

export type ActionQueueCategory =
  | "budget_pacing"
  | "creative_delivery"
  | "recommendation"
  | "measurement"
  | "tracking_template"
  | "site_readiness"
  | "monitoring"
  | "reconciliation"
  | "change_integrity"
  | "evidence";

export type ActionQueueFreshness = "current" | "stale" | "unknown";

export type ActionQueueDeliveryImpact =
  | "blocked"
  | "at_risk"
  | "not_observed"
  | "unknown";

export type ActionQueueTargetTab =
  | "review"
  | "campaigns"
  | "experiments"
  | "readiness"
  | "workspace";

export type ActionQueueMoneyAtRisk =
  | {
      state: "known";
      amountMicros: number;
      currencyCode: string;
      basis: string;
    }
  | {
      state: "unknown";
      reason: string;
    };

export type PortfolioActionItem = {
  id: string;
  source: "simulator" | "live";
  accountId: string;
  accountName: string;
  category: ActionQueueCategory;
  severity: ActionQueueSeverity;
  title: string;
  detail: string;
  evidenceLabel: string;
  evidenceAt: string | null;
  freshness: ActionQueueFreshness;
  deliveryImpact: ActionQueueDeliveryImpact;
  moneyAtRisk: ActionQueueMoneyAtRisk;
  occurrenceCount: number;
  targetTab: ActionQueueTargetTab;
};

type DetailedAccountEvidence = {
  source: "simulator" | "live";
  accountId: string;
  accountName: string;
  currencyCode: string;
  campaigns: Campaign[];
  ads: ScopedAd[];
  budgetGuardEvidence: BudgetGuardEvidence[];
  recommendations: Recommendation[];
  snapshotAt: string | null;
  snapshotFreshness: ActionQueueFreshness;
  approvalHistory?: ApprovalRecordDto[];
  monitoringWindows?: MonitoringWindowDto[];
  conversionMeasurement?: ConversionMeasurementReadiness;
  readinessHistory?: ReadinessAuditHistoryEntry[];
  changeIntegrityEvents?: ChangeIntegrityEventDto[];
};

export type LivePortfolioExpandedEvidence = Omit<
  DetailedAccountEvidence,
  "source"
>;

const severityRank: Record<ActionQueueSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
};

const freshnessRank: Record<ActionQueueFreshness, number> = {
  current: 0,
  stale: 1,
  unknown: 2,
};

const deliveryImpactRank: Record<ActionQueueDeliveryImpact, number> = {
  blocked: 0,
  at_risk: 1,
  not_observed: 2,
  unknown: 3,
};

function unknownMoney(reason: string): ActionQueueMoneyAtRisk {
  return { state: "unknown", reason };
}

function compareMoneyAtRisk(
  left: ActionQueueMoneyAtRisk,
  right: ActionQueueMoneyAtRisk,
) {
  if (left.state !== right.state) return left.state === "known" ? -1 : 1;
  if (left.state === "unknown" || right.state === "unknown") return 0;
  if (left.currencyCode !== right.currencyCode) {
    return left.currencyCode.localeCompare(right.currencyCode);
  }
  return right.amountMicros - left.amountMicros;
}

function sortableEvidenceAt(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/**
 * Sorts without inventing a blended score: severity wins first, then a known
 * amount at risk grouped by currency, evidence freshness, observed delivery
 * impact, and recency. Currency groups provide a deterministic total order;
 * they are not a value comparison or an unstated currency conversion.
 */
export function rankPortfolioActionItems(
  items: readonly PortfolioActionItem[],
) {
  return [...items].sort((left, right) => {
    const severityDifference =
      severityRank[left.severity] - severityRank[right.severity];
    if (severityDifference !== 0) return severityDifference;

    const moneyDifference = compareMoneyAtRisk(
      left.moneyAtRisk,
      right.moneyAtRisk,
    );
    if (moneyDifference !== 0) return moneyDifference;

    const freshnessDifference =
      freshnessRank[left.freshness] - freshnessRank[right.freshness];
    if (freshnessDifference !== 0) return freshnessDifference;

    const deliveryDifference =
      deliveryImpactRank[left.deliveryImpact] -
      deliveryImpactRank[right.deliveryImpact];
    if (deliveryDifference !== 0) return deliveryDifference;

    const leftEvidenceAt = sortableEvidenceAt(left.evidenceAt);
    const rightEvidenceAt = sortableEvidenceAt(right.evidenceAt);
    if (leftEvidenceAt !== rightEvidenceAt) {
      return rightEvidenceAt - leftEvidenceAt;
    }

    const accountDifference = left.accountName.localeCompare(
      right.accountName,
    );
    if (accountDifference !== 0) return accountDifference;
    return left.id.localeCompare(right.id);
  });
}

function budgetStatusTitle(result: BudgetGuardResult, campaignName: string) {
  if (result.status === "critical_overspend") {
    return `Contain critical pacing risk on ${campaignName}`;
  }
  if (result.status === "overspend") {
    return `Review projected overspend on ${campaignName}`;
  }
  if (result.status === "underpacing") {
    return `Restore delivery on underpacing ${campaignName}`;
  }
  return `Confirm budget evidence for ${campaignName}`;
}

function budgetStatusDetail(result: BudgetGuardResult) {
  if (result.paceRatio !== null) {
    const pace = Math.round(result.paceRatio * 100);
    return result.status === "underpacing"
      ? `The confirmed window projects ${pace}% of the applicable spending limit. Review eligibility, bid, targeting, and creative readiness.`
      : `The confirmed window projects ${pace}% of the applicable spending limit. Review the confirmed limit, bid, and delivery settings before changing spend.`;
  }
  if (result.reason === "stale_evidence") {
    return "The budget window is stale. Refresh the account before making a pacing decision.";
  }
  if (result.reason === "unconfirmed_budget_history") {
    return "A fully observed budget window is required because mid-window budget changes alter the applicable provider limit.";
  }
  return `MaintainFlow cannot rank this campaign as safe because its budget evidence is incomplete (${result.reason ?? "reason unavailable"}).`;
}

function budgetActions(evidence: DetailedAccountEvidence) {
  const evaluationNow =
    evidence.source === "simulator"
      ? evidence.budgetGuardEvidence.find((item) => item.calculatedAt)
          ?.calculatedAt
      : evidence.snapshotAt ?? undefined;
  const results = evaluateBudgetGuards({
    campaigns: evidence.campaigns,
    evidence: evidence.budgetGuardEvidence,
    now: evaluationNow,
  });

  return results.flatMap((result, index): PortfolioActionItem[] => {
    if (result.status === "on_track" || result.status === "inactive") {
      return [];
    }
    const campaign = evidence.campaigns[index];
    if (!campaign) return [];
    const knownExposure =
      result.exposureMicros !== null && result.exposureMicros > 0;
    const severity: ActionQueueSeverity =
      result.status === "critical_overspend"
        ? "critical"
        : result.status === "overspend" || result.status === "underpacing"
          ? "high"
          : "medium";

    return [
      {
        id: `${evidence.accountId}:budget:${campaign.id}`,
        source: evidence.source,
        accountId: evidence.accountId,
        accountName: evidence.accountName,
        category: "budget_pacing",
        severity,
        title: budgetStatusTitle(result, campaign.name),
        detail: budgetStatusDetail(result),
        evidenceLabel:
          evidence.source === "simulator"
            ? "Illustrative confirmed-budget window"
            : result.evidence
              ? "Confirmed Ads budget window"
              : "Budget evidence unavailable",
        evidenceAt: result.evidence?.calculatedAt ?? evidence.snapshotAt,
        freshness:
          result.isStale || evidence.snapshotFreshness === "stale"
            ? "stale"
            : result.evidence
              ? evidence.snapshotFreshness
              : "unknown",
        deliveryImpact:
          result.status === "underpacing" ? "at_risk" : "not_observed",
        moneyAtRisk: knownExposure
          ? {
              state: "known",
              amountMicros: result.exposureMicros!,
              currencyCode: evidence.currencyCode,
              basis: "Projected spend above the confirmed applicable limit",
            }
          : unknownMoney(
              result.status === "underpacing"
                ? "Underpacing is confirmed, but lost revenue is not available from the Ads evidence."
                : "No positive overspend exposure could be confirmed from this evidence window.",
            ),
        occurrenceCount: 1,
        targetTab: "campaigns",
      },
    ];
  });
}

function creativeActions(evidence: DetailedAccountEvidence) {
  return evidence.ads.flatMap((ad): PortfolioActionItem[] => {
    const guidance = getCreativeTriageGuidance(ad);
    if (guidance.state === "clear") return [];
    const evidenceAt = Number.isSafeInteger(ad.updated_at)
      ? new Date(ad.updated_at * 1_000).toISOString()
      : evidence.snapshotAt;

    return [
      {
        id: `${evidence.accountId}:creative:${ad.id}`,
        source: evidence.source,
        accountId: evidence.accountId,
        accountName: evidence.accountName,
        category: "creative_delivery",
        severity: guidance.state === "blocked" ? "high" : "medium",
        title: `${guidance.label}: ${ad.name}`,
        detail: [guidance.detail, guidance.providerSignal]
          .filter(Boolean)
          .join(" Provider signal: "),
        evidenceLabel:
          evidence.source === "simulator"
            ? "Illustrative ad review and delivery fields"
            : "Ads API review and delivery fields",
        evidenceAt,
        freshness: evidence.snapshotFreshness,
        deliveryImpact:
          guidance.state === "blocked"
            ? "blocked"
            : guidance.state === "pending" || guidance.state === "delivery"
              ? "at_risk"
              : "unknown",
        moneyAtRisk: unknownMoney(
          "The Ads review response does not quantify revenue or spend affected by this creative.",
        ),
        occurrenceCount: 1,
        targetTab: "campaigns",
      },
    ];
  });
}

function recommendationActions(evidence: DetailedAccountEvidence) {
  return evidence.recommendations.flatMap(
    (recommendation): PortfolioActionItem[] => {
      if (recommendation.status !== "ready") return [];
      return [
        {
          id: `${evidence.accountId}:recommendation:${recommendation.id}`,
          source: evidence.source,
          accountId: evidence.accountId,
          accountName: evidence.accountName,
          category: "recommendation",
          severity: recommendation.priority === "high" ? "high" : "medium",
          title: recommendation.title,
          detail: `${recommendation.summary} ${recommendation.nextStep}`,
          evidenceLabel:
            evidence.source === "simulator"
              ? "Illustrative recommendation evidence"
              : "Schema-validated Ads snapshot",
          evidenceAt: evidence.snapshotAt,
          freshness: evidence.snapshotFreshness,
          deliveryImpact: "unknown",
          moneyAtRisk: unknownMoney(
            "The recommendation has a directional impact estimate, not a confirmed amount-at-risk field.",
          ),
          occurrenceCount: 1,
          targetTab: "review",
        },
      ];
    },
  );
}

function trackingTemplateActions(evidence: DetailedAccountEvidence) {
  const readiness = buildCampaignAttributionReadiness({
    campaigns: evidence.campaigns,
  });

  return readiness.checks.flatMap((check): PortfolioActionItem[] => {
    if (check.status !== "needs_attention" || check.issues.length === 0) {
      return [];
    }
    const firstIssue = check.issues[0]!;
    return [
      {
        id: `${evidence.accountId}:tracking:${check.campaignId}`,
        source: evidence.source,
        accountId: evidence.accountId,
        accountName: evidence.accountName,
        category: "tracking_template",
        severity: firstIssue.priority <= 2 ? "high" : "medium",
        title: `${firstIssue.title} on ${check.campaignName}`,
        detail: `${check.issues.length} campaign-template gap${check.issues.length === 1 ? "" : "s"} detected. ${firstIssue.detail} UTM naming remains MaintainFlow guidance, not an OpenAI requirement.`,
        evidenceLabel:
          evidence.source === "simulator"
            ? "Illustrative campaign-level URL fields"
            : "Ads API campaign-level URL fields",
        evidenceAt: evidence.snapshotAt,
        freshness: evidence.snapshotFreshness,
        deliveryImpact: "not_observed",
        moneyAtRisk: unknownMoney(
          "Campaign URL fields do not quantify unattributed revenue.",
        ),
        occurrenceCount: check.issues.length,
        targetTab: "readiness",
      },
    ];
  });
}

function approvalActions(evidence: DetailedAccountEvidence) {
  return (evidence.approvalHistory ?? []).flatMap(
    (record): PortfolioActionItem[] => {
      const reconciliation =
        record.status === "reconciliation_required" ||
        record.status === "rollback_reconciliation_required";
      const rollbackFailure = record.status === "rollback_failed";
      const safeguardTriggered =
        record.monitoringOutcome === "safeguard_triggered";
      const insufficientEvidence =
        record.monitoringOutcome === "insufficient_evidence";
      if (
        !reconciliation &&
        !rollbackFailure &&
        !safeguardTriggered &&
        !insufficientEvidence
      ) {
        return [];
      }

      const category: ActionQueueCategory = reconciliation || rollbackFailure
        ? "reconciliation"
        : "monitoring";
      const title = reconciliation
        ? `Resolve unknown provider outcome for ${record.recommendationTitle}`
        : rollbackFailure
          ? `Resolve failed rollback for ${record.recommendationTitle}`
          : safeguardTriggered
            ? `Review triggered safeguard for ${record.recommendationTitle}`
            : `Complete monitoring evidence for ${record.recommendationTitle}`;

      return [
        {
          id: `${evidence.accountId}:approval:${record.id}`,
          source: evidence.source,
          accountId: evidence.accountId,
          accountName: evidence.accountName,
          category,
          severity: reconciliation || rollbackFailure ? "critical" : "high",
          title,
          detail:
            record.errorMessage ??
            record.reconciliationNote ??
            (safeguardTriggered
              ? "The recorded post-change observation crossed its stored safeguard. Human rollback review is required."
              : "The monitoring result did not contain enough evidence to declare the change safe."),
          evidenceLabel: "Durable approval and monitoring record",
          evidenceAt: record.updatedAt,
          freshness: "current",
          deliveryImpact: safeguardTriggered ? "at_risk" : "unknown",
          moneyAtRisk: unknownMoney(
            "The durable workflow record does not contain a comparable amount at risk.",
          ),
          occurrenceCount: 1,
          targetTab: "experiments",
        },
      ];
    },
  );
}

function monitoringActions(evidence: DetailedAccountEvidence) {
  return (evidence.monitoringWindows ?? []).flatMap(
    (window): PortfolioActionItem[] => {
      if (
        window.status === "active" ||
        window.status === "within_safeguard"
      ) {
        return [];
      }
      if (
        evidence.approvalHistory?.some(
          (record) =>
            record.id === window.approvalId &&
            ((window.outcome !== null &&
              record.monitoringOutcome === window.outcome) ||
              record.status === "reconciliation_required" ||
              record.status === "rollback_reconciliation_required"),
        )
      ) {
        return [];
      }
      const critical = window.status === "rollback_outcome_unknown";
      return [
        {
          id: `${evidence.accountId}:monitoring:${window.approvalId}`,
          source: evidence.source,
          accountId: evidence.accountId,
          accountName: evidence.accountName,
          category: critical ? "reconciliation" : "monitoring",
          severity: critical ? "critical" : "high",
          title:
            window.status === "review_due"
              ? `Evaluate completed monitoring for ${window.recommendationTitle}`
              : window.status === "rollback_outcome_unknown"
                ? `Resolve unknown rollback outcome for ${window.recommendationTitle}`
                : `Review ${window.recommendationTitle} monitoring`,
          detail: window.safeguard,
          evidenceLabel: "Durable monitoring window",
          evidenceAt: window.evaluatedAt ?? window.endsAt,
          freshness: "current",
          deliveryImpact:
            window.status === "safeguard_triggered" ? "at_risk" : "unknown",
          moneyAtRisk: unknownMoney(
            "The monitoring window does not contain a comparable amount at risk.",
          ),
          occurrenceCount: 1,
          targetTab: "experiments",
        },
      ];
    },
  );
}

function measurementActions(evidence: DetailedAccountEvidence) {
  const readiness = evidence.conversionMeasurement;
  if (!readiness) return [];
  if (readiness.status === "needs_attention") {
    return readiness.checks.flatMap((check): PortfolioActionItem[] => {
      if (check.status === "pass") return [];
      return [
        {
          id: `${evidence.accountId}:measurement:${check.campaignId}`,
          source: evidence.source,
          accountId: evidence.accountId,
          accountName: evidence.accountName,
          category: "measurement",
          severity: check.status === "fail" ? "high" : "medium",
          title: `${check.title}: ${check.campaignName}`,
          detail: check.detail,
          evidenceLabel: "Ads API conversion event-setting fields",
          evidenceAt: readiness.checkedAt,
          freshness: evidence.snapshotFreshness,
          deliveryImpact: "not_observed",
          moneyAtRisk: unknownMoney(
            "Conversion configuration does not quantify unattributed revenue.",
          ),
          occurrenceCount: 1,
          targetTab: "readiness",
        },
      ];
    });
  }
  if (
    readiness.status === "unavailable" &&
    evidence.campaigns.some(
      (campaign) =>
        campaign.status === "active" && campaign.bidding_type === "conversions",
    )
  ) {
    return [
      {
        id: `${evidence.accountId}:measurement:unavailable`,
        source: evidence.source,
        accountId: evidence.accountId,
        accountName: evidence.accountName,
        category: "measurement" as const,
        severity: "medium" as const,
        title: "Verify conversion measurement evidence",
        detail: readiness.message,
        evidenceLabel: "Conversion evidence unavailable",
        evidenceAt: readiness.checkedAt,
        freshness: "unknown" as const,
        deliveryImpact: "unknown" as const,
        moneyAtRisk: unknownMoney(
          "No confirmed conversion configuration is available to quantify impact.",
        ),
        occurrenceCount: 1,
        targetTab: "readiness" as const,
      },
    ];
  }
  return [];
}

function siteReadinessActions(
  evidence: DetailedAccountEvidence,
): PortfolioActionItem[] {
  const latest = [...(evidence.readinessHistory ?? [])].sort(
    (left, right) => Date.parse(right.recordedAt) - Date.parse(left.recordedAt),
  )[0];
  if (!latest || latest.audit.verdict === "ready") return [];
  const exceptions = [
    ...latest.audit.checks,
    ...latest.audit.measurement.checks,
  ].filter((check) => check.status !== "pass");

  return [
    {
      id: `${evidence.accountId}:readiness:${latest.id}`,
      source: evidence.source,
      accountId: evidence.accountId,
      accountName: evidence.accountName,
      category: "site_readiness",
      severity: latest.audit.verdict === "not_ready" ? "critical" : "high",
      title: `${exceptions.length} site-readiness check${exceptions.length === 1 ? "" : "s"} need attention`,
      detail: `${latest.audit.score}/100 for ${latest.audit.finalUrl}. Review the retained evidence before changing the storefront.`,
      evidenceLabel: "Saved MaintainFlow readiness audit",
      evidenceAt: latest.recordedAt,
      freshness: "unknown",
      deliveryImpact: "at_risk",
      moneyAtRisk: unknownMoney(
        "The site audit cannot quantify media or revenue affected by readiness gaps.",
      ),
      occurrenceCount: exceptions.length,
      targetTab: "readiness",
    },
  ];
}

function changeIntegrityActions(
  evidence: DetailedAccountEvidence,
): PortfolioActionItem[] {
  return (evidence.changeIntegrityEvents ?? []).flatMap(
    (event): PortfolioActionItem[] => {
      if (event.reviewStatus !== "open") return [];
      const unexplained = event.classification === "unexplained";
      if (!unexplained && event.classification !== "indeterminate") return [];
      const affectedPathCount = unexplained
        ? event.unexplainedFieldPaths.length
        : event.indeterminateFieldPaths.length;
      const hasSnapshotTiming = event.matchedOperations.some(
        (operation) => operation.uncertaintyReason === "snapshot_timing",
      );
      const hasUnconfirmedOutcome = event.matchedOperations.some(
        (operation) => operation.uncertaintyReason === "provider_outcome",
      );
      const indeterminateReason = hasSnapshotTiming && hasUnconfirmedOutcome
        ? "had indeterminate retained evidence at detection time because some operations overlapped the provider-read interval and others had no confirmed provider outcome"
        : hasSnapshotTiming
          ? "had indeterminate retained evidence at detection time because an operation overlapped the provider-read interval, so snapshot ordering was not proven"
          : hasUnconfirmedOutcome
            ? "had indeterminate retained evidence at detection time because an operation had no confirmed provider outcome"
            : "could not be conclusively ordered from the retained evidence at detection time";
      const affectedLabel = unexplained
        ? "lacked unambiguous latest recorded operation evidence at detection time; equal-time latest operations can agree, while conflicting tied values remain unexplained"
        : indeterminateReason;
      return [
        {
          id: `${evidence.accountId}:integrity:${event.id}`,
          source: evidence.source,
          accountId: evidence.accountId,
          accountName: evidence.accountName,
          category: "change_integrity",
          severity: unexplained ? "high" : "medium",
          title: unexplained
            ? `Review unexplained change on ${event.resourceLabel}`
            : `Review indeterminate change evidence for ${event.resourceLabel}`,
          detail: `${affectedPathCount} of ${event.changedFieldPaths.length} material changed field${event.changedFieldPaths.length === 1 ? "" : "s"} ${affectedLabel}. This does not identify who made the change.`,
          evidenceLabel:
            evidence.source === "simulator"
              ? "Illustrative snapshot comparison"
              : "Confirmed snapshot comparison",
          evidenceAt: event.detectedAt,
          freshness: evidence.snapshotFreshness,
          deliveryImpact: "unknown",
          moneyAtRisk: unknownMoney(
            "A configuration comparison does not quantify media or revenue affected.",
          ),
          occurrenceCount: 1,
          targetTab: "experiments",
        },
      ];
    },
  );
}

function detailedAccountActions(
  evidence: DetailedAccountEvidence,
): PortfolioActionItem[] {
  return [
    ...budgetActions(evidence),
    ...creativeActions(evidence),
    ...recommendationActions(evidence),
    ...trackingTemplateActions(evidence),
    ...approvalActions(evidence),
    ...monitoringActions(evidence),
    ...measurementActions(evidence),
    ...siteReadinessActions(evidence),
    ...changeIntegrityActions(evidence),
  ];
}

export function buildSimulatedPortfolioActionQueue(
  workspaces: readonly SimulatedWorkspace[],
) {
  return rankPortfolioActionItems(
    workspaces.flatMap((workspace) => {
      const snapshotAt =
        [...workspace.budgetGuardEvidence].sort(
          (left, right) =>
            Date.parse(right.calculatedAt) - Date.parse(left.calculatedAt),
        )[0]?.calculatedAt ?? null;
      return detailedAccountActions({
        source: "simulator",
        accountId: workspace.account.id,
        accountName: workspace.account.name,
        currencyCode: workspace.account.currency_code,
        campaigns: workspace.campaigns,
        ads: workspace.ads,
        budgetGuardEvidence: workspace.budgetGuardEvidence,
        recommendations: workspace.recommendations,
        approvalHistory: workspace.approvalHistory,
        changeIntegrityEvents: buildSimulatedChangeIntegrityEventPage({
          account: workspace.account,
          campaigns: workspace.campaigns,
          ads: workspace.ads,
        }).events,
        snapshotAt,
        snapshotFreshness: snapshotAt ? "current" : "unknown",
      });
    }),
  );
}

function liveOperationalActions(
  account: LivePortfolioAccount,
  representedChangeIntegrity: {
    unexplained: number;
    indeterminate: number;
  } = { unexplained: 0, indeterminate: 0 },
) {
  const definitions = [
    {
      key: "changeIntegrityUnexplained" as const,
      category: "change_integrity" as const,
      severity: "high" as const,
      title: "Review unexplained configuration changes",
      detail:
        "At detection time, a fresh snapshot contained material fields without unambiguous latest recorded operation evidence. Equal-time latest operations can agree, while conflicting tied values remain unexplained. Review the comparison; this does not identify who made the change.",
      deliveryImpact: "unknown" as const,
      targetTab: "experiments" as const,
    },
    {
      key: "changeIntegrityIndeterminate" as const,
      category: "change_integrity" as const,
      severity: "medium" as const,
      title: "Review indeterminate change evidence",
      detail:
        "At detection time, a material change had indeterminate retained evidence because snapshot timing was ambiguous or the operation outcome was not confirmed. Verify the current provider state and record the review.",
      deliveryImpact: "unknown" as const,
      targetTab: "experiments" as const,
    },
    {
      key: "reconciliationRequired" as const,
      category: "reconciliation" as const,
      severity: "critical" as const,
      title: "Resolve unknown provider outcomes",
      detail:
        "Check the provider state in Ads Manager, then reconcile the durable workflow record before attempting another write.",
      deliveryImpact: "unknown" as const,
      targetTab: "experiments" as const,
    },
    {
      key: "monitoringFailures" as const,
      category: "monitoring" as const,
      severity: "critical" as const,
      title: "Restore failed monitoring evaluations",
      detail:
        "One or more completed windows could not be evaluated. Missing provider evidence has not been treated as zero.",
      deliveryImpact: "unknown" as const,
      targetTab: "experiments" as const,
    },
    {
      key: "safeguardTriggered" as const,
      category: "monitoring" as const,
      severity: "high" as const,
      title: "Review triggered safeguards",
      detail:
        "Post-change evidence crossed a stored safeguard. Human rollback review is required; MaintainFlow does not auto-rollback.",
      deliveryImpact: "at_risk" as const,
      targetTab: "experiments" as const,
    },
    {
      key: "insufficientEvidence" as const,
      category: "monitoring" as const,
      severity: "high" as const,
      title: "Complete monitoring evidence",
      detail:
        "The monitoring result was inconclusive. Refresh delivery and click-attributed conversion evidence before declaring the change safe.",
      deliveryImpact: "unknown" as const,
      targetTab: "experiments" as const,
    },
  ];

  return definitions.flatMap((definition): PortfolioActionItem[] => {
    const exception = account.operationalExceptions[definition.key];
    const representedCount =
      definition.key === "changeIntegrityUnexplained"
        ? representedChangeIntegrity.unexplained
        : definition.key === "changeIntegrityIndeterminate"
          ? representedChangeIntegrity.indeterminate
          : 0;
    const remainingCount = Math.max(0, exception.count - representedCount);
    if (remainingCount === 0) return [];
    return [
      {
        id: `${account.accountId}:live:${definition.key}`,
        source: "live",
        accountId: account.accountId,
        accountName: account.accountName,
        category: definition.category,
        severity: definition.severity,
        title: `${definition.title} (${remainingCount})`,
        detail: definition.detail,
        evidenceLabel: "Current durable workflow state",
        evidenceAt: exception.oldestAt,
        freshness: "current",
        deliveryImpact: definition.deliveryImpact,
        moneyAtRisk: unknownMoney(
          "Operational exception records do not contain comparable account currency or spend.",
        ),
        occurrenceCount: remainingCount,
        targetTab: definition.targetTab,
      },
    ];
  });
}

function evidenceStateAction(
  account: LivePortfolioAccount,
): PortfolioActionItem[] {
  if (account.evidenceState === "confirmed_fresh") return [];
  const stale = account.evidenceState === "confirmed_stale";
  const expired = account.evidenceState === "confirmed_expired";
  const title = stale
    ? "Refresh the stale Ads snapshot"
    : expired
      ? "Replace the expired Ads snapshot"
      : account.evidenceState === "not_confirmed"
        ? "Create the first confirmed Ads snapshot"
        : account.evidenceState === "refresh_required"
          ? "Refresh the incompatible Ads snapshot"
          : "Repair invalid portfolio evidence";

  return [
    {
      id: `${account.accountId}:live:evidence:${account.evidenceState}`,
      source: "live",
      accountId: account.accountId,
      accountName: account.accountName,
      category: "evidence",
      severity: stale ? "medium" : "high",
      title,
      detail:
        "MaintainFlow will not treat missing or expired provider evidence as a healthy zero, and external writes remain locked without a fresh confirmed snapshot.",
      evidenceLabel:
        account.detectedSignalCount === null
          ? "Detected signals unknown"
          : `${account.detectedSignalCount} detected signal${account.detectedSignalCount === 1 ? "" : "s"} in retained snapshot`,
      evidenceAt: account.evidenceAt,
      freshness: stale || expired ? "stale" : "unknown",
      deliveryImpact: "unknown",
      moneyAtRisk: unknownMoney(
        "Spend and currency are intentionally absent from compact portfolio evidence.",
      ),
      occurrenceCount: 1,
      targetTab: stale || expired ? "campaigns" : "workspace",
    },
  ];
}

function detectedSignalAction(
  account: LivePortfolioAccount,
): PortfolioActionItem[] {
  if (
    account.detectedSignalCount === null ||
    account.detectedSignalCount === 0
  ) {
    return [];
  }
  const current = account.evidenceState === "confirmed_fresh";
  return [
    {
      id: `${account.accountId}:live:detected-signals`,
      source: "live",
      accountId: account.accountId,
      accountName: account.accountName,
      category: "recommendation",
      severity: current ? "high" : "medium",
      title: `Review ${account.detectedSignalCount} detected Ads signal${account.detectedSignalCount === 1 ? "" : "s"}`,
      detail:
        "Open the advertiser workspace to inspect the evidence, exact proposed request, stored rollback, and safeguard for each signal.",
      evidenceLabel: current
        ? "Confirmed portfolio snapshot"
        : "Retained snapshot; refresh required",
      evidenceAt: account.evidenceAt,
      freshness: current ? "current" : "stale",
      deliveryImpact: "unknown",
      moneyAtRisk: unknownMoney(
        "Compact portfolio evidence stores a signal count, not a comparable amount at risk.",
      ),
      occurrenceCount: account.detectedSignalCount,
      targetTab: "review",
    },
  ];
}

export function buildLivePortfolioActionQueue(
  accounts: readonly LivePortfolioAccount[],
  expandedEvidence?: LivePortfolioExpandedEvidence,
) {
  const expandedAccountId = expandedEvidence?.accountId;
  const representedChangeIntegrity = (expandedEvidence?.changeIntegrityEvents ?? [])
    .filter((event) => event.reviewStatus === "open")
    .reduce(
      (counts, event) => {
        if (event.classification === "unexplained") counts.unexplained += 1;
        if (event.classification === "indeterminate") counts.indeterminate += 1;
        return counts;
      },
      { unexplained: 0, indeterminate: 0 },
    );
  const compactActions = accounts.flatMap((account) => [
    ...liveOperationalActions(
      account,
      account.accountId === expandedAccountId
        ? representedChangeIntegrity
        : undefined,
    ),
    ...evidenceStateAction(account),
    ...(account.accountId === expandedAccountId
      ? []
      : detectedSignalAction(account)),
  ]);
  const expandedActions = expandedEvidence
    ? detailedAccountActions({ source: "live", ...expandedEvidence })
    : [];
  return rankPortfolioActionItems([...compactActions, ...expandedActions]);
}

export function summarizePortfolioActionQueue(
  items: readonly PortfolioActionItem[],
) {
  const knownMoneyByCurrency = new Map<string, number>();
  for (const item of items) {
    if (item.moneyAtRisk.state !== "known") continue;
    knownMoneyByCurrency.set(
      item.moneyAtRisk.currencyCode,
      (knownMoneyByCurrency.get(item.moneyAtRisk.currencyCode) ?? 0) +
        item.moneyAtRisk.amountMicros,
    );
  }

  return {
    totalCount: items.length,
    urgentCount: items.filter(
      (item) => item.severity === "critical" || item.severity === "high",
    ).length,
    blockedDeliveryCount: items.filter(
      (item) => item.deliveryImpact === "blocked",
    ).length,
    unknownMoneyCount: items.filter(
      (item) => item.moneyAtRisk.state === "unknown",
    ).length,
    knownMoneyByCurrency: [...knownMoneyByCurrency.entries()]
      .map(([currencyCode, amountMicros]) => ({
        currencyCode,
        amountMicros,
      }))
      .sort((left, right) =>
        left.currencyCode.localeCompare(right.currencyCode),
      ),
  };
}
