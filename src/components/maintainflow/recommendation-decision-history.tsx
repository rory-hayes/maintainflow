import { AlertTriangle, FileCheck2 } from "lucide-react";

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
import type { RecommendationDecisionHistoryDto } from "@/lib/audit/recommendation-decision";

type RecommendationDecisionHistoryProps = {
  records: RecommendationDecisionHistoryDto[];
  dataSource: "demo" | "live";
  error?: string;
};

function decisionTime(value: string) {
  return `${new Intl.DateTimeFormat("en-IE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value))} UTC`;
}

function actorSummary(
  organizationName: string,
  membershipRole: string,
  accountRole: string,
) {
  return `${organizationName} · ${membershipRole}/${accountRole}`;
}

export function RecommendationDecisionHistory({
  records,
  dataSource,
  error,
}: RecommendationDecisionHistoryProps) {
  return (
    <Card className="min-w-0 shadow-sm">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <FileCheck2 />
          </div>
          <div className="min-w-0 grid gap-1">
            <CardTitle className="text-base">Recommendation decisions</CardTitle>
            <CardDescription>
              Reasons, account roles, and restore outcomes retained independently
              from Ads API writes.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="min-w-0">
        {error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Decision history unavailable</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : records.length === 0 ? (
          <Empty className="border-0 py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FileCheck2 />
              </EmptyMedia>
              <EmptyTitle>
                {dataSource === "demo"
                  ? "No durable decisions in demo mode"
                  : "No recommendation decisions yet"}
              </EmptyTitle>
              <EmptyDescription>
                {dataSource === "demo"
                  ? "Demo dismissals remain in the session audit below. Connected accounts retain the full decision and restore trail here."
                  : "Reason-backed dismissals and restores will appear here for this advertiser account."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="max-w-full overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Decision</TableHead>
                  <TableHead>Recommendation</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead>Actor trail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id}>
                    <TableCell className="min-w-44 align-top">
                      <Badge
                        variant="outline"
                        className={
                          record.restoredAt
                            ? "border-primary/20 bg-primary/10 text-primary"
                            : ""
                        }
                      >
                        {record.restoredAt ? "Restored" : "Dismissed"}
                      </Badge>
                      <p className="mt-2 text-xs text-muted-foreground">
                        Dismissed {decisionTime(record.dismissedAt)}
                      </p>
                      {record.restoredAt ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Restored {decisionTime(record.restoredAt)}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="min-w-56 align-top">
                      <p className="font-medium">
                        {record.recommendationTitle}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {record.entityId}
                      </p>
                    </TableCell>
                    <TableCell className="min-w-64 max-w-md align-top text-sm leading-6">
                      {record.reason}
                    </TableCell>
                    <TableCell className="min-w-64 align-top">
                      <p className="text-sm font-medium">Dismissed by</p>
                      <p className="text-xs text-muted-foreground">
                        {actorSummary(
                          record.organizationName,
                          record.membershipRole,
                          record.accountRole,
                        )}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        {record.operatorId}
                      </p>
                      {record.restoredAt &&
                      record.restoredBy &&
                      record.restoredOrganizationName &&
                      record.restoredMembershipRole &&
                      record.restoredAccountRole ? (
                        <div className="mt-3 border-t pt-3">
                          <p className="text-sm font-medium">Restored by</p>
                          <p className="text-xs text-muted-foreground">
                            {actorSummary(
                              record.restoredOrganizationName,
                              record.restoredMembershipRole,
                              record.restoredAccountRole,
                            )}
                          </p>
                          <p className="font-mono text-xs text-muted-foreground">
                            {record.restoredBy}
                          </p>
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
