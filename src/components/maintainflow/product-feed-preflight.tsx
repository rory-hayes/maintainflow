"use client";

import { ChangeEvent, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  FileCheck2,
  FileSearch,
  Loader2,
  RotateCcw,
  ShieldCheck,
  Upload,
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
  Empty,
  EmptyContent,
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
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  auditProductFeedText,
  type ProductFeedAudit,
  type ProductFeedIssue,
} from "@/lib/readiness/product-feed";
import { cn } from "@/lib/utils";

const DEMO_FEED = `id,title,description,link,image_link,availability,availability_date,price,sale_price,brand,gtin,identifier_exists,is_ads_eligible
HH-BENCH-01,Oak storage bench,Compact oak bench with hidden storage,https://harbourhome.example/products/oak-bench,https://harbourhome.example/images/oak-bench.jpg,in_stock,,249.00 USD,219.00 USD,Harbour Home,12345678,yes,true
HH-SHELF-02,Modular shelf,Flexible shelving for small rooms,https://harbourhome.example/products/modular-shelf,https://harbourhome.example/images/modular-shelf.jpg,preorder,,159.00 USD,,Harbour Home,23456789,yes,true
HH-BASKET-03,Woven basket,Natural storage basket,https://harbourhome.example/products/woven-basket,https://harbourhome.example/images/woven-basket.jpg,in_stock,,49.00 USD,,Harbour Home,,no,false`;

function verdictLabel(verdict: ProductFeedAudit["verdict"]) {
  if (verdict === "ready") return "Ready for upload review";
  if (verdict === "invalid") return "Invalid file structure";
  return "Products need attention";
}

function rowsLabel(issue: ProductFeedIssue) {
  const labels = issue.sampleRows.map((row) => (row === 1 ? "Header" : `Row ${row}`));
  const remainder = issue.count - issue.sampleRows.length;
  return `${labels.join(", ")}${remainder > 0 ? ` +${remainder} more` : ""}`;
}

function FeedIssueTable({ issues }: { issues: ProductFeedIssue[] }) {
  return (
    <>
      <div className="divide-y rounded-lg border md:hidden">
        {issues.map((issue) => (
          <div
            key={`${issue.severity}:${issue.code}:mobile`}
            className="grid gap-2 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium">{issue.title}</p>
              <Badge
                variant={issue.severity === "error" ? "destructive" : "secondary"}
                className="shrink-0 capitalize"
              >
                {issue.severity}
              </Badge>
            </div>
            <p className="text-xs leading-5 text-muted-foreground">{issue.detail}</p>
            <p className="text-xs font-medium">{rowsLabel(issue)}</p>
          </div>
        ))}
      </div>
      <div className="hidden overflow-hidden rounded-lg border md:block">
        <Table scrollAreaLabel="Product feed issues">
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead>Check</TableHead>
              <TableHead className="w-28">Severity</TableHead>
              <TableHead className="min-w-48">Affected rows</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {issues.map((issue) => (
              <TableRow key={`${issue.severity}:${issue.code}`}>
                <TableCell className="min-w-72 py-3 align-top">
                  <p className="font-medium">{issue.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {issue.detail}
                  </p>
                </TableCell>
                <TableCell className="py-3 align-top">
                  <Badge
                    variant={issue.severity === "error" ? "destructive" : "secondary"}
                    className="capitalize"
                  >
                    {issue.severity}
                  </Badge>
                </TableCell>
                <TableCell className="py-3 align-top text-xs text-muted-foreground">
                  {rowsLabel(issue)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

export function ProductFeedPreflight({
  onAuditChange,
}: {
  onAuditChange?: (audit: ProductFeedAudit | null) => void;
} = {}) {
  const [audit, setAudit] = useState<ProductFeedAudit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function applyAudit(text: string, fileName: string, byteLength?: number) {
    const result = auditProductFeedText(text, fileName, { byteLength });
    setAudit(result);
    onAuditChange?.(result);
    setError(null);
    toast.success("Product feed preflight complete", {
      description: `${result.adsEligibleRows}/${result.rowCount} rows ready for Ads processing review`,
    });
  }

  async function auditFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    setLoading(true);
    setError(null);
    setAudit(null);
    onAuditChange?.(null);
    try {
      applyAudit(await file.text(), file.name, file.size);
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "The feed could not be audited.";
      setAudit(null);
      onAuditChange?.(null);
      setError(message);
      toast.error("Feed could not be audited", { description: message });
    } finally {
      setLoading(false);
    }
  }

  function auditDemo() {
    try {
      applyAudit(DEMO_FEED, "harbour-home-sample.csv");
    } catch (caught) {
      setAudit(null);
      onAuditChange?.(null);
      setError(caught instanceof Error ? caught.message : "The sample could not run.");
    }
  }

  function reset() {
    setAudit(null);
    onAuditChange?.(null);
    setError(null);
  }

  return (
    <Card className="shadow-sm">
      <CardHeader className="gap-3 border-b bg-muted/20 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <FileSearch className="size-5" />
          </div>
          <div className="grid gap-1">
            <CardTitle className="text-base">Product feed preflight</CardTitle>
            <CardDescription className="max-w-3xl leading-5">
              Check a Google-compatible product feed against OpenAI&apos;s stable
              commerce fields and the additional Ads eligibility requirement.
            </CardDescription>
          </div>
        </div>
        <Badge variant="outline" className="w-fit whitespace-nowrap">
          Local browser check
        </Badge>
      </CardHeader>

      <CardContent className="grid gap-5 p-4 md:p-5">
        <FieldGroup className="gap-3">
          <Field>
            <FieldLabel htmlFor="product-feed-file">Choose a product feed</FieldLabel>
            <Input
              id="product-feed-file"
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              onChange={auditFile}
              disabled={loading}
              aria-describedby="product-feed-help"
              className="cursor-pointer"
            />
            <FieldDescription id="product-feed-help">
              UTF-8 CSV, TSV, or TXT · up to 5 MB and 50,000 product rows. The
              file is read in this browser and is not uploaded to MaintainFlow.
            </FieldDescription>
          </Field>
        </FieldGroup>

        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={auditDemo} disabled={loading}>
            <FileCheck2 data-icon="inline-start" />
            Audit sample feed
          </Button>
          {audit || error ? (
            <Button type="button" variant="ghost" onClick={reset} disabled={loading}>
              <RotateCcw data-icon="inline-start" />
              Clear result
            </Button>
          ) : null}
          {loading ? (
            <span className="inline-flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading file locally
            </span>
          ) : null}
        </div>

        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertTitle>Feed preflight could not run</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!audit && !error ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Upload />
              </EmptyMedia>
              <EmptyTitle>No feed audited yet</EmptyTitle>
              <EmptyDescription>
                Select an export from your catalogue or use the sample to see
                how blocked product rows are reported.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <p className="text-xs text-muted-foreground">
                Product titles, prices, URLs, and identifiers are never retained
                in the audit result.
              </p>
            </EmptyContent>
          </Empty>
        ) : null}

        {audit ? (
          <div className="grid gap-5" aria-live="polite">
            <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
              <div className="grid min-w-0 gap-1">
                <p className="truncate text-sm font-medium">{audit.fileName}</p>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  {audit.format} · local preflight
                </p>
              </div>
              <Badge
                variant={audit.verdict === "ready" ? "outline" : "secondary"}
                className={cn(
                  "w-fit whitespace-nowrap",
                  audit.verdict === "ready" &&
                    "border-success/30 bg-success/10 text-success",
                )}
              >
                {verdictLabel(audit.verdict)}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Product rows</p>
                <p className="mt-1 text-xl font-semibold">{audit.rowCount}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Ads eligible</p>
                <p className="mt-1 text-xl font-semibold">{audit.adsEligibleRows}</p>
              </div>
              <div className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Blocked rows</p>
                <p className="mt-1 text-xl font-semibold">{audit.blockedRows}</p>
              </div>
            </div>

            {audit.issues.length > 0 ? (
              <div className="grid gap-3">
                <div>
                  <h3 className="text-sm font-medium">Issues to fix</h3>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Results contain field names and row numbers only, not product values.
                  </p>
                </div>
                <FeedIssueTable issues={audit.issues} />
              </div>
            ) : (
              <Alert>
                <CheckCircle2 />
                <AlertTitle>Every row passed this local preflight</AlertTitle>
                <AlertDescription>
                  The file is structurally ready for the separate Ads Manager
                  feed-link and upload review.
                </AlertDescription>
              </Alert>
            )}
          </div>
        ) : null}
      </CardContent>

      <CardFooter className="items-start gap-3 border-t bg-muted/20 p-4 md:p-5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-xs leading-5 text-muted-foreground">
          This preflight cannot prove SFTP ingestion, feed linkage, downstream
          indexing, ad eligibility, or serving. OpenAI documents feed connection
          and full-catalog upload in Ads Manager, outside the public Advertiser API.
        </p>
      </CardFooter>
    </Card>
  );
}
