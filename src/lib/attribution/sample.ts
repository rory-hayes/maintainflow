import {
  captureTouch,
  advanceEvidence,
  defaultMapping,
  emptyWorkspace,
  type Workspace,
} from "./model";
export function sampleWorkspace(): Workspace {
  const w = emptyWorkspace("sample", "Acme Studio", "sample");
  w.sites = [
    {
      id: "sample-site",
      name: "Acme website",
      origin: "https://acme.example",
      consent: "required",
      retentionDays: 90,
      formSelector: "form[data-attribution]",
      adapter: "html",
      mapping: defaultMapping,
      installedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      paused: false,
    },
  ];
  const groups = [
    {
      channel: "Paid search",
      source: "google",
      medium: "cpc",
      count: 48,
      qualified: 18,
      opportunities: 9,
      won: 5,
      spend: 2400,
    },
    {
      channel: "Paid social",
      source: "linkedin",
      medium: "paid_social",
      count: 32,
      qualified: 9,
      opportunities: 5,
      won: 2,
      spend: 1600,
    },
    {
      channel: "ChatGPT Ads",
      source: "chatgpt",
      medium: "paid_ai",
      count: 16,
      qualified: 7,
      opportunities: 5,
      won: 3,
      spend: 800,
    },
    {
      channel: "Organic search",
      source: "google",
      medium: "organic",
      count: 20,
      qualified: 6,
      opportunities: 4,
      won: 2,
    },
    {
      channel: "Referral",
      source: "partner.example",
      medium: "referral",
      count: 12,
      qualified: 2,
      opportunities: 2,
      won: 0,
    },
  ];
  let n = 0;
  for (const [g, group] of groups.entries())
    for (let i = 0; i < group.count; i++) {
      n++;
      const at = new Date(
        Date.now() - (1 + ((n * 7) % 29)) * 86400000,
      ).toISOString();
      const campaignId = `campaign-${g + 1}`;
      const first = captureTouch(
        `https://acme.example/request-demo?utm_source=${group.source}&utm_medium=${group.medium}&utm_campaign=${encodeURIComponent(["High-intent search", "B2B decision makers", "AI discovery", "Search discovery", "Partner referrals"][g])}&utm_id=${campaignId}`,
        g === 3
          ? "https://google.com/search"
          : g === 4
            ? "https://partner.example"
            : "",
        new Date(at),
      );
      const evidence = advanceEvidence(null, first);
      const contactId = `contact-${n}`;
      const id = `lead-${String(n).padStart(4, "0")}`;
      w.submissions.push({
        id,
        siteId: "sample-site",
        formId: "request-demo",
        at,
        evidence,
        test: false,
        status: "confirmed",
        confirmation: "crm",
        contactId,
        crmVerifiedAt: at,
        crmFieldsVerifiedAt: at,
        crmFieldDiagnostics: {
          status: "verified",
          missing: [],
          mismatched: [],
        },
      });
      w.contacts.push({
        id: contactId,
        stage:
          i < group.won
            ? "customer"
            : i < group.qualified
              ? "marketingqualifiedlead"
              : "lead",
        submissions: [id],
        updatedAt: at,
      });
      if (i < group.opportunities) {
        const stage =
          i < group.won
            ? "closedwon"
            : i === group.opportunities - 1
              ? "closedlost"
              : "open";
        w.deals.push({
          id: `deal-${n}`,
          contacts: [contactId],
          primaryContactId: contactId,
          stage,
          amount: 3200,
          currency: "EUR",
          closedAt:
            stage === "open"
              ? null
              : new Date(Date.parse(at) + 86400000).toISOString(),
          updatedAt: at,
          history: [{ at, stage, amount: 3200 }],
        });
      }
    }
  for (const [g, group] of groups.entries())
    if (group.spend !== undefined)
      w.costs.push({
        id: `sample-cost-${g}`,
        source: g === 2 ? "openai" : "csv",
        campaignId: `campaign-${g + 1}`,
        campaign: group.channel,
        channel: group.channel,
        date: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
        currency: "EUR",
        amount: group.spend,
      });
  w.connectors = [
    {
      provider: "hubspot",
      accountId: "example",
      status: "connected",
      syncedAt: new Date().toISOString(),
    },
    {
      provider: "openai",
      accountId: "example",
      status: "connected",
      syncedAt: new Date().toISOString(),
      timezone: "Europe/Dublin",
      coverage: "Sample month",
    },
  ];
  return w;
}
