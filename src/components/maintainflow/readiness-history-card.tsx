import {
  ArrowDownRight,
  ArrowUpRight,
  Clock3,
  History,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { Separator } from "@/components/ui/separator";
import {
  compareReadinessAuditHistory,
  type ReadinessAuditHistoryEntry,
} from "@/lib/readiness/history";
import type { AccountAccess } from "@/lib/tenancy/schema";
import { formatUtcDateTime } from "@/lib/formatting";
import { cn } from "@/lib/utils";

function verdictLabel(
  verdict: ReadinessAuditHistoryEntry["audit"]["verdict"],
) {
  if (verdict === "ready") return "Ready for review";
  if (verdict === "needs_work") return "Needs work";
  return "Not ready";
}

function recordedAtLabel(value: string) {
  return formatUtcDateTime(value);
}

function urlLabel(value: string) {
  const url = new URL(value);
  return `${url.hostname}${url.pathname === "/" ? "" : url.pathname}`;
}

export function ReadinessHistoryCard({
  account,
  ready,
  error,
  entries,
  canSave,
}: {
  account?: Pick<AccountAccess, "accountId" | "accountName">;
  ready: boolean;
  error?: string;
  entries: ReadinessAuditHistoryEntry[];
  canSave: boolean;
}) {
  const comparison = compareReadinessAuditHistory(entries);

  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <History className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle className="text-base">Readiness history</CardTitle>
            <CardDescription className="leading-5">
              Account-scoped scans that show what changed before launch.
            </CardDescription>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="w-fit whitespace-nowrap">
            {!account
              ? "Not connected"
              : ready
                ? `${entries.length} saved ${entries.length === 1 ? "scan" : "scans"}`
                : "Unavailable"}
          </Badge>
          {account && ready && !canSave ? (
            <Badge variant="secondary">Review only</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 md:p-5">
        {!account ? (
          <Alert>
            <ShieldCheck />
            <AlertTitle>Connect an account to retain evidence</AlertTitle>
            <AlertDescription>
              Connect an advertiser account to retain scans and compare repeat
              checks. Public URL audits still run without an Ads key.
            </AlertDescription>
          </Alert>
        ) : !ready ? (
          <Alert>
            <ShieldCheck />
            <AlertTitle>Readiness history unavailable</AlertTitle>
            <AlertDescription>
              {error ??
                "Apply the readiness history migration before saving account evidence."}
            </AlertDescription>
          </Alert>
        ) : !comparison ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <History />
              </EmptyMedia>
              <EmptyTitle>No saved scans yet</EmptyTitle>
              <EmptyDescription>
                {canSave
                  ? `The next landing-page audit will be retained for ${account.accountName}.`
                  : "Account manager or owner access is required to save a new scan."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            {!canSave ? (
              <Alert>
                <ShieldCheck />
                <AlertTitle>Saved history is read only</AlertTitle>
                <AlertDescription>
                  You can review prior evidence. Account manager or owner access
                  is required to add another saved scan.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
              <div className="grid gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">
                    {urlLabel(comparison.current.audit.finalUrl)}
                  </p>
                  <Badge variant="secondary">
                    {verdictLabel(comparison.current.audit.verdict)}
                  </Badge>
                  <Badge variant="outline">Manual URL · unverified</Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Latest saved scan · {recordedAtLabel(comparison.current.recordedAt)} UTC
                </p>
                {comparison.previous ? (
                  <p className="text-sm leading-6 text-muted-foreground">
                    Compared with the previous scan of this URL from{" "}
                    {recordedAtLabel(comparison.previous.recordedAt)} UTC.
                  </p>
                ) : (
                  <p className="text-sm leading-6 text-muted-foreground">
                    This is the first saved scan for this exact final URL.
                  </p>
                )}
              </div>
              <div className="flex items-end gap-3 lg:flex-col lg:items-end lg:gap-1">
                <p className="text-3xl font-semibold tracking-[-0.04em]">
                  {comparison.current.audit.score}
                  <span className="text-base text-muted-foreground">/100</span>
                </p>
                {comparison.scoreDelta !== null ? (
                  <div
                    className={cn(
                      "flex items-center gap-1 text-xs font-medium",
                      comparison.scoreDelta > 0 && "text-success",
                      comparison.scoreDelta < 0 && "text-destructive",
                      comparison.scoreDelta === 0 && "text-muted-foreground",
                    )}
                  >
                    {comparison.scoreDelta > 0 ? (
                      <ArrowUpRight className="size-3.5" />
                    ) : comparison.scoreDelta < 0 ? (
                      <ArrowDownRight className="size-3.5" />
                    ) : null}
                    {comparison.scoreDelta > 0 ? "+" : ""}
                    {comparison.scoreDelta} points
                  </div>
                ) : null}
              </div>
            </div>

            {comparison.previous ? (
              comparison.compatible ? (
                <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Checks improved</p>
                  <p className="mt-1 text-xl font-semibold text-success">
                    {comparison.improvedChecks.length}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Checks regressed</p>
                  <p
                    className={cn(
                      "mt-1 text-xl font-semibold",
                      comparison.regressedChecks.length > 0
                        ? "text-destructive"
                        : "text-foreground",
                    )}
                  >
                    {comparison.regressedChecks.length}
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">Verdict changed</p>
                  <p className="mt-1 text-sm font-semibold">
                    {comparison.verdictChanged ? "Yes" : "No"}
                  </p>
                </div>
                </div>
              ) : (
                <Alert>
                  <History />
                  <AlertTitle>Comparison paused</AlertTitle>
                  <AlertDescription>
                    {comparison.incompatibilityReason}
                  </AlertDescription>
                </Alert>
              )
            ) : null}

            <Separator />

            <div className="grid gap-3">
              <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Recent account scans
              </p>
              <ul className="grid gap-2">
                {entries.slice(0, 3).map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {urlLabel(entry.audit.finalUrl)}
                      </p>
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock3 className="size-3.5" />
                        {recordedAtLabel(entry.recordedAt)} UTC
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Badge variant="outline">
                        {verdictLabel(entry.audit.verdict)}
                      </Badge>
                      <span className="text-sm font-semibold">
                        {entry.audit.score}/100
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
              {entries.length > 3 ? (
                <p className="text-xs text-muted-foreground">
                  +{entries.length - 3} more saved{" "}
                  {entries.length - 3 === 1 ? "scan" : "scans"} retained for
                  this account.
                </p>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
      <CardFooter className="border-t bg-muted/20 p-4 md:p-5">
        <p className="text-xs leading-5 text-muted-foreground">
          History stores the sanitized audit result and provenance only—not page
          HTML, cookies, raw response bodies, API keys, or Pixel credentials.
        </p>
      </CardFooter>
    </Card>
  );
}
