import "server-only";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CreateEmailOptions } from "resend";
import { z } from "zod";
import { isSupabaseConfigured } from "@/lib/auth/supabase-config";
import { verifiedSupabaseUser } from "@/lib/auth/supabase.server";
import {
  authorize,
  AttributionError,
  mutateWorkspace,
  readWorkspace,
} from "./store.server";
import { listOrganizationMemberships } from "./membership.server";
import { currentNotificationRecipient } from "./notification-recipient.server";
import type { Workspace } from "./model";
import type {
  NotificationPreferences,
  NotificationStatus,
  NotificationSubscription,
} from "./notifications";

const DAY = 86400000;
export const NOTIFICATION_LIMITS = {
  recipients: 10,
  sendsPerRun: 2,
  budgetMs: 12000,
  requestMs: 5000,
  retryWindowMs: 23 * 3600000,
  attempts: 3,
} as const;
const emailSchema = z.string().email().max(254);
export function reportMailConfig() {
  const origin = process.env.MAINTAINCODE_APP_ORIGIN;
  const from = process.env.MAINTAINCODE_REPORT_FROM;
  if (
    process.env.MAINTAINCODE_REPORT_EMAILS_ENABLED !== "true" ||
    !process.env.RESEND_API_KEY?.startsWith("re_") ||
    !from ||
    !emailSchema.safeParse(from).success ||
    !origin
  )
    return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.origin !== origin) return null;
    return { origin, from: `MaintainCode Ads <${from}>` };
  } catch {
    return null;
  }
}

export async function notificationIdentity(
  request: Request,
  id: string,
  write: boolean,
) {
  await authorize(request, id, write);
  if (!isSupabaseConfigured())
    throw new AttributionError(
      409,
      "Email reports need a verified customer account.",
    );
  const user = await verifiedSupabaseUser();
  if (!user)
    throw new AttributionError(401, "Sign in to manage email reports.");
  if (!user?.email_confirmed_at || !emailSchema.safeParse(user.email).success)
    throw new AttributionError(
      403,
      "Confirm your account email before choosing email reports.",
    );
  // Authorize this authoritative identity directly as well; local-mode fixtures
  // must never lend their membership to a different signed-in account.
  const member = (await listOrganizationMemberships(user.id)).find(
    (m) => m.organizationId === id,
  );
  if (!member || (write && !["owner", "admin"].includes(member.membershipRole)))
    throw new AttributionError(
      403,
      "You do not have permission for this workspace.",
    );
  return {
    id: user.id,
    email: user.email!,
    canEnable: ["owner", "admin"].includes(member.membershipRole),
  };
}
export function notificationStatus(
  w: Workspace,
  user: { id: string; email: string; canEnable: boolean },
): NotificationStatus {
  const saved = w.notifications?.find(
    (s) => s.userId === user.id && s.email === user.email,
  );
  return {
    available: Boolean(reportMailConfig()),
    canEnable: user.canEnable,
    recipient: user.email,
    health: saved?.health ?? false,
    weekly: saved?.weekly ?? false,
    status:
      !saved || (!saved.health && !saved.weekly)
        ? "off"
        : saved.pending?.needsReview
          ? "needs_review"
          : saved.pending
            ? "retrying"
            : "scheduled",
    ...(saved?.acceptedAt ? { acceptedAt: saved.acceptedAt } : {}),
  };
}
export async function saveNotificationPreferences(
  id: string,
  user: { id: string; email: string },
  preferences: NotificationPreferences,
  resume = false,
) {
  preferences = { health: preferences.health, weekly: preferences.weekly };
  if ((preferences.health || preferences.weekly) && !reportMailConfig())
    throw new AttributionError(
      503,
      "Email reports are not configured yet. You can still turn existing reports off.",
    );
  await mutateWorkspace(id, (w) => {
    const old = w.notifications?.find((s) => s.userId === user.id);
    if (
      old &&
      old.email === user.email &&
      old.health === preferences.health &&
      old.weekly === preferences.weekly &&
      !resume
    )
      return;
    const entries = (w.notifications ?? []).filter((s) => s.userId !== user.id);
    if (preferences.health || preferences.weekly) {
      if (entries.length >= NOTIFICATION_LIMITS.recipients)
        throw new AttributionError(
          409,
          "This workspace has reached its email subscriber limit.",
        );
      if (old && old.email === user.email && !resume) {
        const pending = old.pending;
        if (pending && !preferences[pending.kind]) {
          // Consume a disabled pending event, including an uncertain send;
          // changing the other checkbox must not mint a duplicate message.
          if (pending.kind === "health")
            old.healthFingerprint = pending.fingerprint;
          else old.weeklyDueAt = pending.through + 7 * DAY;
          delete old.pending;
        }
        if (preferences.weekly && !old.weekly)
          old.weeklyDueAt = Date.now() + 7 * DAY;
        entries.push({ ...old, ...preferences });
      } else
        entries.push({
          ...preferences,
          userId: user.id,
          email: user.email,
          version: randomUUID(),
          unsubscribeToken: randomBytes(32).toString("hex"),
          weeklyDueAt: Date.now() + 7 * DAY,
          healthFingerprint: resume
            ? healthIssues(w, Date.now())
                .map((i) => i.code)
                .join("|")
            : "",
        });
    }
    w.notifications = entries;
  });
}

export function healthIssues(w: Workspace, now: number) {
  const issues: { code: string; text: string }[] = [];
  if (w.sites.some((s) => !s.paused && !s.installedAt))
    issues.push({
      code: "installation",
      text: "A website has no observed installation. Review its script installation in Websites & forms.",
    });
  if (
    w.submissions.some(
      (s) => s.status === "attempted" && now - Date.parse(s.at) > 3600000,
    )
  )
    issues.push({
      code: "confirmation",
      text: "Some form attempts still lack confirmation. Review successful-submit callbacks in Websites & forms.",
    });
  if (w.submissions.some((s) => s.contactId && !s.crmFieldsVerifiedAt))
    issues.push({
      code: "fields",
      text: "Some matched contacts have unverified attribution fields. Review field diagnostics in Leads.",
    });
  if (
    w.connectors.some(
      (c) =>
        c.status !== "connected" ||
        !c.syncedAt ||
        now - Date.parse(c.syncedAt) > DAY,
    )
  )
    issues.push({
      code: "connector",
      text: "A connector is disconnected, failed or stale. Review its status and reconnect or sync in Integrations.",
    });
  if (w.deals.some((d) => !d.primaryContactId))
    issues.push({
      code: "association",
      text: "Some deals lack a primary attribution contact. Review unresolved associations in Tracking health.",
    });
  return issues;
}

export function summaryText(w: Workspace, through: number) {
  const since = through - 7 * DAY;
  const submissions = w.submissions.filter(
    (s) =>
      !s.test &&
      s.status === "confirmed" &&
      Date.parse(s.at) >= since &&
      Date.parse(s.at) < through,
  );
  const contacts = new Set(submissions.map((s) => s.contactId).filter(Boolean));
  const qualified = w.contacts.filter(
    (c) => contacts.has(c.id) && w.qualifiedStages.includes(c.stage),
  ).length;
  const won = w.deals.filter(
    (d) =>
      w.wonStages.includes(d.stage) &&
      d.closedAt &&
      Date.parse(d.closedAt) >= since &&
      Date.parse(d.closedAt) < through,
  );
  return [
    `Evidence window: ${new Date(since).toISOString()} to ${new Date(through).toISOString()} (end exclusive, UTC).`,
    `Confirmed production submissions: ${submissions.length}.`,
    `Distinct matched contacts from these submissions: ${contacts.size}.`,
    `Currently qualified contacts among these matched contacts: ${qualified}.`,
    `CRM deals currently marked won with a close date in this window: ${won.length}.`,
    "Deal counts use calendar close dates, not acquisition cohorts. CRM snapshots may be incomplete or stale. No collected revenue or incremental impact is inferred.",
  ].join("\n");
}

type Pending = NonNullable<NotificationSubscription["pending"]>;
function prepare(
  w: Workspace,
  s: NotificationSubscription,
  now: number,
  config: NonNullable<ReturnType<typeof reportMailConfig>>,
): Pending | undefined {
  const issues = healthIssues(w, now);
  const fingerprint = issues.map((i) => i.code).join("|");
  const kind =
    s.health && fingerprint !== s.healthFingerprint
      ? "health"
      : s.weekly && now >= s.weeklyDueAt
        ? "weekly"
        : undefined;
  if (!kind) return;
  const report = `${config.origin}/app?mode=live&workspace=${encodeURIComponent(w.id)}&view=${kind === "weekly" ? "Overview" : "Tracking%20health"}`;
  const settings = `${config.origin}/app?mode=live&workspace=${encodeURIComponent(w.id)}&view=Workspace%20%26%20billing`;
  const unsubscribe = `${config.origin}/notifications/unsubscribe?workspace=${encodeURIComponent(w.id)}&token=${s.unsubscribeToken}`;
  const text = [
    "MaintainCode Ads",
    `Workspace: ${w.name
      .replace(/https?:\/\/\S+/gi, "[link omitted]")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 100)
      .trim()}`,
    `Snapshot checked at ${new Date(now).toISOString()}.`,
    kind === "weekly"
      ? "Your weekly workspace summary"
      : issues.length
        ? "Tracking health changed"
        : "Previously reported tracking issues have cleared",
    kind === "weekly"
      ? summaryText(w, now)
      : issues.map((i) => `- ${i.text}`).join("\n"),
    `Open your workspace report: ${report}`,
    `Manage email preferences: ${settings}`,
    `Stop these workspace emails: ${unsubscribe}`,
    "This message contains aggregate information only. Email provider acceptance does not confirm inbox delivery.",
  ].join("\n\n");
  return {
    id: randomUUID(),
    kind,
    fingerprint,
    through: now,
    payload: {
      from: config.from,
      to: s.email,
      subject:
        kind === "weekly"
          ? "MaintainCode Ads: weekly workspace summary"
          : "MaintainCode Ads: tracking health changed",
      text,
    },
    firstAttemptAt: now,
    nextAttemptAt: now,
    attempts: 0,
  };
}

export async function sendReportEmail(
  payload: Pending["payload"],
  key: string,
  signal: AbortSignal,
) {
  const body: CreateEmailOptions = payload;
  // The SDK request options do not expose AbortSignal. Use its payload type with
  // the documented REST endpoint so the maintenance deadline cancels transport.
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
    signal,
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Email provider did not confirm acceptance.");
  }
  const result: unknown = await response.json();
  if (
    !result ||
    typeof result !== "object" ||
    !("id" in result) ||
    typeof result.id !== "string"
  )
    throw new Error("Email provider did not confirm acceptance.");
}

export async function deliverWorkspaceNotifications(
  id: string,
  signal: AbortSignal,
  dependencies: {
    send: typeof sendReportEmail;
    now: () => number;
    pause?: (signal: AbortSignal) => Promise<void>;
  } = { send: sendReportEmail, now: Date.now },
) {
  const config = reportMailConfig();
  if (!config) return { status: "unavailable" as const, accepted: 0 };
  const bounded = AbortSignal.any([
    signal,
    AbortSignal.timeout(NOTIFICATION_LIMITS.budgetMs),
  ]);
  const deadline = dependencies.now() + NOTIFICATION_LIMITS.budgetMs;
  let accepted = 0,
    review = false;
  for (let sent = 0; sent < NOTIFICATION_LIMITS.sendsPerRun; sent++) {
    if (
      bounded.aborted ||
      dependencies.now() + NOTIFICATION_LIMITS.requestMs > deadline
    )
      break;
    const state = await readWorkspace(id);
    const candidates = (state.notifications ?? [])
      .filter((s) => s.health || s.weekly)
      .sort(
        (a, b) =>
          (a.pending?.firstAttemptAt ?? Infinity) -
          (b.pending?.firstAttemptAt ?? Infinity),
      );
    let job:
      | { userId: string; version: string; pending: Pending; lease: string }
      | undefined;
    for (const candidate of candidates) {
      if (
        bounded.aborted ||
        dependencies.now() + NOTIFICATION_LIMITS.requestMs > deadline
      )
        break;
      const validRecipient = await currentNotificationRecipient(
        id,
        candidate.userId,
        candidate.email,
      );
      if (
        bounded.aborted ||
        dependencies.now() + NOTIFICATION_LIMITS.requestMs > deadline
      )
        break;
      if (!validRecipient) {
        await mutateWorkspace(id, (w) => {
          w.notifications = w.notifications?.filter(
            (s) =>
              s.userId !== candidate.userId || s.version !== candidate.version,
          );
        });
        continue;
      }
      job = await mutateWorkspace(id, (w) => {
        const s = w.notifications?.find(
          (s) =>
            s.userId === candidate.userId && s.version === candidate.version,
        );
        if (!s || (!s.health && !s.weekly)) return;
        const now = dependencies.now();
        s.pending ??= prepare(w, s, now, config);
        const p = s.pending;
        if (!p) return;
        if (
          now - p.firstAttemptAt >= NOTIFICATION_LIMITS.retryWindowMs ||
          p.attempts >= NOTIFICATION_LIMITS.attempts
        )
          p.needsReview = true;
        if (p.needsReview) {
          review = true;
          return;
        }
        if (p.nextAttemptAt > now || (p.leaseUntil ?? 0) > now) return;
        const lease = randomUUID();
        p.attempts++;
        p.leaseToken = lease;
        p.leaseUntil = now + 30000;
        return {
          userId: s.userId,
          version: s.version,
          pending: structuredClone(p),
          lease,
        };
      });
      if (job) break;
    }
    if (!job) break;
    let success = false;
    try {
      bounded.throwIfAborted();
      await dependencies.send(
        job.pending.payload,
        `maintaincode-report/${job.pending.id}`,
        AbortSignal.any([
          bounded,
          AbortSignal.timeout(NOTIFICATION_LIMITS.requestMs),
        ]),
      );
      success = true;
      accepted++;
    } catch {
      /* Keep the persisted envelope for a bounded retry. */
    }
    await mutateWorkspace(id, (w) => {
      const s = w.notifications?.find(
        (s) => s.userId === job!.userId && s.version === job!.version,
      );
      const p = s?.pending;
      if (!s || !p || p.id !== job!.pending.id || p.leaseToken !== job!.lease)
        return;
      if (success) {
        s.acceptedAt = new Date(dependencies.now()).toISOString();
        if (p.kind === "weekly") s.weeklyDueAt = p.through + 7 * DAY;
        else s.healthFingerprint = p.fingerprint;
        delete s.pending;
      } else {
        delete p.leaseToken;
        delete p.leaseUntil;
        p.nextAttemptAt = dependencies.now();
      }
    });
    if (
      !success &&
      sent + 1 < NOTIFICATION_LIMITS.sendsPerRun &&
      !bounded.aborted
    ) {
      try {
        await (
          dependencies.pause ?? ((signal) => delay(500, undefined, { signal }))
        )(bounded);
      } catch {
        /* Parent budget cancelled the retry. */
      }
    }
  }
  const remaining = (await readWorkspace(id)).notifications ?? [];
  review ||= remaining.some((s) => s.pending?.needsReview);
  const retrying = remaining.some((s) => s.pending && !s.pending.needsReview);
  return {
    status: review
      ? ("needs_review" as const)
      : retrying
        ? ("retrying" as const)
        : bounded.aborted ||
            dependencies.now() + NOTIFICATION_LIMITS.requestMs > deadline
          ? ("deferred" as const)
          : ("complete" as const),
    accepted,
  };
}

export async function unsubscribeNotifications(id: string, token: string) {
  const state = await readWorkspace(id);
  const matches = (s: NotificationSubscription) => {
    const expected = Buffer.from(s.unsubscribeToken);
    const supplied = Buffer.from(token);
    return (
      expected.length === supplied.length && timingSafeEqual(expected, supplied)
    );
  };
  if (!state.notifications?.some(matches)) return;
  await mutateWorkspace(id, (w) => {
    w.notifications = (w.notifications ?? []).filter((s) => !matches(s));
  });
}
