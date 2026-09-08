import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyWorkspace, type Workspace } from "./model";
import { sampleWorkspace } from "./sample";
const fixture = vi.hoisted(() => ({
  read: vi.fn(),
  mutate: vi.fn(),
  authorize: vi.fn(),
  memberships: vi.fn(),
  user: vi.fn(),
  recipient: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./store.server", () => ({
  readWorkspace: fixture.read,
  mutateWorkspace: fixture.mutate,
  authorize: fixture.authorize,
  sameOrigin: (request: Request) => {
    if (request.headers.get("origin") !== new URL(request.url).origin)
      throw new Error("origin");
  },
  AttributionError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("./membership.server", () => ({
  listOrganizationMemberships: fixture.memberships,
}));
vi.mock("./notification-recipient.server", () => ({
  currentNotificationRecipient: fixture.recipient,
}));
vi.mock("@/lib/auth/supabase-config", () => ({
  isSupabaseConfigured: () => true,
}));
vi.mock("@/lib/auth/supabase.server", () => ({
  verifiedSupabaseUser: fixture.user,
}));
import {
  deliverWorkspaceNotifications,
  notificationIdentity,
  notificationStatus,
  NOTIFICATION_LIMITS,
  saveNotificationPreferences,
  sendReportEmail,
  summaryText,
  unsubscribeNotifications,
} from "./notifications.server";
import {
  GET,
  POST,
} from "@/app/api/attribution/workspaces/[id]/notifications/route";
import {
  GET as unsubscribeGET,
  POST as unsubscribePOST,
} from "@/app/notifications/unsubscribe/route";

const id = "00000000-0000-4000-8000-000000000001";
const user = {
  id: "verified-user",
  email: "verified@example.test",
  canEnable: true,
};
let state: Workspace;
let now: number;
const context = { params: Promise.resolve({ id }) };
const request = (body: object) =>
  new Request(
    `https://maintainflow.io/api/attribution/workspaces/${id}/notifications`,
    {
      method: "POST",
      headers: {
        origin: "https://maintainflow.io",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
const run = (
  send = vi.fn().mockResolvedValue(undefined),
  signal = new AbortController().signal,
) =>
  deliverWorkspaceNotifications(id, signal, {
    send,
    now: () => now,
    pause: async () => {},
  });
const optIn = (preferences = { health: true, weekly: false }) =>
  saveNotificationPreferences(id, user, preferences);
function issue() {
  state.connectors = [
    {
      provider: "hubspot",
      accountId: "private-account",
      status: "error",
      error: "private-token",
    },
  ];
}
beforeEach(() => {
  vi.clearAllMocks();
  now = Date.now();
  state = emptyWorkspace(id, "private-name https://private.example/customer");
  fixture.read.mockImplementation(async () => structuredClone(state));
  fixture.mutate.mockImplementation(
    async (_id: string, update: (w: Workspace) => unknown) => update(state),
  );
  fixture.authorize.mockResolvedValue({ membershipRole: "owner" });
  fixture.memberships.mockResolvedValue([
    { organizationId: id, membershipRole: "owner" },
  ]);
  fixture.user.mockResolvedValue({
    ...user,
    email_confirmed_at: new Date(now).toISOString(),
  });
  fixture.recipient.mockResolvedValue(true);
  vi.stubEnv("MAINTAINCODE_REPORT_EMAILS_ENABLED", "true");
  vi.stubEnv("RESEND_API_KEY", "re_test_not_a_real_key");
  vi.stubEnv("MAINTAINCODE_REPORT_FROM", "reports@maintainflow.io");
  vi.stubEnv("MAINTAINCODE_APP_ORIGIN", "https://maintainflow.io");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("verified opt-in boundary", () => {
  it("defaults off for old workspaces and never sends without opt-in", async () => {
    expect(notificationStatus(state, user)).toMatchObject({
      health: false,
      weekly: false,
      status: "off",
    });
    const send = vi.fn();
    await run(send);
    expect(send).not.toHaveBeenCalled();
  });
  it("requires both workspace permission and an authoritative verified email", async () => {
    fixture.authorize.mockRejectedValueOnce(new Error("denied"));
    await expect(notificationIdentity(request({}), id, true)).rejects.toThrow(
      "denied",
    );
    fixture.user.mockResolvedValueOnce({ ...user, email_confirmed_at: null });
    await expect(notificationIdentity(request({}), id, true)).rejects.toThrow(
      "Confirm",
    );
    fixture.memberships.mockResolvedValueOnce([
      { organizationId: "another-workspace", membershipRole: "owner" },
    ]);
    await expect(notificationIdentity(request({}), id, true)).rejects.toThrow(
      "permission",
    );
  });
  it("forbids analyst opt-in but permits stopping their own reports", async () => {
    fixture.memberships.mockResolvedValue([
      { organizationId: id, membershipRole: "analyst" },
    ]);
    expect(
      (await POST(request({ health: true, weekly: false }), context)).status,
    ).toBe(403);
    expect(
      (await POST(request({ health: false, weekly: false }), context)).status,
    ).toBe(200);
  });
  it("rejects arbitrary recipients, extra fields and cross-origin preference writes", async () => {
    expect(
      (
        await POST(
          request({ health: true, weekly: true, email: "other@example.test" }),
          context,
        )
      ).status,
    ).toBe(400);
    const cross = new Request(
      `https://maintainflow.io/api/attribution/workspaces/${id}/notifications`,
      {
        method: "POST",
        headers: { origin: "https://elsewhere.test" },
        body: "{}",
      },
    );
    expect((await POST(cross, context)).ok).toBe(false);
    expect(fixture.mutate).not.toHaveBeenCalled();
  });
  it("saves only the current verified recipient and makes duplicate saves stable", async () => {
    expect(
      (await POST(request({ health: true, weekly: true }), context)).status,
    ).toBe(200);
    const token = state.notifications![0].unsubscribeToken;
    await POST(request({ health: true, weekly: true }), context);
    expect(state.notifications).toHaveLength(1);
    expect(state.notifications![0].email).toBe(user.email);
    expect(state.notifications![0].unsubscribeToken).toBe(token);
  });
  it("allows opt-out when mail configuration disappears", async () => {
    await optIn();
    vi.stubEnv("RESEND_API_KEY", "");
    await expect(optIn({ health: true, weekly: true })).rejects.toThrow(
      "not configured",
    );
    await optIn({ health: false, weekly: false });
    expect(state.notifications).toEqual([]);
  });
  it("returns only the current user's preference status, never private delivery metadata", async () => {
    await optIn();
    issue();
    const send = vi.fn().mockRejectedValue(new Error("provider-secret"));
    await run(send);
    const result = await GET(request({}), context);
    const text = await result.text();
    expect(text).toContain(user.email);
    for (const forbidden of [
      "unsubscribeToken",
      "payload",
      "leaseToken",
      "provider-secret",
      "private-token",
      "firstAttemptAt",
    ])
      expect(text).not.toContain(forbidden);
    expect(result.headers.get("Cache-Control")).toContain("no-store");
  });
});
describe("durable bounded notification delivery", () => {
  it("counts only confirmed production submissions and never includes their private evidence", async () => {
    const example = sampleWorkspace().submissions[0];
    const submission = {
      ...example,
      at: new Date(now - 1000).toISOString(),
      test: false,
      status: "confirmed" as const,
      contactId: "private-crm-id",
    };
    submission.evidence.first.landing =
      "https://secret.example/customer?token=private";
    submission.evidence.first.oppref = "private-click-reference";
    state.submissions = [
      submission,
      { ...submission, id: "duplicate-contact" },
      { ...submission, id: "diagnostic", test: true },
      { ...submission, id: "attempt", status: "attempted" },
      {
        ...submission,
        id: "old",
        at: new Date(now - 8 * 86400000).toISOString(),
      },
    ];
    state.contacts = [
      {
        id: "private-crm-id",
        stage: state.qualifiedStages[0],
        submissions: [],
        updatedAt: new Date(now).toISOString(),
      },
    ];
    const summary = summaryText(state, now);
    expect(summary).toContain("Confirmed production submissions: 2");
    expect(summary).toContain(
      "Distinct matched contacts from these submissions: 1",
    );
    expect(summary).toContain(
      "Currently qualified contacts among these matched contacts: 1",
    );
    for (const value of [
      "private-crm-id",
      "secret.example",
      "private-click-reference",
    ])
      expect(summary).not.toContain(value);
  });
  it("sends only changed health categories and sends a recovery once", async () => {
    await optIn();
    issue();
    const send = vi.fn().mockResolvedValue(undefined);
    await run(send);
    await run(send);
    expect(send).toHaveBeenCalledTimes(1);
    state.connectors[0] = {
      ...state.connectors[0],
      status: "connected",
      syncedAt: new Date(now).toISOString(),
    };
    await run(send);
    await run(send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].text).toContain("have cleared");
  });
  it("waits seven days for a weekly summary and does not duplicate it", async () => {
    await optIn({ health: false, weekly: true });
    const send = vi.fn().mockResolvedValue(undefined);
    await run(send);
    expect(send).not.toHaveBeenCalled();
    now = state.notifications![0].weeklyDueAt;
    await run(send);
    await run(send);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.notifications![0].weeklyDueAt).toBe(now + 7 * 86400000);
  });
  it("freezes payload and idempotency key across a failed send and safe retry", async () => {
    await optIn();
    issue();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret provider failure"))
      .mockResolvedValue(undefined);
    const first = await run(send);
    expect(first.status).toBe("complete");
    state.name = "Changed name";
    now += 60001;
    await run(send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0].slice(0, 2)).toEqual(
      send.mock.calls[1].slice(0, 2),
    );
    expect(notificationStatus(state, user).acceptedAt).toBeTruthy();
  });
  it("does not resend ambiguous jobs beyond provider idempotency retention", async () => {
    await optIn();
    issue();
    const send = vi.fn().mockRejectedValue(new Error("timeout"));
    await run(send);
    now += NOTIFICATION_LIMITS.retryWindowMs + 1;
    await run(send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(notificationStatus(state, user).status).toBe("needs_review");
    await saveNotificationPreferences(
      id,
      user,
      { health: true, weekly: false },
      true,
    );
    await run(send);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("preserves an ambiguous health envelope when an unrelated preference changes", async () => {
    await optIn();
    issue();
    const send = vi.fn().mockRejectedValue(new Error("timeout"));
    await run(send);
    const pending = structuredClone(state.notifications![0].pending);
    await optIn({ health: true, weekly: true });
    expect(state.notifications![0].pending).toEqual(pending);
    send.mockResolvedValue(undefined);
    await run(send);
    expect(send.mock.calls[2].slice(0, 2)).toEqual(
      send.mock.calls[0].slice(0, 2),
    );
  });
  it("consumes the pending category when that preference is disabled", async () => {
    await optIn({ health: true, weekly: true });
    issue();
    await run(vi.fn().mockRejectedValue(new Error("timeout")));
    const fingerprint = state.notifications![0].pending!.fingerprint;
    await optIn({ health: false, weekly: true });
    expect(state.notifications![0].pending).toBeUndefined();
    expect(state.notifications![0].healthFingerprint).toBe(fingerprint);
  });
  it("backs off and retries during the same bounded maintenance run", async () => {
    await optIn();
    issue();
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(undefined);
    const pause = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      now += 500;
    });
    const result = await deliverWorkspaceNotifications(
      id,
      new AbortController().signal,
      { send, pause, now: () => now },
    );
    expect(pause).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("complete");
  });
  it("uses a lease to prevent concurrent sends of the same job", async () => {
    await optIn();
    issue();
    let release!: () => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = run(send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await run(send);
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await first;
  });
  it("does not restore a subscription opted out while a send is in flight", async () => {
    await optIn();
    issue();
    const send = vi.fn(async () => {
      await optIn({ health: false, weekly: false });
    });
    await run(send);
    expect(state.notifications).toEqual([]);
  });
  it("removes subscriptions whose workspace access has been revoked", async () => {
    await optIn();
    issue();
    fixture.recipient.mockResolvedValue(false);
    const send = vi.fn();
    await run(send);
    expect(send).not.toHaveBeenCalled();
    expect(state.notifications).toEqual([]);
  });
  it("does not send when authoritative current-recipient verification is unavailable", async () => {
    await optIn();
    issue();
    fixture.recipient.mockRejectedValue(new Error("validator unavailable"));
    const send = vi.fn();
    await expect(run(send)).rejects.toThrow("validator unavailable");
    expect(send).not.toHaveBeenCalled();
    expect(state.notifications).toHaveLength(1);
  });
  it("does not remove newer consent after a stale recipient check", async () => {
    await optIn();
    issue();
    fixture.recipient.mockImplementationOnce(async () => {
      await saveNotificationPreferences(
        id,
        user,
        { health: true, weekly: false },
        true,
      );
      return false;
    });
    await run(vi.fn());
    expect(state.notifications).toHaveLength(1);
  });
  it("does not reserve a send when recipient validation exhausts the budget", async () => {
    await optIn();
    issue();
    const send = vi.fn();
    fixture.recipient.mockImplementationOnce(async () => {
      now += NOTIFICATION_LIMITS.budgetMs;
      return true;
    });
    expect((await run(send)).status).toBe("deferred");
    expect(send).not.toHaveBeenCalled();
    expect(state.notifications![0].pending).toBeUndefined();
  });
  it("obeys cancellation and the per-run send limit", async () => {
    for (let i = 0; i < 4; i++)
      await saveNotificationPreferences(
        id,
        { id: `user-${i}`, email: `verified-${i}@example.test` },
        { health: true, weekly: false },
      );
    issue();
    const send = vi.fn().mockResolvedValue(undefined);
    await run(send, AbortSignal.abort());
    expect(send).not.toHaveBeenCalled();
    await run(send);
    expect(send).toHaveBeenCalledTimes(NOTIFICATION_LIMITS.sendsPerRun);
  });
  it("stops before starting another send when the active budget is spent", async () => {
    await optIn({ health: true, weekly: true });
    issue();
    state.notifications![0].weeklyDueAt = now;
    const send = vi.fn(async () => {
      now += NOTIFICATION_LIMITS.budgetMs;
    });
    expect((await run(send)).status).toBe("deferred");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("excludes customer content and raw evidence from generated messages", async () => {
    await optIn({ health: true, weekly: true });
    issue();
    state.notifications![0].weeklyDueAt = now;
    const send = vi.fn().mockResolvedValue(undefined);
    await run(send);
    for (const call of send.mock.calls) {
      expect(call[0].text).toContain(`workspace=${id}`);
      for (const value of [
        state.name,
        "private-account",
        "private-token",
        "https://private.example",
        "oppref",
      ])
        expect(call[0].text).not.toContain(value);
    }
    expect(summaryText(state, now)).toContain(
      "Confirmed production submissions: 0",
    );
  });
  it("uses fixed Resend transport, idempotency and a cancellable server request", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(Response.json({ id: "accepted-id" }));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    await sendReportEmail(
      {
        from: "MaintainCode Ads <reports@maintainflow.io>",
        to: user.email,
        subject: "Summary",
        text: "Aggregate",
      },
      "stable-key",
      signal,
    );
    expect(fetch.mock.calls[0][0]).toBe("https://api.resend.com/emails");
    expect(fetch.mock.calls[0][1]).toMatchObject({
      signal,
      cache: "no-store",
      redirect: "error",
      headers: { "Idempotency-Key": "stable-key" },
    });
  });
  it("does not expose the provider response body on a failed request", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("private-provider-detail", { status: 503 }),
        ),
    );
    await expect(
      sendReportEmail(
        {
          from: "reports@maintainflow.io",
          to: user.email,
          subject: "Summary",
          text: "Aggregate",
        },
        "stable",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Email provider did not confirm acceptance.");
  });
});
describe("safe email opt-out", () => {
  it("GET never changes a subscription and POST requires the exact token and origin", async () => {
    await optIn();
    const token = state.notifications![0].unsubscribeToken;
    const page = await unsubscribeGET(
      new Request(
        `https://maintainflow.io/notifications/unsubscribe?workspace=${id}&token=${token}`,
      ),
    );
    expect(await page.text()).toContain('method="post"');
    expect(state.notifications).toHaveLength(1);
    expect(page.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "form-action 'self'",
    );
    await unsubscribeNotifications(id, "0".repeat(64));
    expect(state.notifications).toHaveLength(1);
    const post = (origin?: string) =>
      new Request("https://maintainflow.io/notifications/unsubscribe", {
        method: "POST",
        headers: origin === undefined ? {} : { origin },
        body: new URLSearchParams({ workspace: id, token }).toString(),
      });
    for (const origin of [undefined, "null", "https://elsewhere.test"]) {
      expect((await unsubscribePOST(post(origin))).status).toBe(400);
      expect(state.notifications).toHaveLength(1);
    }
    expect(
      (await unsubscribePOST(post("https://maintainflow.io"))).status,
    ).toBe(200);
    expect(state.notifications).toEqual([]);
  });
  it("redacts all notification data from the workspace/export boundary", async () => {
    await optIn();
    issue();
    await run(vi.fn().mockRejectedValue(new Error("timeout")));
    const { publicWorkspace } =
      await vi.importActual<typeof import("./store.server")>("./store.server");
    const output = JSON.stringify(publicWorkspace(state));
    for (const forbidden of [
      "notifications",
      user.email,
      state.notifications![0].unsubscribeToken,
      "firstAttemptAt",
    ])
      expect(output).not.toContain(forbidden);
  });
});
