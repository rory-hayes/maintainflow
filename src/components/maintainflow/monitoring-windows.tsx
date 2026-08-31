import {
  CircleCheck,
  Clock3,
  FlaskConical,
  Gauge,
  RotateCcw,
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import type { Recommendation } from "@/lib/openai-ads/demo-data";
import type { MonitoringWindowDto } from "@/lib/openai-ads/monitoring";
import {
  formatDecimal,
  formatGroupedInteger,
  formatUtcDate,
} from "@/lib/formatting";
import { cn } from "@/lib/utils";

function dateLabel(value: string) {
  return formatUtcDate(value);
}

function windowStatusLabel(status: MonitoringWindowDto["status"]) {
  if (status === "review_due") return "Review due";
  if (status === "within_safeguard") return "Within safeguard";
  if (status === "safeguard_triggered") return "Rollback review";
  if (status === "insufficient_evidence") return "Needs evidence";
  if (status === "rollback_pending") return "Rollback pending";
  if (status === "rollback_outcome_unknown") return "Check rollback";
  return "Monitoring";
}

function windowStatusClass(status: MonitoringWindowDto["status"]) {
  if (status === "active") {
    return "border-success/20 bg-success/10 text-success";
  }
  if (status === "within_safeguard") {
    return "border-success/20 bg-success/10 text-success";
  }
  if (status === "safeguard_triggered") {
    return "border-destructive/20 bg-destructive/10 text-destructive";
  }
  if (status === "insufficient_evidence") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (status === "rollback_outcome_unknown") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  return "";
}

function evidenceLabel(window: MonitoringWindowDto) {
  const state = window.observation?.evidenceState;
  if (state === "missing_delivery_insight") {
    return "The delivery row was unavailable, so no result was inferred.";
  }
  if (state === "missing_conversion_insight") {
    return "The conversion row was unavailable, so no result was inferred.";
  }
  if (state === "missing_delivery_and_conversion_insights") {
    return "Delivery and conversion rows were unavailable, so no result was inferred.";
  }
  if (state === "insufficient_baseline") {
    return "The stored baseline was below the minimum evidence floor.";
  }
  return null;
}

function conversionLabel(value: number | null) {
  if (value === null) return "Unavailable";
  return formatDecimal(value);
}

function changeLabel(value: number | null) {
  if (value === null) return "Not calculated";
  return `${value > 0 ? "+" : ""}${formatDecimal(value)}%`;
}

function LiveMonitoringCard({ window }: { window: MonitoringWindowDto }) {
  const currency = new Intl.NumberFormat("en", {
    style: "currency",
    currency: window.plan.baseline.currencyCode,
    maximumFractionDigits: 0,
  });
  const observation = window.observation;
  const evidenceMessage = evidenceLabel(window);

  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
            <Gauge />
          </div>
          <Badge
            variant="outline"
            className={cn(
              "whitespace-nowrap",
              windowStatusClass(window.status),
            )}
          >
            {windowStatusLabel(window.status)}
          </Badge>
        </div>
        <CardTitle className="pt-3 text-base">
          {window.recommendationTitle}
        </CardTitle>
        <CardDescription className="font-mono">
          {window.entityId}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">Observation window</span>
          <span className="font-medium">{window.plan.windowDays} days</span>
        </div>
        <Progress value={window.progress} />
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{dateLabel(window.startedAt)}</span>
          <span>{window.progress}% elapsed</span>
          <span>{dateLabel(window.endsAt)}</span>
        </div>
        <div className="grid grid-cols-2 gap-4 border-y py-3">
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">
              Baseline conversions
            </span>
            <span className="text-sm font-semibold">
              {formatGroupedInteger(
                window.plan.baseline.clickAttributedConversions,
              )}
            </span>
          </div>
          <div className="grid gap-1">
            <span className="text-xs text-muted-foreground">Baseline spend</span>
            <span className="text-sm font-semibold">
              {currency.format(window.plan.baseline.spend)}
            </span>
          </div>
        </div>
        {observation ? (
          <div className="grid gap-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              {window.outcome === "within_safeguard" ? (
                <CircleCheck className="size-4 text-success" />
              ) : (
                <TriangleAlert
                  className={cn(
                    "size-4",
                    window.outcome === "safeguard_triggered"
                      ? "text-destructive"
                      : "text-warning-foreground",
                  )}
                />
              )}
              Observed result
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  Click conversions
                </span>
                <span className="text-sm font-semibold">
                  {conversionLabel(observation.clickAttributedConversions)}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  Change vs baseline
                </span>
                <span className="text-sm font-semibold">
                  {changeLabel(observation.conversionChangePercent)}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  Observed spend
                </span>
                <span className="text-sm font-semibold">
                  {observation.spend === null
                    ? "Unavailable"
                    : currency.format(observation.spend)}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted-foreground">
                  Evaluation
                </span>
                <span className="text-sm font-semibold">
                  {window.evaluatedAt ? dateLabel(window.evaluatedAt) : "—"}
                </span>
              </div>
            </div>
            {window.outcome === "safeguard_triggered" ? (
              <p className="text-xs text-destructive">
                Human rollback review is recommended. No rollback was sent.
              </p>
            ) : null}
            {evidenceMessage ? (
              <p className="text-xs text-muted-foreground">{evidenceMessage}</p>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <RotateCcw className="mt-0.5 size-3.5 shrink-0" />
          <span>{window.safeguard}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function DemoMonitoringCard({
  recommendation,
  index,
}: {
  recommendation: Recommendation;
  index: number;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
            {index === 0 ? <Gauge /> : <FlaskConical />}
          </div>
          <Badge
            className={cn(
              recommendation.status === "monitoring"
                ? "border-success/20 bg-success/10 text-success"
                : "",
            )}
            variant={
              recommendation.status === "monitoring" ? "outline" : "secondary"
            }
          >
            {recommendation.status === "monitoring"
              ? "Monitoring"
              : "Simulator preview"}
          </Badge>
        </div>
        <CardTitle className="pt-3 text-base">{recommendation.title}</CardTitle>
        <CardDescription>{recommendation.entityLabel}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">Observation window</span>
          <span className="font-medium">7 days</span>
        </div>
        <Progress value={recommendation.status === "monitoring" ? 14 : 0} />
        <div className="flex items-start gap-2 text-xs text-muted-foreground">
          <RotateCcw className="mt-0.5 size-3.5 shrink-0" />
          <span>{recommendation.safeguard}</span>
        </div>
      </CardContent>
    </Card>
  );
}

export function MonitoringWindows({
  dataSource,
  windows,
  recommendations,
  error,
}: {
  dataSource: "demo" | "live";
  windows: MonitoringWindowDto[];
  recommendations: Recommendation[];
  error?: string;
}) {
  if (dataSource === "live") {
    if (windows.length === 0) {
      return (
        <>
          {error ? (
            <Alert className="md:col-span-2">
              <TriangleAlert className="size-4" />
              <AlertTitle>Monitoring check delayed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <Empty className="border bg-background py-12 md:col-span-2">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3 />
              </EmptyMedia>
              <EmptyTitle>No active monitoring windows</EmptyTitle>
              <EmptyDescription>
                A window starts only after a live recommendation is confirmed as
                applied.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </>
      );
    }

    return (
      <>
        {error ? (
          <Alert className="md:col-span-2">
            <TriangleAlert className="size-4" />
            <AlertTitle>Monitoring check delayed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {windows.map((window) => (
          <LiveMonitoringCard key={window.approvalId} window={window} />
        ))}
      </>
    );
  }

  const monitoring = recommendations.filter(
    (recommendation) => recommendation.status === "monitoring",
  );
  const experiments =
    monitoring.length > 0
      ? monitoring
      : recommendations.filter((recommendation) =>
          ["rec_bid_20", "rec_creative_test"].includes(recommendation.id),
        );

  return experiments.map((recommendation, index) => (
    <DemoMonitoringCard
      key={recommendation.id}
      recommendation={recommendation}
      index={index}
    />
  ));
}
