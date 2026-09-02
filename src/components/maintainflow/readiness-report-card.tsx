"use client";

import { CheckCircle2, CircleDashed, Download, FileText, ShieldCheck } from "lucide-react";
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
import type { ConversionMeasurementReadiness } from "@/lib/openai-ads/measurement-readiness";
import type { ConversionPayloadAudit } from "@/lib/readiness/conversions-api";
import type { ProductFeedAudit } from "@/lib/readiness/product-feed";
import {
  buildReadinessReportHtml,
  getReadinessReportSummary,
  readinessReportFileName,
} from "@/lib/readiness/report";
import type { ReadinessAudit } from "@/lib/readiness/schema";
import { cn } from "@/lib/utils";

type ReadinessReportCardProps = {
  storefront: ReadinessAudit | null;
  productFeed: ProductFeedAudit | null;
  conversionsApi: ConversionPayloadAudit | null;
  accountMeasurement: ConversionMeasurementReadiness;
};

export function ReadinessReportCard({
  storefront,
  productFeed,
  conversionsApi,
  accountMeasurement,
}: ReadinessReportCardProps) {
  const summary = getReadinessReportSummary({
    storefront,
    productFeed,
    conversionsApi,
    accountMeasurement,
  });
  const remainingSections = summary.totalSections - summary.completedSections;
  const partialReport = summary.canExport && !summary.isComplete;

  function downloadReport() {
    if (!summary.canExport) return;
    const report = {
      generatedAt: new Date().toISOString(),
      storefront,
      productFeed,
      conversionsApi,
      accountMeasurement,
    };
    const blob = new Blob([buildReadinessReportHtml(report)], {
      type: "text/html;charset=utf-8",
    });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = readinessReportFileName(report);
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    toast.success(partialReport ? "Partial report downloaded" : "Client report downloaded", {
      description: `${summary.completedSections} of ${summary.totalSections} readiness sections included.`,
    });
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <FileText className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle className="text-base">
              {partialReport
                ? "Partial launch readiness report"
                : summary.isComplete
                  ? "Client launch readiness report"
                  : "Launch readiness report"}
            </CardTitle>
            <CardDescription className="max-w-3xl leading-5">
              Download a print-ready HTML evidence report for a client,
              developer, or launch review. Untested sections are clearly marked.
            </CardDescription>
          </div>
        </div>
        <Badge variant="outline" className="w-fit whitespace-nowrap">
          {partialReport ? "Partial · " : ""}
          {summary.completedSections} of {summary.totalSections} evaluated
        </Badge>
      </CardHeader>

      <CardContent className="grid gap-4 p-4 md:p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summary.sections.map((section) => {
            const Icon = section.complete ? CheckCircle2 : CircleDashed;
            return (
              <div key={section.id} className="flex items-start gap-3 rounded-lg border p-3">
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    section.complete ? "text-success" : "text-muted-foreground",
                  )}
                />
                <div className="grid gap-1">
                  <p className="text-xs font-medium">{section.label}</p>
                  <p className="text-xs leading-5 text-muted-foreground">
                    {section.result}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-start gap-3 text-xs leading-5 text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" />
          <p>
            The report is assembled in this browser from sanitized findings. It
            excludes raw feed rows, pasted events, Pixel IDs, API keys, bearer
            tokens, and stored credential material.
          </p>
        </div>
      </CardContent>

      <CardFooter className="flex-col items-start justify-between gap-3 border-t bg-muted/20 p-4 sm:flex-row sm:items-center md:p-5">
        <p className="text-xs text-muted-foreground">
          {summary.canExport
            ? partialReport
              ? `Partial report · ${summary.verdictLabel} · ${remainingSections} ${remainingSections === 1 ? "section" : "sections"} not evaluated.`
              : `${summary.verdictLabel} · open the HTML file and print to PDF if needed.`
            : "Complete at least one readiness check to create a report."}
        </p>
        <Button type="button" onClick={downloadReport} disabled={!summary.canExport}>
          <Download data-icon="inline-start" />
          {partialReport ? "Download partial report" : "Download client report"}
        </Button>
      </CardFooter>
    </Card>
  );
}
