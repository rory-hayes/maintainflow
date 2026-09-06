"use client";

import { useId, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ListChecks,
  ShieldAlert,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildAppHref } from "@/lib/app-navigation";
import { formatGroupedInteger, formatUtcDateTime } from "@/lib/formatting";
import {
  summarizePortfolioActionQueue,
  type ActionQueueCategory,
  type ActionQueueDeliveryImpact,
  type ActionQueueFreshness,
  type ActionQueueSeverity,
  type PortfolioActionItem,
} from "@/lib/openai-ads/action-queue";
import { cn } from "@/lib/utils";

const DEFAULT_VISIBLE_ACTIONS = 12;

function categoryLabel(category: ActionQueueCategory) {
  if (category === "budget_pacing") return "Budget pacing";
  if (category === "creative_delivery") return "Creative delivery";
  if (category === "recommendation") return "Recommendation";
  if (category === "measurement") return "Measurement";
  if (category === "tracking_template") return "Tracking template";
  if (category === "site_readiness") return "Site readiness";
  if (category === "monitoring") return "Monitoring";
  if (category === "reconciliation") return "Reconciliation";
  if (category === "change_integrity") return "Change integrity";
  return "Evidence";
}

function severityLabel(severity: ActionQueueSeverity) {
  if (severity === "critical") return "Critical";
  if (severity === "high") return "High";
  return "Medium";
}

function severityClass(severity: ActionQueueSeverity) {
  if (severity === "critical") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (severity === "high") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  return "";
}

function freshnessLabel(freshness: ActionQueueFreshness) {
  if (freshness === "current") return "Current evidence";
  if (freshness === "stale") return "Stale evidence";
  return "Freshness unknown";
}

function deliveryImpactLabel(impact: ActionQueueDeliveryImpact) {
  if (impact === "blocked") return "Delivery blocked";
  if (impact === "at_risk") return "Delivery at risk";
  if (impact === "not_observed") return "No block observed";
  return "Impact unknown";
}

function deliveryImpactClass(impact: ActionQueueDeliveryImpact) {
  if (impact === "blocked") {
    return "border-destructive/30 bg-destructive/10 text-destructive";
  }
  if (impact === "at_risk") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  return "";
}

function moneyFormatter(currencyCode: string) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 0,
  });
}

function moneyAtRiskLabel(item: PortfolioActionItem) {
  if (item.moneyAtRisk.state === "unknown") return "Unknown — not zero";
  return moneyFormatter(item.moneyAtRisk.currencyCode).format(
    item.moneyAtRisk.amountMicros / 1_000_000,
  );
}

function knownMoneySummary(items: readonly PortfolioActionItem[]) {
  const summary = summarizePortfolioActionQueue(items);
  if (summary.knownMoneyByCurrency.length === 0) {
    return {
      value: "Not quantified",
      detail: `${summary.unknownMoneyCount} action${summary.unknownMoneyCount === 1 ? "" : "s"} explicitly marked unknown`,
    };
  }
  if (summary.knownMoneyByCurrency.length === 1) {
    const total = summary.knownMoneyByCurrency[0]!;
    const knownActionCount = items.filter(
      (item) => item.moneyAtRisk.state === "known",
    ).length;
    return {
      value: moneyFormatter(total.currencyCode).format(
        total.amountMicros / 1_000_000,
      ),
      detail: `Calculated from confirmed budget evidence across ${knownActionCount} ranked action${knownActionCount === 1 ? "" : "s"}`,
    };
  }
  return {
    value: `${summary.knownMoneyByCurrency.length} currencies`,
    detail: "Projected amounts are not aggregated across currencies",
  };
}

function QueueMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

export function PortfolioActionQueue({
  items,
  accountCount,
  currentAccountId,
  organizationId,
  source,
  error,
}: {
  items: PortfolioActionItem[];
  accountCount: number;
  currentAccountId: string;
  organizationId?: string;
  source: "simulator" | "live";
  error?: string;
}) {
  const queueId = useId();
  const [expanded, setExpanded] = useState(false);
  const summary = summarizePortfolioActionQueue(items);
  const moneySummary = knownMoneySummary(items);
  const resolvedAccountCount = Math.max(
    accountCount,
    new Set(items.map((item) => item.accountId)).size,
  );
  const actionEvidenceUnavailable =
    source === "live" && Boolean(error) && items.length === 0;
  const accountCountUnavailable =
    actionEvidenceUnavailable && resolvedAccountCount === 0;
  const visibleItems = expanded
    ? items
    : items.slice(0, DEFAULT_VISIBLE_ACTIONS);
  const hiddenCount = items.length - visibleItems.length;

  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <ListChecks className="size-5" />
          </div>
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Portfolio action queue</CardTitle>
              <Badge variant="secondary">
                {source === "simulator" ? "Simulator portfolio" : "Live portfolio"}
              </Badge>
            </div>
            <CardDescription className="max-w-3xl leading-5">
              Ranked by severity, then projected exposure within each currency,
              evidence freshness, and delivery impact. Currencies are not
              converted; unknown amounts stay unknown.
            </CardDescription>
          </div>
        </div>
        <Badge variant="outline" className="w-fit whitespace-nowrap">
          {accountCountUnavailable
            ? "Account count unavailable"
            : `${resolvedAccountCount} client account${resolvedAccountCount === 1 ? "" : "s"}`}
        </Badge>
      </CardHeader>

      <CardContent className="grid gap-5 p-4 md:p-5">
        {error ? (
          <Alert>
            <ShieldAlert />
            <AlertTitle>Some portfolio evidence is unavailable</AlertTitle>
            <AlertDescription>
              {error} Any available account actions remain visible below; missing
              accounts are not counted as healthy.
            </AlertDescription>
          </Alert>
        ) : null}

        {!actionEvidenceUnavailable ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <QueueMetric
              label="Actions requiring attention"
              value={formatGroupedInteger(summary.totalCount)}
              detail={`${summary.urgentCount} critical or high priority`}
            />
            <QueueMetric
              label="Projected budget exposure"
              value={moneySummary.value}
              detail={moneySummary.detail}
            />
            <QueueMetric
              label="Delivery blocked"
              value={formatGroupedInteger(summary.blockedDeliveryCount)}
              detail="Based only on observed review and serving evidence"
            />
            <QueueMetric
              label="Unquantified actions"
              value={formatGroupedInteger(summary.unknownMoneyCount)}
              detail="Unknown means not available, not zero impact"
            />
          </div>
        ) : null}

        {items.length === 0 ? (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                {error ? <ShieldAlert /> : <ListChecks />}
              </EmptyMedia>
              <EmptyTitle>
                {error
                  ? "Portfolio action status unavailable"
                  : "No exception in available evidence"}
              </EmptyTitle>
              <EmptyDescription>
                {error
                  ? "No healthy or zero-action conclusion can be made until live client evidence loads."
                  : "MaintainFlow found no action to rank in the confirmed evidence currently available for these accounts."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <ol
              aria-label="Portfolio action queue"
              className="m-0 grid list-none gap-3 p-0 md:hidden"
              data-testid="portfolio-action-queue-mobile"
            >
              {visibleItems.map((item, index) => {
                const current = item.accountId === currentAccountId;
                const titleId = `${queueId}-mobile-action-${index}`;
                const moneyDetail =
                  item.moneyAtRisk.state === "unknown"
                    ? item.moneyAtRisk.reason
                    : item.moneyAtRisk.basis;

                return (
                  <li key={item.id}>
                    <Card
                      aria-labelledby={titleId}
                      className="min-w-0 overflow-hidden shadow-none"
                    >
                      <CardHeader className="gap-3 p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn(severityClass(item.severity))}
                          >
                            {severityLabel(item.severity)}
                          </Badge>
                          <Badge variant="secondary">
                            {categoryLabel(item.category)}
                          </Badge>
                          {current ? (
                            <Badge variant="outline">Open account</Badge>
                          ) : null}
                          <span className="ml-auto text-xs font-medium text-muted-foreground">
                            Priority {index + 1}
                          </span>
                        </div>
                        <div className="min-w-0">
                          <p className="break-words text-xs font-medium text-muted-foreground">
                            {item.accountName}
                          </p>
                          <h3
                            id={titleId}
                            className="mt-1 break-words text-sm font-semibold leading-5"
                          >
                            {item.title}
                          </h3>
                          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">
                            {item.detail}
                          </p>
                        </div>
                      </CardHeader>

                      <CardContent className="grid gap-4 border-t bg-muted/10 p-4">
                        <div className="grid min-w-0 gap-1.5">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Evidence
                          </p>
                          <p className="break-words text-sm font-medium">
                            {item.evidenceLabel}
                          </p>
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge
                              variant="outline"
                              className={cn(
                                item.freshness === "stale" &&
                                  "border-warning/30 bg-warning/10 text-warning-foreground",
                              )}
                            >
                              {freshnessLabel(item.freshness)}
                            </Badge>
                            <span className="text-xs text-muted-foreground">
                              {item.evidenceAt
                                ? formatUtcDateTime(item.evidenceAt, {
                                    includeTimeZone: true,
                                  })
                                : "Timestamp unavailable"}
                            </span>
                          </div>
                        </div>

                        <div className="grid gap-1.5">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Delivery
                          </p>
                          <Badge
                            variant="outline"
                            className={cn(
                              "w-fit",
                              deliveryImpactClass(item.deliveryImpact),
                            )}
                          >
                            {deliveryImpactLabel(item.deliveryImpact)}
                          </Badge>
                        </div>

                        <div className="grid min-w-0 gap-1.5">
                          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                            Projected exposure
                          </p>
                          <p
                            className={cn(
                              "break-words text-sm font-semibold",
                              item.moneyAtRisk.state === "unknown" &&
                                "text-muted-foreground",
                            )}
                          >
                            {moneyAtRiskLabel(item)}
                          </p>
                          <p className="break-words text-xs leading-5 text-muted-foreground">
                            {moneyDetail}
                            {item.occurrenceCount > 1
                              ? ` · ${item.occurrenceCount} related signals`
                              : ""}
                          </p>
                        </div>
                      </CardContent>

                      <CardFooter className="border-t p-4 pt-4">
                        <Button
                          asChild
                          className="w-full justify-between"
                          size="sm"
                          variant="outline"
                        >
                          <Link
                            aria-label={`Review evidence for ${item.accountName}: ${item.title}`}
                            href={buildAppHref({
                              tab: item.targetTab,
                              accountId: item.accountId,
                              organizationId,
                            })}
                          >
                            Review evidence
                            <ArrowRight data-icon="inline-end" />
                          </Link>
                        </Button>
                      </CardFooter>
                    </Card>
                  </li>
                );
              })}
            </ol>

            <div className="hidden md:block">
              <Table
                scrollAreaLabel="Portfolio action queue"
                scrollAreaClassName="pb-2"
              >
                <TableHeader>
                  <TableRow>
                    <TableHead>Priority</TableHead>
                    <TableHead>Client and action</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead className="text-right">Projected exposure</TableHead>
                    <TableHead className="text-right">Next step</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleItems.map((item) => {
                    const current = item.accountId === currentAccountId;
                    return (
                      <TableRow key={item.id}>
                        <TableCell className="align-top">
                          <Badge
                            variant="outline"
                            className={cn(
                              "whitespace-nowrap",
                              severityClass(item.severity),
                            )}
                          >
                            {severityLabel(item.severity)}
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-80 align-top">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{item.accountName}</span>
                            {current ? <Badge variant="outline">Open</Badge> : null}
                            <Badge variant="secondary">
                              {categoryLabel(item.category)}
                            </Badge>
                          </div>
                          <p className="mt-2 text-sm font-medium">{item.title}</p>
                          <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
                            {item.detail}
                          </p>
                        </TableCell>
                        <TableCell className="min-w-52 align-top">
                          <p className="text-xs font-medium">{item.evidenceLabel}</p>
                          <Badge
                            variant="outline"
                            className={cn(
                              "mt-2 whitespace-nowrap",
                              item.freshness === "stale" &&
                                "border-warning/30 bg-warning/10 text-warning-foreground",
                            )}
                          >
                            {freshnessLabel(item.freshness)}
                          </Badge>
                          {item.evidenceAt ? (
                            <p className="mt-2 whitespace-nowrap text-xs text-muted-foreground">
                              {formatUtcDateTime(item.evidenceAt, {
                                includeTimeZone: true,
                              })}
                            </p>
                          ) : (
                            <p className="mt-2 text-xs text-muted-foreground">
                              Timestamp unavailable
                            </p>
                          )}
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge
                            variant="outline"
                            className={cn(
                              "whitespace-nowrap",
                              deliveryImpactClass(item.deliveryImpact),
                            )}
                          >
                            {deliveryImpactLabel(item.deliveryImpact)}
                          </Badge>
                        </TableCell>
                        <TableCell className="min-w-40 text-right align-top">
                          <span
                            className={cn(
                              "font-medium",
                              item.moneyAtRisk.state === "unknown" &&
                                "text-muted-foreground",
                            )}
                          >
                            {moneyAtRiskLabel(item)}
                          </span>
                          <p className="mt-1 max-w-56 text-right text-xs leading-5 text-muted-foreground">
                            {item.moneyAtRisk.state === "unknown"
                              ? item.moneyAtRisk.reason
                              : item.moneyAtRisk.basis}
                          </p>
                          {item.occurrenceCount > 1 ? (
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.occurrenceCount} related signals
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right align-top">
                          <Button asChild size="sm" variant="outline">
                            <Link
                              href={buildAppHref({
                                tab: item.targetTab,
                                accountId: item.accountId,
                                organizationId,
                              })}
                            >
                              Review evidence
                              <ArrowRight data-icon="inline-end" />
                            </Link>
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>

      {items.length > DEFAULT_VISIBLE_ACTIONS ? (
        <CardFooter className="justify-between gap-3 border-t bg-muted/10 px-4 py-3 md:px-5">
          <p className="text-xs text-muted-foreground">
            {expanded
              ? `Showing all ${items.length} ranked actions`
              : `Showing the top ${visibleItems.length}; ${hiddenCount} more available`}
          </p>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show highest priority" : "Show all actions"}
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
