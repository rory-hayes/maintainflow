"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  CircleHelp,
  FileSearch2,
  Loader2,
  ShieldCheck,
  TriangleAlert,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { formatGroupedInteger, formatUtcDateTime } from "@/lib/formatting";
import {
  changeIntegrityEventDtoSchema,
  changeIntegrityEventPageSchema,
  type ChangeIntegrityEventDto,
  type ChangeIntegrityEventPage,
} from "@/lib/openai-ads/change-integrity-schema";
import { cn } from "@/lib/utils";

function valueAtPath(value: Record<string, unknown> | null, path: string) {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function moneyFromMicros(currencyCode: string, value: number) {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: currencyCode,
    maximumFractionDigits: 2,
  }).format(value / 1_000_000);
}

export function displayChangeIntegrityValue(
  value: unknown,
  path: string,
  currencyCode: string,
) {
  if (value === undefined) return "Not present";
  if (value === null) return "None";
  if (
    typeof value === "number" &&
    path.endsWith("_micros") &&
    !path.endsWith("bid_multiplier_micros")
  ) {
    return moneyFromMicros(currencyCode, value);
  }
  if (typeof value === "string") return value || "Empty string";
  const serialized = JSON.stringify(value);
  if (!serialized) return String(value);
  return serialized.length > 180 ? `${serialized.slice(0, 177)}…` : serialized;
}

function fieldLabel(path: string) {
  return path
    .split(".")
    .map((part) =>
      part
        .replace(/_micros$/, "")
        .replaceAll("_", " ")
        .replace(/^bidding config$/, "bidding"),
    )
    .join(" · ");
}

export function changeIntegrityPageVersion(page: ChangeIntegrityEventPage) {
  return [
    page.summary.lastCheckedAt ?? "no-baseline",
    page.summary.retainedEventCount,
    page.summary.openUnexplainedCount,
    page.summary.openIndeterminateCount,
    page.summary.consistentCount,
    page.summary.reviewedCount,
    page.hasMore ? "more" : "complete",
    ...page.events.map(
      (event) =>
        `${event.id}:${event.reviewStatus}:${event.reviewedAt ?? "unreviewed"}`,
    ),
  ].join("|");
}

function resourceTypeLabel(type: ChangeIntegrityEventDto["resourceType"]) {
  if (type === "ad_account") return "Ad account";
  if (type === "ad_group") return "Ad group";
  return type === "campaign" ? "Campaign" : "Ad";
}

function classificationLabel(
  classification: ChangeIntegrityEventDto["classification"],
) {
  if (classification === "maintainflow_consistent") {
    return "Matches approved change";
  }
  return classification === "indeterminate"
    ? "Indeterminate at detection"
    : "Unexplained";
}

function classificationIcon(
  classification: ChangeIntegrityEventDto["classification"],
) {
  if (classification === "maintainflow_consistent") {
    return <CheckCircle2 className="size-3" />;
  }
  return classification === "indeterminate" ? (
    <CircleHelp className="size-3" />
  ) : (
    <TriangleAlert className="size-3" />
  );
}

function classificationClass(
  classification: ChangeIntegrityEventDto["classification"],
) {
  if (classification === "maintainflow_consistent") {
    return "border-success/30 bg-success/10 text-success";
  }
  if (classification === "indeterminate") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  return "border-destructive/30 bg-destructive/10 text-destructive";
}

function IntegrityMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border bg-background p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
    </div>
  );
}

function EventClassification({ event }: { event: ChangeIntegrityEventDto }) {
  return (
    <Badge
      variant="outline"
      className={cn("w-fit gap-1.5 whitespace-nowrap", classificationClass(event.classification))}
    >
      {classificationIcon(event.classification)}
      {classificationLabel(event.classification)}
    </Badge>
  );
}

export function changeIntegrityFieldClassification(
  event: ChangeIntegrityEventDto,
  path: string,
) {
  if (event.unexplainedFieldPaths.includes(path)) {
    return {
      label: "No unambiguous explanation",
      className: "border-destructive/30 bg-destructive/10 text-destructive",
    };
  }
  if (event.indeterminateFieldPaths.includes(path)) {
    return {
      label: "Indeterminate at detection",
      className: "border-warning/30 bg-warning/10 text-warning-foreground",
    };
  }
  return {
    label: "Matches operation",
    className: "border-success/30 bg-success/10 text-success",
  };
}

export function shouldRefreshAfterChangeIntegrityReview(
  source: "simulator" | "live",
) {
  return source === "live";
}

export function changeIntegrityOperationEvidenceSummary(
  operations: ChangeIntegrityEventDto["matchedOperations"],
) {
  const operationCount = operations.length;
  const operation = operationCount === 1 ? "operation was" : "operations were";
  const timingIndeterminate = operations.some(
    (item) => item.uncertaintyReason === "snapshot_timing",
  );
  const outcomeIndeterminate = operations.some(
    (item) => item.uncertaintyReason === "provider_outcome",
  );
  const uncertainty = timingIndeterminate && outcomeIndeterminate
    ? " At detection time, some evidence overlapped the provider-read interval and some had no confirmed provider outcome."
    : timingIndeterminate
      ? " At detection time, some evidence overlapped the provider-read interval, so snapshot ordering was not proven."
      : outcomeIndeterminate
        ? " At detection time, some evidence had no confirmed provider outcome."
        : "";
  return `${operationCount} retained MaintainFlow ${operation} considered for these changed fields. The recorded expected values may agree with or conflict with the observed values.${uncertainty} The classification above reflects the combined evidence and any fields left unexplained or indeterminate at detection time.`;
}

function ChangeDetails({
  event,
  currencyCode,
}: {
  event: ChangeIntegrityEventDto;
  currencyCode: string;
}) {
  return (
    <div className="grid gap-2">
      {event.changedFieldPaths.map((path) => (
        <div key={path} className="grid gap-2 rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="break-words text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {fieldLabel(path)}
            </p>
            <Badge
              variant="outline"
              className={cn(
                "w-fit whitespace-nowrap",
                changeIntegrityFieldClassification(event, path).className,
              )}
            >
              {changeIntegrityFieldClassification(event, path).label}
            </Badge>
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="min-w-0 rounded-md bg-background p-2">
              <p className="mb-1 text-muted-foreground">Previous</p>
              <p className="break-words font-mono leading-5">
                {displayChangeIntegrityValue(
                  valueAtPath(event.previousConfiguration, path),
                  path,
                  currencyCode,
                )}
              </p>
            </div>
            <div className="min-w-0 rounded-md bg-background p-2">
              <p className="mb-1 text-muted-foreground">Observed</p>
              <p className="break-words font-mono leading-5">
                {displayChangeIntegrityValue(
                  valueAtPath(event.currentConfiguration, path),
                  path,
                  currencyCode,
                )}
              </p>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function reviewedPage(
  page: ChangeIntegrityEventPage,
  reviewed: ChangeIntegrityEventDto,
) {
  const prior = page.events.find((event) => event.id === reviewed.id);
  if (!prior || prior.reviewStatus !== "open") return page;
  return {
    ...page,
    events: page.events.map((event) =>
      event.id === reviewed.id ? reviewed : event,
    ),
    summary: {
      ...page.summary,
      openUnexplainedCount: Math.max(
        0,
        page.summary.openUnexplainedCount -
          (prior.classification === "unexplained" ? 1 : 0),
      ),
      openIndeterminateCount: Math.max(
        0,
        page.summary.openIndeterminateCount -
          (prior.classification === "indeterminate" ? 1 : 0),
      ),
      reviewedCount: page.summary.reviewedCount + 1,
    },
  };
}

type ChangeIntegrityCursor = {
  reviewStatus: ChangeIntegrityEventDto["reviewStatus"];
  detectedAt: string;
  id: string;
};

function cursorFromEvent(
  event: ChangeIntegrityEventDto | undefined,
): ChangeIntegrityCursor | null {
  return event
    ? {
        reviewStatus: event.reviewStatus,
        detectedAt: event.detectedAt,
        id: event.id,
      }
    : null;
}

export function ChangeIntegrityGuard({
  accountId,
  currencyCode,
  source,
  initialPage,
  freshness,
  ready,
  error,
  canReview,
  operatorName,
}: {
  accountId: string;
  currencyCode: string;
  source: "simulator" | "live";
  initialPage: ChangeIntegrityEventPage;
  freshness: "current" | "stale" | "unknown";
  ready: boolean;
  error?: string;
  canReview: boolean;
  operatorName: string;
}) {
  const router = useRouter();
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState<ChangeIntegrityEventDto | null>(null);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string>();
  const [paginationCursor, setPaginationCursor] =
    useState<ChangeIntegrityCursor | null>(() =>
      cursorFromEvent(initialPage.events.at(-1)),
    );
  const openCount =
    page.summary.openUnexplainedCount + page.summary.openIndeterminateCount;
  const guardCurrent = ready && page.summary.baselineReady && freshness === "current";
  const guardStatus =
    error || !ready
      ? "Unavailable"
      : !page.summary.baselineReady
        ? "Awaiting baseline"
        : freshness === "stale"
          ? "Retained baseline"
          : freshness === "current"
            ? "Active"
            : "Status unknown";
  const orderedEvents = useMemo(
    () =>
      [...page.events].sort((left, right) => {
        const openRank = Number(right.reviewStatus === "open") -
          Number(left.reviewStatus === "open");
        return (
          openRank ||
          Date.parse(right.detectedAt) - Date.parse(left.detectedAt) ||
          right.id.localeCompare(left.id)
        );
      }),
    [page.events],
  );

  function openEvent(event: ChangeIntegrityEventDto) {
    setSelected(event);
    setNote("");
    setSubmitError(undefined);
  }

  async function loadMoreEvents() {
    if (source !== "live" || !page.hasMore || !paginationCursor) return;
    setLoadingMore(true);
    setLoadMoreError(undefined);
    try {
      const search = new URLSearchParams({
        accountId,
        limit: "50",
        afterOpen:
          paginationCursor.reviewStatus === "open" ? "true" : "false",
        afterDetectedAt: paginationCursor.detectedAt,
        afterId: paginationCursor.id,
      });
      const response = await fetch(`/api/ads/integrity-events?${search}`);
      const body = (await response.json()) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error ?? "More integrity events could not be loaded.");
      }
      const nextPage = changeIntegrityEventPageSchema.parse(body);
      if (nextPage.hasMore && nextPage.events.length === 0) {
        throw new Error("The next integrity-events page did not advance.");
      }
      setPage((current) => {
        const byId = new Map(current.events.map((event) => [event.id, event]));
        for (const event of nextPage.events) byId.set(event.id, event);
        return {
          events: [...byId.values()],
          hasMore: nextPage.hasMore,
          summary: nextPage.summary,
        };
      });
      setPaginationCursor(cursorFromEvent(nextPage.events.at(-1)));
    } catch (caught) {
      setLoadMoreError(
        caught instanceof Error
          ? caught.message
          : "More integrity events could not be loaded.",
      );
    } finally {
      setLoadingMore(false);
    }
  }

  async function recordReviewed() {
    if (!selected || selected.reviewStatus !== "open") return;
    const trimmedNote = note.trim();
    if (trimmedNote.length < 10) {
      setSubmitError("Add at least 10 characters describing what you verified.");
      return;
    }

    setSubmitting(true);
    setSubmitError(undefined);
    try {
      let reviewed: ChangeIntegrityEventDto;
      if (source === "simulator") {
        reviewed = changeIntegrityEventDtoSchema.parse({
          ...selected,
          reviewStatus: "reviewed",
          reviewedByName: `${operatorName} · simulator`,
          reviewNote: trimmedNote,
          reviewedAt: new Date().toISOString(),
        });
      } else {
        const response = await fetch(
          `/api/ads/integrity-events/${encodeURIComponent(selected.id)}/acknowledge`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId, note: trimmedNote }),
          },
        );
        const result = (await response.json()) as {
          event?: unknown;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(result.error ?? "The integrity event could not be reviewed.");
        }
        reviewed = changeIntegrityEventDtoSchema.parse(result.event);
      }

      setPage((current) => reviewedPage(current, reviewed));
      setSelected(reviewed);
      setNote("");
      toast.success("Integrity review recorded", {
        description:
          source === "simulator"
            ? "This simulator review stays in the current browser session."
            : "The operator note is now part of the durable account evidence.",
      });
      if (shouldRefreshAfterChangeIntegrityReview(source)) router.refresh();
    } catch (caught) {
      setSubmitError(
        caught instanceof Error
          ? caught.message
          : "The integrity event could not be reviewed.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <Card className="min-w-0 shadow-sm">
        <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <ShieldCheck className="size-5" />
            </div>
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">Change Integrity Guard</CardTitle>
                <Badge variant="secondary">
                  {source === "simulator" ? "Simulator evidence" : "Live evidence"}
                </Badge>
              </div>
              <CardDescription className="max-w-3xl leading-5">
                Checks each fresh confirmed snapshot for material account, campaign,
                ad-group, and ad changes, then compares them with recorded MaintainFlow
                operations.
              </CardDescription>
            </div>
          </div>
          <Badge
            variant="outline"
            className={cn(
              "w-fit whitespace-nowrap",
              guardCurrent
                ? "border-success/30 bg-success/10 text-success"
                : "border-warning/30 bg-warning/10 text-warning-foreground",
            )}
          >
              {guardCurrent
                ? "Guard active"
                : error || !ready
                  ? "Unavailable"
                  : page.summary.baselineReady && freshness === "stale"
                    ? "Refresh required"
                    : page.summary.baselineReady && freshness === "unknown"
                      ? "Status unknown"
                      : "Setup required"}
          </Badge>
        </CardHeader>

        <CardContent className="grid gap-5 p-4 md:p-5">
          {error ? (
            <Alert>
              <TriangleAlert />
              <AlertTitle>Integrity evidence is unavailable</AlertTitle>
              <AlertDescription>
                {error} Missing evidence is not treated as a clean account.
              </AlertDescription>
            </Alert>
          ) : null}

          {!error && source === "live" && freshness === "stale" ? (
            <Alert>
              <CircleHelp />
              <AlertTitle>Showing retained integrity evidence</AlertTitle>
              <AlertDescription>
                The latest full Ads refresh did not complete. Events and totals remain
                available from the last confirmed baseline, but no newer comparison has
                been inferred.
              </AlertDescription>
            </Alert>
          ) : null}

          {!error && source === "live" && freshness === "unknown" ? (
            <Alert>
              <CircleHelp />
              <AlertTitle>Latest comparison status unavailable</AlertTitle>
              <AlertDescription>
                Retained events remain available from the last confirmed baseline,
                but MaintainFlow could not establish whether a newer full sync
                completed. No newer comparison has been inferred.
              </AlertDescription>
            </Alert>
          ) : null}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <IntegrityMetric
              label="Guard status"
              value={guardStatus}
              detail={
                page.summary.baselineReady
                  ? "Credential-independent baseline retained"
                  : "The first fresh live snapshot creates the baseline"
              }
            />
            <IntegrityMetric
              label="Needs human review"
              value={formatGroupedInteger(openCount)}
              detail="Open unexplained and detection-time indeterminate events"
            />
            <IntegrityMetric
              label="Open unexplained events"
              value={formatGroupedInteger(page.summary.openUnexplainedCount)}
              detail="At least one field lacks unambiguous latest recorded operation evidence"
            />
            <IntegrityMetric
              label="Last confirmed check"
              value={
                page.summary.lastCheckedAt
                  ? formatUtcDateTime(page.summary.lastCheckedAt)
                  : "Not checked"
              }
              detail={`${formatGroupedInteger(page.summary.retainedEventCount)} retained change event${page.summary.retainedEventCount === 1 ? "" : "s"}`}
            />
          </div>

          <Alert className="bg-background">
            <FileSearch2 />
            <AlertTitle>Change detection, not actor attribution</AlertTitle>
            <AlertDescription>
              “Unexplained” means that, at detection time, the observed value lacked
              unambiguous latest recorded operation evidence between two snapshots.
              Equal-time latest operations count as unambiguous when their recorded
              values agree; conflicting tied values remain unexplained. Indeterminate
              evidence at detection can reflect ambiguous snapshot timing or an
              operation outcome that was not confirmed then. This does not prove who
              made the change, and checks occur only when a fresh full sync completes.
            </AlertDescription>
          </Alert>

          {orderedEvents.length === 0 ? (
            <Empty className="border-0 py-8">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ShieldCheck />
                </EmptyMedia>
                <EmptyTitle>
                  {page.summary.baselineReady
                    ? "No material changes in retained evidence"
                    : "A fresh snapshot will establish the baseline"}
                </EmptyTitle>
                <EmptyDescription>
                  {page.summary.baselineReady
                    ? "The latest retained comparisons contain no material configuration change events."
                    : "MaintainFlow needs two fresh snapshots before it can compare changes."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="min-w-0">
              <Table scrollAreaLabel="Change integrity events">
                <TableHeader>
                  <TableRow>
                    <TableHead>Detected</TableHead>
                    <TableHead>Resource</TableHead>
                    <TableHead>Change</TableHead>
                    <TableHead>Classification</TableHead>
                    <TableHead>Fields</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orderedEvents.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatUtcDateTime(event.detectedAt, { includeTimeZone: true })}
                      </TableCell>
                      <TableCell className="min-w-44">
                        <p className="font-medium">{event.resourceLabel}</p>
                        <p className="text-xs text-muted-foreground">
                          {resourceTypeLabel(event.resourceType)}
                        </p>
                      </TableCell>
                      <TableCell className="capitalize">{event.changeType}</TableCell>
                      <TableCell>
                        <EventClassification event={event} />
                      </TableCell>
                      <TableCell className="min-w-48 text-muted-foreground">
                        {event.changedFieldPaths.slice(0, 2).map(fieldLabel).join(", ")}
                        {event.changedFieldPaths.length > 2
                          ? ` +${event.changedFieldPaths.length - 2}`
                          : ""}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openEvent(event)}
                        >
                          {event.reviewStatus === "reviewed" ? "View review" : "Inspect"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {page.hasMore ? (
                <div className="mt-3 flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Open items are shown first. Account totals include every retained
                    event.
                  </p>
                  {source === "live" ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={loadingMore || !paginationCursor}
                      onClick={loadMoreEvents}
                    >
                      {loadingMore ? (
                        <Loader2 className="animate-spin" data-icon="inline-start" />
                      ) : (
                        <FileSearch2 data-icon="inline-start" />
                      )}
                      Load more events
                    </Button>
                  ) : null}
                </div>
              ) : null}
              {loadMoreError ? (
                <Alert variant="destructive" className="mt-3">
                  <TriangleAlert />
                  <AlertTitle>More events could not be loaded</AlertTitle>
                  <AlertDescription>{loadMoreError}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !submitting) {
            setSelected(null);
            setNote("");
            setSubmitError(undefined);
          }
        }}
      >
        <DialogContent className="grid max-h-[calc(100dvh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0 sm:max-w-2xl">
          {selected ? (
            <>
              <DialogHeader className="border-b px-6 pb-4 pt-6 pr-12">
                <div className="flex flex-wrap items-center gap-2">
                  <EventClassification event={selected} />
                  <Badge variant="outline" className="capitalize">
                    {selected.changeType}
                  </Badge>
                </div>
                <DialogTitle>{selected.resourceLabel}</DialogTitle>
                <DialogDescription>
                  {resourceTypeLabel(selected.resourceType)} · detected {" "}
                  {formatUtcDateTime(selected.detectedAt, { includeTimeZone: true })}
                </DialogDescription>
              </DialogHeader>

              <div className="min-h-0 overflow-y-auto px-6 py-5">
                <div className="grid gap-5">
                  <ChangeDetails event={selected} currencyCode={currencyCode} />

                  {selected.matchedOperations.length > 0 ? (
                    <div className="rounded-lg border p-3 text-sm">
                      <p className="font-medium">Workflow evidence considered</p>
                      <p className="mt-1 text-muted-foreground">
                        {changeIntegrityOperationEvidenceSummary(
                          selected.matchedOperations,
                        )}
                      </p>
                    </div>
                  ) : null}

                  {selected.reviewStatus === "reviewed" ? (
                    <div className="rounded-lg border bg-muted/20 p-4 text-sm">
                      <p className="font-medium">Human review recorded</p>
                      <p className="mt-1 text-muted-foreground">
                        {selected.reviewedByName} · {selected.reviewedAt
                          ? formatUtcDateTime(selected.reviewedAt, { includeTimeZone: true })
                          : "Time unavailable"}
                      </p>
                      <p className="mt-3 whitespace-pre-wrap">{selected.reviewNote}</p>
                    </div>
                  ) : selected.reviewStatus === "open" ? (
                    <Field data-invalid={Boolean(submitError)}>
                      <FieldLabel htmlFor="integrity-review-note">Verification note</FieldLabel>
                      <Textarea
                        id="integrity-review-note"
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        placeholder="Describe what you checked and the follow-up, if any."
                        minLength={10}
                        maxLength={1_000}
                        disabled={!canReview || submitting}
                        aria-invalid={Boolean(submitError)}
                        aria-describedby="integrity-review-requirement"
                      />
                      <FieldDescription id="integrity-review-requirement">
                        At least 10 characters. Recording a review does not change the Ads
                        configuration or claim who made the change.
                      </FieldDescription>
                      {submitError ? <FieldError>{submitError}</FieldError> : null}
                    </Field>
                  ) : null}
                </div>
              </div>

              <DialogFooter className="border-t px-6 py-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={submitting}
                  onClick={() => setSelected(null)}
                >
                  Close
                </Button>
                {selected.reviewStatus === "open" ? (
                  <Button
                    type="button"
                    disabled={!canReview || submitting || note.trim().length < 10}
                    onClick={recordReviewed}
                  >
                    {submitting ? (
                      <Loader2 className="animate-spin" data-icon="inline-start" />
                    ) : (
                      <ShieldCheck data-icon="inline-start" />
                    )}
                    Record reviewed
                  </Button>
                ) : null}
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
