"use client";

import { useState } from "react";
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

export function ApprovalHistory({
  records,
  canRollback,
  canReconcile,
  error,
}: ApprovalHistoryProps) {
  const router = useRouter();
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
            <CardTitle className="text-base">Durable approval history</CardTitle>
            <CardDescription>
              Account-scoped live changes, stored rollback requests, and reconciled outcomes.
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
              <EmptyTitle>No live approvals yet</EmptyTitle>
              <EmptyDescription>
                Records appear here only after a live recommendation is approved.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table>
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
          </div>
        )}
      </CardContent>

      <AlertDialog open={Boolean(rollbackRecord)} onOpenChange={(open) => !open && setRollbackRecord(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply the stored rollback?</AlertDialogTitle>
            <AlertDialogDescription>
              This sends the exact rollback request retained before the original change. It is a live Ads API write.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {rollbackRecord ? (
            <div className="grid gap-2 rounded-lg border bg-muted/40 p-4 text-sm">
              <p className="font-mono text-xs">POST {rollbackRecord.rollbackPath}</p>
              <p className="text-muted-foreground">{rollbackRecord.safeguard}</p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={rollback} disabled={busy}>
              {busy ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <RotateCcw data-icon="inline-start" />}
              Apply rollback
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={Boolean(reconcileRecord)} onOpenChange={(open) => !open && setReconcileRecord(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reconcile uncertain outcome</DialogTitle>
            <DialogDescription>
              Verify the live account first, then record what actually happened. This action never sends an Ads API write.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="reconciliation-note">Verification note</FieldLabel>
              <Textarea
                id="reconciliation-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="What did you verify in OpenAI Ads Manager?"
                rows={4}
              />
              <FieldDescription>Required for the durable audit trail; minimum 10 characters.</FieldDescription>
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
