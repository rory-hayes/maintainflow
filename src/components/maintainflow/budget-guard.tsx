import {
  ArrowDown,
  CheckCircle2,
  ExternalLink,
  Gauge,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  evaluateBudgetGuards,
  type BudgetGuardEvidence,
  type BudgetGuardResult,
} from "@/lib/openai-ads/budget-guard";
import type { Campaign } from "@/lib/openai-ads/schema";
import { cn } from "@/lib/utils";

function moneyFromMicros(currencyCode: string, value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 0,
  }).format(value / 1_000_000);
}

function paceLabel(result: BudgetGuardResult) {
  if (result.paceRatio === null) return "—";
  return `${Math.round(result.paceRatio * 100)}%`;
}

function statusLabel(status: BudgetGuardResult["status"]) {
  if (status === "critical_overspend") return "Critical pacing risk";
  if (status === "overspend") return "Pacing risk";
  if (status === "underpacing") return "Underpacing";
  if (status === "on_track") return "On track";
  if (status === "inactive") return "Inactive";
  return "Needs evidence";
}

function statusClass(status: BudgetGuardResult["status"]) {
  if (status === "critical_overspend") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (status === "overspend" || status === "underpacing") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (status === "on_track") {
    return "border-success/30 bg-success/10 text-success";
  }
  return "";
}

function actionLabel(result: BudgetGuardResult) {
  if (result.dailyAnomaly) {
    return `Investigate ${result.dailyAnomaly.accountLocalDate}: recorded spend exceeded the documented maximum for that day.`;
  }
  if (result.status === "critical_overspend") {
    return "Review the confirmed weekly limit, bid, and delivery settings.";
  }
  if (result.status === "overspend") {
    return "Check the cap, bid, and delivery settings.";
  }
  if (result.status === "underpacing") {
    return "Check eligibility, targeting, bid, and creative readiness.";
  }
  if (result.status === "on_track") {
    return "No pacing action is indicated by this evidence window.";
  }
  if (result.status === "inactive") {
    return "No urgent pacing action for an inactive campaign.";
  }
  if (result.reason === "lifetime_range_mismatch") {
    return "A lifetime cap needs spend covering the exact campaign window.";
  }
  if (result.reason === "stale_evidence") {
    return "Refresh the account before making a pacing decision.";
  }
  if (result.reason === "unconfirmed_budget_history") {
    return "Wait for a fully observed week with no unverified budget change.";
  }
  return "Confirmed budget history and complete account-local spend are required.";
}

function evidenceThrough(evidence: BudgetGuardEvidence) {
  const observedSecond = Math.max(evidence.rangeStart, evidence.rangeEnd - 1);
  return new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeZone: evidence.accountTimeZone,
  }).format(new Date(observedSecond * 1_000));
}

export function BudgetGuard({
  campaigns,
  evidence,
  currencyCode,
  dataSource,
}: {
  campaigns: Campaign[];
  evidence: BudgetGuardEvidence[];
  currencyCode: string;
  dataSource: "demo" | "live";
}) {
  const demoCalculationTime =
    dataSource === "demo"
      ? evidence.find((item) => item.source === "demo")?.calculatedAt
      : undefined;
  const evaluations = evaluateBudgetGuards({
    campaigns,
    evidence,
    now: demoCalculationTime,
  });
  const results = campaigns.map((campaign, index) => ({
    campaign,
    result: evaluations[index],
  }));
  const measured = results.filter(
    ({ result }) => result.applicableSpendLimitMicros !== null,
  );
  const actionable = measured.filter(({ result }) =>
    result.dailyAnomaly !== null ||
    ["critical_overspend", "overspend", "underpacing"].includes(result.status),
  );
  const overspendExposure = measured.reduce(
    (sum, { result }) => sum + (result.exposureMicros ?? 0),
    0,
  );
  const monitoredLimit = measured.reduce(
    (sum, { result }) => sum + (result.applicableSpendLimitMicros ?? 0),
    0,
  );
  const highestRisk = actionable
    .filter(
      ({ result }) =>
        ["critical_overspend", "overspend"].includes(result.status) &&
        (result.exposureMicros ?? 0) > 0,
    )
    .sort(
      (left, right) =>
        (right.result.exposureMicros ?? 0) -
        (left.result.exposureMicros ?? 0),
    )[0];
  const highestDailyAnomaly = actionable
    .filter(({ result }) => result.dailyAnomaly !== null)
    .sort(
      (left, right) =>
        (right.result.dailyAnomaly?.exposureMicros ?? 0) -
        (left.result.dailyAnomaly?.exposureMicros ?? 0),
    )[0];
  const underpacingCount = measured.filter(
    ({ result }) => result.status === "underpacing",
  ).length;
  const latestEvidence = [...evidence].sort(
    (left, right) => right.rangeEnd - left.rangeEnd,
  )[0];
  const evidenceBadge =
    evidence.length > 0
      ? evidence.every((item) => item.source === "demo")
        ? "Illustrative simulator"
        : "Confirmed budget history"
      : dataSource === "live"
        ? "Live history required"
        : "Simulator evidence required";

  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 min-[640px]:flex-row min-[640px]:items-start min-[640px]:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Gauge className="size-5" />
          </div>
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Budget Guard</CardTitle>
              <Badge variant="secondary">{evidenceBadge}</Badge>
            </div>
            <CardDescription className="max-w-3xl leading-5">
              Forecasts daily-budget campaigns against OpenAI&apos;s applicable
              seven-day spending limit and lifetime-budget campaigns against
              their exact campaign cap. A daily budget is an average: one day
              may spend up to twice that value, and any mid-week change locks
              the forecast until its history is confirmed.
            </CardDescription>
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "w-fit whitespace-nowrap",
            actionable.length > 0
              ? "border-warning/30 bg-warning/10 text-warning-foreground"
              : measured.length > 0
                ? "border-success/30 bg-success/10 text-success"
                : "",
          )}
        >
          {actionable.length > 0
            ? `${actionable.length} campaign${actionable.length === 1 ? "" : "s"} need review`
            : measured.length > 0
              ? "Portfolio on track"
              : "Evidence required"}
        </Badge>
      </CardHeader>

      <CardContent className="grid gap-5 p-4 md:p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">
              Confirmed spending limits
            </p>
            <p className="mt-1 text-xl font-semibold">
              {moneyFromMicros(
                currencyCode,
                measured.length > 0 ? monitoredLimit : null,
              )}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Projected overspend</p>
            <p
              className={cn(
                "mt-1 text-xl font-semibold",
                overspendExposure > 0 && "text-destructive",
              )}
            >
              {moneyFromMicros(
                currencyCode,
                measured.length > 0 ? overspendExposure : null,
              )}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Campaigns to review</p>
            <p className="mt-1 text-xl font-semibold">{actionable.length}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Evidence through</p>
            <p className="mt-1 text-base font-semibold">
              {latestEvidence ? evidenceThrough(latestEvidence) : "Not available"}
            </p>
          </div>
        </div>

        {highestDailyAnomaly?.result.dailyAnomaly ? (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>
              {highestDailyAnomaly.campaign.name} exceeded its documented daily
              maximum
            </AlertTitle>
            <AlertDescription>
              On {highestDailyAnomaly.result.dailyAnomaly.accountLocalDate}, the
              evidence is {moneyFromMicros(
                currencyCode,
                highestDailyAnomaly.result.dailyAnomaly.exposureMicros,
              )} above the confirmed maximum for that day. Investigate the
              provider record before approving another budget change.
            </AlertDescription>
          </Alert>
        ) : highestRisk ? (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>
              {highestRisk.campaign.name} is projected above its {highestRisk.result.budgetBasis === "lifetime_campaign_cap"
                ? "lifetime cap"
                : "7-day limit"}
            </AlertTitle>
            <AlertDescription className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
              <span>
                The current pace projects {moneyFromMicros(
                  currencyCode,
                  highestRisk.result.exposureMicros,
                )} above the confirmed applicable limit. Review the exact
                campaign row before approving any change.
              </span>
              <a
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border bg-background px-3 text-xs font-medium shadow-xs hover:bg-accent"
                href={`#budget-campaign-${highestRisk.campaign.id}`}
              >
                Review campaign row
                <ArrowDown className="size-3.5" />
              </a>
            </AlertDescription>
          </Alert>
        ) : underpacingCount > 0 ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>
              {underpacingCount} campaign{underpacingCount === 1 ? " is" : "s are"}{" "}
              projected below the confirmed limit
            </AlertTitle>
            <AlertDescription>
              Check eligibility, targeting, bids, and creative readiness. This is
              a delivery signal, not evidence that more spend will improve return.
            </AlertDescription>
          </Alert>
        ) : measured.length > 0 ? (
          <div className="flex items-start gap-3 rounded-lg border border-success/20 bg-success/5 p-3">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <div className="grid gap-1">
              <p className="text-sm font-medium">No overspend exposure detected</p>
              <p className="text-xs leading-5 text-muted-foreground">
                This is a pacing result for the stated evidence window, not a
                guarantee of future delivery or performance.
              </p>
            </div>
          </div>
        ) : (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Budget decisions remain locked</AlertTitle>
            <AlertDescription>
              The Ads API currently exposes the campaign&apos;s present budget, not
              the history needed to reconstruct a changed weekly limit. Live
              decisions stay locked until MaintainFlow has a complete, stable
              seven-day budget history and exact spend window. Lifetime caps are
              evaluated only over the exact campaign range.{" "}
              <a
                className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                href="https://help.openai.com/en/articles/20001413-daily-budgets"
                target="_blank"
                rel="noreferrer"
              >
                OpenAI budget rules
                <ExternalLink className="size-3" />
              </a>
            </AlertDescription>
          </Alert>
        )}

        <div
          aria-label="Budget Guard campaign evidence"
          role="region"
          tabIndex={0}
          className="data-table-scroll max-w-full overflow-x-auto pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Observed spend</TableHead>
                <TableHead className="text-right">Applicable limit</TableHead>
                <TableHead className="text-right">Projected period spend</TableHead>
                <TableHead className="text-right">Projected pace</TableHead>
                <TableHead className="min-w-64">Next check</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.map(({ campaign, result }) => (
                <TableRow
                  key={campaign.id}
                  id={`budget-campaign-${campaign.id}`}
                  className="scroll-mt-24"
                >
                  <TableCell>
                    <div className="grid min-w-44 gap-1">
                      <span className="font-medium">{campaign.name}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {campaign.id}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-36 flex-col items-start gap-1.5">
                      <Badge
                        variant="outline"
                        className={cn(
                          "whitespace-nowrap",
                          statusClass(result.status),
                        )}
                      >
                        {statusLabel(result.status)}
                      </Badge>
                      {result.dailyAnomaly ? (
                        <Badge
                          variant="outline"
                          className="whitespace-nowrap border-destructive/30 bg-destructive/10 text-destructive"
                        >
                          Daily maximum exceeded
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {moneyFromMicros(currencyCode, result.spendMicros)}
                  </TableCell>
                  <TableCell className="text-right">
                    {moneyFromMicros(
                      currencyCode,
                      result.applicableSpendLimitMicros,
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {moneyFromMicros(currencyCode, result.projectedSpendMicros)}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {paceLabel(result)}
                  </TableCell>
                  <TableCell className="text-xs leading-5 text-muted-foreground">
                    {actionLabel(result)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
