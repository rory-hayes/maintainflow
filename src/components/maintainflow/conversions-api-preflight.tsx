"use client";

import { useState } from "react";
import {
  Braces,
  CheckCircle2,
  CircleAlert,
  CircleX,
  FileJson2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  auditConversionsApiPayload,
  createConversionsApiSample,
  type ConversionPayloadAudit,
  type ConversionPayloadIssue,
} from "@/lib/readiness/conversions-api";
import { cn } from "@/lib/utils";

function verdictLabel(verdict: ConversionPayloadAudit["verdict"]) {
  if (verdict === "ready_for_validation") return "Ready for validate_only";
  if (verdict === "needs_attention") return "Review warnings";
  return "Payload needs fixes";
}

function affectedEventsLabel(issue: ConversionPayloadIssue) {
  if (issue.affectedEvents.length === 0) return "Batch-level finding";
  const remainder = issue.count - issue.affectedEvents.length;
  const events = issue.affectedEvents.map((index) => `Event ${index}`).join(", ");
  return `${events}${remainder > 0 ? ` +${remainder} more` : ""}`;
}

export function ConversionsApiAuditResult({
  audit,
}: {
  audit: ConversionPayloadAudit;
}) {
  const VerdictIcon =
    audit.verdict === "ready_for_validation"
      ? CheckCircle2
      : audit.verdict === "needs_attention"
        ? CircleAlert
        : CircleX;

  return (
    <div className="grid gap-4" aria-live="polite" data-testid="conversions-result">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div className="flex items-center gap-2">
          <VerdictIcon
            className={cn(
              "size-5 shrink-0",
              audit.verdict === "ready_for_validation"
                ? "text-success"
                : audit.verdict === "needs_attention"
                  ? "text-warning"
                  : "text-destructive",
            )}
          />
          <p className="font-medium">Static contract result</p>
        </div>
        <Badge
          variant="outline"
          className={cn(
            "w-fit whitespace-nowrap",
            audit.verdict === "ready_for_validation" &&
              "border-success/30 bg-success/10 text-success",
            audit.verdict === "needs_attention" &&
              "border-warning/30 bg-warning/10 text-warning-foreground",
            audit.verdict === "invalid" &&
              "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {verdictLabel(audit.verdict)}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Events", audit.eventCount],
          ["Ready", audit.readyEventCount],
          ["Blockers", audit.blockerCount],
          ["Warnings", audit.warningCount],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-xl font-semibold">{value}</p>
          </div>
        ))}
      </div>

      {audit.eventTypes.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {audit.incomplete
              ? "Event types (partial scan)"
              : "Event types"}
          </span>
          {audit.eventTypes.map((eventType) => (
            <Badge key={eventType.name} variant="secondary" className="font-mono text-[11px]">
              {eventType.name} · {eventType.count}
            </Badge>
          ))}
        </div>
      ) : null}

      {audit.issues.length > 0 ? (
        <div className="grid gap-2">
          <div>
            <h3 className="text-sm font-medium">Findings to review</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Results retain field paths and event positions only—never IDs,
              URLs, hashes, attribution values, or pasted field values.
            </p>
          </div>
          <div className="divide-y overflow-hidden rounded-lg border">
            {audit.issues.map((issue) => (
              <div
                key={`${issue.severity}:${issue.code}:${issue.field}`}
                className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium">{issue.title}</p>
                    <Badge
                      variant={issue.severity === "blocker" ? "destructive" : "secondary"}
                      className="capitalize"
                    >
                      {issue.severity}
                    </Badge>
                  </div>
                  <p className="mt-1 break-words font-mono text-[11px] text-muted-foreground">
                    {issue.field}
                  </p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {issue.detail}
                  </p>
                </div>
                <p className="text-xs font-medium text-muted-foreground sm:text-right">
                  {affectedEventsLabel(issue)}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <Alert>
          <CheckCircle2 />
          <AlertTitle>The documented static checks passed</AlertTitle>
          <AlertDescription>
            The next controlled step is a real server-side request with
            validate_only set to true after your Ads account is enabled.
          </AlertDescription>
        </Alert>
      )}

      <Alert>
        <ShieldCheck />
        <AlertTitle>Evidence boundary</AlertTitle>
        <AlertDescription>
          {audit.limitations.join(" ")}
        </AlertDescription>
      </Alert>
    </div>
  );
}

export function ConversionsApiPreflight({
  onAuditChange,
}: {
  onAuditChange?: (audit: ConversionPayloadAudit | null) => void;
} = {}) {
  const [open, setOpen] = useState(false);
  const [payload, setPayload] = useState("");
  const [audit, setAudit] = useState<ConversionPayloadAudit | null>(null);

  function loadSample() {
    setPayload(createConversionsApiSample());
    setAudit(null);
    onAuditChange?.(null);
    toast.success("Safe sample loaded", {
      description: "The timestamp was generated for this local preflight.",
    });
  }

  function validatePayload() {
    const result = auditConversionsApiPayload(payload);
    setAudit(result);
    onAuditChange?.(result);
    if (result.verdict === "ready_for_validation") {
      toast.success("Payload passed the static preflight", {
        description: "Ready for a future server-side validate_only request.",
      });
    } else if (result.verdict === "needs_attention") {
      toast.warning("Payload has warnings", {
        description: "Review the findings before a validate_only request.",
      });
    } else {
      toast.error("Payload needs fixes", {
        description: `${result.blockerCount} blocker${result.blockerCount === 1 ? "" : "s"} found locally.`,
      });
    }
  }

  function clearPayload() {
    setPayload("");
    setAudit(null);
    onAuditChange?.(null);
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <Braces className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle className="text-base">Conversions API preflight</CardTitle>
            <CardDescription className="max-w-3xl leading-5">
              Validate a server event batch against OpenAI&apos;s current event,
              user-matching, timestamp, and data-shape contract.
            </CardDescription>
          </div>
        </div>
        <Badge variant="outline" className="w-fit whitespace-nowrap">
          Local JSON check
        </Badge>
      </CardHeader>

      <CardContent className="flex flex-col justify-between gap-4 p-4 sm:flex-row sm:items-center md:p-5">
        <div className="grid max-w-3xl gap-1">
          <p className="text-sm font-medium">Catch rejected batches before launch</p>
          <p className="text-sm leading-6 text-muted-foreground">
            Check up to 1,000 events without sending data to OpenAI or
            MaintainFlow. Never paste an API key, bearer token, or Pixel ID.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button type="button" className="shrink-0">
              <FileJson2 data-icon="inline-start" />
              Check JSON payload
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-4xl gap-0 overflow-hidden p-0">
            <DialogHeader className="p-4 pr-12 text-left md:p-6 md:pr-14">
              <DialogTitle>Conversions API payload preflight</DialogTitle>
              <DialogDescription className="leading-5">
                Paste only the JSON request body. This check runs in your browser;
                it does not call bzr.openai.com or store the payload.
              </DialogDescription>
            </DialogHeader>

            <div className="grid max-h-[calc(100dvh-13rem)] gap-5 overflow-y-auto border-y p-4 md:p-6">
              <Field>
                <FieldLabel htmlFor="conversions-api-payload">Request body JSON</FieldLabel>
                <Textarea
                  id="conversions-api-payload"
                  value={payload}
                  onChange={(event) => {
                    setPayload(event.target.value);
                    setAudit(null);
                    onAuditChange?.(null);
                  }}
                  placeholder={'{"validate_only":true,"events":[…]}'}
                  rows={12}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="min-h-64 resize-y font-mono text-xs leading-5"
                  aria-describedby="conversions-api-payload-help"
                />
                <FieldDescription id="conversions-api-payload-help">
                  Maximum local sample: 1 MB. Credentials belong only in your
                  protected server-side Authorization header—not in this body.
                </FieldDescription>
              </Field>

              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={loadSample}>
                  <FileJson2 data-icon="inline-start" />
                  Load safe sample
                </Button>
                <Button type="button" onClick={validatePayload}>
                  <CheckCircle2 data-icon="inline-start" />
                  Validate payload
                </Button>
                {payload || audit ? (
                  <Button type="button" variant="ghost" onClick={clearPayload}>
                    <RotateCcw data-icon="inline-start" />
                    Clear
                  </Button>
                ) : null}
              </div>

              {audit ? <ConversionsApiAuditResult audit={audit} /> : null}
            </div>

            <DialogFooter className="p-4 md:p-6">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>

      <CardFooter className="items-start gap-3 border-t bg-muted/20 p-4 md:p-5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-5 text-muted-foreground">
          A clean result is ready for a future validate_only request; it does not
          prove event receipt, matching, deduplication, attribution, or campaign
          optimization.
        </p>
      </CardFooter>
    </Card>
  );
}
