import { describe, it, expect, vi } from "vitest";
import { sampleWorkspace } from "./sample";
import {
  advanceEvidence,
  captureTouch,
  defaultMapping,
  emptyWorkspace,
  upsertSubmission,
  reconcileCRM,
  report,
  costCSV,
  usage,
  captureAllowance,
  pruneExpired,
  normalizeEvidence,
  attributionFields,
  type Submission,
} from "./model";
const now = new Date("2026-09-06T12:00:00Z");
function fixture() {
  const w = emptyWorkspace("a", "Test");
  w.sites = [
    {
      id: "site-a",
      name: "A",
      origin: "https://example.com",
      adapter: "html",
      consent: "required",
      retentionDays: 90,
      formSelector: "form",
      mapping: defaultMapping,
      paused: false,
    },
  ];
  const evidence = advanceEvidence(
    null,
    captureTouch(
      "https://example.com/?utm_source=google&utm_medium=cpc&utm_id=campaign-a",
      "",
      now,
    ),
  );
  const s: Submission = {
    id: "s1",
    siteId: "site-a",
    formId: "f",
    at: now.toISOString(),
    evidence,
    test: false,
    status: "confirmed",
  };
  upsertSubmission(w, s);
  return { w, s };
}
const options = {
  from: "2026-09-01",
  to: "2026-09-30",
  model: "first" as const,
  period: "cohort" as const,
  currency: "EUR",
};
describe("source capture", () => {
  it.each([
    ["https://example.com/", ""],
    ["https://example.com/?oppref=opaque-value", ""],
    ["https://example.com/", "https://perplexity.ai/search/example"],
    ["https://example.com/", "https://chatgpt.com/"],
    ["https://example.com/?utm_source=direct", ""],
  ])(
    "preserves observed classification during server normalization: %s %s",
    (href, referrer) => {
      const { w } = fixture();
      const touch = captureTouch(href, referrer, now);
      const evidence = advanceEvidence(null, touch);
      expect(normalizeEvidence(evidence, w.sites[0])).toEqual(evidence);
    },
  );
  it("normalizes retained evidence captured before source tags were separate", () => {
    const { w } = fixture();
    const evidence = advanceEvidence(
      null,
      captureTouch("https://example.com/?oppref=opaque", "", now),
    );
    delete evidence.first.sourceTag;
    delete evidence.latest.sourceTag;
    expect(normalizeEvidence(evidence, w.sites[0]).first.channel).toBe(
      "ChatGPT Ads",
    );
  });
  it("preserves first and non-direct evidence through direct navigation", () => {
    const first = captureTouch(
      "https://example.com/?utm_source=google&utm_medium=cpc",
      "",
      now,
    );
    const evidence = advanceEvidence(null, first);
    const direct = captureTouch(
      "https://example.com/contact",
      "https://example.com/products",
      new Date(+now + 1000),
    );
    expect(advanceEvidence(evidence, direct).first).toEqual(first);
    expect(advanceEvidence(evidence, direct).latest).toEqual(first);
    const email = captureTouch(
      "https://example.com/?utm_source=newsletter&utm_medium=email",
      "",
      new Date(+now + 2000),
    );
    const next = advanceEvidence(evidence, email);
    expect(next.first).toEqual(first);
    expect(next.latest.channel).toBe("Email");
  });
  it("expires history at the retention boundary", () => {
    const e = advanceEvidence(
      null,
      captureTouch(
        "https://example.com/?utm_source=google&utm_medium=cpc",
        "",
        now,
      ),
      1,
    );
    expect(
      advanceEvidence(
        e,
        captureTouch("https://example.com", "", new Date(+now + 86400000)),
      ).first.channel,
    ).toBe("Direct");
  });
  it("distinguishes paid, organic and ambiguous ChatGPT", () => {
    expect(
      captureTouch("https://example.com/?utm_source=chatgpt&utm_medium=cpc")
        .channel,
    ).toBe("ChatGPT Ads");
    expect(
      captureTouch("https://example.com/?utm_source=chatgpt&utm_medium=organic")
        .channel,
    ).toBe("Organic AI");
    expect(
      captureTouch("https://example.com/", "https://chatgpt.com").channel,
    ).toBe("Unknown");
  });
  it("preserves opaque values, flags conflicts and drops unrelated URL values", () => {
    const t = captureTouch(
      "https://example.com/demo?oppref=opaque_X-1&email=private%40example.com&token=secret&utm_source=google",
    );
    expect(t.oppref).toBe("opaque_X-1");
    expect(t.conflict).toBe(true);
    expect(t.channel).toBe("Unknown");
    expect(t.landing).toBe("https://example.com/demo");
    expect(JSON.stringify(t)).not.toContain("secret");
  });
  it("rejects hostname lookalikes as search evidence", () =>
    expect(
      captureTouch("https://example.com", "https://evilgoogle.com").channel,
    ).toBe("Referral"));
});
describe("CRM identities and reporting", () => {
  it("matches CRM identity without claiming delivery of absent attribution fields", () => {
    const { w, s } = fixture();
    reconcileCRM(
      w,
      [
        {
          id: "c",
          stage: "lead",
          submissions: [s.id],
          currentSubmissions: [s.id],
          fieldValues: { mc_submission_id: s.id },
          updatedAt: now.toISOString(),
        },
      ],
      [],
    );
    expect(s.contactId).toBe("c");
    expect(s.crmVerifiedAt).toBeDefined();
    expect(s.crmFieldsVerifiedAt).toBeUndefined();
    expect(s.crmFieldDiagnostics?.missing).toContain("first_source");
  });
  it("verifies the mapped source handoff without persisting raw CRM field values", () => {
    const { w, s } = fixture();
    const expected = attributionFields(s.evidence, s.id);
    const fieldValues = Object.fromEntries(
      Object.entries(defaultMapping).map(([logical, property]) => [
        property,
        expected[logical as keyof typeof expected],
      ]),
    );
    const contact = {
      id: "c",
      stage: "lead",
      submissions: [s.id],
      currentSubmissions: [s.id],
      fieldValues,
      updatedAt: now.toISOString(),
    };
    reconcileCRM(w, [contact], []);
    expect(s.crmFieldsVerifiedAt).toBeDefined();
    expect(s.crmFieldDiagnostics).toEqual({
      status: "verified",
      missing: [],
      mismatched: [],
    });
    expect(w.contacts[0]).not.toHaveProperty("fieldValues");
    reconcileCRM(
      w,
      [
        {
          ...contact,
          fieldValues: { ...fieldValues, mc_first_source: "sales correction" },
        },
      ],
      [],
    );
    expect(s.crmFieldsVerifiedAt).toBeUndefined();
    expect(s.crmFieldDiagnostics?.mismatched).toEqual(["first_source"]);
    expect(JSON.stringify(w)).not.toContain("sales correction");
  });
  it("does not use another submission's current source fields to prove historical handoff", () => {
    const { w, s } = fixture();
    reconcileCRM(
      w,
      [
        {
          id: "c",
          stage: "lead",
          submissions: [s.id, "later"],
          currentSubmissions: ["later"],
          fieldValues: { mc_submission_id: "later", mc_first_source: "google" },
          updatedAt: now.toISOString(),
        },
      ],
      [],
    );
    expect(s.contactId).toBe("c");
    expect(s.crmFieldsVerifiedAt).toBeUndefined();
    expect(s.crmFieldDiagnostics?.status).toBe("not_current");
  });
  it("does not downgrade a CRM confirmation when a browser callback is retried", () => {
    const { w, s } = fixture();
    s.confirmation = "crm";
    upsertSubmission(w, { ...s, confirmation: "browser_success" });
    expect(s.confirmation).toBe("crm");
  });
  it("assigns contacts and deals using touch time rather than submission order", () => {
    const { w, s } = fixture();
    const second = {
      ...s,
      id: "s2",
      at: "2026-09-07T00:00:00Z",
      evidence: advanceEvidence(
        null,
        captureTouch(
          "https://example.com/?utm_source=newsletter&utm_medium=email",
          "",
          new Date("2026-09-02T00:00:00Z"),
        ),
      ),
    };
    upsertSubmission(w, second);
    const contact = {
      id: "c",
      stage: "customer",
      submissions: [s.id, second.id],
      updatedAt: now.toISOString(),
    };
    reconcileCRM(
      w,
      [contact, contact],
      [
        {
          id: "d",
          contacts: ["c"],
          primaryContactId: "c",
          stage: "closedwon",
          amount: 10,
          currency: "EUR",
          closedAt: "2026-09-08T00:00:00Z",
          updatedAt: "2026-09-08T00:00:00Z",
        },
      ],
    );
    expect(w.contacts).toHaveLength(1);
    const first = report(w, options).rows.find((r) => r.channel === "Email")!;
    expect(first.qualified).toEqual(["c"]);
    expect(first.won).toEqual(["d"]);
    const latest = report(w, { ...options, model: "latest" }).rows.find(
      (r) => r.channel === "Paid search",
    )!;
    expect(latest.qualified).toEqual(["c"]);
    expect(latest.won).toEqual(["d"]);
  });
  it("deduplicates retries without downgrading confirmation", () => {
    const { w, s } = fixture();
    upsertSubmission(w, { ...s, status: "attempted" });
    expect(w.submissions).toHaveLength(1);
    expect(w.submissions[0].status).toBe("confirmed");
    expect(() => upsertSubmission(w, { ...s, siteId: "other" })).toThrow();
  });
  it("excludes attempts and test records from production usage", () => {
    const { w, s } = fixture();
    s.test = true;
    expect(usage(w, now)).toBe(0);
    s.test = false;
    s.status = "attempted";
    expect(usage(w, now)).toBe(0);
    expect(report(w, options).rows).toEqual([]);
  });
  it("counts distinct shared opportunities across submissions and retains them on reopening or loss", () => {
    const { w, s } = fixture();
    upsertSubmission(w, { ...s, id: "s2" });
    const contacts = [
      {
        id: "c1",
        stage: "customer",
        submissions: ["s1", "s2"],
        updatedAt: now.toISOString(),
      },
      {
        id: "c2",
        stage: "customer",
        submissions: [],
        updatedAt: now.toISOString(),
      },
    ];
    const deal = {
      id: "d1",
      contacts: ["c1", "c2"],
      primaryContactId: "c1",
      stage: "closedwon",
      amount: 5000,
      currency: "EUR",
      closedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    const open = { ...deal, id: "d2", stage: "open", closedAt: null };
    reconcileCRM(w, contacts, [deal, deal, open]);
    expect(w.deals).toHaveLength(2);
    expect(report(w, options).rows[0]).toMatchObject({
      submissions: ["s1", "s2"],
      qualified: ["c1"],
      deals: ["d1", "d2"],
      won: ["d1"],
      booked: 5000,
    });
    reconcileCRM(w, contacts, [
      { ...deal, stage: "reopened", closedAt: null },
      open,
    ]);
    expect(report(w, options).rows[0]).toMatchObject({
      deals: ["d1", "d2"],
      won: [],
      booked: 0,
    });
    expect(
      report(w, { ...options, period: "sales" }).rows.flatMap((r) => r.deals),
    ).toEqual([]);
    expect(w.deals[0].history).toHaveLength(2);
    reconcileCRM(w, contacts, [{ ...deal, stage: "closedlost" }, open]);
    expect(report(w, options).rows[0]).toMatchObject({
      deals: ["d1", "d2"],
      won: [],
      booked: 0,
    });
    expect(
      report(w, { ...options, period: "sales" }).rows.flatMap((r) => r.deals),
    ).toEqual(["d1"]);
    expect(w.deals[0].history).toHaveLength(3);
  });
  it("leaves ambiguous contacts and absent primary contacts unattributed", () => {
    const { w } = fixture();
    reconcileCRM(
      w,
      [
        {
          id: "c1",
          stage: "customer",
          submissions: ["s1"],
          updatedAt: now.toISOString(),
        },
        {
          id: "c2",
          stage: "customer",
          submissions: ["s1"],
          updatedAt: now.toISOString(),
        },
      ],
      [
        {
          id: "d",
          contacts: ["c1", "c2"],
          stage: "closedwon",
          amount: 5,
          currency: "EUR",
          closedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    );
    expect(w.submissions[0].contactId).toBeUndefined();
    expect(report(w, options).unattributed).toEqual(["d"]);
  });
  it("separates cohorts from calendar sales and original currencies", () => {
    const { w, s } = fixture();
    s.evidence.first.at = "2026-08-01T00:00:00Z";
    reconcileCRM(
      w,
      [
        {
          id: "c",
          stage: "customer",
          submissions: ["s1"],
          updatedAt: now.toISOString(),
        },
      ],
      [
        {
          id: "d",
          contacts: ["c"],
          primaryContactId: "c",
          stage: "closedwon",
          amount: 300,
          currency: "USD",
          closedAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ],
    );
    expect(report(w, options).rows).toHaveLength(0);
    expect(report(w, { ...options, period: "sales" }).rows[0]).toMatchObject({
      deals: ["d"],
      won: [],
      booked: 0,
    });
    expect(
      report(w, { ...options, period: "sales", currency: "USD" }).rows[0],
    ).toMatchObject({ deals: ["d"], won: ["d"], booked: 300 });
  });
  it("includes all opportunity stages and currencies in the cohort, independent of the revenue currency", () => {
    const { w, s } = fixture();
    const contact = {
      id: "c",
      stage: "customer",
      submissions: [s.id],
      updatedAt: now.toISOString(),
    };
    reconcileCRM(
      w,
      [contact],
      [
        { id: "eur-won", stage: "closedwon", currency: "EUR", amount: 200 },
        { id: "usd-won", stage: "closedwon", currency: "USD", amount: 300 },
        { id: "gbp-open", stage: "open", currency: "GBP", amount: null },
        { id: "usd-lost", stage: "closedlost", currency: "USD", amount: 400 },
      ].map((deal) => ({
        ...deal,
        contacts: [contact.id],
        primaryContactId: contact.id,
        closedAt: deal.stage === "open" ? null : now.toISOString(),
        updatedAt: now.toISOString(),
      })),
    );
    for (const [currency, won, booked] of [
      ["EUR", ["eur-won"], 200],
      ["USD", ["usd-won"], 300],
      ["GBP", [], 0],
    ] as const)
      expect(report(w, { ...options, currency }).rows[0]).toMatchObject({
        deals: ["eur-won", "usd-won", "gbp-open", "usd-lost"],
        won,
        booked,
      });
  });
  it("scopes opportunities by selected touch for cohorts and existing CRM close dates for calendar sales", () => {
    const { w, s } = fixture();
    s.evidence = advanceEvidence(
      advanceEvidence(
        null,
        captureTouch(
          "https://example.com/?utm_source=google&utm_medium=cpc&utm_id=campaign-a",
          "",
          new Date("2026-08-31T12:00:00Z"),
        ),
      ),
      captureTouch(
        "https://example.com/?utm_source=newsletter&utm_medium=email&utm_id=campaign-b",
        "",
        new Date("2026-09-01T12:00:00Z"),
      ),
    );
    reconcileCRM(
      w,
      [{ id: "c", stage: "lead", submissions: [s.id], updatedAt: s.at }],
      [
        { id: "closed", stage: "closedlost", closedAt: "2026-09-08T12:00:00Z" },
        { id: "open", stage: "open", closedAt: null },
      ].map((deal) => ({
        ...deal,
        contacts: ["c"],
        primaryContactId: "c",
        amount: 100,
        currency: "EUR",
        updatedAt: "2026-09-08T12:00:00Z",
      })),
    );
    expect(report(w, options).rows.flatMap((r) => r.deals)).toEqual([]);
    expect(report(w, { ...options, model: "latest" }).rows[0]).toMatchObject({
      channel: "Email",
      deals: ["closed", "open"],
    });
    const sales = {
      ...options,
      period: "sales" as const,
      from: "2026-09-08",
      to: "2026-09-08",
    };
    expect(
      report(w, { ...sales, campaignId: "campaign-a" }).rows[0],
    ).toMatchObject({
      channel: "Paid search",
      deals: ["closed"],
    });
    expect(
      report(w, { ...sales, model: "latest", campaignId: "campaign-a" }).rows,
    ).toEqual([]);
    expect(
      report(w, { ...sales, model: "latest", campaignId: "campaign-b" })
        .rows[0],
    ).toMatchObject({ channel: "Email", deals: ["closed"] });
    expect(
      report(w, { ...sales, from: "2026-09-09", to: "2026-09-30" }).rows,
    ).toEqual([]);
  });
  it("does not attribute opportunities from diagnostic or unconfirmed-only evidence", () => {
    const { w, s } = fixture();
    s.contactId = "production-contact";
    w.submissions.push(
      { ...s, id: "diagnostic", contactId: "test-contact", test: true },
      {
        ...s,
        id: "attempt",
        contactId: "attempt-contact",
        status: "attempted",
      },
    );
    w.deals = w.submissions.map((submission) => ({
      id: `deal-${submission.id}`,
      contacts: [submission.contactId!],
      primaryContactId: submission.contactId,
      stage: "open",
      amount: null,
      currency: "EUR",
      closedAt: null,
      updatedAt: now.toISOString(),
      history: [],
    }));
    const result = report(w, options);
    expect(result.rows.flatMap((r) => r.deals)).toEqual(["deal-s1"]);
    expect(result.unattributed).toEqual(["deal-diagnostic", "deal-attempt"]);
  });
  it("demonstrates open and lost sample opportunities without changing established headline totals", () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const w = sampleWorkspace();
      const rows = report(w, { ...options, from: "2026-08-01" }).rows;
      expect(
        Object.fromEntries(rows.map((r) => [r.channel, r.deals.length])),
      ).toEqual({
        "Paid search": 9,
        "Paid social": 5,
        "ChatGPT Ads": 5,
        "Organic search": 4,
        Referral: 2,
      });
      expect(rows.flatMap((r) => r.submissions)).toHaveLength(128);
      expect(rows.flatMap((r) => r.qualified)).toHaveLength(42);
      expect(rows.flatMap((r) => r.deals)).toHaveLength(25);
      expect(rows.flatMap((r) => r.won)).toHaveLength(12);
      expect(rows.reduce((sum, r) => sum + r.booked, 0)).toBe(38400);
      const open = w.deals.filter((d) => d.stage === "open");
      const lost = w.deals.filter((d) => d.stage === "closedlost");
      expect(open).toHaveLength(8);
      expect(open.every((d) => d.closedAt === null)).toBe(true);
      expect(lost).toHaveLength(5);
      expect(lost.every((d) => d.closedAt !== null)).toBe(true);
      expect(
        report(w, {
          ...options,
          from: "2026-08-01",
          period: "sales",
        }).rows.flatMap((r) => r.deals),
      ).toHaveLength(17);
    } finally {
      vi.useRealTimers();
    }
  });
  it("keeps missing spend and unsupported ratios unavailable", () => {
    const { w } = fixture();
    const r = report(w, options).rows[0];
    expect(r.spend).toBeNull();
    expect(r.cpl).toBeNull();
  });
});
describe("CSV cost validation", () => {
  const header = "date,campaign_id,campaign,channel,currency,spend\n";
  it("handles quoted names and rejects duplicate rows", () => {
    const row = '2026-09-01,a,"Search, brand",Paid search,EUR,123.45';
    expect(costCSV(header + row)[0].campaign).toBe("Search, brand");
    expect(() => costCSV(header + row + "\n" + row)).toThrow("Duplicate");
  });
  it.each([
    "2026-02-31,a,Test,Paid search,EUR,1",
    "2026-09-01,a,Test,Paid search,EUR,-1",
    "2026-09-01,a,Test,Unsupported,EUR,1",
    "2026-09-01,a,Test,Paid search,EUR,NaN",
  ])("rejects invalid row %s", (row) =>
    expect(() => costCSV(header + row)).toThrow(),
  );
});

describe("subscription and retention boundaries", () => {
  it("does not charge retries or diagnostic submissions after a trial ends", () => {
    const { w, s } = fixture();
    w.billing.trialEndsAt = new Date(+now - 1).toISOString();
    expect(captureAllowance(w, "new", false, now)).toContain("trial has ended");
    expect(captureAllowance(w, s.id, false, now)).toBeNull();
    expect(captureAllowance(w, "diagnostic", true, now)).toBeNull();
  });
  it("blocks new capture at the plan allowance without blocking retry confirmation", () => {
    const { w, s } = fixture();
    w.billing.status = "active";
    w.submissions = Array.from({ length: 500 }, (_, i) => ({
      ...s,
      id: `s-${i}`,
    }));
    expect(captureAllowance(w, "new", false, now)).toContain(
      "Monthly submission limit",
    );
    expect(captureAllowance(w, "s-1", false, now)).toBeNull();
  });
  it("removes expired click evidence and linked CRM data, preserving other contacts", () => {
    const { w, s } = fixture();
    s.evidence.expiresAt = new Date(+now - 1).toISOString();
    s.contactId = "expired";
    w.contacts = [
      {
        id: "expired",
        stage: "lead",
        submissions: [s.id],
        updatedAt: now.toISOString(),
      },
      {
        id: "other",
        stage: "lead",
        submissions: [],
        updatedAt: now.toISOString(),
      },
    ];
    pruneExpired(w, +now);
    expect(w.submissions).toHaveLength(0);
    expect(w.contacts.map((c) => c.id)).toEqual(["other"]);
  });
  it("includes campaigns with cost records and no captured leads", () => {
    const w = emptyWorkspace("w", "Test");
    w.costs = costCSV(
      "date,campaign_id,campaign,channel,currency,spend\n2026-09-01,quiet,Quiet,Paid search,EUR,25.00",
    );
    const rows = report(w, { ...options, campaignId: "" }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].submissions).toEqual([]);
    expect(rows[0].spend).toBe(25);
    expect(rows[0].cpl).toBeNull();
  });
});
