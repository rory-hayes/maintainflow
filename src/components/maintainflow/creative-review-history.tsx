import { Clock3, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { CreativeReviewEvent } from "@/lib/openai-ads/creative-history";
import { formatUtcDateTime } from "@/lib/formatting";

function statusLabel(status: CreativeReviewEvent["reviewStatus"]) {
  if (status === "in_review") return "In review";
  return status === "approved" ? "Approved" : "Rejected";
}

function deliveryLabel(status: CreativeReviewEvent["deliveryStatus"]) {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function reviewVariant(status: CreativeReviewEvent["reviewStatus"]) {
  if (status === "rejected") return "destructive" as const;
  if (status === "in_review") return "secondary" as const;
  return "outline" as const;
}

function detectedLabel(detectedAt: string) {
  return formatUtcDateTime(detectedAt);
}

export function CreativeReviewHistory({
  events,
  dataSource,
  ready,
  error,
}: {
  events: CreativeReviewEvent[];
  dataSource: "demo" | "live";
  ready: boolean;
  error?: string;
}) {
  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader className="gap-3 md:flex-row md:items-start md:justify-between">
        <div className="grid gap-1.5">
          <CardTitle className="text-base">Recent creative changes</CardTitle>
          <CardDescription>
            Review and delivery transitions detected between account syncs
          </CardDescription>
        </div>
        {dataSource === "demo" ? (
          <Badge className="self-start" variant="secondary">
            Simulator history
          </Badge>
        ) : ready ? (
          <Badge className="self-start" variant="outline">
            Durable history
          </Badge>
        ) : null}
      </CardHeader>
      <CardContent className="min-w-0">
        {error ? (
          <Alert>
            <Info />
            <AlertTitle>Creative history unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : events.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Creative</TableHead>
                <TableHead>Review decision</TableHead>
                <TableHead>Delivery</TableHead>
                <TableHead>Detected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {events.map((event) => (
                <TableRow key={event.id}>
                  <TableCell>
                    <div className="grid min-w-56 gap-1">
                      <span className="font-medium">{event.adName}</span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {event.adId} · {event.adGroupId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-56 items-center gap-2 whitespace-nowrap">
                      <Badge variant={reviewVariant(event.previousReviewStatus)}>
                        {statusLabel(event.previousReviewStatus)}
                      </Badge>
                      <span className="text-xs text-muted-foreground">to</span>
                      <Badge variant={reviewVariant(event.reviewStatus)}>
                        {statusLabel(event.reviewStatus)}
                      </Badge>
                    </div>
                  </TableCell>
                  <TableCell>
                    {event.previousDeliveryStatus === event.deliveryStatus ? (
                      <span className="whitespace-nowrap text-sm text-muted-foreground">
                        No delivery change
                      </span>
                    ) : (
                      <div className="flex min-w-44 items-center gap-2 whitespace-nowrap text-sm">
                        <span>{deliveryLabel(event.previousDeliveryStatus)}</span>
                        <span className="text-xs text-muted-foreground">to</span>
                        <span>{deliveryLabel(event.deliveryStatus)}</span>
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {detectedLabel(event.detectedAt)} UTC
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Empty className="border-0 py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Clock3 />
              </EmptyMedia>
              <EmptyTitle>No creative changes recorded yet</EmptyTitle>
              <EmptyDescription>
                The first live sync establishes a baseline. Later review or
                delivery changes will appear here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </CardContent>
    </Card>
  );
}
