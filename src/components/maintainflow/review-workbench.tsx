"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignOutButton } from "@clerk/nextjs";
import {
  ArrowDownRight,
  ArrowRight,
  BarChart3,
  Check,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  FileClock,
  Gauge,
  Info,
  Loader2,
  LogOut,
  RefreshCcw,
  RotateCcw,
  SearchCheck,
  ShieldCheck,
  Sparkles,
  Target,
  X,
} from "lucide-react";
import {
  formatGroupedInteger,
  formatUtcDateTime,
} from "@/lib/formatting";
import { toast } from "sonner";

import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { ApprovalHistory } from "@/components/maintainflow/approval-history";
import { ChangeAssuranceReportCard } from "@/components/maintainflow/change-assurance-report-card";
import { CreativeReviewHistory } from "@/components/maintainflow/creative-review-history";
import { CreativeReviewTable } from "@/components/maintainflow/creative-review-table";
import { BudgetGuard } from "@/components/maintainflow/budget-guard";
import { MonitoringWindows } from "@/components/maintainflow/monitoring-windows";
import { ReadinessWorkbench } from "@/components/maintainflow/readiness-workbench";
import { RecommendationDecisionHistory } from "@/components/maintainflow/recommendation-decision-history";
import {
  WorkspaceOnboarding,
  type WorkspaceSetupState,
} from "@/components/maintainflow/workspace-onboarding";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  buildAppHref,
  parseAppTab,
  replaceAppTabInUrl,
  type AppTab,
} from "@/lib/app-navigation";
import type { AdAccount, Campaign, ScopedAd } from "@/lib/openai-ads/schema";
import type { ApprovalRecordDto } from "@/lib/audit/approval-schema";
import type { RecommendationDecisionHistoryDto } from "@/lib/audit/recommendation-decision";
import type { CreativeReviewEvent } from "@/lib/openai-ads/creative-history";
import type { MonitoringWindowDto } from "@/lib/openai-ads/monitoring";
import { buildMonitoringWindows } from "@/lib/openai-ads/recommendation-lifecycle";
import type { ConversionMeasurementReadiness } from "@/lib/openai-ads/measurement-readiness";
import type { BudgetGuardEvidence } from "@/lib/openai-ads/budget-guard";
import type { ConversionsConnectionStatus } from "@/lib/openai-ads/conversions-connection";
import {
  livePortfolioOperationalExceptionCount,
  livePortfolioUrgency,
  oldestLivePortfolioExceptionAt,
  rankLivePortfolioAccounts,
  summarizeLivePortfolioEvidence,
  type LivePortfolioAccount,
  type LivePortfolioEvidenceState,
  type LivePortfolioExceptionEvidence,
  type LivePortfolioUrgency,
} from "@/lib/openai-ads/live-portfolio";
import type { ReadinessAuditHistoryEntry } from "@/lib/readiness/history";
import {
  canWriteAccount,
  type AccountAccess,
} from "@/lib/tenancy/schema";
import type {
  CampaignPerformance,
  Recommendation,
  RecommendationStatus,
} from "@/lib/openai-ads/demo-data";
import type { SimulatedAccountOption } from "@/lib/openai-ads/simulated-workspaces";
import { cn } from "@/lib/utils";

type WorkbenchProps = {
  initialTab: AppTab;
  account: AdAccount;
  ads: ScopedAd[];
  creativeReviewHistory: CreativeReviewEvent[];
  creativeHistoryReady: boolean;
  creativeHistoryError?: string;
  campaigns: Campaign[];
  performance: CampaignPerformance[];
  budgetGuardEvidence: BudgetGuardEvidence[];
  initialRecommendations: Recommendation[];
  recommendationApprovalFingerprints: Record<string, string>;
  recommendationFingerprints: Record<string, string>;
  dataSource: "demo" | "live";
  writeMode: "demo" | "live";
  syncedAt?: string;
  snapshotAvailable: boolean;
  syncError?: string;
  syncWarning?: string;
  operator: { id: string; name: string; initials: string };
  operatorAuthenticated: boolean;
  authConfigured: boolean;
  writeBlockers: string[];
  approvalHistory: ApprovalRecordDto[];
  monitoringWindows: MonitoringWindowDto[];
  monitoringEvaluationError?: string;
  conversionMeasurement: ConversionMeasurementReadiness;
  approvalHistoryError?: string;
  approvalHistoryReady: boolean;
  workspaceSetupState: WorkspaceSetupState;
  workspaceAccess?: AccountAccess;
  workspaceAccountName?: string;
  workspaceMessage?: string;
  conversionsConnection: ConversionsConnectionStatus;
  availableAccounts: AccountAccess[];
  agencyClientAttachEnabled: boolean;
  simulatedAccounts: SimulatedAccountOption[];
  simulatorLabel: string;
  livePortfolioVisible: boolean;
  livePortfolioAccounts: LivePortfolioAccount[];
  livePortfolioError?: string;
  recommendationDecisionReady: boolean;
  recommendationDecisionError?: string;
  canManageRecommendationDecisions: boolean;
  recommendationDecisionHistory: RecommendationDecisionHistoryDto[];
  readinessHistoryReady: boolean;
  readinessHistoryError?: string;
  initialReadinessHistory: ReadinessAuditHistoryEntry[];
  readinessHistoryCanSave: boolean;
};

type AuditEvent = {
  id: string;
  occurredAt: string;
  action: string;
  entity: string;
  outcome: string;
  mode: "demo" | "live";
};

type RecommendationApplyResponse = {
  applied?: boolean;
  error?: string;
  message?: string;
  mode?: "demo" | "live";
};

export function isConfirmedLiveApplyResponse(
  result: RecommendationApplyResponse,
) {
  return result.mode === "live" && result.applied === true;
}

export function canReconcileApprovalHistory(
  approvalHistoryReady: boolean,
  workspaceAccess: AccountAccess | undefined,
) {
  return Boolean(
    approvalHistoryReady &&
      workspaceAccess &&
      canWriteAccount(workspaceAccess),
  );
}

export function RecommendationApprovalConfirmation({
  account,
  recommendation,
  dataSource,
  writeMode,
  syncedAt,
}: {
  account: AdAccount;
  recommendation: Recommendation;
  dataSource: "demo" | "live";
  writeMode: "demo" | "live";
  syncedAt?: string;
}) {
  const liveWrite = dataSource === "live" && writeMode === "live";
  const sourceLabel =
    dataSource === "demo"
      ? "Labelled simulator fixture"
      : syncedAt
        ? `Confirmed ${formatUtcDateTime(syncedAt, { includeTimeZone: true })}`
        : "No confirmed live snapshot";

  return (
    <div className="grid gap-3 text-sm">
      <Alert
        className={cn(
          liveWrite && "border-warning/30 bg-warning/10 text-foreground",
        )}
      >
        <ShieldCheck />
        <AlertTitle>
          {liveWrite
            ? `Live write to ${account.name}`
            : dataSource === "demo"
              ? "Simulator approval only"
              : "External write is locked"}
        </AlertTitle>
        <AlertDescription>
          {liveWrite
            ? "Confirm the advertiser, exact API request, stored rollback, and safeguard before sending this non-idempotent change."
            : dataSource === "demo"
              ? "This records a local workflow example. It does not contact OpenAI Ads."
              : "MaintainFlow will not contact OpenAI Ads until every live-write gate is restored."}
        </AlertDescription>
      </Alert>

      <dl className="grid gap-3 rounded-lg border bg-muted/40 p-4">
        <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">Advertiser</dt>
          <dd className="min-w-0">
            <span className="font-medium">{account.name}</span>
            <span className="sr-only">, advertiser ID </span>
            <span
              aria-hidden="true"
              className="mx-2 text-muted-foreground"
            >
              ·
            </span>
            <span className="break-all font-mono text-xs text-muted-foreground">
              {account.id}
            </span>
          </dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">Evidence source</dt>
          <dd>{sourceLabel}</dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">API request</dt>
          <dd className="break-all font-mono text-xs">
            {recommendation.mutation.method} {recommendation.mutation.path}
          </dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">Stored rollback</dt>
          <dd className="break-all font-mono text-xs">
            {recommendation.rollback.method} {recommendation.rollback.path}
          </dd>
        </div>
        <div className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-4">
          <dt className="text-muted-foreground">Change</dt>
          <dd
            aria-label={`Current ${recommendation.currentValue}; proposed ${recommendation.proposedValue}`}
          >
            <span aria-hidden="true" className="font-medium">
              {recommendation.currentValue}
            </span>
            <span className="mx-2 text-muted-foreground" aria-hidden="true">
              →
            </span>
            <span aria-hidden="true" className="font-medium text-primary">
              {recommendation.proposedValue}
            </span>
          </dd>
        </div>
      </dl>

      <div className="grid gap-3 sm:grid-cols-2">
        <CodePayload title="Exact request body" mutation={recommendation.mutation} />
        <CodePayload title="Exact stored rollback body" mutation={recommendation.rollback} />
      </div>

      <div className="grid gap-1 rounded-lg border p-4">
        <p className="font-medium">Safeguard and human rollback review</p>
        <p className="text-muted-foreground">{recommendation.safeguard}</p>
      </div>
    </div>
  );
}

function moneyFormatter(currencyCode: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 0,
  });
}

function statusBadge(status: RecommendationStatus) {
  if (status === "monitoring") {
    return (
      <Badge className="border-success/20 bg-success/10 text-success hover:bg-success/10">
        Monitoring
      </Badge>
    );
  }
  if (status === "dismissed") {
    return <Badge variant="secondary">Dismissed</Badge>;
  }
  return <Badge variant="outline">Ready</Badge>;
}

export function MaintainFlowWorkbench({
  initialTab,
  account,
  ads,
  creativeReviewHistory,
  creativeHistoryReady,
  creativeHistoryError,
  campaigns,
  performance,
  budgetGuardEvidence,
  initialRecommendations,
  recommendationApprovalFingerprints,
  recommendationFingerprints,
  dataSource,
  writeMode,
  syncedAt,
  snapshotAvailable,
  syncError,
  syncWarning,
  operator,
  operatorAuthenticated,
  authConfigured,
  writeBlockers,
  approvalHistory,
  monitoringWindows,
  monitoringEvaluationError,
  conversionMeasurement,
  approvalHistoryError,
  approvalHistoryReady,
  workspaceSetupState,
  workspaceAccess,
  workspaceAccountName,
  workspaceMessage,
  conversionsConnection,
  availableAccounts,
  agencyClientAttachEnabled,
  simulatedAccounts,
  simulatorLabel,
  livePortfolioVisible,
  livePortfolioAccounts,
  livePortfolioError,
  recommendationDecisionReady,
  recommendationDecisionError,
  canManageRecommendationDecisions,
  recommendationDecisionHistory,
  readinessHistoryReady,
  readinessHistoryError,
  initialReadinessHistory,
  readinessHistoryCanSave,
}: WorkbenchProps) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const tabListRef = useRef<HTMLDivElement>(null);
  const approvalTitleRef = useRef<HTMLHeadingElement>(null);
  const [demoRecommendations, setDemoRecommendations] = useState(
    initialRecommendations,
  );
  const [demoApprovalHistory, setDemoApprovalHistory] = useState(
    dataSource === "demo" ? approvalHistory : [],
  );
  const recommendations =
    dataSource === "live" ? initialRecommendations : demoRecommendations;
  const visibleApprovalHistory =
    dataSource === "demo" ? demoApprovalHistory : approvalHistory;
  const visibleMonitoringWindows = useMemo(
    () =>
      dataSource === "demo"
        ? buildMonitoringWindows(demoApprovalHistory)
        : monitoringWindows,
    [dataSource, demoApprovalHistory, monitoringWindows],
  );
  const [selectedId, setSelectedId] = useState(
    initialRecommendations[0]?.id ?? "",
  );
  const [filter, setFilter] = useState("all");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [dismissalOpen, setDismissalOpen] = useState(false);
  const [dismissalReason, setDismissalReason] = useState("");
  const [deciding, setDeciding] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const initialAuditEvent: AuditEvent | null = snapshotAvailable
    ? {
        id: "initial-review",
        occurredAt: syncedAt ?? "Simulator snapshot",
        action: "Account review completed",
        entity: account.name,
        outcome: `${initialRecommendations.length} recommendations prepared`,
        mode: dataSource,
      }
    : null;
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(
    initialAuditEvent ? [initialAuditEvent] : [],
  );

  useEffect(() => {
    tabListRef.current
      ?.querySelector<HTMLElement>('[data-state="active"]')
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activeTab]);

  function changeTab(value: string) {
    const nextTab = parseAppTab(value);
    if (!nextTab) return;
    setActiveTab(nextTab);

    window.history.replaceState(
      null,
      "",
      replaceAppTabInUrl(window.location, nextTab),
    );
  }

  function openAccount(accountId: string) {
    router.push(buildAppHref({ tab: activeTab, accountId }));
  }

  const selected =
    recommendations.find((recommendation) => recommendation.id === selectedId) ??
    recommendations[0] ??
    null;

  const filteredRecommendations = useMemo(
    () =>
      recommendations.filter((recommendation) => {
        if (filter === "high") return recommendation.priority === "high";
        if (filter === "ready") return recommendation.status === "ready";
        return true;
      }),
    [filter, recommendations],
  );

  const readyCount = recommendations.filter(
    (recommendation) => recommendation.status === "ready",
  ).length;

  const connectionStatusTone =
    syncError && dataSource === "live"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : syncWarning && dataSource === "live"
        ? "border-warning/30 bg-warning/10 text-warning-foreground"
        : dataSource === "live"
          ? "border-success/30 bg-success/10 text-success"
          : "border-warning/30 bg-warning/10 text-warning-foreground";
  const connectionStatusDot =
    syncError && dataSource === "live"
      ? "bg-destructive"
      : syncWarning && dataSource === "live"
        ? "bg-warning"
        : dataSource === "live"
          ? "bg-success"
          : "bg-warning";
  const connectionStatusTitle =
    syncError && dataSource === "live"
      ? "The connected account has no confirmed live snapshot"
      : syncWarning && dataSource === "live"
        ? "The last confirmed snapshot is visible, but live writes are locked until refresh succeeds"
        : syncedAt
          ? `Last synced ${formatUtcDateTime(syncedAt, { includeTimeZone: true })}`
          : dataSource === "live"
            ? "Live account connected; awaiting a confirmed snapshot"
            : simulatorLabel;
  const connectionStatusText =
    workspaceSetupState === "needs_setup"
      ? "Setup required"
      : workspaceSetupState === "unavailable" && dataSource === "demo"
        ? "Access locked"
        : syncError && dataSource === "live"
          ? "Live sync unavailable"
          : syncWarning && dataSource === "live"
            ? "Live data · stale"
            : dataSource === "demo"
              ? "Simulator data"
              : writeMode === "live"
                ? "Live · writes on"
                : "Live data · writes off";
  const accountSelectorVisible =
    workspaceSetupState === "demo" ||
    workspaceSetupState === "ready" ||
    workspaceSetupState === "connection_error";
  const selectableAccounts: SimulatedAccountOption[] =
    dataSource === "demo"
      ? simulatedAccounts
      : availableAccounts.map((item) => ({
          accountId: item.accountId,
          accountName: item.accountName,
        }));
  const accountSelectorOptions =
    selectableAccounts.length > 0
      ? selectableAccounts
      : [{ accountId: account.id, accountName: account.name }];
  const selectedAccountId =
    dataSource === "demo"
      ? account.id
      : workspaceAccess?.accountId ?? account.id;

  function changeAccount(accountId: string) {
    if (accountSelectorOptions.some((item) => item.accountId === accountId)) {
      openAccount(accountId);
    }
  }

  function updateStatus(
    id: string,
    status: RecommendationStatus,
    dismissal?: Recommendation["dismissal"],
  ) {
    setDemoRecommendations((current) =>
      current.map((recommendation) =>
        recommendation.id === id
          ? {
              ...recommendation,
              status,
              dismissal: status === "dismissed" ? dismissal : undefined,
            }
          : recommendation,
      ),
    );
  }

  function addAuditEvent(event: Omit<AuditEvent, "id" | "occurredAt">) {
    setAuditEvents((current) => [
      {
        ...event,
        id: `${event.action}-${Date.now()}`,
        occurredAt: new Date().toISOString(),
      },
      ...current,
    ]);
  }

  async function approveRecommendation() {
    if (!selected) return;

    setApplying(true);
    try {
      if (dataSource === "demo") {
        updateStatus(selected.id, "monitoring");
        const startedAt = new Date();
        const monitoringEndsAt = selected.monitoringPlan
          ? new Date(
              startedAt.getTime() +
                selected.monitoringPlan.windowDays * 24 * 60 * 60 * 1_000,
            ).toISOString()
          : null;
        setDemoApprovalHistory((current) => [
          {
            id: crypto.randomUUID(),
            accountId: account.id,
            organizationName: `${account.name} simulator`,
            membershipRole: null,
            accountRole: null,
            recommendationId: selected.id,
            recommendationTitle: selected.title,
            entityId: selected.entityId,
            mutation: selected.mutation,
            rollbackMethod: selected.rollback.method,
            rollbackPath: selected.rollback.path,
            rollbackBody: selected.rollback.body,
            evidence: selected.evidence,
            safeguard: selected.safeguard,
            status: "applied",
            errorMessage: null,
            reconciliationNote: null,
            monitoringPlan: selected.monitoringPlan ?? null,
            monitoringStartedAt: selected.monitoringPlan
              ? startedAt.toISOString()
              : null,
            monitoringEndsAt,
            monitoringOutcome: null,
            monitoringObservation: null,
            monitoringEvaluatedAt: null,
            createdAt: startedAt.toISOString(),
            updatedAt: startedAt.toISOString(),
            appliedAt: startedAt.toISOString(),
            rolledBackAt: null,
          },
          ...current,
        ]);
        const message =
          "Simulated approval recorded locally. No OpenAI Ads request was sent.";
        addAuditEvent({
          action: "Simulated approval recorded",
          entity: selected.entityLabel,
          outcome: message,
          mode: "demo",
        });
        setApprovalOpen(false);
        toast.success("Simulator approval recorded", {
          description: message,
        });
        return;
      }
      if (!workspaceAccess) {
        throw new Error("Select an authorized advertiser account first.");
      }

      const response = await fetch("/api/ads/recommendations/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId: selected.id,
          accountId: workspaceAccess.accountId,
          recommendationSource: selected.source,
          recommendationFingerprint:
            recommendationApprovalFingerprints[selected.id],
        }),
      });
      const result = (await response.json()) as RecommendationApplyResponse;

      if (!response.ok) throw new Error(result.error ?? "Approval failed.");
      if (!isConfirmedLiveApplyResponse(result)) {
        const message =
          result.message ??
          "MaintainFlow did not send a live Ads change because the release gates changed.";
        addAuditEvent({
          action: "No live change sent",
          entity: selected.entityLabel,
          outcome: message,
          mode: result.mode === "live" ? "live" : "demo",
        });
        setApprovalOpen(false);
        toast.warning("No live change sent", {
          description: `${message} Refresh the workspace before reviewing again.`,
        });
        router.refresh();
        return;
      }

      addAuditEvent({
        action: "Change applied",
        entity: selected.entityLabel,
        outcome:
          result.message ?? "Recommendation moved to its monitoring window.",
        mode: "live",
      });
      setApprovalOpen(false);
      toast.success("Change applied", {
        description:
          result.message ?? "The recommendation is now being monitored.",
      });
      router.refresh();
    } catch (error) {
      toast.error("Unable to approve recommendation", {
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setApplying(false);
    }
  }

  async function recordRecommendationDecision(
    action: "dismiss" | "restore",
  ) {
    if (!selected || !recommendationDecisionReady) return;
    if (action === "dismiss" && dismissalReason.trim().length < 5) return;

    setDeciding(true);
    try {
      let message =
        action === "dismiss"
          ? "Recommendation dismissed for this demo session."
          : "Recommendation restored for review.";

      if (dataSource === "live") {
        if (!workspaceAccess) {
          throw new Error("Select an authorized advertiser account first.");
        }
        const response = await fetch("/api/ads/recommendations/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountId: workspaceAccess.accountId,
            recommendationId: selected.id,
            recommendationFingerprint: recommendationFingerprints[selected.id],
            action,
            reason:
              action === "dismiss" ? dismissalReason.trim() : undefined,
          }),
        });
        const result = (await response.json()) as {
          error?: string;
          message?: string;
        };
        if (!response.ok) {
          throw new Error(
            result.error ?? "The recommendation decision could not be recorded.",
          );
        }
        message = result.message ?? message;
      } else if (action === "dismiss") {
        updateStatus(selected.id, "dismissed", {
          reason: dismissalReason.trim(),
          dismissedAt: new Date().toISOString(),
        });
      } else {
        updateStatus(selected.id, "ready");
      }

      addAuditEvent({
        action:
          action === "dismiss"
            ? "Recommendation dismissed"
            : "Recommendation restored",
        entity: selected.entityLabel,
        outcome:
          action === "dismiss"
            ? `${dismissalReason.trim()} No Ads mutation was made.`
            : "Returned to active review. No Ads mutation was made.",
        mode: dataSource,
      });
      setDismissalOpen(false);
      setDismissalReason("");
      toast.success(
        action === "dismiss"
          ? "Recommendation dismissed"
          : "Recommendation restored",
        { description: message },
      );
      if (dataSource === "live") router.refresh();
    } catch (error) {
      toast.error(
        action === "dismiss"
          ? "Unable to dismiss recommendation"
          : "Unable to restore recommendation",
        {
          description:
            error instanceof Error ? error.message : "Please try again.",
        },
      );
    } finally {
      setDeciding(false);
    }
  }

  async function runAccountReview() {
    setReviewing(true);

    if (dataSource === "live") {
      addAuditEvent({
        action: "Live snapshot reload requested",
        entity: account.name,
        outcome:
          "Reloading the latest confirmed snapshot. Provider refreshes are automatically coalesced to protect API quota.",
        mode: "live",
      });
      router.refresh();
      toast.success("Live snapshot reload requested", {
        description:
          "MaintainFlow will use a recent confirmed snapshot or refresh it when its freshness window has elapsed.",
      });
      setReviewing(false);
      return;
    }

    await new Promise((resolve) => window.setTimeout(resolve, 450));
    addAuditEvent({
      action: "Simulator review completed",
      entity: account.name,
      outcome: `${initialRecommendations.length} schema-valid checks evaluated.`,
      mode: "demo",
    });
    toast.success("Simulator review complete", {
      description: `${initialRecommendations.length} schema-valid checks were evaluated without contacting the Ads API.`,
    });
    setReviewing(false);
  }

  function resetDemoState() {
    setDemoRecommendations(initialRecommendations);
    setDemoApprovalHistory(approvalHistory);
    setSelectedId(initialRecommendations[0]?.id ?? "");
    setFilter("all");
    setDismissalOpen(false);
    setDismissalReason("");
    setAuditEvents(initialAuditEvent ? [initialAuditEvent] : []);
    toast.success("Simulator reset", {
      description: "Recommendation statuses and this session's audit trail were restored.",
    });
  }

  return (
    <main className="min-h-screen bg-[#FAFAFA] text-foreground">
      <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur">
        <div className="flex min-h-16 items-center gap-4 px-4 md:px-6">
          <MaintainFlowBrand />
          <Separator orientation="vertical" className="hidden h-6 md:block" />
          <div className="ml-auto flex items-center gap-2 md:gap-3">
            <Badge
              variant="outline"
              className={cn(
                "hidden gap-1.5 md:inline-flex",
                connectionStatusTone,
              )}
              title={connectionStatusTitle}
            >
              <span
                className={cn("size-1.5 rounded-full", connectionStatusDot)}
              />
              {connectionStatusText}
            </Badge>
            {accountSelectorVisible ? (
              <Select value={selectedAccountId} onValueChange={changeAccount}>
                <SelectTrigger
                  className="hidden w-[190px] bg-background md:flex"
                  aria-label="Ad account"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {accountSelectorOptions.map((item) => (
                      <SelectItem key={item.accountId} value={item.accountId}>
                        {item.accountName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="h-10 gap-2 px-2"
                  aria-label="Open profile menu"
                >
                  <Avatar className="size-7">
                    <AvatarFallback className="bg-primary text-xs font-semibold text-primary-foreground">
                      {operator.initials}
                    </AvatarFallback>
                  </Avatar>
                  <ChevronDown data-icon="inline-end" className="hidden md:block" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>{operator.name}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuItem disabled>
                    {operatorAuthenticated
                      ? "Authenticated operator"
                      : "Simulator operator"}
                  </DropdownMenuItem>
                  {!operatorAuthenticated ? (
                    <DropdownMenuItem asChild>
                      <a href="/auth/sign-in">
                        {authConfigured ? "Sign in" : "View access setup"}
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                  {dataSource === "demo" ? (
                    <DropdownMenuItem onSelect={resetDemoState}>
                      Reset current session
                    </DropdownMenuItem>
                  ) : null}
                  {operatorAuthenticated ? (
                    <SignOutButton redirectUrl="/">
                      <DropdownMenuItem>
                        <LogOut data-icon="inline-start" />
                        Sign out
                      </DropdownMenuItem>
                    </SignOutButton>
                  ) : null}
                </DropdownMenuGroup>
                {(dataSource === "demo"
                  ? simulatedAccounts.length > 1
                  : availableAccounts.length > 0) ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>
                      {dataSource === "demo"
                        ? "Simulated advertiser accounts"
                        : "Advertiser accounts"}
                    </DropdownMenuLabel>
                    <DropdownMenuGroup>
                      {(dataSource === "demo"
                        ? simulatedAccounts
                        : availableAccounts
                      ).map((item) => (
                        <DropdownMenuItem
                          key={item.accountId}
                          onSelect={() => openAccount(item.accountId)}
                        >
                          {item.accountId ===
                          (dataSource === "demo"
                            ? account.id
                            : workspaceAccess?.accountId) ? (
                            <Check data-icon="inline-start" />
                          ) : null}
                          {item.accountName}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuGroup>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div
          className="flex items-center gap-2 border-t px-4 py-2 md:hidden"
          role="group"
          aria-label="Mobile data source and account"
        >
          <Badge
            variant="outline"
            className={cn("shrink-0 gap-1.5", connectionStatusTone)}
            title={connectionStatusTitle}
          >
            <span
              className={cn("size-1.5 rounded-full", connectionStatusDot)}
            />
            {connectionStatusText}
          </Badge>
          {accountSelectorVisible ? (
            <Select value={selectedAccountId} onValueChange={changeAccount}>
              <SelectTrigger
                className="h-8 min-w-0 flex-1 bg-background text-xs"
                aria-label="Mobile ad account"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {accountSelectorOptions.map((item) => (
                    <SelectItem key={item.accountId} value={item.accountId}>
                      {item.accountName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </header>

      {syncError ? (
        <div className="border-b bg-background px-4 py-3 md:px-6">
          <Alert variant="destructive" className="mx-auto max-w-7xl">
            <Info />
            <AlertTitle>Live connection unavailable</AlertTitle>
            <AlertDescription>{syncError}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {syncWarning ? (
        <div className="border-b bg-background px-4 py-3 md:px-6">
          <Alert className="mx-auto max-w-7xl">
            <Info />
            <AlertTitle>Live data may be stale</AlertTitle>
            <AlertDescription>{syncWarning}</AlertDescription>
          </Alert>
        </div>
      ) : null}

      {dataSource === "live" && writeMode === "demo" && writeBlockers.length > 0 ? (
        <div className="border-b bg-background px-4 py-3 md:px-6">
          <Alert className="mx-auto max-w-7xl">
            <ShieldCheck />
            <AlertTitle>Live account is review-only</AlertTitle>
            <AlertDescription>
              External changes remain locked. Missing gates: {writeBlockers.join(", ")}.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      {dataSource === "live" && recommendationDecisionError ? (
        <div className="border-b bg-background px-4 py-3 md:px-6">
          <Alert className="mx-auto max-w-7xl">
            <FileClock />
            <AlertTitle>Saved review decisions unavailable</AlertTitle>
            <AlertDescription>
              {recommendationDecisionError} Approval review remains available,
              but dismissal is locked rather than pretending the decision will
              survive a refresh.
            </AlertDescription>
          </Alert>
        </div>
      ) : null}

      <Tabs
        value={activeTab}
        onValueChange={changeTab}
        className="w-full"
      >
        <div className="overflow-x-auto border-b bg-background px-4 md:px-6">
          <TabsList
            ref={tabListRef}
            aria-label="MaintainFlow workspace"
            className="h-12 w-max justify-start gap-1 rounded-none bg-transparent p-0"
          >
            <TabsTrigger
              value="review"
              className="h-12 rounded-none border-b-2 border-transparent px-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Review
              <Badge variant="secondary" className="ml-2 px-1.5 py-0">
                {readyCount}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="campaigns"
              className="h-12 rounded-none border-b-2 border-transparent px-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Campaigns
            </TabsTrigger>
            <TabsTrigger
              value="experiments"
              className="h-12 rounded-none border-b-2 border-transparent px-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Experiments
            </TabsTrigger>
            <TabsTrigger
              value="readiness"
              className="h-12 rounded-none border-b-2 border-transparent px-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Readiness
            </TabsTrigger>
            <TabsTrigger
              value="workspace"
              className="h-12 rounded-none border-b-2 border-transparent px-3 shadow-none data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none"
            >
              Workspace
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="review" className="m-0">
          <section className="grid min-h-[calc(100vh-7rem)] sm:grid-cols-[270px_minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)]">
            <aside className="border-b bg-background sm:border-b-0 sm:border-r">
              <div className="flex items-start justify-between gap-3 border-b p-4 md:p-5">
                <div className="grid gap-1">
                  <h1 className="text-base font-semibold">Recommendations</h1>
                  <p className="text-sm text-muted-foreground">
                    Evidence first. You approve every change.
                  </p>
                </div>
                <Select value={filter} onValueChange={setFilter}>
                  <SelectTrigger className="w-[106px]" aria-label="Filter recommendations">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="high">High</SelectItem>
                      <SelectItem value="ready">Ready</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>

              <div className="grid max-h-[42vh] overflow-y-auto p-2 sm:max-h-[calc(100vh-12rem)]">
                {filteredRecommendations.map((recommendation) => (
                  <button
                    key={recommendation.id}
                    type="button"
                    onClick={() => setSelectedId(recommendation.id)}
                    aria-pressed={selected?.id === recommendation.id}
                    className={cn(
                      "grid gap-3 rounded-xl border border-transparent p-3 text-left transition",
                      "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected?.id === recommendation.id &&
                        "border-border bg-muted/70 shadow-sm",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <Badge
                        variant={
                          recommendation.priority === "high" ? "destructive" : "secondary"
                        }
                        className="capitalize"
                      >
                        {recommendation.priority}
                      </Badge>
                      {statusBadge(recommendation.status)}
                    </div>
                    <div className="grid gap-1">
                      <h2 className="text-sm font-semibold leading-5">
                        {recommendation.title}
                      </h2>
                      <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {recommendation.summary}
                      </p>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>{recommendation.entityLabel.split(" · ")[0]}</span>
                      <span>{recommendation.confidence}% confidence</span>
                    </div>
                  </button>
                ))}
                {filteredRecommendations.length === 0 ? (
                  <Empty className="border-0 px-3 py-10">
                    <EmptyHeader>
                      <EmptyMedia variant="icon">
                        <SearchCheck />
                      </EmptyMedia>
                      <EmptyTitle className="text-sm">No matching checks</EmptyTitle>
                      <EmptyDescription>
                        Change the filter or run a fresh account review.
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                ) : null}
              </div>
            </aside>

            {selected ? (
              <RecommendationDetail
                recommendation={selected}
                dataSource={dataSource}
                writeMode={writeMode}
                onApprove={() => setApprovalOpen(true)}
                onDismiss={() => setDismissalOpen(true)}
                onRestore={() => recordRecommendationDecision("restore")}
                canManageDecision={
                  recommendationDecisionReady &&
                  canManageRecommendationDecisions
                }
                deciding={deciding}
              />
            ) : (
              <NoRecommendations
                onReview={runAccountReview}
                reviewing={reviewing}
                syncUnavailable={Boolean(syncError && dataSource === "live")}
              />
            )}
          </section>
        </TabsContent>

        <TabsContent value="campaigns" className="m-0 min-w-0">
          <CampaignsView
            ads={ads}
            creativeReviewHistory={creativeReviewHistory}
            creativeHistoryReady={creativeHistoryReady}
            creativeHistoryError={creativeHistoryError}
            dataSource={dataSource}
            campaigns={campaigns}
            performance={performance}
            budgetGuardEvidence={budgetGuardEvidence}
            currencyCode={account.currency_code}
            recommendationCount={readyCount}
            onReview={runAccountReview}
            reviewing={reviewing}
            snapshotAvailable={snapshotAvailable}
            portfolioAccounts={
              dataSource === "demo" ? simulatedAccounts : []
            }
            livePortfolioVisible={livePortfolioVisible}
            livePortfolioAccounts={livePortfolioAccounts}
            livePortfolioError={livePortfolioError}
            currentAccountId={account.id}
            onOpenAccount={openAccount}
          />
        </TabsContent>

        <TabsContent value="experiments" className="m-0">
          <ExperimentsView
            account={{ id: account.id, name: account.name }}
            recommendations={recommendations}
            dataSource={dataSource}
            currencyCode={account.currency_code}
            monitoringWindows={visibleMonitoringWindows}
            monitoringEvaluationError={monitoringEvaluationError}
            auditEvents={auditEvents}
            approvalHistory={visibleApprovalHistory}
            approvalHistoryError={approvalHistoryError}
            canRollback={writeMode === "live"}
            canReconcile={canReconcileApprovalHistory(
              approvalHistoryReady,
              workspaceAccess,
            )}
            recommendationDecisionHistory={recommendationDecisionHistory}
            recommendationDecisionError={recommendationDecisionError}
          />
        </TabsContent>

        <TabsContent value="readiness" className="m-0">
          <ReadinessWorkbench
            key={workspaceAccess?.accountId ?? "public-readiness"}
            conversionMeasurement={conversionMeasurement}
            campaigns={campaigns}
            dataSource={dataSource}
            account={workspaceAccess}
            historyReady={readinessHistoryReady}
            historyError={readinessHistoryError}
            initialHistory={initialReadinessHistory}
            canSaveHistory={readinessHistoryCanSave}
          />
        </TabsContent>

        <TabsContent value="workspace" className="m-0">
          <WorkspaceOnboarding
            state={workspaceSetupState}
            access={workspaceAccess}
            connectedAccountName={workspaceAccountName}
            message={workspaceMessage}
            conversionsConnection={conversionsConnection}
            agencyClientAttachEnabled={agencyClientAttachEnabled}
          />
        </TabsContent>
      </Tabs>

      <Dialog open={approvalOpen && Boolean(selected)} onOpenChange={setApprovalOpen}>
        <DialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            approvalTitleRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle ref={approvalTitleRef} tabIndex={-1}>
              Approve this change?
            </DialogTitle>
            <DialogDescription>
              MaintainFlow will use the exact request shown in the review and retain
              the rollback payload. {dataSource === "live" && writeMode !== "live"
                ? "External changes are locked until every live-write gate is restored."
                : writeMode === "demo"
                  ? "This is a simulator action. No external write will be made."
                  : "This live recommendation is connected for an external write."}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <RecommendationApprovalConfirmation
              account={account}
              recommendation={selected}
              dataSource={dataSource}
              writeMode={writeMode}
              syncedAt={syncedAt}
            />
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setApprovalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={approveRecommendation}
              disabled={
                applying || (dataSource === "live" && writeMode !== "live")
              }
            >
              {applying ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Check data-icon="inline-start" />
              )}
              {dataSource === "live" && writeMode !== "live"
                ? "External changes locked"
                : writeMode === "demo"
                  ? "Record simulator approval"
                  : "Approve and apply live change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={
          dismissalOpen &&
          Boolean(selected) &&
          selected?.status === "ready"
        }
        onOpenChange={(open) => {
          setDismissalOpen(open);
          if (!open) setDismissalReason("");
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss this recommendation?</DialogTitle>
            <DialogDescription>
              Record why this exact proposed change should leave active review.
              It will surface again if the underlying change or severity is
              materially different.
            </DialogDescription>
          </DialogHeader>
          <Field
            data-invalid={
              dismissalReason.length > 0 && dismissalReason.trim().length < 5
                ? true
                : undefined
            }
          >
            <FieldLabel htmlFor="dismissal-reason">Decision reason</FieldLabel>
            <Textarea
              id="dismissal-reason"
              value={dismissalReason}
              onChange={(event) => setDismissalReason(event.target.value)}
              placeholder="For example: Keep the current bid until the seasonal campaign ends."
              maxLength={500}
              rows={4}
              disabled={deciding}
              autoFocus
            />
            <FieldDescription>
              Stored with the account, operator, roles, and recommendation
              snapshot. {dismissalReason.length}/500 characters.
            </FieldDescription>
            {dismissalReason.length > 0 &&
            dismissalReason.trim().length < 5 ? (
              <FieldError>Enter at least five characters.</FieldError>
            ) : null}
          </Field>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setDismissalOpen(false)}
              disabled={deciding}
            >
              Keep in review
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => recordRecommendationDecision("dismiss")}
              disabled={dismissalReason.trim().length < 5 || deciding}
            >
              {deciding ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <X data-icon="inline-start" />
              )}
              Record dismissal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function RecommendationDetail({
  recommendation,
  dataSource,
  writeMode,
  onApprove,
  onDismiss,
  onRestore,
  canManageDecision,
  deciding,
}: {
  recommendation: Recommendation;
  dataSource: "demo" | "live";
  writeMode: "demo" | "live";
  onApprove: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  canManageDecision: boolean;
  deciding: boolean;
}) {
  return (
    <article className="min-w-0 p-4 md:p-6 lg:p-8">
      <div className="mx-auto grid max-w-5xl gap-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="grid max-w-3xl gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{recommendation.entityLabel}</Badge>
              {dataSource === "demo" ? (
                <Badge variant="secondary">Simulator</Badge>
              ) : null}
              {statusBadge(recommendation.status)}
            </div>
            <div className="grid gap-2">
              <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">
                {recommendation.title}
              </h1>
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground md:text-base">
                {recommendation.rationale}
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          {recommendation.evidence.map((metric, index) => {
            const icons = [CircleDollarSign, Target, BarChart3];
            const Icon = icons[index] ?? Gauge;
            return (
              <Card key={metric.label} className="shadow-sm">
                <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
                  <CardDescription>{metric.label}</CardDescription>
                  <Icon className="size-4 text-muted-foreground" />
                </CardHeader>
                <CardContent className="grid gap-1">
                  <CardTitle className="text-2xl">{metric.value}</CardTitle>
                  <p className="text-xs text-muted-foreground">{metric.detail}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <Card className="overflow-hidden shadow-sm">
          <CardHeader className="border-b bg-muted/30">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
              <div className="grid gap-1">
                <CardTitle className="text-base">Proposed API change</CardTitle>
                <CardDescription>
                  Exact request prepared from the OpenAI Ads schema
                </CardDescription>
              </div>
              <Badge variant="outline" className="w-fit font-mono">
                {recommendation.mutation.method} {recommendation.mutation.path}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-5 p-5 sm:grid-cols-[1fr_auto_1fr] sm:p-6">
            <div className="grid gap-1 rounded-lg border bg-background p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Current
              </span>
              <span className="text-lg font-semibold">{recommendation.currentValue}</span>
            </div>
            <div className="grid place-items-center text-muted-foreground">
              <ArrowRight className="hidden sm:block" />
              <ArrowDownRight className="sm:hidden" />
            </div>
            <div className="grid gap-1 rounded-lg border border-primary/20 bg-primary/5 p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-primary">
                Proposed
              </span>
              <span className="text-lg font-semibold">{recommendation.proposedValue}</span>
            </div>
          </CardContent>
          <CardFooter className="border-t bg-muted/20 px-5 py-4 md:px-6">
            <div className="flex items-start gap-3 text-sm">
              <Sparkles className="mt-0.5 size-4 shrink-0 text-primary" />
              <p>
                <span className="font-medium">Estimated effect: </span>
                <span className="text-muted-foreground">
                  {recommendation.estimatedImpact}
                </span>
              </p>
            </div>
          </CardFooter>
        </Card>

        <div className="grid gap-4 sm:grid-cols-2">
          <Alert className="bg-background">
            <ShieldCheck className="size-4" />
            <AlertTitle>Safeguard and rollback</AlertTitle>
            <AlertDescription>{recommendation.safeguard}</AlertDescription>
          </Alert>
          <Alert className="bg-background">
            <Clock3 className="size-4" />
            <AlertTitle>What happens next</AlertTitle>
            <AlertDescription>{recommendation.nextStep}</AlertDescription>
          </Alert>
        </div>

        {recommendation.status === "dismissed" && recommendation.dismissal ? (
          <Alert className="bg-muted/30">
            <FileClock />
            <AlertTitle>Dismissed from active review</AlertTitle>
            <AlertDescription>
              {recommendation.dismissal.reason} This decision is tied to the
              exact proposed change and can be restored without changing the
              Ads account.
            </AlertDescription>
          </Alert>
        ) : null}

        <details className="group rounded-xl border bg-background shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 p-4 text-sm font-medium">
            View request and rollback payloads
            <ChevronDown className="size-4 text-muted-foreground transition group-open:rotate-180" />
          </summary>
          <Separator />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <CodePayload title="Request" mutation={recommendation.mutation} />
            <CodePayload title="Rollback" mutation={recommendation.rollback} />
          </div>
        </details>

        <div className="flex flex-col-reverse justify-end gap-3 border-t pt-5 sm:flex-row">
          {recommendation.status === "dismissed" ? (
            <Button
              variant="outline"
              onClick={onRestore}
              disabled={!canManageDecision || deciding}
            >
              {deciding ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <RotateCcw data-icon="inline-start" />
              )}
              Restore to review
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                onClick={onDismiss}
                disabled={
                  recommendation.status !== "ready" || !canManageDecision
                }
              >
                <X data-icon="inline-start" />
                Dismiss
              </Button>
              <Button
                onClick={onApprove}
                disabled={
                  recommendation.status !== "ready" ||
                  (dataSource === "live" && writeMode !== "live")
                }
              >
                <Check data-icon="inline-start" />
                {recommendation.status === "monitoring"
                  ? "Monitoring"
                  : writeMode === "live"
                    ? "Approve and apply"
                    : dataSource === "live"
                      ? "External changes locked"
                      : "Approve in simulator"}
              </Button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}

function CodePayload({
  title,
  mutation,
}: {
  title: string;
  mutation: Recommendation["mutation"];
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-zinc-950 text-zinc-100">
      <div className="border-b border-white/10 px-4 py-2 text-xs text-zinc-400">
        {title} · {mutation.method} {mutation.path}
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-5">
        {mutation.body ? JSON.stringify(mutation.body, null, 2) : "No request body"}
      </pre>
    </div>
  );
}

function NoRecommendations({
  onReview,
  reviewing,
  syncUnavailable,
}: {
  onReview: () => void;
  reviewing: boolean;
  syncUnavailable: boolean;
}) {
  return (
    <section className="grid min-h-[calc(100vh-7rem)] place-items-center p-6">
      <Empty className="max-w-xl border bg-background">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchCheck />
          </EmptyMedia>
          <EmptyTitle>
            {syncUnavailable
              ? "No confirmed live snapshot"
              : "No changes need approval"}
          </EmptyTitle>
          <EmptyDescription>
            {syncUnavailable
              ? "MaintainFlow did not substitute demo metrics for this connected account. Retry the read-only sync when the provider connection is available."
              : "The current evidence did not cross a MaintainFlow safeguard threshold. That is a valid result—not a reason to invent a recommendation."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onReview} disabled={reviewing}>
            {reviewing ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <RefreshCcw data-icon="inline-start" />
            )}
            Review again
          </Button>
        </EmptyContent>
      </Empty>
    </section>
  );
}

function livePortfolioEvidenceLabel(state: LivePortfolioEvidenceState) {
  switch (state) {
    case "confirmed_fresh":
      return "Fresh";
    case "confirmed_stale":
      return "Stale";
    case "confirmed_expired":
      return "Expired";
    case "invalid":
      return "Rejected";
    case "refresh_required":
      return "Refresh required";
    default:
      return "Not captured";
  }
}

function livePortfolioEvidenceTone(state: LivePortfolioEvidenceState) {
  if (state === "confirmed_fresh") {
    return "border-success/30 bg-success/10 text-success";
  }
  if (state === "confirmed_stale") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (state === "confirmed_expired" || state === "invalid") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (state === "refresh_required") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  return "text-muted-foreground";
}

function livePortfolioUrgencyLabel(urgency: LivePortfolioUrgency) {
  if (urgency === "critical") return "Urgent action";
  if (urgency === "attention") return "Action needed";
  if (urgency === "review") return "Evidence review";
  return "No exception";
}

function livePortfolioUrgencyVariant(
  urgency: LivePortfolioUrgency,
): "destructive" | "secondary" | "outline" {
  if (urgency === "critical") return "destructive";
  if (urgency === "attention") return "secondary";
  return "outline";
}

function exceptionCountLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
) {
  return `${formatGroupedInteger(count)} ${count === 1 ? singular : plural}`;
}

function LivePortfolioExceptionItem({
  evidence,
  singular,
  plural,
  variant,
}: {
  evidence: LivePortfolioExceptionEvidence;
  singular: string;
  plural?: string;
  variant: "destructive" | "secondary";
}) {
  if (evidence.count === 0) return null;

  return (
    <div className="flex min-w-72 items-center justify-between gap-3">
      <Badge variant={variant}>
        {exceptionCountLabel(evidence.count, singular, plural)}
      </Badge>
      <span className="whitespace-nowrap text-xs text-muted-foreground">
        {evidence.oldestAt
          ? `Oldest ${formatUtcDateTime(evidence.oldestAt, {
              includeTimeZone: true,
            })}`
          : "Timestamp unavailable"}
      </span>
    </div>
  );
}

export function CampaignsView({
  ads,
  creativeReviewHistory,
  creativeHistoryReady,
  creativeHistoryError,
  dataSource,
  campaigns,
  performance,
  budgetGuardEvidence,
  currencyCode,
  recommendationCount,
  onReview,
  reviewing,
  snapshotAvailable,
  portfolioAccounts,
  livePortfolioVisible,
  livePortfolioAccounts,
  livePortfolioError,
  currentAccountId,
  onOpenAccount,
}: {
  ads: ScopedAd[];
  creativeReviewHistory: CreativeReviewEvent[];
  creativeHistoryReady: boolean;
  creativeHistoryError?: string;
  dataSource: "demo" | "live";
  campaigns: Campaign[];
  performance: CampaignPerformance[];
  budgetGuardEvidence: BudgetGuardEvidence[];
  currencyCode: string;
  recommendationCount: number;
  onReview: () => void;
  reviewing: boolean;
  snapshotAvailable: boolean;
  portfolioAccounts: SimulatedAccountOption[];
  livePortfolioVisible: boolean;
  livePortfolioAccounts: LivePortfolioAccount[];
  livePortfolioError?: string;
  currentAccountId: string;
  onOpenAccount: (accountId: string) => void;
}) {
  const currency = moneyFormatter(currencyCode);
  const totalSpend = performance.reduce((sum, item) => sum + item.spend, 0);
  const totalConversions = performance.reduce(
    (sum, item) => sum + item.conversions,
    0,
  );
  const portfolioRows = portfolioAccounts.filter(
    (item) => item.portfolioSummary,
  );
  const portfolioExposure = portfolioRows.reduce(
    (sum, item) => sum + (item.portfolioSummary?.projectedExposure ?? 0),
    0,
  );
  const portfolioReviews = portfolioRows.reduce(
    (sum, item) => sum + (item.portfolioSummary?.openReviews ?? 0),
    0,
  );
  const portfolioTemplateFixes = portfolioRows.reduce(
    (sum, item) => sum + (item.portfolioSummary?.campaignTemplateFixes ?? 0),
    0,
  );
  const livePortfolioSummary = summarizeLivePortfolioEvidence(
    livePortfolioAccounts,
  );
  const rankedLivePortfolioAccounts = rankLivePortfolioAccounts(
    livePortfolioAccounts,
  );

  return (
    <section className="mx-auto grid w-full min-w-0 max-w-7xl gap-6 p-4 md:p-6 lg:p-8">
      <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
        <div className="grid gap-2">
          <Badge variant="outline" className="w-fit">OpenAI Ads</Badge>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">
            Campaign health
          </h1>
          <p className="text-sm text-muted-foreground">
            Delivery metrics use the Insights field names; CPA is derived from
            click-attributed conversions.
          </p>
        </div>
        <Button variant="outline" onClick={onReview} disabled={reviewing}>
          {reviewing ? (
            <Loader2 data-icon="inline-start" className="animate-spin" />
          ) : (
            <SearchCheck data-icon="inline-start" />
          )}
          {reviewing ? "Reloading snapshot" : "Reload account snapshot"}
        </Button>
      </div>

      {portfolioRows.length > 1 ? (
        <Card className="min-w-0 shadow-sm">
          <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">Agency exception queue</CardTitle>
                <Badge variant="secondary">Simulator portfolio</Badge>
              </div>
              <CardDescription>
                Triage money at risk, open reviews, and campaign-template gaps
                across clients before opening one advertiser account.
              </CardDescription>
            </div>
            <Badge variant="outline">{portfolioRows.length} client accounts</Badge>
          </CardHeader>
          <CardContent className="grid gap-4 p-4 md:p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <MetricCard
                label="Projected weekly exposure"
                value={currency.format(portfolioExposure)}
                detail="Illustrative confirmed-budget windows"
              />
              <MetricCard
                label="Open reviews"
                value={formatGroupedInteger(portfolioReviews)}
                detail="Across the simulated agency portfolio"
              />
              <MetricCard
                label="Campaign template fixes"
                value={formatGroupedInteger(portfolioTemplateFixes)}
                detail="Campaign-level checks only"
              />
            </div>
            <Table
              scrollAreaLabel="Agency account exception queue"
              scrollAreaClassName="pb-2"
            >
                <TableHeader>
                  <TableRow>
                    <TableHead>Client account</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Money at risk</TableHead>
                    <TableHead className="text-right">Open reviews</TableHead>
                    <TableHead className="text-right">Template fixes</TableHead>
                    <TableHead className="text-right">Workspace</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {portfolioRows.map((item) => {
                    const summary = item.portfolioSummary!;
                    const selected = item.accountId === currentAccountId;
                    return (
                      <TableRow key={item.accountId}>
                        <TableCell>
                          <div className="flex min-w-44 items-center gap-2">
                            <span className="font-medium">{item.accountName}</span>
                            {selected ? <Badge variant="outline">Open</Badge> : null}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant="outline"
                            className={cn(
                              "whitespace-nowrap",
                              summary.status === "critical"
                                ? "border-destructive/30 bg-destructive/10 text-destructive"
                                : summary.status === "attention"
                                  ? "border-warning/30 bg-warning/10 text-warning-foreground"
                                  : "border-success/30 bg-success/10 text-success",
                            )}
                          >
                            {summary.status === "critical"
                              ? "Budget risk"
                              : summary.status === "attention"
                                ? "Review needed"
                                : "No exception"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right font-medium">
                          {currency.format(summary.projectedExposure)}
                        </TableCell>
                        <TableCell className="text-right">
                          {summary.openReviews}
                        </TableCell>
                        <TableCell className="text-right">
                          {summary.campaignTemplateFixes}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant={selected ? "secondary" : "outline"}
                            disabled={selected}
                            onClick={() => onOpenAccount(item.accountId)}
                          >
                            {selected ? "Current" : "Open account"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
            </Table>
          </CardContent>
        </Card>
      ) : null}

      {dataSource === "live" && livePortfolioVisible ? (
        <Card className="min-w-0 shadow-sm">
          <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">Live agency exception queue</CardTitle>
                <Badge variant="secondary">Agency portfolio</Badge>
              </div>
              <CardDescription>
                Reconciliation and monitoring exceptions are ranked ahead of
                read-only snapshot signals. Missing evidence is never counted as zero.
              </CardDescription>
            </div>
            <Badge variant="outline">
              {livePortfolioError
                ? "Account count unavailable"
                : `${livePortfolioAccounts.length} active client${livePortfolioAccounts.length === 1 ? "" : "s"}`}
            </Badge>
          </CardHeader>
          <CardContent className="grid gap-4 p-4 md:p-5">
            {livePortfolioError ? (
              <Alert>
                <Info />
                <AlertTitle>Live portfolio evidence unavailable</AlertTitle>
                <AlertDescription>{livePortfolioError}</AlertDescription>
              </Alert>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  <MetricCard
                    label="Accounts requiring action"
                    value={formatGroupedInteger(
                      livePortfolioSummary.operationalExceptionAccountCount,
                    )}
                    detail={`Across ${livePortfolioAccounts.length} active client${livePortfolioAccounts.length === 1 ? "" : "s"}`}
                  />
                  <MetricCard
                    label="Unresolved reconciliation"
                    value={formatGroupedInteger(
                      livePortfolioSummary.reconciliationRequiredCount,
                    )}
                    detail="Provider outcomes requiring an Ads Manager check"
                  />
                  <MetricCard
                    label="Monitoring exceptions"
                    value={formatGroupedInteger(
                      livePortfolioSummary.monitoringExceptionCount,
                    )}
                    detail="Safeguard breaches, evidence gaps, and failed evaluations"
                  />
                </div>

                <Table
                  scrollAreaLabel="Live agency client evidence"
                  scrollAreaClassName="pb-2"
                >
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client account</TableHead>
                      <TableHead>Priority</TableHead>
                      <TableHead>Operational exceptions</TableHead>
                      <TableHead>Oldest attention</TableHead>
                      <TableHead>Snapshot evidence</TableHead>
                      <TableHead className="text-right">Review</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rankedLivePortfolioAccounts.map((item) => {
                      const selected = item.accountId === currentAccountId;
                      const urgency = livePortfolioUrgency(item);
                      const oldestExceptionAt =
                        oldestLivePortfolioExceptionAt(item);
                      const hasOperationalExceptions =
                        livePortfolioOperationalExceptionCount(item) > 0;
                      return (
                        <TableRow key={item.accountId}>
                          <TableCell>
                            <div className="flex min-w-44 items-center gap-2">
                              <span className="font-medium">
                                {item.accountName}
                              </span>
                              {selected ? (
                                <Badge variant="outline">Open</Badge>
                              ) : null}
                            </div>
                            <span className="font-mono text-xs text-muted-foreground">
                              {item.accountId}
                            </span>
                          </TableCell>
                          <TableCell>
                            <Badge
                              variant={livePortfolioUrgencyVariant(urgency)}
                              className="whitespace-nowrap"
                            >
                              {livePortfolioUrgencyLabel(urgency)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <div className="grid min-w-80 gap-1.5">
                              <LivePortfolioExceptionItem
                                evidence={
                                  item.operationalExceptions
                                    .reconciliationRequired
                                }
                                singular="reconciliation"
                                variant="destructive"
                              />
                              <LivePortfolioExceptionItem
                                evidence={
                                  item.operationalExceptions.monitoringFailures
                                }
                                singular="monitoring failure"
                                variant="destructive"
                              />
                              <LivePortfolioExceptionItem
                                evidence={
                                  item.operationalExceptions.safeguardTriggered
                                }
                                singular="safeguard breach"
                                plural="safeguard breaches"
                                variant="secondary"
                              />
                              <LivePortfolioExceptionItem
                                evidence={
                                  item.operationalExceptions.insufficientEvidence
                                }
                                singular="evidence gap"
                                variant="secondary"
                              />
                              {!hasOperationalExceptions ? (
                                <Badge variant="outline">
                                  No active monitoring exception
                                </Badge>
                              ) : null}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {oldestExceptionAt
                              ? formatUtcDateTime(oldestExceptionAt, {
                                  includeTimeZone: true,
                                })
                              : "—"}
                          </TableCell>
                          <TableCell className="min-w-48">
                            <Badge
                              variant="outline"
                              className={cn(
                                "whitespace-nowrap",
                                livePortfolioEvidenceTone(item.evidenceState),
                              )}
                            >
                              {livePortfolioEvidenceLabel(item.evidenceState)}
                            </Badge>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.detectedSignalCount === null
                                ? "Detected signals unknown"
                                : `${formatGroupedInteger(item.detectedSignalCount)} detected signal${item.detectedSignalCount === 1 ? "" : "s"}`}
                            </p>
                            {item.evidenceAt ? (
                              <p className="mt-1 whitespace-nowrap text-xs text-muted-foreground">
                                {formatUtcDateTime(item.evidenceAt, {
                                  includeTimeZone: true,
                                })}
                              </p>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              asChild
                              size="sm"
                              variant={
                                hasOperationalExceptions ? "default" : "outline"
                              }
                            >
                              <Link
                                href={buildAppHref({
                                  tab: "experiments",
                                  accountId: item.accountId,
                                })}
                              >
                                {hasOperationalExceptions
                                  ? "Review exceptions"
                                  : "Open history"}
                                <ArrowRight data-icon="inline-end" />
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </>
            )}
          </CardContent>
        </Card>
      ) : null}

      {!snapshotAvailable ? (
        <Empty className="border bg-background py-12 shadow-sm">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BarChart3 />
            </EmptyMedia>
            <EmptyTitle>No confirmed live snapshot</EmptyTitle>
            <EmptyDescription>
              Spend, conversion, campaign, and currency values stay hidden until
              OpenAI Ads returns a schema-valid snapshot for this account.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={onReview} disabled={reviewing}>
              {reviewing ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <RefreshCcw data-icon="inline-start" />
              )}
              {reviewing ? "Retrying live sync" : "Retry live sync"}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <>
      <div className="grid gap-3 md:grid-cols-3">
        <MetricCard
          label="Month-to-date spend"
          value={currency.format(totalSpend)}
          detail={`Current account snapshot · ${campaigns.length} campaigns`}
        />
        <MetricCard
          label="Click-attributed conversions"
          value={formatGroupedInteger(totalConversions)}
          detail="View-through shown separately"
        />
        <MetricCard
          label="Open recommendations"
          value={formatGroupedInteger(recommendationCount)}
          detail="Only evidence-backed changes"
        />
      </div>

      <BudgetGuard
        campaigns={campaigns}
        evidence={budgetGuardEvidence}
        currencyCode={currencyCode}
        dataSource={dataSource}
      />

      <Card className="min-w-0 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Campaigns</CardTitle>
          <CardDescription>Current account hierarchy and delivery</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          {campaigns.length > 0 ? (
            <Table scrollAreaLabel="Campaign performance">
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Objective</TableHead>
                <TableHead className="text-right">Spend</TableHead>
                <TableHead className="text-right">Clicks</TableHead>
                <TableHead className="text-right">CPA</TableHead>
                <TableHead>Signal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((campaign) => {
                const metrics = performance.find(
                  (item) => item.campaignId === campaign.id,
                );
                const cpa =
                  metrics && metrics.conversions > 0
                    ? metrics.spend / metrics.conversions
                    : null;
                return (
                  <TableRow key={campaign.id}>
                    <TableCell>
                      <div className="grid min-w-44 gap-1">
                        <span className="font-medium">{campaign.name}</span>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            {campaign.id}
                          </span>
                          {campaign.mode === "product_feed" ? (
                            <Badge variant="secondary">Product feed</Badge>
                          ) : null}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={campaign.status === "active" ? "outline" : "secondary"}
                        className="capitalize"
                      >
                        {campaign.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="capitalize">{campaign.bidding_type}</TableCell>
                    <TableCell className="text-right">
                      {currency.format(metrics?.spend ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {formatGroupedInteger(metrics?.clicks ?? 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {cpa === null ? "—" : currency.format(cpa)}
                    </TableCell>
                    <TableCell>
                      <span
                        className={cn(
                          "text-sm",
                          metrics?.trend.startsWith("+")
                            ? "text-destructive"
                            : "text-muted-foreground",
                        )}
                      >
                        {metrics?.trend}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            </Table>
          ) : (
            <Empty className="border-0 py-12">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <BarChart3 />
                </EmptyMedia>
                <EmptyTitle>No campaigns returned</EmptyTitle>
                <EmptyDescription>
                  The connected ad account does not currently contain a campaign.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </CardContent>
      </Card>

      <CreativeReviewTable ads={ads} />

      <CreativeReviewHistory
        events={creativeReviewHistory}
        dataSource={dataSource}
        ready={creativeHistoryReady}
        error={creativeHistoryError}
      />
        </>
      )}
    </section>
  );
}

function MetricCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <CardDescription>{label}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1">
        <CardTitle className="text-2xl">{value}</CardTitle>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </CardContent>
    </Card>
  );
}

function ExperimentsView({
  account,
  recommendations,
  dataSource,
  currencyCode,
  monitoringWindows,
  monitoringEvaluationError,
  auditEvents,
  approvalHistory,
  approvalHistoryError,
  canRollback,
  canReconcile,
  recommendationDecisionHistory,
  recommendationDecisionError,
}: {
  account: { id: string; name: string };
  recommendations: Recommendation[];
  dataSource: "demo" | "live";
  currencyCode: string;
  monitoringWindows: MonitoringWindowDto[];
  monitoringEvaluationError?: string;
  auditEvents: AuditEvent[];
  approvalHistory: ApprovalRecordDto[];
  approvalHistoryError?: string;
  canRollback: boolean;
  canReconcile: boolean;
  recommendationDecisionHistory: RecommendationDecisionHistoryDto[];
  recommendationDecisionError?: string;
}) {
  return (
    <section className="mx-auto grid min-w-0 max-w-6xl gap-6 p-4 md:p-6 lg:p-8">
      <div className="grid gap-2">
        <Badge variant="outline" className="w-fit">Human-approved</Badge>
        <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">
          Monitoring windows
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every approved change gets a baseline, success rule, rollback rule, and
          audit trail. Simulator experiments are clearly separated from live results.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <MonitoringWindows
          dataSource={dataSource}
          currencyCode={currencyCode}
          windows={monitoringWindows}
          recommendations={recommendations}
          error={monitoringEvaluationError}
        />
      </div>

      <Alert className="bg-background">
        <Info className="size-4" />
        <AlertTitle>No fabricated performance</AlertTitle>
        <AlertDescription>
          MaintainFlow compares equal seven-day windows using click-attributed
          conversions only as a directional guardrail, not causal lift. A
          safeguard breach recommends human rollback review; it never sends a
          rollback automatically.
        </AlertDescription>
      </Alert>

      <ChangeAssuranceReportCard
        account={account}
        dataSource={dataSource}
        records={approvalHistory}
      />

      <ApprovalHistory
        records={approvalHistory}
        dataSource={dataSource}
        canRollback={canRollback}
        canReconcile={canReconcile}
        error={approvalHistoryError}
      />

      <RecommendationDecisionHistory
        records={recommendationDecisionHistory}
        dataSource={dataSource}
        error={recommendationDecisionError}
      />

      <Card className="min-w-0 shadow-sm">
        <CardHeader>
          <div className="flex items-start gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground">
              <FileClock />
            </div>
            <div className="grid gap-1">
              <CardTitle className="text-base">Session audit trail</CardTitle>
              <CardDescription>
                Every review decision is recorded with its mode and outcome.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="min-w-0">
          <Table scrollAreaLabel="Session audit trail">
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditEvents.map((event) => {
                return (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatUtcDateTime(event.occurredAt, {
                        fallback: event.occurredAt,
                        includeTimeZone: true,
                      })}
                    </TableCell>
                    <TableCell className="font-medium">{event.action}</TableCell>
                    <TableCell>{event.entity}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {event.mode}
                      </Badge>
                    </TableCell>
                    <TableCell className="min-w-64 text-muted-foreground">
                      {event.outcome}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </section>
  );
}
