"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileClock, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { formatUtcDateTime } from "@/lib/formatting";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  FieldGroup,
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
import type {
  ApprovalRecordDto,
  ApprovalStatus,
  ReconciliationAction,
} from "@/lib/audit/approval-schema";
import { cn } from "@/lib/utils";

type ApprovalHistoryProps = {
  records: ApprovalRecordDto[];
  dataSource?: "demo" | "live";
  canRollback: boolean;
  canReconcile: boolean;
  error?: string;
};

const statusLabels: Record<ApprovalStatus, string> = {
  pending: "Pending",
  applied: "Applied",
  failed: "Failed",
  reconciliation_required: "Check outcome",
  rollback_pending: "Rollback pending",
  rolled_back: "Rolled back",
  rollback_failed: "Rollback failed",
  rollback_reconciliation_required: "Check rollback",
};

function statusTone(status: ApprovalStatus) {
  if (status === "applied") return "border-success/20 bg-success/10 text-success";
  if (status === "rolled_back") return "border-primary/20 bg-primary/10 text-primary";
  if (status.includes("reconciliation")) {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (status.includes("failed")) return "border-destructive/20 bg-destructive/10 text-destructive";
  return "";
}

function reconciliationOptions(status: ApprovalStatus): Array<{
  action: ReconciliationAction;
  label: string;
}> {
  if (status === "reconciliation_required") {
    return [
      { action: "mark_applied", label: "Confirmed applied" },
      { action: "mark_not_applied", label: "Confirmed not applied" },
    ];
  }
  return [
    { action: "mark_rolled_back", label: "Confirmed rolled back" },
    { action: "mark_still_applied", label: "Original change remains" },
  ];
}

function formatRole(role: string) {
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function RollbackConfirmationDetails({
  record,
}: {
  record: ApprovalRecordDto;
}) {
  return (
    <dl className="grid gap-3 rounded-lg border bg-muted/40 p-4 text-sm">
      <div className="grid gap-1">
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Advertiser account
        </dt>
        <dd className="break-all font-mono text-xs">{record.accountId}</dd>
      </div>
      <div className="grid gap-1">
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Original change
        </dt>
        <dd className="font-medium">{record.recommendationTitle}</dd>
        <dd className="break-all font-mono text-xs text-muted-foreground">
          {record.entityId}
        </dd>
      </div>
      <div className="grid gap-1">
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Exact rollback request
        </dt>
        <dd className="min-w-0 overflow-hidden rounded-lg bg-zinc-950 text-zinc-100">
          <span className="block border-b border-white/10 px-3 py-2 break-all font-mono text-xs text-zinc-400">
            {record.rollbackMethod} {record.rollbackPath}
          </span>
          <pre className="overflow-x-auto p-3 text-xs leading-5">
            {record.rollbackBody
              ? JSON.stringify(record.rollbackBody, null, 2)
              : "No request body"}
          </pre>
        </dd>
      </div>
      <div className="grid gap-1">
        <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Safeguard that prompted review
        </dt>
        <dd className="text-muted-foreground">{record.safeguard}</dd>
      </div>
    </dl>
  );
}

export function ReconciliationDecisionContext({
  record,
}: {
  record: ApprovalRecordDto;
}) {
  const headingId = useId();
  const hasOrganization = Boolean(record.organizationName);
  const hasRecordedRole = Boolean(record.membershipRole || record.accountRole);

  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-3 rounded-lg border bg-muted/40 p-4"
    >
      <div className="grid gap-1">
        <h3 id={headingId} className="text-sm font-medium">
          Read-only incident context
        </h3>
        <p className="text-xs text-muted-foreground">
          Confirm this stored evidence against the live advertiser account before
          recording an outcome.
        </p>
      </div>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="grid min-w-0 gap-1">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Advertiser account
          </dt>
          <dd className="break-all font-mono text-xs">{record.accountId}</dd>
        </div>
        <div className="grid min-w-0 gap-1">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Current status
          </dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge
              variant="outline"
              className={cn("whitespace-nowrap", statusTone(record.status))}
            >
              {statusLabels[record.status]}
            </Badge>
            <span className="break-all font-mono text-xs text-muted-foreground">
              {record.status}
            </span>
          </dd>
        </div>
        {hasOrganization ? (
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Organization
            </dt>
            {record.organizationName ? (
              <dd className="font-medium">{record.organizationName}</dd>
            ) : null}
          </div>
        ) : null}
        {hasRecordedRole ? (
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recorded roles
            </dt>
            {record.membershipRole ? (
              <dd>Workspace {formatRole(record.membershipRole)}</dd>
            ) : null}
            {record.accountRole ? (
              <dd className="text-muted-foreground">
                Advertiser account {formatRole(record.accountRole)}
              </dd>
            ) : null}
          </div>
        ) : null}
        <div className="grid min-w-0 gap-1 sm:col-span-2">
          <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recommendation and entity
          </dt>
          <dd className="font-medium">{record.recommendationTitle}</dd>
          <dd className="break-all font-mono text-xs text-muted-foreground">
            {record.entityId}
          </dd>
        </div>
        {record.errorMessage ? (
          <div className="grid min-w-0 gap-1 sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Stored provider error
            </dt>
            <dd className="break-words text-destructive">
              {record.errorMessage}
            </dd>
          </div>
        ) : null}
        {record.reconciliationNote ? (
          <div className="grid min-w-0 gap-1 sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Prior reconciliation note
            </dt>
            <dd className="whitespace-pre-wrap break-words text-muted-foreground">
              {record.reconciliationNote}
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

export function ApprovalHistory({
  records,
  dataSource = "live",
  canRollback,
  canReconcile,
  error,
}: ApprovalHistoryProps) {
  const router = useRouter();
  const rollbackTitleRef = useRef<HTMLHeadingElement>(null);
  const [rollbackRecord, setRollbackRecord] = useState<ApprovalRecordDto | null>(null);
  const [reconcileRecord, setReconcileRecord] = useState<ApprovalRecordDto | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function rollback() {
    if (!rollbackRecord) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/ads/approvals/${rollbackRecord.id}/rollback`,
        { method: "POST" },
      );
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "Rollback failed.");
      toast.success("Rollback applied", { description: result.message });
      setRollbackRecord(null);
      router.refresh();
    } catch (caught) {
      toast.error("Unable to confirm rollback", {
        description: caught instanceof Error ? caught.message : "Review the approval record.",
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function reconcile(action: ReconciliationAction) {
    if (!reconcileRecord || note.trim().length < 10) return;
    setBusy(true);
    try {
      const response = await fetch(
        `/api/ads/approvals/${reconcileRecord.id}/reconcile`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, note }),
        },
      );
      const result = (await response.json()) as { error?: string; message?: string };
      if (!response.ok) throw new Error(result.error ?? "Reconciliation failed.");
      toast.success("Outcome recorded", { description: result.message });
      setReconcileRecord(null);
      setNote("");
      router.refresh();
    } catch (caught) {
      toast.error("Unable to reconcile approval", {
        description: caught instanceof Error ? caught.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <FileClock />
          </div>
          <div className="min-w-0 grid gap-1">
            <CardTitle role="heading" aria-level={2} className="text-base">
              Durable approval history
            </CardTitle>
            <CardDescription>
              {dataSource === "live"
                ? "Account-scoped live changes, stored rollback requests, and reconciled outcomes."
                : "Illustrative approvals, rollback requests, monitoring, and reconciliation records. No Ads API request was sent."}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0">
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Approval history unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : records.length === 0 ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileClock /></EmptyMedia>
              <EmptyTitle>
                {dataSource === "live"
                  ? "No live approvals yet"
                  : "No simulator approvals yet"}
              </EmptyTitle>
              <EmptyDescription>
                {dataSource === "live"
                  ? "Records appear here only after a live recommendation is approved."
                  : "Approve a simulator recommendation to add an illustrative record for this session."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table scrollAreaLabel="Durable approval history">
              <TableHeader>
                <TableRow>
                  <TableHead>Created</TableHead>
                  <TableHead>Recommendation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Rollback</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => {
                  const needsReconciliation = record.status.includes("reconciliation");
                  const rollbackEligible = ["applied", "rollback_failed"].includes(record.status);
                  return (
                    <TableRow key={record.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {formatUtcDateTime(record.createdAt, {
                          includeTimeZone: true,
                        })}
                      </TableCell>
                      <TableCell className="min-w-56">
                        <p className="font-medium">{record.recommendationTitle}</p>
                        <p className="font-mono text-xs text-muted-foreground">{record.entityId}</p>
                        {record.organizationName ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {record.organizationName} · {record.accountRole}
                          </p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("whitespace-nowrap", statusTone(record.status))}>
                          {statusLabels[record.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="min-w-56">
                        <p className="font-mono text-xs">{record.rollbackPath}</p>
                        <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{record.safeguard}</p>
                      </TableCell>
                      <TableCell className="text-right">
                        {needsReconciliation ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canReconcile}
                            onClick={() => { setNote(""); setReconcileRecord(record); }}
                          >
                            Reconcile
                          </Button>
                        ) : rollbackEligible ? (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!canRollback}
                            onClick={() => setRollbackRecord(record)}
                          >
                            <RotateCcw data-icon="inline-start" />
                            Roll back
                          </Button>
                        ) : (
                          <span className="text-xs text-muted-foreground">No action</span>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
          </Table>
        )}
      </CardContent>

      <AlertDialog open={Boolean(rollbackRecord)} onOpenChange={(open) => !open && setRollbackRecord(null)}>
        <AlertDialogContent
          className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            rollbackTitleRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle ref={rollbackTitleRef} tabIndex={-1}>
              Apply the stored rollback?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This sends the exact rollback request retained before the original
              change. It is a live, human-initiated Ads API write and is never
              triggered automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rollbackRecord ? (
            <RollbackConfirmationDetails record={rollbackRecord} />
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={rollback} disabled={busy}>
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}
              Apply live rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(reconcileRecord)} onOpenChange={(open) => !open && setReconcileRecord(null)}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Reconcile uncertain outcome</DialogTitle>
            <DialogDescription>
              Verify the live account first, then record what actually happened. This action never sends an Ads API write.
            </DialogDescription>
          </DialogHeader>
          {reconcileRecord ? (
            <ReconciliationDecisionContext record={reconcileRecord} />
          ) : null}
          <FieldGroup>
            <Field data-invalid={note.length > 0 && note.trim().length < 10}>
              <FieldLabel htmlFor="reconciliation-note">Verification note</FieldLabel>
              <Textarea
                id="reconciliation-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What did you verify in OpenAI Ads Manager?"
                rows={4}
                required
                minLength={10}
                aria-invalid={note.length > 0 && note.trim().length < 10}
                aria-describedby="reconciliation-note-requirement"
              />
              <FieldDescription id="reconciliation-note-requirement">
                Required for the durable audit trail; minimum 10 characters.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="gap-2 sm:flex-wrap">
            <Button variant="outline" onClick={() => setReconcileRecord(null)} disabled={busy}>Cancel</Button>
            {reconcileRecord
              ? reconciliationOptions(reconcileRecord.status).map((option) => (
                  <Button
                    key={option.action}
                    variant={option.action.includes("not") || option.action.includes("still") ? "outline" : "default"}
                    disabled={busy || note.trim().length < 10}
                    onClick={() => reconcile(option.action)}
                  >
                    {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : null}
                    {option.label}
                  </Button>
                ))
              : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
