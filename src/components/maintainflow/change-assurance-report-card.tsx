"use client";

import { Download, FileCheck2, ShieldCheck } from "lucide-react";
import { useId } from "react";
import { toast } from "sonner";

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
import type { ApprovalRecordDto } from "@/lib/audit/approval-schema";
import {
  buildChangeAssuranceReportHtml,
  changeAssuranceReportFileName,
  changeAssuranceReportSummary,
} from "@/lib/audit/change-assurance-report";

export function ChangeAssuranceReportCard({
  account,
  dataSource,
  records,
}: {
  account: { id: string; name: string };
  dataSource: "demo" | "live";
  records: ApprovalRecordDto[];
}) {
  const titleId = useId();
  const summary = changeAssuranceReportSummary({
    generatedAt: new Date(0).toISOString(),
    dataSource,
    account,
    records,
  });

  function downloadReport() {
    if (!summary.canExport) return;
    const report = {
      generatedAt: new Date().toISOString(),
      dataSource,
      account,
      records,
    };
    const blob = new Blob([buildChangeAssuranceReportHtml(report)], {
      type: "text/html;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = changeAssuranceReportFileName(report);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    // Keep the Blob URL alive long enough for browser download managers to
    // consume it after the synthetic anchor click.
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    toast.success("Change assurance report downloaded", {
      description: `${summary.total} durable change ${summary.total === 1 ? "record" : "records"} included.`,
    });
  }

  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      className="min-w-0 shadow-sm"
    >
      <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <FileCheck2 className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle
              id={titleId}
              role="heading"
              aria-level={2}
              className="text-base"
            >
              Client change assurance report
            </CardTitle>
            <CardDescription className="max-w-3xl leading-5">
              Export the approved request, stored rollback, evidence, outcome,
              monitoring result, and unresolved items as a print-ready HTML record.
            </CardDescription>
          </div>
        </div>
        <Badge variant="outline" className="w-fit whitespace-nowrap">
          {dataSource === "live" ? "Live evidence" : "Simulator evidence"}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 md:p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Change records</p>
            <p className="mt-1 text-xl font-semibold">{summary.total}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Monitoring completed</p>
            <p className="mt-1 text-xl font-semibold">{summary.monitored}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs text-muted-foreground">Unresolved items</p>
            <p className="mt-1 text-xl font-semibold">{summary.unresolved}</p>
          </div>
        </div>
        <div className="flex items-start gap-3 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            Credential-shaped fields are redacted. Simulator exports are labelled
            as non-live evidence, and the report does not claim causal lift.
          </p>
        </div>
      </CardContent>
      <CardFooter className="flex-col items-start justify-between gap-3 border-t bg-muted/20 p-4 sm:flex-row sm:items-center md:p-5">
        <p className="text-xs text-muted-foreground">
          {summary.canExport
            ? summary.unresolved > 0
              ? `${summary.unresolved} unresolved ${summary.unresolved === 1 ? "item is" : "items are"} called out in the report.`
              : "All included records have a terminal outcome."
            : dataSource === "live"
              ? "A durable live approval is required before a report can be exported."
              : "A simulator approval record is required before an example report can be exported."}
        </p>
        <Button type="button" onClick={downloadReport} disabled={!summary.canExport}>
          <Download data-icon="inline-start" />
          Download assurance report
        </Button>
      </CardFooter>
    </Card>
  );
}
