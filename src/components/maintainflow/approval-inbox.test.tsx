import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DomUtils, parseDocument } from "htmlparser2";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/components/ui/dialog", async () => {
  const React = await import("react");
  type DialogRootProps = {
    children?: ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  };
  type DialogContentProps = HTMLAttributes<HTMLDivElement> & {
    onOpenAutoFocus?: (event: Event) => void;
    onCloseAutoFocus?: (event: Event) => void;
  };
  const DialogContent = React.forwardRef<HTMLDivElement, DialogContentProps>(
    (
      {
        children,
        onOpenAutoFocus: _onOpenAutoFocus,
        onCloseAutoFocus: _onCloseAutoFocus,
        ...props
      },
      ref,
    ) => {
      void _onOpenAutoFocus;
      void _onCloseAutoFocus;
      return React.createElement(
        "div",
        { ...props, ref, role: "dialog" },
        children,
      );
    },
  );
  DialogContent.displayName = "TestDialogContent";
  const DialogTitle = React.forwardRef<
    HTMLHeadingElement,
    HTMLAttributes<HTMLHeadingElement>
  >(({ children, ...props }, ref) =>
    React.createElement("h2", { ...props, ref }, children),
  );
  DialogTitle.displayName = "TestDialogTitle";
  return {
    Dialog: ({ children, open }: DialogRootProps) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    DialogContent,
    DialogDescription: ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) =>
      React.createElement("p", props, children),
    DialogFooter: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) =>
      React.createElement("div", props, children),
    DialogHeader: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) =>
      React.createElement("div", props, children),
    DialogTitle,
  };
});

vi.mock("@/components/ui/tabs", async () => {
  const React = await import("react");
  const TabsValue = React.createContext<string | undefined>(undefined);
  type TabsProps = HTMLAttributes<HTMLDivElement> & {
    value?: string;
    onValueChange?: (value: string) => void;
  };
  type TabsTriggerProps = Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "value"
  > & { value: string };
  type TabsContentProps = HTMLAttributes<HTMLDivElement> & {
    value: string;
    forceMount?: boolean;
  };
  return {
    Tabs: ({
      children,
      value,
      onValueChange: _onValueChange,
      ...props
    }: TabsProps) => {
      void _onValueChange;
      return React.createElement(
        TabsValue.Provider,
        { value },
        React.createElement(
          "div",
          { ...props, "data-active-filter": value },
          children,
        ),
      );
    },
    TabsList: ({ children, ...props }: HTMLAttributes<HTMLDivElement>) =>
      React.createElement("div", { ...props, role: "tablist" }, children),
    TabsTrigger: ({ children, value, ...props }: TabsTriggerProps) => {
      const activeValue = React.useContext(TabsValue);
      return React.createElement(
        "button",
        {
          ...props,
          type: "button",
          role: "tab",
          "data-filter-value": value,
          "aria-selected": activeValue === value,
        },
        children,
      );
    },
    TabsContent: ({
      children,
      value,
      forceMount: _forceMount,
      ...props
    }: TabsContentProps) => {
      const activeValue = React.useContext(TabsValue);
      void _forceMount;
      return React.createElement(
        "div",
        {
          ...props,
          role: "tabpanel",
          "data-filter-panel": value,
          "data-state": activeValue === value ? "active" : "inactive",
          hidden: activeValue !== value,
        },
        children,
      );
    },
  };
});

import type { ChangeApprovalRequestDto } from "@/lib/approvals/change-request-schema";
import {
  ApprovalInbox,
  ApprovalRequestReviewDetails,
  approvalInboxFilterForRequest,
  buildAgencyApprovalApplyBody,
  canCurrentOperatorApplyRequest,
  canCurrentOperatorCancelRequest,
  canCurrentOperatorDecideRequest,
  changeApprovalStatusLabel,
  findApprovalRequestById,
  groupChangeApprovalRequests,
  isApprovalDecisionNoteValid,
  parseApprovalInboxFilter,
} from "./approval-inbox";

const requesterId = "user_requester";
const approverId = "user_approver";
const farFuture = "2099-09-10T12:00:00.000Z";

function request(
  overrides: Partial<ChangeApprovalRequestDto> = {},
): ChangeApprovalRequestDto {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    organizationId: "00000000-0000-4000-8000-000000000102",
    organizationName: "Northstar Agency",
    advertiserAccountId: null,
    accountId: "adacct_sim_northstar",
    accountName: "Harbour Home",
    source: "simulator",
    recommendationId: "rec_bid_20",
    recommendationTitle: "Reduce an inefficient CPA bid",
    entityId: "adgrp_301",
    recommendationFingerprint: "a".repeat(64),
    decisionContext: {
      schemaVersion: 2,
      priority: "high",
      summary: "The current bid is above the guarded simulator target.",
      rationale:
        "The observed CPA remains above target after incomplete conversions are excluded.",
      entityLabel: "Harbour Home · Purchase group",
      currentValue: "EUR 300",
      proposedValue: "EUR 240",
      estimatedImpact: "Lower inefficient acquisition spend",
      confidence: 88,
      nextStep: "Re-check a fresh provider snapshot before execution.",
      monitoringPlan: null,
    },
    mutation: {
      method: "POST",
      path: "/ad_groups/adgrp_301",
      body: { bidding_config: { max_bid_micros: 240_000_000 } },
    },
    rollback: {
      method: "POST",
      path: "/ad_groups/adgrp_301",
      body: { bidding_config: { max_bid_micros: 300_000_000 } },
    },
    evidence: [
      {
        label: "CPA",
        value: "EUR 84",
        detail: "Confirmed simulator fixture",
      },
    ],
    safeguard: "Review rollback if conversions fall more than 15%.",
    requesterOperatorId: requesterId,
    requesterName: "Alex Analyst",
    requesterMembershipRole: "analyst",
    requestNote: "Please review this guarded bid reduction.",
    status: "awaiting_approval",
    decisionOperatorId: null,
    decisionName: null,
    decisionMembershipRole: null,
    decisionNote: null,
    requestedAt: "2026-09-03T09:00:00.000Z",
    decidedAt: null,
    expiresAt: farFuture,
    version: 1,
    createdAt: "2026-09-03T09:00:00.000Z",
    updatedAt: "2026-09-03T09:00:00.000Z",
    adsApprovalRecordId: null,
    retiredAt: null,
    ...overrides,
  };
}

describe("approval inbox", () => {
  it("accepts only known approval filters", () => {
    expect(parseApprovalInboxFilter("requested-by-me")).toBe(
      "requested-by-me",
    );
    expect(parseApprovalInboxFilter("ready-to-apply")).toBe(
      "ready-to-apply",
    );
    expect(parseApprovalInboxFilter("unknown")).toBeNull();
    expect(parseApprovalInboxFilter(["history"])).toBeNull();
  });

  it("resolves only the exact request selected by a safe deep link", () => {
    const first = request();
    const second = request({
      id: "00000000-0000-4000-8000-000000000202",
    });

    expect(findApprovalRequestById([first, second], second.id)).toBe(second);
    expect(
      findApprovalRequestById(
        [first, second],
        "00000000-0000-4000-8000-000000000999",
      ),
    ).toBeNull();
    expect(findApprovalRequestById([first], undefined)).toBeNull();
  });

  it("opens the exact deep-linked request in the tab for its current state", () => {
    const other = request({
      id: "00000000-0000-4000-8000-000000000201",
      recommendationTitle: "Other queued change",
    });
    const consumed = request({
      id: "00000000-0000-4000-8000-000000000202",
      source: "live",
      advertiserAccountId: "00000000-0000-4000-8000-000000000203",
      accountId: "adacct_live",
      recommendationTitle: "Exact consumed change",
      status: "approved",
      version: 3,
      adsApprovalRecordId: "00000000-0000-4000-8000-000000000204",
    });

    expect(approvalInboxFilterForRequest(consumed, requesterId)).toBe(
      "history",
    );
    const document = parseDocument(
      renderToStaticMarkup(
        <ApprovalInbox
          requests={[other, consumed]}
          currentOperatorId={requesterId}
          canDecide
          initialFilter="ready-to-apply"
          initialRequestId={consumed.id}
        />,
      ),
    );
    const tabs = DomUtils.findOne(
      (element) => element.attribs["data-active-filter"] === "history",
      document.children,
    );
    const activeTab = tabs
      ? DomUtils.findOne(
          (element) =>
            element.name === "button" &&
            element.attribs["aria-selected"] === "true",
          tabs.children,
        )
      : null;
    const dialog = DomUtils.findOne(
      (element) => element.attribs.role === "dialog",
      document.children,
    );

    expect(tabs).not.toBeNull();
    expect(activeTab?.attribs["data-filter-value"]).toBe("history");
    expect(dialog).not.toBeNull();
    expect(DomUtils.textContent(dialog!)).toContain("Exact consumed change");
    expect(DomUtils.textContent(dialog!)).not.toContain("Other queued change");
  });

  it("keeps every simulator request inside the explicit no-write boundary", () => {
    const item = request();
    const inbox = renderToStaticMarkup(
      <ApprovalInbox
        requests={[item]}
        currentOperatorId={approverId}
        canDecide
      />,
    );
    const review = renderToStaticMarkup(
      <ApprovalRequestReviewDetails request={item} />,
    );

    expect(inbox).toContain(
      "Simulator evidence · approved only · no external write.",
    );
    expect(inbox).not.toContain("You requested this change");
    expect(inbox).toContain("Expires");
    expect(review).toContain(
      "Simulator evidence · approved only · no external write.",
    );
    expect(review).toContain("Alex Analyst");
    expect(review).toContain("Northstar Agency");
    expect(review).toContain("POST /ad_groups/adgrp_301");
    expect(review).toContain("240000000");
    expect(review).toContain("300000000");
    expect(review).toContain("EUR 300");
    expect(review).toContain("EUR 240");
    expect(review).toContain("88%");
    expect(review).toContain("fresh provider snapshot");
    expect(review).toContain(item.safeguard);
  });

  it("shows the rationale bound into a version two approval packet", () => {
    const item = request({
      decisionContext: {
        schemaVersion: 2,
        priority: "high",
        summary: "The current bid is above the guarded simulator target.",
        rationale:
          "The observed CPA remains above the target after excluding incomplete conversions.",
        entityLabel: "Harbour Home · Purchase group",
        currentValue: "EUR 300",
        proposedValue: "EUR 240",
        estimatedImpact: "Lower inefficient acquisition spend",
        confidence: 88,
        nextStep: "Re-check a fresh provider snapshot before execution.",
        monitoringPlan: null,
      },
    });

    const review = renderToStaticMarkup(
      <ApprovalRequestReviewDetails request={item} />,
    );

    expect(review).toContain("Rationale");
    expect(review).toContain("excluding incomplete conversions");
  });

  it("labels simulator approval as simulator-only and never as an applied change", () => {
    const approved = request({
      status: "approved",
      decisionOperatorId: approverId,
      decisionName: "Rory Reviewer",
      decisionMembershipRole: "owner",
      decisionNote: "Safe to execute after a fresh provider check.",
      decidedAt: "2026-09-03T10:00:00.000Z",
      version: 2,
    });
    const html = renderToStaticMarkup(
      <ApprovalInbox
        requests={[approved]}
        currentOperatorId={requesterId}
        canDecide
      />,
    );

    expect(changeApprovalStatusLabel(approved)).toBe(
      "Approved · simulator only",
    );
    expect(html).toContain("Approved · simulator only");
    expect(html).toContain("Rory Reviewer");
    expect(html).not.toContain(">Applied<");
    expect(html).not.toContain("change applied");
  });

  it("groups active requests by the current actor and sends terminal rows to history", () => {
    const mine = request({ id: "00000000-0000-4000-8000-000000000111" });
    const theirs = request({
      id: "00000000-0000-4000-8000-000000000112",
      requesterOperatorId: "user_other",
      requesterName: "Morgan Maker",
    });
    const history = request({
      id: "00000000-0000-4000-8000-000000000113",
      status: "changes_requested",
      decisionOperatorId: approverId,
      decisionName: "Rory Reviewer",
      decisionMembershipRole: "admin",
      decisionNote: "Add the missing client safeguard before resubmitting.",
      decidedAt: "2026-09-03T11:00:00.000Z",
    });

    const groups = groupChangeApprovalRequests(
      [history, theirs, mine],
      requesterId,
      new Date("2026-09-03T12:00:00.000Z"),
    );

    expect(groups.requestedByMe.map((item) => item.id)).toEqual([mine.id]);
    expect(groups.needsDecision.map((item) => item.id)).toEqual([theirs.id]);
    expect(groups.readyToApply).toEqual([]);
    expect(groups.history.map((item) => item.id)).toEqual([history.id]);
  });

  it("separates executable live approvals from simulator, consumed, and expired history", () => {
    const ready = request({
      id: "00000000-0000-4000-8000-000000000121",
      source: "live",
      advertiserAccountId: "00000000-0000-4000-8000-000000000122",
      accountId: "adacct_live",
      status: "approved",
      decisionOperatorId: approverId,
      decisionName: "Rory Reviewer",
      decisionMembershipRole: "owner",
      decidedAt: "2026-09-03T10:00:00.000Z",
      version: 2,
    });
    const simulator = request({
      id: "00000000-0000-4000-8000-000000000123",
      status: "approved",
    });
    const consumed = request({
      ...ready,
      id: "00000000-0000-4000-8000-000000000124",
      adsApprovalRecordId: "00000000-0000-4000-8000-000000000125",
    });
    const expired = request({
      ...ready,
      id: "00000000-0000-4000-8000-000000000126",
      expiresAt: "2026-09-03T11:00:00.000Z",
    });
    const legacy = request({
      ...ready,
      id: "00000000-0000-4000-8000-000000000127",
      decisionContext: {
        schemaVersion: 1,
        priority: "high",
        summary: "The current bid is above the guarded simulator target.",
        entityLabel: "Harbour Home · Purchase group",
        currentValue: "EUR 300",
        proposedValue: "EUR 240",
        estimatedImpact: "Lower inefficient acquisition spend",
        confidence: 88,
        nextStep: "Re-check a fresh provider snapshot before execution.",
        monitoringPlan: null,
      },
    });
    const retired = request({
      ...ready,
      id: "00000000-0000-4000-8000-000000000128",
      retiredAt: "2026-09-03T11:30:00.000Z",
    });

    const groups = groupChangeApprovalRequests(
      [simulator, consumed, expired, legacy, retired, ready],
      requesterId,
      new Date("2026-09-03T12:00:00.000Z"),
    );

    expect(groups.readyToApply.map((item) => item.id)).toEqual([ready.id]);
    expect(groups.history).toHaveLength(5);
    expect(groups.history.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        consumed.id,
        expired.id,
        legacy.id,
        retired.id,
        simulator.id,
      ]),
    );
    expect(changeApprovalStatusLabel(ready)).toBe("Ready to apply");
    expect(changeApprovalStatusLabel(consumed)).toBe(
      "Sent to execution ledger",
    );
    expect(
      changeApprovalStatusLabel(
        expired,
        new Date("2026-09-03T12:00:00.000Z"),
      ),
    ).toBe("Approval expired");
    expect(changeApprovalStatusLabel(legacy)).toBe("Fresh review required");
    expect(changeApprovalStatusLabel(retired)).toBe("Fresh review required");
  });

  it("only enables live application with current writable account access and builds the exact contract", () => {
    const ready = request({
      source: "live",
      accountId: "adacct_live",
      status: "approved",
      version: 4,
    });
    const now = new Date("2026-09-03T12:00:00.000Z");

    expect(
      canCurrentOperatorApplyRequest(ready, requesterId, true, now),
    ).toBe(true);
    expect(canCurrentOperatorApplyRequest(ready, null, true, now)).toBe(false);
    expect(
      canCurrentOperatorApplyRequest(ready, requesterId, false, now),
    ).toBe(false);
    expect(
      buildAgencyApprovalApplyBody(ready),
    ).toEqual({
      authorization: "agency_request",
      approvalRequestId: ready.id,
      approvalRequestVersion: 4,
    });
  });

  it("shows live ready work as an explicit apply queue", () => {
    const ready = request({
      source: "live",
      accountId: "adacct_live",
      status: "approved",
      version: 2,
    });
    const html = renderToStaticMarkup(
      <ApprovalInbox
        requests={[ready]}
        currentOperatorId={requesterId}
        canDecide
        writableAccountIds={["adacct_live"]}
        initialFilter="ready-to-apply"
      />,
    );

    expect(html).toContain("Ready to apply");
    expect(html).toContain("Live Ads");
    expect(html).toContain("Review and apply");
    expect(html).not.toContain(
      "Simulator evidence · approved only · no external write.",
    );
  });

  it("enforces maker-checker and cancellation action eligibility", () => {
    const item = request();
    const now = new Date("2026-09-03T12:00:00.000Z");

    expect(
      canCurrentOperatorDecideRequest(item, approverId, true, now),
    ).toBe(true);
    expect(
      canCurrentOperatorDecideRequest(item, requesterId, true, now),
    ).toBe(false);
    expect(
      canCurrentOperatorDecideRequest(item, approverId, false, now),
    ).toBe(false);
    expect(
      canCurrentOperatorCancelRequest(item, requesterId, false, now),
    ).toBe(true);
    expect(
      canCurrentOperatorCancelRequest(item, approverId, true, now),
    ).toBe(true);
    expect(
      canCurrentOperatorCancelRequest(item, approverId, false, now),
    ).toBe(false);
    expect(
      canCurrentOperatorDecideRequest(
        request({ status: "approved" }),
        approverId,
        true,
        now,
      ),
    ).toBe(false);
  });

  it("allows an empty approval note but validates both non-empty decision notes", () => {
    expect(isApprovalDecisionNoteValid("approve", "")).toBe(true);
    expect(isApprovalDecisionNoteValid("approve", "okay")).toBe(false);
    expect(isApprovalDecisionNoteValid("approve", "Looks safe")).toBe(true);
    expect(isApprovalDecisionNoteValid("request_changes", "Too short")).toBe(
      false,
    );
    expect(
      isApprovalDecisionNoteValid(
        "request_changes",
        "Add a safer rollback threshold.",
      ),
    ).toBe(true);
  });

  it("shows unresolved work without telling an analyst it needs their decision", () => {
    const html = renderToStaticMarkup(
      <ApprovalInbox
        requests={[request({ requesterOperatorId: "user_other" })]}
        currentOperatorId={requesterId}
        canDecide={false}
      />,
    );

    expect(html).toContain("Needs review");
    expect(html).toContain("Review details");
    expect(html).not.toContain("Needs your decision");
    expect(html).not.toContain("Review and decide");
  });

  it("does not tell a sole admin they cannot decide another member's packet", () => {
    const html = renderToStaticMarkup(
      <ApprovalInbox
        requests={[request({ requesterOperatorId: "user_analyst" })]}
        currentOperatorId={approverId}
        canDecide
        selectedOrganizationId="00000000-0000-4000-8000-000000000102"
        eligibleReviewerCount={0}
      />,
    );

    expect(html).toContain("Needs review");
    expect(html).not.toContain("No other reviewer for requests you created");
  });

  it("warns when the current operator's queued packet has no other reviewer", () => {
    const html = renderToStaticMarkup(
      <ApprovalInbox
        requests={[request()]}
        currentOperatorId={requesterId}
        canDecide
        selectedOrganizationId="00000000-0000-4000-8000-000000000102"
        eligibleReviewerCount={0}
      />,
    );

    expect(html).toContain("No other reviewer for requests you created");
    expect(html).toContain("You may still decide requests created by other members");
  });
});
