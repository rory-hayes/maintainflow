import { describe, expect, it } from "vitest";

import { buildApprovalNotificationEmail } from "./notification-email";

describe("approval notification email", () => {
  it("uses fixed privacy-safe content and includes the authenticated deep link", () => {
    const email = buildApprovalNotificationEmail({
      eventType: "review_requested",
      deepLink:
        "https://maintainflow.io/approvals/open/00000000-0000-4000-8000-000000000101",
    });

    expect(email.subject).toBe("Approval review requested in MaintainFlow");
    expect(email.text).toContain("immutable change packet");
    expect(email.text).toContain("client, campaign, payload, evidence and note");
    expect(email.html).toContain("https://maintainflow.io/approvals/open/");
    expect(email.html).not.toContain("account_id");
  });

  it("escapes an unexpected link before placing it in HTML", () => {
    const email = buildApprovalNotificationEmail({
      eventType: "approval_approved",
      deepLink: 'https://maintainflow.io/path?x="<&',
    });

    expect(email.html).toContain("&quot;&lt;&amp;");
    expect(email.html).not.toContain('href="https://maintainflow.io/path?x="');
  });
});
