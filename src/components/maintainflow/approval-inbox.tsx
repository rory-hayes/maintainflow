"use client";

import { useId, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  Clock3,
  FileCheck2,
  FileClock,
  Loader2,
  Play,
  ShieldCheck,
  X,
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
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import type { ChangeApprovalRequestDto } from "@/lib/approvals/change-request-schema";
import { formatUtcDateTime } from "@/lib/formatting";
import type { OrganizationMembership } from "@/lib/tenancy/schema";
import { cn } from "@/lib/utils";

const SIMULATOR_BOUNDARY_COPY =
  "Simulator evidence · approved only · no external write.";

type ApprovalInboxProps = {
  requests: ChangeApprovalRequestDto[];
  nextCursor?: string | null;
  currentOperatorId: string | null;
  canDecide: boolean;
  organizations?: OrganizationMembership[];
  selectedOrganizationId?: string;
  onOrganizationChange?: (organizationId: string) => void;
  eligibleReviewerCount?: number;
  emailNotificationsEnabled?: boolean;
  writableAccountIds?: string[];
  initialFilter?: ApprovalInboxFilter;
  initialRequestId?: string;
  onFilterChange?: (filter: ApprovalInboxFilter) => void;
  error?: string;
};

type DecisionAction = "approve" | "request_changes";
export type ApprovalInboxFilter =
  | "needs-review"
  | "requested-by-me"
  | "ready-to-apply"
  | "history";

const approvalInboxFilters = new Set<ApprovalInboxFilter>([
  "needs-review",
  "requested-by-me",
  "ready-to-apply",
  "history",
]);

export function parseApprovalInboxFilter(
  value: string | string[] | undefined,
): ApprovalInboxFilter | null {
  return typeof value === "string" &&
    approvalInboxFilters.has(value as ApprovalInboxFilter)
    ? (value as ApprovalInboxFilter)
    : null;
}

type ApprovalRequestGroups = {
  needsDecision: ChangeApprovalRequestDto[];
  requestedByMe: ChangeApprovalRequestDto[];
  readyToApply: ChangeApprovalRequestDto[];
  history: ChangeApprovalRequestDto[];
};

type ApprovalRequestPageState = {
  sourceRequests: ChangeApprovalRequestDto[];
  sourceCursor: string | null;
  visibleRequests: ChangeApprovalRequestDto[];
  paginationCursor: string | null;
};

export function findApprovalRequestById(
  requests: readonly ChangeApprovalRequestDto[],
  requestId: string | undefined,
) {
  if (!requestId) return null;
  return requests.find((request) => request.id === requestId) ?? null;
}

function timestamp(value: string) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestFirst(
  left: ChangeApprovalRequestDto,
  right: ChangeApprovalRequestDto,
) {
  return timestamp(right.requestedAt) - timestamp(left.requestedAt);
}

export function isChangeApprovalRequestExpired(
  request: ChangeApprovalRequestDto,
  now = new Date(),
) {
  const expiresAt = new Date(request.expiresAt).getTime();
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

export function isChangeApprovalRequestReadyToApply(
  request: ChangeApprovalRequestDto,
  now = new Date(),
) {
  return Boolean(
    request.source === "live" &&
      request.status === "approved" &&
      request.decisionContext.schemaVersion === 2 &&
      request.adsApprovalRecordId === null &&
      request.retiredAt === null &&
      !isChangeApprovalRequestExpired(request, now),
  );
}

export function approvalInboxFilterForRequest(
  request: ChangeApprovalRequestDto,
  currentOperatorId: string | null,
  now = new Date(),
): ApprovalInboxFilter {
  if (isChangeApprovalRequestReadyToApply(request, now)) {
    return "ready-to-apply";
  }
  if (
    request.status === "awaiting_approval" &&
    !isChangeApprovalRequestExpired(request, now)
  ) {
    return currentOperatorId &&
      request.requesterOperatorId === currentOperatorId
      ? "requested-by-me"
      : "needs-review";
  }
  return "history";
}

export function groupChangeApprovalRequests(
  requests: ChangeApprovalRequestDto[],
  currentOperatorId: string | null,
  now = new Date(),
): ApprovalRequestGroups {
  const groups: ApprovalRequestGroups = {
    needsDecision: [],
    requestedByMe: [],
    readyToApply: [],
    history: [],
  };

  for (const request of requests) {
    if (isChangeApprovalRequestReadyToApply(request, now)) {
      groups.readyToApply.push(request);
      continue;
    }

    const awaiting =
      request.status === "awaiting_approval" &&
      !isChangeApprovalRequestExpired(request, now);

    if (!awaiting) {
      groups.history.push(request);
    } else if (
      currentOperatorId &&
      request.requesterOperatorId === currentOperatorId
    ) {
      groups.requestedByMe.push(request);
    } else {
      groups.needsDecision.push(request);
    }
  }

  groups.needsDecision.sort(newestFirst);
  groups.requestedByMe.sort(newestFirst);
  groups.readyToApply.sort(newestFirst);
  groups.history.sort(newestFirst);
  return groups;
}

export function canCurrentOperatorDecideRequest(
  request: ChangeApprovalRequestDto,
  currentOperatorId: string | null,
  canDecide: boolean,
  now = new Date(),
) {
  return Boolean(
    canDecide &&
      currentOperatorId &&
      request.requesterOperatorId !== currentOperatorId &&
      request.status === "awaiting_approval" &&
      !isChangeApprovalRequestExpired(request, now),
  );
}

export function canCurrentOperatorCancelRequest(
  request: ChangeApprovalRequestDto,
  currentOperatorId: string | null,
  canManage: boolean,
  now = new Date(),
) {
  return Boolean(
    currentOperatorId &&
      (request.requesterOperatorId === currentOperatorId || canManage) &&
      request.status === "awaiting_approval" &&
      !isChangeApprovalRequestExpired(request, now),
  );
}

export function canCurrentOperatorApplyRequest(
  request: ChangeApprovalRequestDto,
  currentOperatorId: string | null,
  hasWritableAccountAccess: boolean,
  now = new Date(),
) {
  return Boolean(
    currentOperatorId &&
      hasWritableAccountAccess &&
      isChangeApprovalRequestReadyToApply(request, now),
  );
}

export function buildAgencyApprovalApplyBody(
  request: ChangeApprovalRequestDto,
) {
  return {
    authorization: "agency_request" as const,
    approvalRequestId: request.id,
    approvalRequestVersion: request.version,
  };
}

export function isApprovalDecisionNoteValid(
  action: DecisionAction,
  note: string,
) {
  const length = note.trim().length;
  return action === "approve" ? length === 0 || length >= 5 : length >= 10;
}

export function changeApprovalStatusLabel(
  request: ChangeApprovalRequestDto,
  now = new Date(),
) {
  if (
    request.status === "approved" &&
    request.adsApprovalRecordId !== null
  ) {
    return "Sent to execution ledger";
  }

  if (request.status === "approved" && request.retiredAt !== null) {
    return "Fresh review required";
  }

  if (
    request.status === "approved" &&
    isChangeApprovalRequestExpired(request, now)
  ) {
    return "Approval expired";
  }

  if (request.status === "approved" && request.source === "simulator") {
    return "Approved · simulator only";
  }

  if (
    request.status === "approved" &&
    request.source === "live" &&
    request.decisionContext.schemaVersion !== 2 &&
    request.adsApprovalRecordId === null
  ) {
    return "Fresh review required";
  }

  if (isChangeApprovalRequestReadyToApply(request, now)) {
    return "Ready to apply";
  }

  if (
    request.status === "expired" ||
    (request.status === "awaiting_approval" &&
      isChangeApprovalRequestExpired(request, now))
  ) {
    return "Expired";
  }

  const labels: Record<ChangeApprovalRequestDto["status"], string> = {
    awaiting_approval: "Awaiting approval",
    approved: "Approved",
    changes_requested: "Changes requested",
    cancelled: "Cancelled",
    expired: "Expired",
  };
  return labels[request.status];
}

function statusTone(request: ChangeApprovalRequestDto) {
  const label = changeApprovalStatusLabel(request);
  if (label === "Ready to apply") {
    return "border-success/20 bg-success/10 text-success";
  }
  if (label === "Approved · simulator only") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (label === "Fresh review required") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (label === "Changes requested") {
    return "border-warning/30 bg-warning/10 text-warning-foreground";
  }
  if (
    label === "Cancelled" ||
    label === "Expired" ||
    label === "Approval expired" ||
    label === "Sent to execution ledger"
  ) {
    return "bg-muted text-muted-foreground";
  }
  return "border-primary/20 bg-primary/10 text-primary";
}

function formatRole(role: string) {
  return role
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function requestKey(request: ChangeApprovalRequestDto) {
  return `${request.id}:${request.version}`;
}

function RequestList({
  requests,
  emptyTitle,
  emptyDescription,
  currentOperatorId,
  canDecide,
  writableAccountIds,
  onReview,
}: {
  requests: ChangeApprovalRequestDto[];
  emptyTitle: string;
  emptyDescription: string;
  currentOperatorId: string | null;
  canDecide: boolean;
  writableAccountIds: ReadonlySet<string>;
  onReview: (
    request: ChangeApprovalRequestDto,
    trigger: HTMLButtonElement,
  ) => void;
}) {
  if (requests.length === 0) {
    return (
      <Empty className="border bg-background py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileClock />
          </EmptyMedia>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="grid gap-4">
      {requests.map((request) => {
        const mayDecide = canCurrentOperatorDecideRequest(
          request,
          currentOperatorId,
          canDecide,
        );
        const requestedByCurrentOperator = Boolean(
          currentOperatorId &&
            request.requesterOperatorId === currentOperatorId,
        );
        const mayApply = canCurrentOperatorApplyRequest(
          request,
          currentOperatorId,
          writableAccountIds.has(request.accountId),
        );

        return (
          <Card key={requestKey(request)} className="min-w-0 shadow-sm">
            <CardHeader className="gap-3">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
                <div className="min-w-0 grid gap-1">
                  <CardTitle className="break-words text-base">
                    {request.recommendationTitle}
                  </CardTitle>
                  <CardDescription className="break-words">
                    {request.accountName} · {request.entityId}
                  </CardDescription>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Badge variant="secondary">
                    {request.source === "live" ? "Live Ads" : "Simulator"}
                  </Badge>
                  <Badge
                    variant="outline"
                    className={cn("w-fit", statusTone(request))}
                  >
                    {changeApprovalStatusLabel(request)}
                  </Badge>
                </div>
              </div>
              {request.source === "simulator" ? (
                <p className="text-xs font-medium text-warning-foreground">
                  {SIMULATOR_BOUNDARY_COPY}
                </p>
              ) : null}
            </CardHeader>
            <CardContent className="grid gap-4">
              <dl className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                <div className="grid gap-1">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Requested by
                  </dt>
                  <dd className="font-medium">{request.requesterName}</dd>
                  <dd className="text-xs text-muted-foreground">
                    {formatRole(request.requesterMembershipRole)} · {formatUtcDateTime(request.requestedAt, { includeTimeZone: true })}
                  </dd>
                </div>
                <div className="grid gap-1">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Decision
                  </dt>
                  {request.decisionName && request.decisionMembershipRole ? (
                    <>
                      <dd className="font-medium">{request.decisionName}</dd>
                      <dd className="text-xs text-muted-foreground">
                        {formatRole(request.decisionMembershipRole)}
                        {request.decidedAt
                          ? ` · ${formatUtcDateTime(request.decidedAt, { includeTimeZone: true })}`
                          : ""}
                      </dd>
                    </>
                  ) : (
                    <dd className="text-muted-foreground">No decision recorded</dd>
                  )}
                </div>
                <div className="grid gap-1">
                  <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Expires
                  </dt>
                  <dd>
                    {formatUtcDateTime(request.expiresAt, {
                      includeTimeZone: true,
                    })}
                  </dd>
                </div>
              </dl>

              {request.requestNote ? (
                <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Request note
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words">
                    {request.requestNote}
                  </p>
                </div>
              ) : null}

              {request.decisionNote ? (
                <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Decision note
                  </p>
                  <p className="mt-1 whitespace-pre-wrap break-words">
                    {request.decisionNote}
                  </p>
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                {requestedByCurrentOperator ? (
                  <Badge variant="outline" className="mr-auto w-fit self-center">
                    You requested this change
                  </Badge>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant={mayDecide || mayApply ? "default" : "outline"}
                  className="min-h-11"
                  aria-label={`Review ${request.recommendationTitle}`}
                  onClick={(event) => onReview(request, event.currentTarget)}
                >
                  <FileCheck2 data-icon="inline-start" />
                  {mayApply
                    ? "Review and apply"
                    : mayDecide
                      ? "Review and decide"
                      : "Review details"}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

export function ApprovalRequestReviewDetails({
  request,
}: {
  request: ChangeApprovalRequestDto;
}) {
  const headingId = useId();

  return (
    <div className="grid gap-5 text-sm">
      {request.source === "simulator" ? (
        <Alert className="border-warning/30 bg-warning/10">
          <ShieldCheck />
          <AlertTitle>Simulator approval boundary</AlertTitle>
          <AlertDescription>{SIMULATOR_BOUNDARY_COPY}</AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-warning/30 bg-warning/10">
          <ShieldCheck />
          <AlertTitle>Live write boundary</AlertTitle>
          <AlertDescription>
            Approval authorizes only this exact packet. Applying it may send one
            external Ads write after MaintainFlow rechecks access, freshness,
            provider state, and the stored fingerprint.
          </AlertDescription>
        </Alert>
      )}

      <section aria-labelledby={headingId} className="grid gap-3">
        <h3 id={headingId} className="font-medium">
          Immutable request context
        </h3>
        <dl className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Agency
            </dt>
            <dd className="break-words">{request.organizationName}</dd>
          </div>
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Advertiser account
            </dt>
            <dd className="break-words">{request.accountName}</dd>
            <dd className="break-all font-mono text-xs text-muted-foreground">
              {request.accountId}
            </dd>
          </div>
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Recommendation
            </dt>
            <dd>{request.recommendationTitle}</dd>
            <dd className="break-all font-mono text-xs text-muted-foreground">
              {request.recommendationId}
            </dd>
          </div>
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Entity
            </dt>
            <dd className="break-all font-mono text-xs">{request.entityId}</dd>
          </div>
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Requested by
            </dt>
            <dd>{request.requesterName}</dd>
            <dd className="text-xs text-muted-foreground">
              {formatRole(request.requesterMembershipRole)}
            </dd>
          </div>
          <div className="grid min-w-0 gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Expires
            </dt>
            <dd>{formatUtcDateTime(request.expiresAt, { includeTimeZone: true })}</dd>
          </div>
        </dl>
      </section>

      <section className="grid gap-3" aria-labelledby={`${headingId}-decision`}>
        <div className="grid gap-1">
          <h3 id={`${headingId}-decision`} className="font-medium">
            Decision context shown to the requester
          </h3>
          <p className="text-muted-foreground">
            {request.decisionContext.summary}
          </p>
          {request.decisionContext.schemaVersion === 2 ? (
            <div className="mt-2 grid gap-1 rounded-lg border bg-muted/30 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Rationale
              </p>
              <p className="text-sm">{request.decisionContext.rationale}</p>
            </div>
          ) : null}
        </div>
        <dl className="grid gap-3 rounded-lg border bg-muted/30 p-4 sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Priority
            </dt>
            <dd className="capitalize">{request.decisionContext.priority}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Confidence
            </dt>
            <dd>{Math.round(request.decisionContext.confidence)}%</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Current value
            </dt>
            <dd>{request.decisionContext.currentValue}</dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Proposed value
            </dt>
            <dd>{request.decisionContext.proposedValue}</dd>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Estimated impact
            </dt>
            <dd>{request.decisionContext.estimatedImpact}</dd>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Required next step
            </dt>
            <dd>{request.decisionContext.nextStep}</dd>
          </div>
        </dl>
        {request.decisionContext.monitoringPlan ? (
          <p className="text-xs text-muted-foreground">
            Monitoring plan: {request.decisionContext.monitoringPlan.windowDays}
            -day click-attributed conversion window; human rollback review if
            conversions decrease by more than {request.decisionContext.monitoringPlan.rollbackRule.thresholdPercent}%.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">
            No post-change monitoring plan was included in this approval packet.
          </p>
        )}
      </section>

      {request.evidence.length > 0 ? (
        <section className="grid gap-3" aria-labelledby={`${headingId}-evidence`}>
          <h3 id={`${headingId}-evidence`} className="font-medium">
            Evidence retained with this request
          </h3>
          <dl className="grid gap-3 sm:grid-cols-2">
            {request.evidence.map((item, index) => (
              <div
                key={`${item.label}:${index}`}
                className="rounded-lg border bg-background p-3"
              >
                <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {item.label}
                </dt>
                <dd className="mt-1 font-medium">{item.value}</dd>
                <dd className="mt-1 text-xs text-muted-foreground">
                  {item.detail}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <section className="grid gap-3" aria-labelledby={`${headingId}-payloads`}>
        <div className="grid gap-1">
          <h3 id={`${headingId}-payloads`} className="font-medium">
            Exact request and rollback
          </h3>
          <p className="text-xs text-muted-foreground">
            These payloads and the fingerprint are read-only snapshots of the
            request under review.
          </p>
        </div>
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <PayloadBlock title="Request" mutation={request.mutation} />
          <PayloadBlock title="Rollback" mutation={request.rollback} />
        </div>
        <p className="break-all font-mono text-[11px] text-muted-foreground">
          Fingerprint {request.recommendationFingerprint}
        </p>
      </section>

      <Alert>
        <ShieldCheck />
        <AlertTitle>Safeguard</AlertTitle>
        <AlertDescription>{request.safeguard}</AlertDescription>
      </Alert>

      {request.requestNote ? (
        <section className="grid gap-1 rounded-lg border bg-muted/30 p-4">
          <h3 className="font-medium">Requester note</h3>
          <p className="whitespace-pre-wrap break-words text-muted-foreground">
            {request.requestNote}
          </p>
        </section>
      ) : null}

      {request.decisionName ? (
        <section className="grid gap-1 rounded-lg border bg-muted/30 p-4">
          <h3 className="font-medium">Recorded decision</h3>
          <p>{changeApprovalStatusLabel(request)}</p>
          <p className="text-muted-foreground">
            {request.decisionName}
            {request.decisionMembershipRole
              ? ` · ${formatRole(request.decisionMembershipRole)}`
              : ""}
            {request.decidedAt
              ? ` · ${formatUtcDateTime(request.decidedAt, { includeTimeZone: true })}`
              : ""}
          </p>
          {request.decisionNote ? (
            <p className="mt-2 whitespace-pre-wrap break-words">
              {request.decisionNote}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function PayloadBlock({
  title,
  mutation,
}: {
  title: string;
  mutation: ChangeApprovalRequestDto["mutation"];
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg bg-zinc-950 text-zinc-100">
      <div className="border-b border-white/10 px-4 py-2 break-all font-mono text-xs text-zinc-400">
        {title} · {mutation.method} {mutation.path}
      </div>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words p-4 text-xs leading-5">
        {mutation.body
          ? JSON.stringify(mutation.body, null, 2)
          : "No request body"}
      </pre>
    </div>
  );
}

export function ApprovalInbox({
  requests,
  nextCursor = null,
  currentOperatorId,
  canDecide,
  organizations = [],
  selectedOrganizationId,
  onOrganizationChange,
  eligibleReviewerCount = 0,
  emailNotificationsEnabled = false,
  writableAccountIds = [],
  initialFilter = "needs-review",
  initialRequestId,
  onFilterChange,
  error,
}: ApprovalInboxProps) {
  const router = useRouter();
  const sectionTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogTitleRef = useRef<HTMLHeadingElement>(null);
  const dialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [reviewRequest, setReviewRequest] =
    useState<ChangeApprovalRequestDto | null>(() =>
      findApprovalRequestById(requests, initialRequestId),
    );
  const [note, setNote] = useState("");
  const [busyAction, setBusyAction] = useState<
    DecisionAction | "cancel" | "apply" | null
  >(null);
  const [localFilter, setLocalFilter] =
    useState<ApprovalInboxFilter>(() =>
      reviewRequest
        ? approvalInboxFilterForRequest(
            reviewRequest,
            currentOperatorId,
          )
        : initialFilter,
    );
  const deepLinkedFilter =
    reviewRequest && reviewRequest.id === initialRequestId
      ? approvalInboxFilterForRequest(reviewRequest, currentOperatorId)
      : null;
  const activeFilter =
    deepLinkedFilter ?? (onFilterChange ? initialFilter : localFilter);
  const [requestPage, setRequestPage] = useState<ApprovalRequestPageState>(
    () => ({
      sourceRequests: requests,
      sourceCursor: nextCursor,
      visibleRequests: requests,
      paginationCursor: nextCursor,
    }),
  );
  if (
    requestPage.sourceRequests !== requests ||
    requestPage.sourceCursor !== nextCursor
  ) {
    setRequestPage({
      sourceRequests: requests,
      sourceCursor: nextCursor,
      visibleRequests: requests,
      paginationCursor: nextCursor,
    });
  }
  const { visibleRequests, paginationCursor } = requestPage;
  const [loadingMore, setLoadingMore] = useState(false);
  const groups = groupChangeApprovalRequests(
    visibleRequests,
    currentOperatorId,
  );
  const writableAccountSet = useMemo(
    () => new Set(writableAccountIds),
    [writableAccountIds],
  );

  const mayDecide = reviewRequest
    ? canCurrentOperatorDecideRequest(
        reviewRequest,
        currentOperatorId,
        canDecide,
      )
    : false;
  const mayCancel = reviewRequest
    ? canCurrentOperatorCancelRequest(
        reviewRequest,
        currentOperatorId,
        canDecide,
      )
    : false;
  const mayApply = reviewRequest
    ? canCurrentOperatorApplyRequest(
        reviewRequest,
        currentOperatorId,
        writableAccountSet.has(reviewRequest.accountId),
      )
    : false;
  const approveNoteValid = isApprovalDecisionNoteValid("approve", note);
  const changesNoteValid = isApprovalDecisionNoteValid(
    "request_changes",
    note,
  );
  const noteLength = note.trim().length;
  const noteError =
    noteLength > 0 && noteLength < 5
      ? "An approval note must be empty or at least 5 characters. Requesting changes requires at least 10 characters."
      : noteLength >= 5 && noteLength < 10
        ? "Add at least 10 characters to request changes."
        : null;

  function openReview(
    request: ChangeApprovalRequestDto,
    trigger: HTMLButtonElement,
  ) {
    dialogTriggerRef.current = trigger;
    setNote("");
    setReviewRequest(request);
  }

  function changeFilter(value: string) {
    const filter = parseApprovalInboxFilter(value);
    if (!filter) return;
    setLocalFilter(filter);
    onFilterChange?.(filter);
  }

  function closeReview() {
    if (busyAction) return;
    if (deepLinkedFilter) changeFilter(deepLinkedFilter);
    setReviewRequest(null);
    setNote("");
  }

  async function postRequestAction(
    path: string,
    body: Record<string, unknown>,
    successTitle: string,
    successDescription: string,
    action: DecisionAction | "cancel",
    successFilter?: ApprovalInboxFilter,
  ) {
    if (!reviewRequest || busyAction) return;
    setBusyAction(action);
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!response.ok) {
        if (response.status === 409) {
          setReviewRequest(null);
          setNote("");
          router.refresh();
        }
        throw new Error(result.error ?? "The approval request could not be updated.");
      }

      toast.success(successTitle, {
        description: result.message ?? successDescription,
      });
      setReviewRequest(null);
      setNote("");
      if (successFilter) changeFilter(successFilter);
      router.refresh();
    } catch (caught) {
      toast.error("Unable to update approval request", {
        description:
          caught instanceof Error ? caught.message : "Please try again.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function decide(action: DecisionAction) {
    if (!reviewRequest || !mayDecide) return;
    if (!isApprovalDecisionNoteValid(action, note)) return;
    await postRequestAction(
      `/api/approvals/requests/${reviewRequest.id}/decision`,
      {
        action,
        note: note.trim() || undefined,
        version: reviewRequest.version,
      },
      action === "approve" ? "Request approved" : "Changes requested",
      action === "approve"
        ? reviewRequest.source === "live"
          ? "The exact packet is ready for one live execution. Approval itself sent no external write."
          : "Approved · simulator only. No external write can be sent from this packet."
        : `Feedback was recorded. Regenerate the fixed ${reviewRequest.source === "live" ? "live" : "simulator"} proposal before submitting a materially revised packet.`,
      action,
      action === "approve" && reviewRequest.source === "live"
        ? "ready-to-apply"
        : undefined,
    );
  }

  async function applyApprovedChange() {
    if (!reviewRequest || !mayApply || busyAction) return;
    setBusyAction("apply");
    try {
      const response = await fetch("/api/ads/recommendations/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildAgencyApprovalApplyBody(reviewRequest)),
      });
      const result = (await response.json().catch(() => ({}))) as {
        applied?: boolean;
        error?: string;
        message?: string;
        mode?: "demo" | "live";
      };

      if (!response.ok) {
        if (response.status === 409) {
          setReviewRequest(null);
          setNote("");
          router.refresh();
        }
        throw new Error(result.error ?? "The approved change could not be applied.");
      }

      setReviewRequest(null);
      setNote("");
      changeFilter("history");
      router.refresh();

      if (result.mode !== "live" || result.applied !== true) {
        toast.warning("No live change sent", {
          description:
            result.message ??
            "MaintainFlow stopped before the external write because a live gate changed.",
        });
        return;
      }

      toast.success("Approved change applied", {
        description:
          result.message ??
          "The exact approved packet was sent and moved into monitoring.",
      });
    } catch (caught) {
      toast.error("Unable to apply approved change", {
        description:
          caught instanceof Error ? caught.message : "Please try again.",
      });
    } finally {
      setBusyAction(null);
    }
  }

  async function cancel() {
    if (!reviewRequest || !mayCancel) return;
    await postRequestAction(
      `/api/approvals/requests/${reviewRequest.id}/cancel`,
      { version: reviewRequest.version },
      "Request cancelled",
      "The request left the active approval queue.",
      "cancel",
    );
  }

  async function loadMoreRequests() {
    if (!selectedOrganizationId || !paginationCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const query = new URLSearchParams({
        organizationId: selectedOrganizationId,
        cursor: paginationCursor,
      });
      const response = await fetch(`/api/approvals/requests?${query}`);
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        requests?: ChangeApprovalRequestDto[];
        nextCursor?: string | null;
      };
      if (!response.ok || !Array.isArray(result.requests)) {
        throw new Error(result.error ?? "Older requests could not be loaded.");
      }
      setRequestPage((current) => {
        const known = new Set(
          current.visibleRequests.map((request) => request.id),
        );
        return {
          ...current,
          visibleRequests: [
            ...current.visibleRequests,
            ...result.requests!.filter((request) => !known.has(request.id)),
          ],
          paginationCursor: result.nextCursor ?? null,
        };
      });
    } catch (caught) {
      toast.error("Unable to load older requests", {
        description:
          caught instanceof Error ? caught.message : "Please try again.",
      });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="mx-auto grid min-w-0 max-w-6xl gap-6 p-4 md:p-6 lg:p-8">
      <div className="grid gap-2">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">Two-person review</Badge>
          <Badge variant="outline">
            Approval email {emailNotificationsEnabled ? "on" : "off"}
          </Badge>
        </div>
        <h1
          ref={sectionTitleRef}
          tabIndex={-1}
          className="text-2xl font-semibold tracking-[-0.03em] md:text-3xl"
        >
          Approval inbox
        </h1>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          Review the exact request, rollback and safeguard retained by the
          agency. The person who requested a change cannot approve it.
        </p>
        {organizations.length > 1 && selectedOrganizationId ? (
          <div className="mt-2 grid max-w-sm gap-2">
            <label
              htmlFor="approval-organization"
              className="text-sm font-medium"
            >
              Agency workspace
            </label>
            <Select
              value={selectedOrganizationId}
              onValueChange={onOrganizationChange}
            >
              <SelectTrigger id="approval-organization" className="w-full">
                <SelectValue placeholder="Select an agency" />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {organizations.map((organization) => (
                    <SelectItem
                      key={organization.organizationId}
                      value={organization.organizationId}
                    >
                      {organization.organizationName}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Approval inbox unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!error &&
      selectedOrganizationId &&
      eligibleReviewerCount === 0 &&
      groups.requestedByMe.length > 0 ? (
        <Alert className="border-warning/30 bg-warning/10">
          <AlertTriangle />
          <AlertTitle>No other reviewer for requests you created</AlertTitle>
          <AlertDescription>
            Add a different agency owner or admin before your queued packets
            can receive a two-person decision. You may still decide requests
            created by other members. Approval email requires another eligible
            owner or admin and must be enabled for this workspace.
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        value={activeFilter}
        onValueChange={changeFilter}
        className="min-w-0"
      >
        <TabsList
          aria-label="Approval inbox filters"
          className="grid h-auto w-full grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-4"
        >
          <TabsTrigger value="needs-review" className="min-h-11 justify-between gap-2">
            Needs review
            <Badge variant="secondary">{groups.needsDecision.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="requested-by-me" className="min-h-11 justify-between gap-2">
            Requested by me
            <Badge variant="secondary">{groups.requestedByMe.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="ready-to-apply" className="min-h-11 justify-between gap-2">
            Ready to apply
            <Badge variant="secondary">{groups.readyToApply.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="history" className="min-h-11 justify-between gap-2">
            History
            <Badge variant="secondary">{groups.history.length}</Badge>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="needs-review" forceMount className="mt-4 data-[state=inactive]:hidden">
          <RequestList
            requests={groups.needsDecision}
            emptyTitle="No requests need review"
            emptyDescription="New requests from other agency members will appear here."
            currentOperatorId={currentOperatorId}
            canDecide={canDecide}
            writableAccountIds={writableAccountSet}
            onReview={openReview}
          />
        </TabsContent>
        <TabsContent value="requested-by-me" forceMount className="mt-4 data-[state=inactive]:hidden">
          <RequestList
            requests={groups.requestedByMe}
            emptyTitle="No requests awaiting review"
            emptyDescription="Changes you submit will remain here until another authorized agency member decides."
            currentOperatorId={currentOperatorId}
            canDecide={canDecide}
            writableAccountIds={writableAccountSet}
            onReview={openReview}
          />
        </TabsContent>
        <TabsContent value="ready-to-apply" forceMount className="mt-4 data-[state=inactive]:hidden">
          <RequestList
            requests={groups.readyToApply}
            emptyTitle="No approved live changes are ready"
            emptyDescription="A live packet appears here after a different agency owner or admin approves it."
            currentOperatorId={currentOperatorId}
            canDecide={canDecide}
            writableAccountIds={writableAccountSet}
            onReview={openReview}
          />
        </TabsContent>
        <TabsContent value="history" forceMount className="mt-4 data-[state=inactive]:hidden">
          <RequestList
            requests={groups.history}
            emptyTitle="No approval history yet"
            emptyDescription="Approved, changes-requested, cancelled and expired requests will appear here."
            currentOperatorId={currentOperatorId}
            canDecide={canDecide}
            writableAccountIds={writableAccountSet}
            onReview={openReview}
          />
        </TabsContent>
      </Tabs>

      {paginationCursor ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={loadMoreRequests}
            disabled={loadingMore}
            aria-busy={loadingMore}
          >
            {loadingMore ? (
              <Loader2 data-icon="inline-start" className="animate-spin" />
            ) : (
              <FileClock data-icon="inline-start" />
            )}
            Load older requests
          </Button>
        </div>
      ) : null}

      <Dialog
        open={Boolean(reviewRequest)}
        onOpenChange={(open) => {
          if (!open) closeReview();
        }}
      >
        <DialogContent
          className="grid max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            dialogTitleRef.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (dialogTriggerRef.current?.isConnected) {
              dialogTriggerRef.current.focus();
              return;
            }
            sectionTitleRef.current?.focus();
          }}
        >
          <DialogHeader className="border-b px-5 pb-4 pt-5 pr-12 sm:px-6 sm:pt-6">
            <DialogTitle ref={dialogTitleRef} tabIndex={-1}>
              {mayApply
                ? "Review approved live change"
                : mayDecide
                  ? "Review approval request"
                  : "Review approval details"}
            </DialogTitle>
            <DialogDescription>
              {mayApply
                ? "Confirm the immutable evidence and actor trail before execution. Applying can send this one exact external Ads write."
                : reviewRequest?.source === "live"
                  ? "Confirm the immutable evidence and actor trail before recording a decision. Approval enables one later execution; this decision sends no external write."
                  : "Confirm the immutable evidence and actor trail before recording a decision. Simulator decisions never send an external write."}
            </DialogDescription>
          </DialogHeader>

          <div
            role="region"
            aria-label="Approval request evidence"
            tabIndex={0}
            className="min-h-0 overflow-y-auto px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-6"
          >
            {reviewRequest ? (
              <ApprovalRequestReviewDetails request={reviewRequest} />
            ) : null}

            {mayDecide ? (
              <>
                <Separator className="my-5" />
                <Field data-invalid={Boolean(noteError)}>
                  <FieldLabel htmlFor="approval-decision-note">
                    Decision note
                  </FieldLabel>
                  <Textarea
                    id="approval-decision-note"
                    value={note}
                    maxLength={500}
                    aria-invalid={Boolean(noteError)}
                    aria-describedby="approval-decision-note-description"
                    onChange={(event) => setNote(event.target.value)}
                    placeholder="Optional for approval; explain what must change when returning the request."
                    disabled={Boolean(busyAction)}
                  />
                  <FieldDescription id="approval-decision-note-description">
                    Approval notes may be empty or at least 5 characters. Requesting
                    changes requires at least 10 characters. {note.length}/500.
                  </FieldDescription>
                  <FieldError>{noteError}</FieldError>
                </Field>
              </>
            ) : null}

            {reviewRequest &&
            isChangeApprovalRequestReadyToApply(reviewRequest) &&
            !mayApply ? (
              <>
                <Separator className="my-5" />
                <Alert>
                  <ShieldCheck />
                  <AlertTitle>Account write access required</AlertTitle>
                  <AlertDescription>
                    An agency owner or admin with management access to this
                    advertiser account must apply the approved packet.
                  </AlertDescription>
                </Alert>
              </>
            ) : null}
          </div>

          <DialogFooter className="border-t bg-background px-5 py-4 sm:px-6">
            <Button
              type="button"
              variant="outline"
              onClick={closeReview}
              disabled={Boolean(busyAction)}
              className="min-h-11"
            >
              Close
            </Button>
            {mayCancel ? (
              <Button
                type="button"
                variant="outline"
                onClick={cancel}
                disabled={Boolean(busyAction)}
                aria-busy={busyAction === "cancel"}
                className="min-h-11"
              >
                {busyAction === "cancel" ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <X data-icon="inline-start" />
                )}
                Cancel request
              </Button>
            ) : null}
            {mayDecide ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => decide("request_changes")}
                  disabled={Boolean(busyAction) || !changesNoteValid}
                  aria-busy={busyAction === "request_changes"}
                  className="min-h-11"
                >
                  {busyAction === "request_changes" ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Clock3 data-icon="inline-start" />
                  )}
                  Return with feedback
                </Button>
                <Button
                  type="button"
                  onClick={() => decide("approve")}
                  disabled={Boolean(busyAction) || !approveNoteValid}
                  aria-busy={busyAction === "approve"}
                  className="min-h-11"
                >
                  {busyAction === "approve" ? (
                    <Loader2 data-icon="inline-start" className="animate-spin" />
                  ) : (
                    <Check data-icon="inline-start" />
                  )}
                  {reviewRequest?.source === "live"
                    ? "Approve exact live change"
                    : "Approve simulator review"}
                </Button>
              </>
            ) : null}
            {mayApply ? (
              <Button
                type="button"
                onClick={applyApprovedChange}
                disabled={Boolean(busyAction)}
                aria-busy={busyAction === "apply"}
                className="min-h-11"
              >
                {busyAction === "apply" ? (
                  <Loader2 data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Play data-icon="inline-start" />
                )}
                Apply approved change
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
