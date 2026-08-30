"use client";

import { useMemo, useState } from "react";
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
import { toast } from "sonner";

import { MaintainFlowBrand } from "@/components/maintainflow/brand";
import { ApprovalHistory } from "@/components/maintainflow/approval-history";
import { CreativeReviewHistory } from "@/components/maintainflow/creative-review-history";
import { CreativeReviewTable } from "@/components/maintainflow/creative-review-table";
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
import type { AdAccount, Campaign, ScopedAd } from "@/lib/openai-ads/schema";
import type { ApprovalRecordDto } from "@/lib/audit/approval-schema";
import type { RecommendationDecisionHistoryDto } from "@/lib/audit/recommendation-decision";
import type { CreativeReviewEvent } from "@/lib/openai-ads/creative-history";
import type { MonitoringWindowDto } from "@/lib/openai-ads/monitoring";
import type { ConversionMeasurementReadiness } from "@/lib/openai-ads/measurement-readiness";
import type { ConversionsConnectionStatus } from "@/lib/openai-ads/conversions-connection";
import type { ReadinessAuditHistoryEntry } from "@/lib/readiness/history";
import type { AccountAccess } from "@/lib/tenancy/schema";
import type {
  CampaignPerformance,
  Recommendation,
  RecommendationStatus,
} from "@/lib/openai-ads/demo-data";
import { cn } from "@/lib/utils";

type WorkbenchProps = {
  account: AdAccount;
  ads: ScopedAd[];
  creativeReviewHistory: CreativeReviewEvent[];
  creativeHistoryReady: boolean;
  creativeHistoryError?: string;
  campaigns: Campaign[];
  performance: CampaignPerformance[];
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
  account,
  ads,
  creativeReviewHistory,
  creativeHistoryReady,
  creativeHistoryError,
  campaigns,
  performance,
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
  const [demoRecommendations, setDemoRecommendations] = useState(
    initialRecommendations,
  );
  const recommendations =
    dataSource === "live" ? initialRecommendations : demoRecommendations;
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
        occurredAt: syncedAt ?? "Demo snapshot",
        action: "Account review completed",
        entity: account.name,
        outcome: `${initialRecommendations.length} recommendations prepared`,
        mode: dataSource,
      }
    : null;
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>(
    initialAuditEvent ? [initialAuditEvent] : [],
  );

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
      const response = await fetch("/api/ads/recommendations/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recommendationId: selected.id,
          accountId: workspaceAccess?.accountId,
          recommendationSource: selected.source,
          recommendationFingerprint:
            recommendationApprovalFingerprints[selected.id],
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        message?: string;
        mode?: "demo" | "live";
      };

      if (!response.ok) throw new Error(result.error ?? "Approval failed.");

      if (result.mode !== "live") updateStatus(selected.id, "monitoring");
      addAuditEvent({
        action: result.mode === "live" ? "Change applied" : "Approval recorded",
        entity: selected.entityLabel,
        outcome:
          result.message ?? "Recommendation moved to its monitoring window.",
        mode: result.mode === "live" ? "live" : "demo",
      });
      setApprovalOpen(false);
      toast.success(
        result.mode === "live" ? "Change applied" : "Demo approval recorded",
        {
          description:
            result.message ?? "The recommendation is now being monitored.",
        },
      );
      if (result.mode === "live") router.refresh();
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
      action: "Demo review completed",
      entity: account.name,
      outcome: `${initialRecommendations.length} schema-valid checks evaluated.`,
      mode: "demo",
    });
    toast.success("Demo review complete", {
      description: `${initialRecommendations.length} schema-valid checks were evaluated without contacting the Ads API.`,
    });
    setReviewing(false);
  }

  function resetDemoState() {
    setDemoRecommendations(initialRecommendations);
    setSelectedId(initialRecommendations[0]?.id ?? "");
    setFilter("all");
    setDismissalOpen(false);
    setDismissalReason("");
    setAuditEvents(initialAuditEvent ? [initialAuditEvent] : []);
    toast.success("Demo reset", {
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
                syncError && dataSource === "live"
                  ? "border-destructive/30 bg-destructive/10 text-destructive"
                  : syncWarning && dataSource === "live"
                    ? "border-warning/30 bg-warning/10 text-warning-foreground"
                  : dataSource === "live"
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-warning/30 bg-warning/10 text-warning-foreground",
              )}
              title={
                syncError && dataSource === "live"
                  ? "The connected account has no confirmed live snapshot"
                  : syncWarning && dataSource === "live"
                    ? "The last confirmed snapshot is visible, but live writes are locked until refresh succeeds"
                  : syncedAt
                  ? `Last synced ${new Date(syncedAt).toLocaleString()}`
                  : dataSource === "live"
                    ? "Live account connected; awaiting a confirmed snapshot"
                    : "Local demo snapshot"
              }
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  syncError && dataSource === "live"
                    ? "bg-destructive"
                    : syncWarning && dataSource === "live"
                      ? "bg-warning"
                    : dataSource === "live"
                      ? "bg-success"
                      : "bg-warning",
                )}
              />
              {workspaceSetupState === "needs_setup"
                ? "Setup required"
                : workspaceSetupState === "unavailable" && dataSource === "demo"
                  ? "Access locked"
                  : syncError && dataSource === "live"
                    ? "Live sync unavailable"
                    : syncWarning && dataSource === "live"
                      ? "Live data · stale"
                  : dataSource === "demo"
                ? "Demo data"
                : writeMode === "live"
                  ? "Live · writes on"
                  : "Live data · writes off"}
            </Badge>
            {workspaceSetupState === "demo" ||
            workspaceSetupState === "ready" ||
            workspaceSetupState === "connection_error" ? (
              <Select
                value={workspaceAccess?.accountId ?? account.id}
                onValueChange={(accountId) => {
                  if (
                    availableAccounts.some(
                      (item) => item.accountId === accountId,
                    )
                  ) {
                    router.push(`/app?account=${encodeURIComponent(accountId)}`);
                  }
                }}
              >
                <SelectTrigger
                  className="hidden w-[190px] bg-background md:flex"
                  aria-label="Ad account"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {availableAccounts.length > 0 ? (
                      availableAccounts.map((item) => (
                        <SelectItem key={item.accountId} value={item.accountId}>
                          {item.accountName}
                        </SelectItem>
                      ))
                    ) : (
                      <SelectItem value={account.id}>{account.name}</SelectItem>
                    )}
                  </SelectGroup>
                </SelectContent>
              </Select>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="h-10 gap-2 px-2">
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
                    {operatorAuthenticated ? "Authenticated operator" : "Demo operator"}
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
                {availableAccounts.length > 0 ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Advertiser accounts</DropdownMenuLabel>
                    <DropdownMenuGroup>
                      {availableAccounts.map((item) => (
                        <DropdownMenuItem
                          key={item.accountId}
                          onSelect={() =>
                            router.push(
                              `/app?account=${encodeURIComponent(item.accountId)}`,
                            )
                          }
                        >
                          {item.accountId === workspaceAccess?.accountId ? (
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
        defaultValue={
          workspaceSetupState === "needs_setup" ||
          workspaceSetupState === "unavailable" ||
          workspaceSetupState === "connection_error"
            ? "workspace"
            : "review"
        }
        className="w-full"
      >
        <div className="overflow-x-auto border-b bg-background px-4 md:px-6">
          <TabsList className="h-12 w-max justify-start gap-1 rounded-none bg-transparent p-0">
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
          <section className="grid min-h-[calc(100vh-7rem)] min-[640px]:grid-cols-[270px_minmax(0,1fr)] lg:grid-cols-[340px_minmax(0,1fr)]">
            <aside className="border-b bg-background min-[640px]:border-b-0 min-[640px]:border-r">
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

              <div className="grid max-h-[42vh] overflow-y-auto p-2 min-[640px]:max-h-[calc(100vh-12rem)]">
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
            currencyCode={account.currency_code}
            recommendationCount={readyCount}
            onReview={runAccountReview}
            reviewing={reviewing}
            snapshotAvailable={snapshotAvailable}
          />
        </TabsContent>

        <TabsContent value="experiments" className="m-0">
          <ExperimentsView
            recommendations={recommendations}
            dataSource={dataSource}
            monitoringWindows={monitoringWindows}
            monitoringEvaluationError={monitoringEvaluationError}
            auditEvents={auditEvents}
            approvalHistory={approvalHistory}
            approvalHistoryError={approvalHistoryError}
            approvalHistoryReady={approvalHistoryReady}
            canRollback={writeMode === "live"}
            recommendationDecisionHistory={recommendationDecisionHistory}
            recommendationDecisionError={recommendationDecisionError}
          />
        </TabsContent>

        <TabsContent value="readiness" className="m-0">
          <ReadinessWorkbench
            key={workspaceAccess?.accountId ?? "public-readiness"}
            conversionMeasurement={conversionMeasurement}
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
          />
        </TabsContent>
      </Tabs>

      <Dialog open={approvalOpen && Boolean(selected)} onOpenChange={setApprovalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve this change?</DialogTitle>
            <DialogDescription>
              MaintainFlow will use the exact request shown in the review and retain
              the rollback payload. {dataSource === "live" && writeMode !== "live"
                ? "External changes are locked until every live-write gate is restored."
                : writeMode === "demo"
                  ? "No external write will be made in demo mode."
                  : "This live recommendation is connected for an external write."}
            </DialogDescription>
          </DialogHeader>
          {selected ? (
            <div className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Current</span>
                <span className="font-medium">{selected.currentValue}</span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-muted-foreground">Proposed</span>
                <span className="font-medium text-primary">{selected.proposedValue}</span>
              </div>
            </div>
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
                  ? "Record demo approval"
                  : "Approve and apply"}
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
        <div className="flex flex-col justify-between gap-4 min-[640px]:flex-row min-[640px]:items-start">
          <div className="grid max-w-3xl gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{recommendation.entityLabel}</Badge>
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

        <div className="grid gap-3 min-[640px]:grid-cols-3">
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
          <CardContent className="grid gap-5 p-5 min-[640px]:grid-cols-[1fr_auto_1fr] min-[640px]:p-6">
            <div className="grid gap-1 rounded-lg border bg-background p-4">
              <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Current
              </span>
              <span className="text-lg font-semibold">{recommendation.currentValue}</span>
            </div>
            <div className="grid place-items-center text-muted-foreground">
              <ArrowRight className="hidden min-[640px]:block" />
              <ArrowDownRight className="min-[640px]:hidden" />
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

        <div className="grid gap-4 min-[640px]:grid-cols-2">
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
          <div className="grid gap-4 p-4 min-[640px]:grid-cols-2">
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
                      : "Approve in demo"}
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

export function CampaignsView({
  ads,
  creativeReviewHistory,
  creativeHistoryReady,
  creativeHistoryError,
  dataSource,
  campaigns,
  performance,
  currencyCode,
  recommendationCount,
  onReview,
  reviewing,
  snapshotAvailable,
}: {
  ads: ScopedAd[];
  creativeReviewHistory: CreativeReviewEvent[];
  creativeHistoryReady: boolean;
  creativeHistoryError?: string;
  dataSource: "demo" | "live";
  campaigns: Campaign[];
  performance: CampaignPerformance[];
  currencyCode: string;
  recommendationCount: number;
  onReview: () => void;
  reviewing: boolean;
  snapshotAvailable: boolean;
}) {
  const currency = moneyFormatter(currencyCode);
  const totalSpend = performance.reduce((sum, item) => sum + item.spend, 0);
  const totalConversions = performance.reduce(
    (sum, item) => sum + item.conversions,
    0,
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
          detail={`Across ${campaigns.length} campaigns`}
        />
        <MetricCard
          label="Click-attributed conversions"
          value={totalConversions.toLocaleString()}
          detail="View-through shown separately"
        />
        <MetricCard
          label="Open recommendations"
          value={recommendationCount.toLocaleString()}
          detail="Only evidence-backed changes"
        />
      </div>

      <Card className="min-w-0 shadow-sm">
        <CardHeader>
          <CardTitle className="text-base">Campaigns</CardTitle>
          <CardDescription>Current account hierarchy and delivery</CardDescription>
        </CardHeader>
        <CardContent className="min-w-0">
          {campaigns.length > 0 ? (
            <Table>
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
                      {(metrics?.clicks ?? 0).toLocaleString()}
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
  recommendations,
  dataSource,
  monitoringWindows,
  monitoringEvaluationError,
  auditEvents,
  approvalHistory,
  approvalHistoryError,
  approvalHistoryReady,
  canRollback,
  recommendationDecisionHistory,
  recommendationDecisionError,
}: {
  recommendations: Recommendation[];
  dataSource: "demo" | "live";
  monitoringWindows: MonitoringWindowDto[];
  monitoringEvaluationError?: string;
  auditEvents: AuditEvent[];
  approvalHistory: ApprovalRecordDto[];
  approvalHistoryError?: string;
  approvalHistoryReady: boolean;
  canRollback: boolean;
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
          audit trail. Demo experiments are clearly separated from live results.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <MonitoringWindows
          dataSource={dataSource}
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

      <ApprovalHistory
        records={approvalHistory}
        canRollback={canRollback}
        canReconcile={approvalHistoryReady}
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
          <div className="max-w-full overflow-x-auto">
          <Table>
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
                const parsedTime = Date.parse(event.occurredAt);
                return (
                  <TableRow key={event.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {Number.isNaN(parsedTime)
                        ? event.occurredAt
                        : new Date(parsedTime).toLocaleString()}
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
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
