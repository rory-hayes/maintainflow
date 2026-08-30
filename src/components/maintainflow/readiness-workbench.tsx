"use client";

import { FormEvent, useMemo, useState } from "react";
import {
  Bot,
  Cable,
  CheckCircle2,
  CircleAlert,
  CircleX,
  ExternalLink,
  Globe2,
  Loader2,
  Radar,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { ProductFeedPreflight } from "@/components/maintainflow/product-feed-preflight";
import { ConversionsApiPreflight } from "@/components/maintainflow/conversions-api-preflight";
import { ReadinessReportCard } from "@/components/maintainflow/readiness-report-card";
import { ReadinessHistoryCard } from "@/components/maintainflow/readiness-history-card";
import type { ConversionPayloadAudit } from "@/lib/readiness/conversions-api";
import type { ReadinessAuditHistoryEntry } from "@/lib/readiness/history";
import type { ProductFeedAudit } from "@/lib/readiness/product-feed";
import type {
  MeasurementInstallation,
  ReadinessAudit,
  ReadinessCheck,
} from "@/lib/readiness/schema";
import type { ConversionMeasurementReadiness } from "@/lib/openai-ads/measurement-readiness";
import type { AccountAccess } from "@/lib/tenancy/schema";
import { cn } from "@/lib/utils";

const statusOrder: Record<ReadinessCheck["status"], number> = {
  fail: 0,
  warning: 1,
  pass: 2,
};

function verdictLabel(verdict: ReadinessAudit["verdict"]) {
  if (verdict === "ready") return "Ready for review";
  if (verdict === "needs_work") return "Needs work";
  return "Not ready";
}

function checkIcon(status: ReadinessCheck["status"]) {
  if (status === "pass") return CheckCircle2;
  if (status === "warning") return CircleAlert;
  return CircleX;
}

function checkedAtLabel(value: string) {
  return new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function ReadinessWorkbench({
  conversionMeasurement,
  account,
  historyReady,
  historyError,
  initialHistory,
  canSaveHistory,
}: {
  conversionMeasurement: ConversionMeasurementReadiness;
  account?: Pick<AccountAccess, "accountId" | "accountName">;
  historyReady: boolean;
  historyError?: string;
  initialHistory: ReadinessAuditHistoryEntry[];
  canSaveHistory: boolean;
}) {
  const [url, setUrl] = useState("");
  const [audit, setAudit] = useState<ReadinessAudit | null>(null);
  const [productFeedAudit, setProductFeedAudit] = useState<ProductFeedAudit | null>(
    null,
  );
  const [conversionsApiAudit, setConversionsApiAudit] =
    useState<ConversionPayloadAudit | null>(null);
  const [history, setHistory] = useState(initialHistory);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const priorityFixes = useMemo(
    () =>
      audit?.checks
        .filter((item) => item.status !== "pass")
        .sort(
          (left, right) =>
            statusOrder[left.status] - statusOrder[right.status] ||
            right.weight - left.weight,
        )
        .slice(0, 3) ?? [],
    [audit],
  );

  async function runAudit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/readiness/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          ...(account && historyReady && canSaveHistory
            ? { accountId: account.accountId }
            : {}),
        }),
      });
      const result = (await response.json()) as ReadinessAudit & {
        error?: string;
        historyEntry?: ReadinessAuditHistoryEntry;
        historySaveError?: string;
      };
      if (!response.ok) throw new Error(result.error ?? "The page could not be audited.");
      setAudit(result);
      setUrl(result.finalUrl);
      if (result.historyEntry) {
        setHistory((current) => [
          result.historyEntry as ReadinessAuditHistoryEntry,
          ...current.filter((entry) => entry.id !== result.historyEntry?.id),
        ]);
      }
      toast.success("Readiness audit complete", {
        description: `${result.score}/100 · ${verdictLabel(result.verdict)}`,
      });
      if (result.historySaveError) {
        toast.warning("Audit was not added to account history", {
          description: result.historySaveError,
        });
      }
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The page could not be audited.";
      setAudit(null);
      setError(message);
      toast.error("Audit could not run", { description: message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="mx-auto grid max-w-7xl gap-6 p-4 md:p-6 lg:p-8">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div className="grid max-w-3xl gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">Commerce preflight · no key required</Badge>
            <Badge variant="secondary">Public URL only</Badge>
          </div>
          <h1 className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl">
            Is your commerce stack ready for ChatGPT?
          </h1>
          <p className="text-sm leading-6 text-muted-foreground md:text-base">
            Audit a landing page and product feed against OpenAI&apos;s published
            crawler, commerce, Measurement Pixel, and server event guidance
            before you connect an Ads key.
          </p>
        </div>
      </div>

      <Card className="shadow-sm">
        <CardContent className="p-4 md:p-5">
          <form className="flex flex-col gap-3 md:flex-row" onSubmit={runAudit}>
            <div className="relative flex-1">
              <Globe2 className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="text"
                inputMode="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://your-shop.com/products/best-seller"
                aria-label="Public landing-page URL"
                className="h-11 pl-9"
                required
              />
            </div>
            <Button className="h-11 md:min-w-40" type="submit" disabled={loading}>
              {loading ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Radar data-icon="inline-start" />
              )}
              {loading ? "Auditing page" : "Run readiness audit"}
            </Button>
          </form>
          <p className="mt-3 text-xs text-muted-foreground">
            MaintainFlow makes a read-only request and does not submit, edit, or
            approve an ad.
          </p>
        </CardContent>
      </Card>

      {error ? (
        <Alert variant="destructive">
          <CircleX />
          <AlertTitle>We could not audit that page</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {audit ? (
        <AuditResults audit={audit} priorityFixes={priorityFixes} />
      ) : (
        <ReadinessEmptyState />
      )}

      <ReadinessHistoryCard
        account={account}
        ready={historyReady}
        error={historyError}
        entries={history}
        canSave={canSaveHistory}
      />

      <ConversionMeasurementCard readiness={conversionMeasurement} />

      <ReadinessReportCard
        storefront={audit}
        productFeed={productFeedAudit}
        conversionsApi={conversionsApiAudit}
        accountMeasurement={conversionMeasurement}
      />

      <ProductFeedPreflight onAuditChange={setProductFeedAudit} />

      <ConversionsApiPreflight onAuditChange={setConversionsApiAudit} />
    </section>
  );
}

function measurementStatusLabel(
  status: ConversionMeasurementReadiness["status"],
) {
  if (status === "ready") return "Measurement ready";
  if (status === "needs_attention") return "Needs attention";
  if (status === "not_applicable") return "Not applicable";
  return "Live check unavailable";
}

function installationStatusLabel(
  status: MeasurementInstallation["status"],
) {
  if (status === "detected") return "Static signal detected";
  if (status === "needs_attention") return "Needs attention";
  return "Not detected";
}

export function ConversionMeasurementCard({
  readiness,
}: {
  readiness: ConversionMeasurementReadiness;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 min-[640px]:flex-row min-[640px]:items-start min-[640px]:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Cable className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle className="text-base">Conversion measurement</CardTitle>
            <CardDescription className="leading-5">
              A separate, read-only Ads API check for the connected account. It
              does not use or change the public URL audit below.
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
          {measurementStatusLabel(readiness.status)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 md:p-5">
        <p className="text-sm text-muted-foreground">{readiness.message}</p>
        {readiness.status !== "unavailable" ? (
          <div className="grid grid-cols-2 gap-3 sm:max-w-md">
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Active conversion campaigns</p>
              <p className="mt-1 text-xl font-semibold">
                {readiness.activeConversionCampaigns}
              </p>
            </div>
            <div className="rounded-lg border p-3">
              <p className="text-xs text-muted-foreground">Healthy measurement</p>
              <p className="mt-1 text-xl font-semibold">
                {readiness.healthyCampaigns}/{readiness.activeConversionCampaigns}
              </p>
            </div>
          </div>
        ) : null}
        {readiness.checks.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {readiness.checks.map((check) => {
              const Icon = checkIcon(check.status);
              return (
                <div
                  key={check.campaignId}
                  className="flex items-start gap-3 rounded-lg border p-3"
                >
                  <Icon
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      check.status === "pass" && "text-success",
                      check.status === "warning" && "text-warning",
                      check.status === "fail" && "text-destructive",
                    )}
                  />
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{check.campaignName}</p>
                      <Badge variant="outline" className="capitalize">
                        {check.status}
                      </Badge>
                    </div>
                    <p className="text-xs font-medium">{check.title}</p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {check.detail}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {readiness.source === "live" ? (
          <p className="text-xs text-muted-foreground">
            Checked {checkedAtLabel(readiness.checkedAt)} UTC · bid
            recommendations fail closed when this evidence is unavailable.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            Demo mode does not fabricate event-setting evidence.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function MeasurementInstallationCard({
  measurement,
}: {
  measurement: MeasurementInstallation;
}) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 min-[640px]:flex-row min-[640px]:items-start min-[640px]:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Radar className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle className="text-base">ChatGPT measurement installation</CardTitle>
            <CardDescription className="leading-5">
              Static evidence from the returned HTML and Content Security Policy.
            </CardDescription>
          </div>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "w-fit whitespace-nowrap",
            measurement.status === "detected" &&
              "border-success/30 bg-success/10 text-success",
            measurement.status === "needs_attention" &&
              "border-warning/30 bg-warning/10 text-warning-foreground",
          )}
        >
          {installationStatusLabel(measurement.status)}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 md:p-5">
        <div className="grid gap-3 md:grid-cols-2">
          {measurement.checks.map((item) => {
            const Icon = checkIcon(item.status);
            return (
              <div
                key={item.id}
                className="flex items-start gap-3 rounded-lg border p-3"
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    item.status === "pass" && "text-success",
                    item.status === "warning" && "text-warning",
                    item.status === "fail" && "text-destructive",
                  )}
                />
                <div className="grid gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{item.title}</p>
                    <Badge variant="outline" className="capitalize">
                      {item.status}
                    </Badge>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {item.evidence}
                  </p>
                  {item.status !== "pass" ? (
                    <p className="text-xs leading-5">{item.recommendation}</p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        <Alert className="bg-background">
          <CircleAlert />
          <AlertTitle>Static preflight only</AlertTitle>
          <AlertDescription>
            MaintainFlow did not execute JavaScript or fire a conversion. Tag-manager
            rules and the server-side Conversions API require separate runtime
            validation.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function ReadinessEmptyState() {
  const previews = [
    {
      icon: Bot,
      title: "OpenAI crawler access",
      description: "Checks robots.txt rules for OAI-AdsBot and OAI-SearchBot.",
    },
    {
      icon: Globe2,
      title: "Landing-page access",
      description: "Follows safe public redirects and verifies crawlable HTML.",
    },
    {
      icon: Sparkles,
      title: "Product understanding",
      description: "Looks for Product schema, offer facts, metadata, and a sitemap.",
    },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-3">
      {previews.map(({ icon: Icon, title, description }) => (
        <Card key={title} className="shadow-sm">
          <CardHeader>
            <div className="mb-2 grid size-10 place-items-center rounded-lg bg-primary/10 text-primary">
              <Icon className="size-5" />
            </div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription className="leading-5">{description}</CardDescription>
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}

function AuditResults({
  audit,
  priorityFixes,
}: {
  audit: ReadinessAudit;
  priorityFixes: ReadinessCheck[];
}) {
  const passed = audit.checks.filter((item) => item.status === "pass").length;

  return (
    <div className="grid gap-6">
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card className="shadow-sm">
          <CardHeader className="pb-3">
            <CardDescription>Readiness score</CardDescription>
            <div className="flex items-end justify-between gap-3">
              <CardTitle className="text-5xl tracking-[-0.05em]">
                {audit.score}
                <span className="text-lg text-muted-foreground">/100</span>
              </CardTitle>
              <Badge
                variant={audit.verdict === "ready" ? "outline" : "secondary"}
                className={cn(
                  audit.verdict === "ready" &&
                    "border-success/30 bg-success/10 text-success",
                )}
              >
                {verdictLabel(audit.verdict)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Progress value={audit.score} />
            <p className="text-xs text-muted-foreground">
              {passed} of {audit.checks.length} checks passed · scanned{" "}
              {new Date(audit.scannedAt).toLocaleString()}
            </p>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle className="text-base">
              {priorityFixes.length > 0 ? "Fix these first" : "No priority blockers found"}
            </CardTitle>
            <CardDescription>
              Ranked by OpenAI crawler importance and potential impact.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {priorityFixes.length > 0 ? (
              priorityFixes.map((item, index) => (
                <div key={item.id} className="flex items-start gap-3 rounded-lg border p-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">
                    {index + 1}
                  </span>
                  <div className="grid gap-1">
                    <p className="text-sm font-medium">{item.title}</p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {item.recommendation}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <div className="flex items-start gap-3 rounded-lg border border-success/20 bg-success/5 p-4">
                <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
                <p className="text-sm leading-6">
                  This page passed every check in the current scan. Keep monitoring
                  crawler access and structured data as the storefront changes.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <MeasurementInstallationCard measurement={audit.measurement} />

      <Card className="shadow-sm">
        <CardHeader className="flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="grid gap-1">
            <CardTitle className="text-base">Observed checks</CardTitle>
            <CardDescription className="break-all">{audit.finalUrl}</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <a href={audit.finalUrl} target="_blank" rel="noreferrer">
              Open page
              <ExternalLink data-icon="inline-end" />
            </a>
          </Button>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          {audit.checks.map((item) => {
            const Icon = checkIcon(item.status);
            return (
              <div key={item.id} className="flex items-start gap-3 rounded-xl border p-4">
                <Icon
                  className={cn(
                    "mt-0.5 size-5 shrink-0",
                    item.status === "pass" && "text-success",
                    item.status === "warning" && "text-warning",
                    item.status === "fail" && "text-destructive",
                  )}
                />
                <div className="grid gap-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{item.title}</p>
                    <Badge variant="outline" className="capitalize">
                      {item.status}
                    </Badge>
                  </div>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {item.evidence}
                  </p>
                  {item.status !== "pass" ? (
                    <p className="text-xs leading-5">{item.recommendation}</p>
                  ) : null}
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <Alert className="bg-background">
        <CircleAlert />
        <AlertTitle>What this audit cannot prove</AlertTitle>
        <AlertDescription>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            {audit.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    </div>
  );
}
