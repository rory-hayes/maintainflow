import {
  CheckCircle2,
  CircleAlert,
  Link2,
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
import type { CampaignAttributionReadiness } from "@/lib/openai-ads/attribution-readiness";
import { cn } from "@/lib/utils";

function statusLabel(status: CampaignAttributionReadiness["status"]) {
  if (status === "ready") return "Campaign template configured";
  if (status === "not_applicable") return "Not applicable";
  return "Campaign template needs attention";
}

export function AttributionReadinessCard({
  readiness,
  dataSource,
}: {
  readiness: CampaignAttributionReadiness;
  dataSource: "demo" | "live";
}) {
  const priorityActions = readiness.actionableChecks;
  const evidenceLabel =
    dataSource === "live"
      ? readiness.counts.totalCampaigns > 0
        ? "Campaign fields from Ads API"
        : "No campaign evidence"
      : "Simulator evidence";

  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 min-[640px]:flex-row min-[640px]:items-start min-[640px]:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Link2 className="size-5" />
          </div>
          <div className="grid gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base">Campaign-level URL tags</CardTitle>
              <Badge variant="secondary">{evidenceLabel}</Badge>
            </div>
            <CardDescription className="max-w-3xl leading-5">
              Reviews the campaign query template for useful source labels and
              OpenAI-supported dynamic identifiers. Ad URL, ad, and ad-group
              overrides are more specific and are not resolved by this check.
            </CardDescription>
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "w-fit whitespace-nowrap",
            readiness.status === "ready" &&
              "border-success/30 bg-success/10 text-success",
            readiness.status === "needs_attention" &&
              "border-warning/30 bg-warning/10 text-warning-foreground",
          )}
        >
          {statusLabel(readiness.status)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-5 p-4 md:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Active campaigns</p>
            <p className="mt-1 text-xl font-semibold">
              {readiness.counts.activeCampaigns}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">
              Campaign templates configured
            </p>
            <p className="mt-1 text-xl font-semibold">
              {readiness.counts.readyCampaigns}/{readiness.counts.activeCampaigns}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Priority fixes</p>
            <p className="mt-1 text-xl font-semibold">
              {readiness.counts.actionableChecks}
            </p>
          </div>
        </div>

        {priorityActions.length > 0 ? (
          <div className="grid gap-3">
            <div className="flex items-center gap-2">
              <CircleAlert className="size-4 text-warning" />
              <h3 className="text-sm font-semibold">Fix before launch</h3>
            </div>
            {priorityActions.map((action) => (
              <div
                key={`${action.campaignId}:${action.code}`}
                className="grid gap-2 rounded-lg border p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium">{action.title}</p>
                  <Badge variant="outline">{action.campaignName}</Badge>
                </div>
                <p className="text-xs leading-5 text-muted-foreground">
                  {action.detail}
                </p>
                <div className="min-w-0 rounded-md bg-muted px-3 py-2">
                  <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                    Safe starting template
                  </p>
                  <code className="block overflow-x-auto whitespace-nowrap text-xs">
                    {action.recommendedTemplate}
                  </code>
                </div>
              </div>
            ))}
          </div>
        ) : readiness.status === "ready" ? (
          <div className="flex items-start gap-3 rounded-lg border border-success/20 bg-success/5 p-3">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
            <div className="grid gap-1">
              <p className="text-sm font-medium">
                Active campaign templates are configured
              </p>
              <p className="text-xs leading-5 text-muted-foreground">
                {readiness.message}
              </p>
            </div>
          </div>
        ) : null}

        <Alert>
          <TriangleAlert />
          <AlertTitle>
            Campaign-level check, not effective-URL or attribution proof
          </AlertTitle>
          <AlertDescription>
            UTM naming is a MaintainFlow recommendation, not an OpenAI rule.
            More-specific URL settings can override the campaign template. This
            check cannot prove that redirects preserve OpenAI&apos;s reserved oppref
            value or that your analytics platform recorded the visit.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
