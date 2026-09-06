import { z } from "zod";
import type { NotificationSubscription } from "./notifications";

export const RULE_VERSION = "2026-09-06.1";
export const channels = [
  "Paid search",
  "Paid social",
  "ChatGPT Ads",
  "Organic search",
  "Organic social",
  "Organic AI",
  "Email",
  "Affiliate",
  "Referral",
  "Direct",
  "Unknown",
] as const;
export const touchSchema = z
  .object({
    at: z.string().datetime(),
    landing: z.string().max(512),
    referrer: z.string().max(255),
    source: z.string().max(160),
    // Preserve the observed tag separately from the source label derived from a referrer.
    sourceTag: z.string().max(160).optional(),
    medium: z.string().max(160),
    campaign: z.string().max(160),
    campaignId: z.string().max(160),
    adId: z.string().max(160),
    oppref: z.string().max(2048),
    channel: z.enum(channels),
    reason: z.string().max(300),
    conflict: z.boolean(),
    rule: z.literal(RULE_VERSION),
  })
  .strict();
export type Touch = z.infer<typeof touchSchema>;
export type Evidence = { first: Touch; latest: Touch; expiresAt: string };
export const evidenceSchema = z
  .object({
    first: touchSchema,
    latest: touchSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();
export type FormMapping = Record<string, string>;
export const defaultMapping: FormMapping = Object.fromEntries(
  [
    "submission_id",
    "first_source",
    "first_medium",
    "first_campaign",
    "latest_source",
    "latest_medium",
    "latest_campaign",
    "landing_page",
    "captured_at",
    "campaign_id",
    "ad_id",
    "oppref",
  ].map((k) => [k, `mc_${k}`]),
);
export type Site = {
  id: string;
  name: string;
  origin: string;
  consent: "required" | "not_required";
  retentionDays: number;
  formSelector: string;
  adapter: "html" | "hubspot_v4";
  mapping: FormMapping;
  installedAt?: string;
  verifiedAt?: string;
  paused: boolean;
};
export type Submission = {
  id: string;
  siteId: string;
  formId: string;
  at: string;
  evidence: Evidence;
  test: boolean;
  status: "attempted" | "confirmed";
  confirmation?: "browser_success" | "crm";
  contactId?: string;
  crmVerifiedAt?: string;
  crmFieldsVerifiedAt?: string;
  crmFieldDiagnostics?: {
    status: "verified" | "not_current" | "missing" | "mismatch";
    missing: string[];
    mismatched: string[];
  };
};
export type Contact = {
  id: string;
  stage: string;
  submissions: string[];
  updatedAt: string;
};
// These values exist only during reconciliation and are not persisted or exported.
export type ContactSnapshot = Contact & {
  currentSubmissions?: string[];
  fieldValues?: Record<string, string | null>;
};
export type Deal = {
  id: string;
  contacts: string[];
  primaryContactId?: string;
  stage: string;
  amount: number | null;
  currency: string;
  closedAt: string | null;
  updatedAt: string;
  history: { at: string; stage: string; amount: number | null }[];
};
export type Cost = {
  id: string;
  source: "csv" | "openai";
  campaignId: string;
  campaign: string;
  channel: string;
  date: string;
  currency: string;
  amount: number;
  impressions?: number;
  clicks?: number;
  providerConversions?: number;
};
export type Connector = {
  provider: "hubspot" | "openai";
  accountId: string;
  status: "connected" | "error" | "revoked";
  operationId?: string;
  syncedAt?: string;
  error?: string;
  timezone?: string;
  coverage?: string;
};
export type Workspace = {
  notifications?: NotificationSubscription[];
  id: string;
  name: string;
  mode: "live" | "local" | "sample";
  timezone: string;
  retentionDays?: number;
  createdAt: string;
  sites: Site[];
  submissions: Submission[];
  contacts: Contact[];
  deals: Deal[];
  costs: Cost[];
  connectors: Connector[];
  qualifiedStages: string[];
  wonStages: string[];
  primaryContactProperty: string;
  submissionProperty: string;
  primarySelections?: Record<string, string>;
  adInventory?: {
    accountId: string;
    campaigns: { id: string; name: string; status: string }[];
    groups: { id: string; name: string; status: string; campaignId: string }[];
    ads: { id: string; name: string; status: string; groupId: string }[];
  };
  billing: {
    plan: "starter" | "agency";
    status: string;
    customerId?: string;
    subscriptionId?: string;
    lastEventAt?: number;
    trialEndsAt: string;
  };
};
export function workspaceRetentionDays(w: Workspace): number {
  return w.retentionDays ?? w.sites[0]?.retentionDays ?? 90;
}
export function emptyWorkspace(
  id: string,
  name: string,
  mode: Workspace["mode"] = "live",
): Workspace {
  const now = new Date();
  return {
    id,
    name,
    mode,
    timezone: "Europe/Dublin",
    retentionDays: 90,
    createdAt: now.toISOString(),
    sites: [],
    submissions: [],
    contacts: [],
    deals: [],
    costs: [],
    connectors: [],
    qualifiedStages: [
      "marketingqualifiedlead",
      "salesqualifiedlead",
      "opportunity",
      "customer",
    ],
    wonStages: ["closedwon"],
    primaryContactProperty: "mc_primary_contact_id",
    submissionProperty: "mc_submission_id",
    billing: {
      plan: "starter",
      status: "trialing",
      trialEndsAt: new Date(+now + 14 * 86400000).toISOString(),
    },
  };
}
const safe = (value: string | null) =>
  (value ?? "").slice(0, 160).replace(/[\u0000-\u001f]/g, "");
const hostIs = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);
export function captureTouch(
  href: string,
  referrer = "",
  now = new Date(),
): Touch {
  const url = new URL(href);
  let ref = "";
  try {
    ref = new URL(referrer).hostname.toLowerCase();
  } catch {
    /* no available referrer */
  }
  if (ref === url.hostname) ref = "";
  const p = url.searchParams;
  const source = safe(p.get("utm_source"));
  const medium = safe(p.get("utm_medium"));
  const s = source.toLowerCase(),
    m = medium.toLowerCase();
  const oppref = p.get("oppref") ?? "";
  const paid = /^(cpc|ppc|paid|paid_social|paid_search|display|paid_ai)$/.test(
    m,
  );
  const ai = [
    "chatgpt.com",
    "chat.openai.com",
    "perplexity.ai",
    "gemini.google.com",
  ].some((d) => hostIs(ref, d));
  const chat = /^(chatgpt|openai)$/.test(s);
  let channel: Touch["channel"] = "Unknown",
    reason = "Insufficient acquisition evidence.";
  const conflict = Boolean(oppref && ((source && !chat) || (medium && !paid)));
  if (conflict) {
    reason =
      "OpenAI click reference conflicts with supplied campaign tags; review required.";
  } else if (oppref || (chat && paid)) {
    channel = "ChatGPT Ads";
    reason = oppref
      ? "Observed opaque OpenAI click reference; not independently authenticated."
      : "Observed ChatGPT paid campaign tags.";
  } else if (paid) {
    channel = /facebook|instagram|meta|linkedin|tiktok|twitter/.test(s)
      ? "Paid social"
      : /google|bing|microsoft/.test(s)
        ? "Paid search"
        : "Unknown";
    reason = "Observed paid campaign tags.";
  } else if (m === "email") {
    channel = "Email";
    reason = "Observed email campaign tag.";
  } else if (m === "affiliate") {
    channel = "Affiliate";
    reason = "Observed affiliate campaign tag.";
  } else if (
    (chat && /^(organic|referral|ai)$/.test(m)) ||
    (ai &&
      !hostIs(ref, "chatgpt.com") &&
      !hostIs(ref, "chat.openai.com") &&
      !source &&
      !medium)
  ) {
    channel = "Organic AI";
    reason = "Identifiable AI referral without paid evidence.";
  } else if (ai) {
    reason =
      "AI referrer alone does not distinguish paid from organic ChatGPT traffic.";
  } else if (
    [
      "google.com",
      "google.ie",
      "google.co.uk",
      "bing.com",
      "duckduckgo.com",
      "search.yahoo.com",
    ].some((d) => hostIs(ref, d)) &&
    !paid
  ) {
    channel = "Organic search";
    reason = "Recognized search-engine referrer.";
  } else if (
    [
      "facebook.com",
      "linkedin.com",
      "instagram.com",
      "t.co",
      "twitter.com",
    ].some((d) => hostIs(ref, d))
  ) {
    channel = "Organic social";
    reason = "Recognized social referrer without paid tags.";
  } else if (ref) {
    channel = "Referral";
    reason = "Observed external website referrer.";
  } else if (!source && !medium && !p.get("utm_campaign")) {
    channel = "Direct";
    reason =
      "No available external referrer or campaign tags; origin may be unobservable.";
  }
  return {
    at: now.toISOString(),
    landing: url.origin + url.pathname.slice(0, 300),
    referrer: ref,
    source: source || ref || "direct",
    sourceTag: source,
    medium,
    campaign: safe(p.get("utm_campaign")),
    campaignId: safe(p.get("utm_id")),
    adId: safe(p.get("ad_id")),
    oppref,
    channel,
    reason,
    conflict,
    rule: RULE_VERSION,
  };
}
export function advanceEvidence(
  previous: Evidence | null,
  touch: Touch,
  retentionDays = 90,
): Evidence {
  const expiry = previous
    ? Math.min(
        Date.parse(previous.expiresAt),
        Date.parse(previous.first.at) + retentionDays * 86400000,
      )
    : 0;
  if (!previous || expiry <= Date.parse(touch.at))
    return {
      first: touch,
      latest: touch,
      expiresAt: new Date(
        Date.parse(touch.at) + retentionDays * 86400000,
      ).toISOString(),
    };
  return {
    ...previous,
    expiresAt: new Date(expiry).toISOString(),
    latest:
      touch.channel === "Direct" ||
      Date.parse(touch.at) < Date.parse(previous.latest.at)
        ? previous.latest
        : touch,
  };
}
export function attributionFields(e: Evidence, submissionId: string) {
  return {
    submission_id: submissionId,
    first_source: e.first.source,
    first_medium: e.first.medium,
    first_campaign: e.first.campaign,
    latest_source: e.latest.source,
    latest_medium: e.latest.medium,
    latest_campaign: e.latest.campaign,
    landing_page: e.first.landing,
    captured_at: e.first.at,
    campaign_id: e.latest.campaignId,
    ad_id: e.latest.adId,
    oppref: e.latest.oppref || e.first.oppref,
  };
}
export function upsertSubmission(w: Workspace, item: Submission) {
  if (!w.sites.some((s) => s.id === item.siteId))
    throw new Error("Website does not belong to this workspace.");
  const existing = w.submissions.find((s) => s.id === item.id);
  if (existing) {
    if (existing.siteId !== item.siteId || existing.formId !== item.formId)
      throw new Error("Submission identity conflict.");
    if (item.status === "confirmed") {
      existing.status = "confirmed";
      if (existing.confirmation !== "crm")
        existing.confirmation = item.confirmation ?? existing.confirmation;
    }
    return existing;
  }
  w.submissions.push(item);
  return item;
}
export function reconcileCRM(
  w: Workspace,
  contacts: ContactSnapshot[],
  deals: Omit<Deal, "history">[],
) {
  // A provider page boundary can repeat an object without creating a second contact.
  const snapshots = [...new Map(contacts.map((c) => [c.id, c])).values()];
  w.contacts = snapshots.map(({ id, stage, submissions, updatedAt }) => ({
    id,
    stage,
    submissions,
    updatedAt,
  }));
  for (const s of w.submissions) {
    const matches = snapshots.filter((c) => c.submissions.includes(s.id));
    delete s.contactId;
    delete s.crmVerifiedAt;
    delete s.crmFieldDiagnostics;
    if (matches.length === 1) {
      const contact = matches[0];
      s.contactId = contact.id;
      s.crmVerifiedAt = new Date().toISOString();
      s.status = "confirmed";
      s.confirmation = "crm";
      // Submission identity history establishes the contact match, not delivery
      // of the source fields. Only current values can verify the current handoff.
      const diagnostics: NonNullable<Submission["crmFieldDiagnostics"]> = {
        status: "not_current",
        missing: [],
        mismatched: [],
      };
      if (contact.currentSubmissions?.includes(s.id)) {
        const site = w.sites.find((site) => site.id === s.siteId);
        const expected = attributionFields(s.evidence, s.id);
        for (const logical of [
          "submission_id",
          "first_source",
          "latest_source",
        ])
          if (!site?.mapping[logical]) diagnostics.missing.push(logical);
        for (const [logical, property] of Object.entries(site?.mapping ?? {})) {
          if (!(logical in expected)) continue;
          const wanted = expected[logical as keyof typeof expected];
          const actual = contact.fieldValues?.[property] ?? "";
          if (wanted && !actual) diagnostics.missing.push(logical);
          else if (actual !== wanted) diagnostics.mismatched.push(logical);
        }
        diagnostics.status = diagnostics.missing.length
          ? "missing"
          : diagnostics.mismatched.length
            ? "mismatch"
            : "verified";
        if (diagnostics.status === "verified")
          s.crmFieldsVerifiedAt = s.crmVerifiedAt;
        else delete s.crmFieldsVerifiedAt;
      }
      s.crmFieldDiagnostics = diagnostics;
    } else {
      delete s.crmFieldsVerifiedAt;
    }
  }
  w.deals = [...new Map(deals.map((d) => [d.id, d])).values()].map((d) => {
    const old = w.deals.find((x) => x.id === d.id);
    const history = old?.history ?? [];
    if (!old || old.stage !== d.stage || old.amount !== d.amount)
      history.push({ at: d.updatedAt, stage: d.stage, amount: d.amount });
    const primary = w.primarySelections?.[d.id] ?? d.primaryContactId;
    return {
      ...d,
      primaryContactId:
        primary && d.contacts.includes(primary) ? primary : undefined,
      history: history.slice(-100),
    };
  });
}
export type ReportOptions = {
  model: "first" | "latest";
  period: "cohort" | "sales";
  from: string;
  to: string;
  currency: string;
  campaignId?: string;
};
export function localDate(at: string, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}
export function report(w: Workspace, options: ReportOptions) {
  const inWindow = (at: string) => {
    const date = localDate(at, w.timezone);
    return date >= options.from && date <= options.to;
  };
  const production = w.submissions.filter(
    (s) => !s.test && s.status === "confirmed",
  );
  const cohort = production.filter((s) =>
    inWindow(s.evidence[options.model].at),
  );
  const chooseTouch = (candidates: Submission[]) => {
    candidates.sort(
      (a, b) =>
        Date.parse(a.evidence[options.model].at) -
          Date.parse(b.evidence[options.model].at) ||
        Date.parse(a.at) - Date.parse(b.at) ||
        a.id.localeCompare(b.id),
    );
    return options.model === "first" ? candidates[0] : candidates.at(-1);
  };
  const rows = new Map<
    string,
    {
      channel: string;
      campaignId: string;
      campaign: string;
      submissions: string[];
      contacts: string[];
      qualified: string[];
      deals: string[];
      won: string[];
      booked: number;
      missingAmounts: number;
      spend: number | null;
      cpl: number | null;
    }
  >();
  const get = (t: Touch) => {
    const key =
      options.campaignId !== undefined
        ? `${t.channel}:${t.campaignId}`
        : t.channel;
    if (!rows.has(key))
      rows.set(key, {
        channel: t.channel,
        campaignId: t.campaignId,
        campaign: t.campaign,
        submissions: [],
        contacts: [],
        qualified: [],
        deals: [],
        won: [],
        booked: 0,
        missingAmounts: 0,
        spend: null,
        cpl: null,
      });
    return rows.get(key)!;
  };
  for (const s of cohort) {
    const t = s.evidence[options.model];
    if (options.campaignId && t.campaignId !== options.campaignId) continue;
    const r = get(t);
    r.submissions.push(s.id);
  }
  // A contact gets one acquisition assignment per model, even after submitting
  // several forms through different channels. Submission counts stay separate.
  for (const contact of w.contacts) {
    const chosen = chooseTouch(
      production.filter((s) => s.contactId === contact.id),
    );
    if (!chosen) continue;
    const touch = chosen.evidence[options.model];
    if (
      !inWindow(touch.at) ||
      (options.campaignId && touch.campaignId !== options.campaignId)
    )
      continue;
    const row = get(touch);
    row.contacts.push(contact.id);
    if (w.qualifiedStages.includes(contact.stage))
      row.qualified.push(contact.id);
  }
  const unattributed: string[] = [];
  for (const d of w.deals) {
    const s = chooseTouch(
      production.filter(
        (s) =>
          s.contactId === d.primaryContactId &&
          Date.parse(s.at) <= Date.parse(d.closedAt ?? d.updatedAt) &&
          Date.parse(s.evidence[options.model].at) <=
            Date.parse(d.closedAt ?? d.updatedAt),
      ),
    );
    if (!d.primaryContactId || !s) {
      unattributed.push(d.id);
      continue;
    }
    const t = s.evidence[options.model];
    if (options.campaignId && t.campaignId !== options.campaignId) continue;
    if (
      options.period === "cohort"
        ? !inWindow(t.at)
        : !d.closedAt || !inWindow(d.closedAt)
    )
      continue;
    const r = get(t);
    r.deals.push(d.id);
    if (w.wonStages.includes(d.stage) && d.currency === options.currency) {
      r.won.push(d.id);
      if (d.amount === null) r.missingAmounts++;
      else r.booked += d.amount;
    }
  }
  // Spend-only campaigns must remain visible even when they produce no enquiries.
  for (const cost of w.costs) {
    if (
      cost.currency !== options.currency ||
      cost.date < options.from ||
      cost.date > options.to ||
      (options.campaignId && cost.campaignId !== options.campaignId)
    )
      continue;
    get({
      ...captureTouch("https://attribution.invalid"),
      channel: cost.channel as Touch["channel"],
      campaignId: cost.campaignId,
      campaign: cost.campaign,
    });
  }
  // Costs retain day and campaign identity. No unsupported ROAS/CPL is inferred from incomplete coverage.
  for (const r of rows.values()) {
    const costs = w.costs.filter(
      (c) =>
        c.channel === r.channel &&
        c.currency === options.currency &&
        c.date >= options.from &&
        c.date <= options.to &&
        (options.campaignId === undefined || c.campaignId === r.campaignId),
    );
    r.spend = costs.length ? costs.reduce((a, c) => a + c.amount, 0) : null;
  }
  return {
    rows: [...rows.values()],
    unattributed,
    definition:
      options.period === "cohort"
        ? "Acquisition cohort"
        : "Calendar-period sales",
    options,
  };
}
export function costCSV(input: string): Cost[] {
  if (input.length > 500000) throw new Error("CSV exceeds 500 KB.");
  const lines: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (ch === "," || ch === "\n")) {
      row.push(field.replace(/\r$/, ""));
      field = "";
      if (ch === "\n") {
        lines.push(row);
        row = [];
      }
    } else field += ch;
  }
  if (quoted) throw new Error("Unclosed CSV quote.");
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    lines.push(row);
  }
  const header = [
    "date",
    "campaign_id",
    "campaign",
    "channel",
    "currency",
    "spend",
  ];
  if (lines.shift()?.join(",") !== header.join(","))
    throw new Error(`Expected columns: ${header.join(",")}`);
  const seen = new Set<string>();
  return lines
    .filter((r) => r.some(Boolean))
    .map((r, i) => {
      const [date, campaignId, campaign, channel, currency, spend] = r;
      if (
        r.length !== 6 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        !campaignId ||
        campaignId.length > 160 ||
        campaign.length > 160 ||
        !channels.includes(channel as (typeof channels)[number]) ||
        !/^[A-Z]{3}$/.test(currency) ||
        !/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(spend) ||
        Number(spend) > 1e9
      )
        throw new Error(
          `Invalid cost row ${i + 2}. Use an ISO date, campaign ID, channel, currency and non-negative spend.`,
        );
      const id = `${date}:${channel}:${campaignId}:${currency}`;
      if (seen.has(id)) throw new Error(`Duplicate cost row ${i + 2}.`);
      seen.add(id);
      return {
        id,
        source: "csv",
        date,
        campaignId,
        campaign,
        channel,
        currency,
        amount: Number(spend),
      };
    });
}
export function usage(w: Workspace, now = new Date()) {
  const month = localDate(now.toISOString(), w.timezone).slice(0, 7);
  return w.submissions.filter(
    (s) =>
      !s.test &&
      s.status === "confirmed" &&
      localDate(s.at, w.timezone).startsWith(month),
  ).length;
}

export function pruneExpired(w: Workspace, now = Date.now()) {
  const expiredContacts = new Set(
    w.submissions
      .filter((s) => Date.parse(s.evidence.expiresAt) <= now)
      .map((s) => s.contactId),
  );
  w.submissions = w.submissions.filter(
    (s) => Date.parse(s.evidence.expiresAt) > now,
  );
  const retained = new Set(
    w.submissions.map((s) => s.contactId).filter(Boolean),
  );
  w.contacts = w.contacts.filter(
    (c) =>
      retained.has(c.id) ||
      (!expiredContacts.has(c.id) &&
        Date.parse(c.updatedAt) > now - 90 * 86400000),
  );
  w.deals = w.deals.filter(
    (d) =>
      d.contacts.some((c) => retained.has(c)) ||
      (!d.contacts.some((c) => expiredContacts.has(c)) &&
        Date.parse(d.updatedAt) > now - 90 * 86400000),
  );
  w.primarySelections = Object.fromEntries(
    Object.entries(w.primarySelections ?? {}).filter(([id]) =>
      w.deals.some((d) => d.id === id),
    ),
  );
}
export function captureAllowance(
  w: Workspace,
  id: string,
  test: boolean,
  now = new Date(),
): string | null {
  if (test || w.submissions.some((s) => s.id === id)) return null;
  if (
    w.billing.status === "trialing" &&
    Date.parse(w.billing.trialEndsAt) <= +now
  )
    return "The 14-day trial has ended. Choose a plan to resume new attribution captures.";
  if (!["trialing", "active"].includes(w.billing.status))
    return "Subscription is inactive. Resume your plan to capture new attribution records.";
  if (usage(w, now) >= (w.billing.plan === "agency" ? 2500 : 500))
    return "Monthly submission limit reached. No overage charge applies; existing business forms still submit.";
  return null;
}

export function normalizeEvidence(e: Evidence, site: Site): Evidence {
  const touch = (t: Touch) => {
    const url = new URL(t.landing);
    if (
      url.origin !== site.origin ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      throw new Error("Invalid captured website URL.");
    if (t.referrer && new URL(`https://${t.referrer}`).hostname !== t.referrer)
      throw new Error("Invalid referrer host.");
    for (const [key, value] of Object.entries({
      utm_source:
        t.sourceTag ?? (t.source === (t.referrer || "direct") ? "" : t.source),
      utm_medium: t.medium,
      utm_campaign: t.campaign,
      utm_id: t.campaignId,
      ad_id: t.adId,
      oppref: t.oppref,
    }))
      if (value) url.searchParams.set(key, value);
    return captureTouch(
      url.href,
      t.referrer ? `https://${t.referrer}` : "",
      new Date(t.at),
    );
  };
  if (Date.parse(e.first.at) > Date.parse(e.latest.at))
    throw new Error("First touch cannot follow latest touch.");
  return {
    first: touch(e.first),
    latest: touch(e.latest),
    expiresAt: new Date(
      Math.min(
        Date.parse(e.expiresAt),
        Date.parse(e.first.at) + site.retentionDays * 86400000,
      ),
    ).toISOString(),
  };
}
