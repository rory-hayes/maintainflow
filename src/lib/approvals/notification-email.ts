export type ApprovalNotificationEvent =
  | "review_requested"
  | "approval_approved"
  | "approval_changes_requested"
  | "approval_cancelled";

const copy: Record<
  ApprovalNotificationEvent,
  { subject: string; heading: string; description: string; action: string }
> = {
  review_requested: {
    subject: "Approval review requested in MaintainFlow",
    heading: "A change is waiting for your review",
    description:
      "A teammate submitted an immutable change packet for independent review.",
    action: "Review the change",
  },
  approval_approved: {
    subject: "Your MaintainFlow change was approved",
    heading: "Your change was approved",
    description:
      "An independent reviewer approved the exact packet. Approval alone did not send an external Ads write.",
    action: "Open the approval",
  },
  approval_changes_requested: {
    subject: "Changes were requested in MaintainFlow",
    heading: "Your change needs another pass",
    description:
      "An independent reviewer returned the packet with feedback. Open MaintainFlow to review the decision.",
    action: "Review the feedback",
  },
  approval_cancelled: {
    subject: "Your MaintainFlow approval request was cancelled",
    heading: "Your approval request was cancelled",
    description:
      "An agency owner or admin cancelled the pending packet. No external Ads write was sent.",
    action: "Open the request",
  },
};

function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

export function buildApprovalNotificationEmail(options: {
  eventType: ApprovalNotificationEvent;
  deepLink: string;
}) {
  const content = copy[options.eventType];
  const safeLink = escapeHtml(options.deepLink);
  const text = `${content.heading}\n\n${content.description}\n\n${content.action}: ${options.deepLink}\n\nFor privacy, this email omits client, campaign, payload, evidence and note details. Sign in to MaintainFlow to view the tenant-scoped record.`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f7f7f5;color:#18181b;font-family:Arial,sans-serif"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px"><tr><td style="padding:28px"><p style="margin:0 0 24px;font-size:15px;font-weight:700">MaintainFlow</p><h1 style="margin:0 0 12px;font-size:24px;line-height:1.25">${escapeHtml(content.heading)}</h1><p style="margin:0 0 24px;color:#52525b;font-size:15px;line-height:1.6">${escapeHtml(content.description)}</p><p style="margin:0 0 24px"><a href="${safeLink}" style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 16px;font-size:14px;font-weight:700">${escapeHtml(content.action)}</a></p><p style="margin:0;color:#71717a;font-size:12px;line-height:1.6">For privacy, this email omits client, campaign, payload, evidence and note details. Sign in to view the tenant-scoped record.</p></td></tr></table></td></tr></table></body></html>`;
  return { subject: content.subject, text, html };
}
