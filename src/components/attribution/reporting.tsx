"use client";
import { ArrowUpRight, Download, Info, Search } from "lucide-react";
import { useState } from "react";
import {
  report,
  localDate,
  type Workspace,
  type ReportOptions,
  type Submission,
} from "@/lib/attribution/model";
export const money = (value: number, currency = "EUR") =>
  new Intl.NumberFormat("en-IE", {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
  }).format(value);
export function download(name: string, body: string, type = "text/csv") {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (value: unknown) =>
  `"${String(value ?? "")
    .replace(/^[=+@-]/, "'$&")
    .replaceAll('"', '""')}"`;
export function Reporting({
  w,
  onLead,
  onView,
  campaigns = false,
}: {
  w: Workspace;
  onLead: (s: Submission) => void;
  onView: (view: string) => void;
  campaigns?: boolean;
}) {
  const [reportNow] = useState(() => Date.now());
  const [model, setModel] = useState<"first" | "latest">("first"),
    [period, setPeriod] = useState<"cohort" | "sales">("cohort"),
    [currency, setCurrency] = useState("EUR"),
    [days, setDays] = useState(30),
    [campaign, setCampaign] = useState("");
  const [evidenceChannel, setEvidenceChannel] = useState<string | null>(null);
  const options: ReportOptions = {
    model,
    period: campaigns ? period : "cohort",
    currency,
    from: localDate(
      new Date(reportNow - (days - 1) * 86400000).toISOString(),
      w.timezone,
    ),
    to: localDate(new Date().toISOString(), w.timezone),
    ...(campaigns ? { campaignId: campaign } : {}),
  };
  const result = report(w, options);
  const totals = result.rows.reduce(
    (a, r) => ({
      leads: a.leads + r.submissions.length,
      qualified: a.qualified + r.qualified.length,
      opportunities: a.opportunities + r.deals.length,
      won: a.won + r.won.length,
      booked: a.booked + r.booked,
    }),
    { leads: 0, qualified: 0, opportunities: 0, won: 0, booked: 0 },
  );
  const opportunityDefinition =
    "Opportunities are distinct attributed CRM deals across all stages and currencies. " +
    (options.period === "cohort"
      ? "Acquisition cohort uses the selected first-touch or last-non-direct acquisition date."
      : "Calendar-period sales uses the CRM close date, which can be planned for open deals; deals without a close date are excluded.");
  const known = w.submissions.filter(
    (s) =>
      s.status === "confirmed" &&
      !s.test &&
      localDate(s.evidence[model].at, w.timezone) >= options.from &&
      localDate(s.evidence[model].at, w.timezone) <= options.to &&
      (!campaigns || !campaign || s.evidence[model].campaignId === campaign),
  );
  const coverage = known.length
    ? Math.round(
        (100 *
          known.filter(
            (s) => !["Unknown", "Direct"].includes(s.evidence[model].channel),
          ).length) /
          known.length,
      )
    : null;
  const dailyMaximum = Math.max(
    1,
    ...Array.from({ length: Math.min(days, 30) }, (_, i) => {
      const date = localDate(
        new Date(reportNow - i * 86400000).toISOString(),
        w.timezone,
      );
      return known.filter(
        (s) => localDate(s.evidence[model].at, w.timezone) === date,
      ).length;
    }),
  );
  function exportReport() {
    download(
      `${w.mode}-channel-report.csv`,
      [
        [
          "data_mode",
          "channel",
          "campaign_id",
          "enquiries",
          "qualified_contacts",
          "opportunities",
          "opportunity_definition",
          "won_deals",
          "booked_value",
          "currency",
          "observed_spend",
          "model",
          "period",
          "from",
          "to",
        ],
        ...result.rows.map((r) => [
          w.mode,
          r.channel,
          r.campaignId,
          r.submissions.length,
          r.qualified.length,
          r.deals.length,
          opportunityDefinition,
          r.won.length,
          r.booked,
          currency,
          r.spend ?? "Unknown",
          model,
          options.period,
          options.from,
          options.to,
        ]),
      ]
        .map((r) => r.map(csvCell).join(","))
        .join("\n"),
    );
  }
  const colors = ["#0d543e", "#238866", "#72c8af", "#97d6ae", "#c1e4cb"];
  return (
    <>
      <div className="mc-heading">
        <div>
          <h1>
            {campaigns
              ? "Every campaign, through to the sale."
              : "See what becomes a customer."}
          </h1>
          <p>
            {campaigns
              ? "Compare captured acquisition evidence and observed campaign costs."
              : "Trace enquiries from their first visit to a won deal."}
          </p>
        </div>
      </div>
      <div className="mc-toolbar">
        <select
          aria-label="Date range"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={30}>Last 30 days</option>
          <option value={7}>Last 7 days</option>
          <option value={90}>Last 90 days</option>
        </select>
        <select
          aria-label="Attribution model"
          value={model}
          onChange={(e) => setModel(e.target.value as typeof model)}
        >
          <option value="first">First touch</option>
          <option value="latest">Last non-direct</option>
        </select>
        <select
          aria-label="Currency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {[
            ...new Set([
              "EUR",
              "USD",
              "GBP",
              ...w.deals.map((d) => d.currency).filter((c) => c !== "UNKNOWN"),
            ]),
          ].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        {campaigns && (
          <>
            <select
              aria-label="Reporting period"
              value={period}
              onChange={(e) => setPeriod(e.target.value as typeof period)}
            >
              <option value="cohort">Acquisition cohort</option>
              <option value="sales">Calendar-period sales</option>
            </select>
            <select
              aria-label="Campaign"
              value={campaign}
              onChange={(e) => setCampaign(e.target.value)}
            >
              <option value="">All campaigns</option>
              {[
                ...new Map([
                  ...w.submissions.map(
                    (s) =>
                      [
                        s.evidence[model].campaignId,
                        s.evidence[model].campaign,
                      ] as [string, string],
                  ),
                  ...w.costs.map(
                    (c) => [c.campaignId, c.campaign] as [string, string],
                  ),
                  ...(w.adInventory?.campaigns ?? []).map(
                    (c) => [c.id, c.name] as [string, string],
                  ),
                ]).entries(),
              ]
                .filter(([id]) => id)
                .map(([id, name]) => (
                  <option key={id} value={id}>
                    {name || id}
                  </option>
                ))}
            </select>
          </>
        )}
        <button className="mc-export" onClick={exportReport}>
          <Download />
          Export report
        </button>
      </div>
      <ModeNotice w={w} />
      <div className="mc-metrics">
        {[
          ["Enquiries", totals.leads],
          ["Qualified leads", totals.qualified],
          ["Opportunities", totals.opportunities],
          ["Won deals", totals.won],
          ["Booked deal value", money(totals.booked, currency)],
        ].map(([label, value]) => (
          <button key={label} onClick={() => setEvidenceChannel("all")}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>
              Inspect evidence <ArrowUpRight />
            </small>
          </button>
        ))}
      </div>
      <details className="mc-report-definition">
        <summary>How opportunities are counted</summary>
        <p>
          {opportunityDefinition} Won deals and booked value use the selected
          currency. These are attributed deals, not a count of newly created
          opportunities or open pipeline alone.
        </p>
      </details>
      <div className="mc-chart-layout">
        <section className="mc-panel mc-chart">
          <h2>Enquiries by channel</h2>
          {known.length ? (
            <>
              <div className="mc-bars" aria-label="Daily enquiry counts">
                {Array.from({ length: Math.min(days, 30) }, (_, i) => {
                  const date = localDate(
                    new Date(
                      reportNow - (Math.min(days, 30) - 1 - i) * 86400000,
                    ).toISOString(),
                    w.timezone,
                  );
                  return (
                    <div key={date} className="mc-bar-day" title={date}>
                      {result.rows.map((row, j) => {
                        const count = known.filter(
                          (s) =>
                            row.submissions.includes(s.id) &&
                            localDate(s.evidence[model].at, w.timezone) ===
                              date,
                        ).length;
                        return (
                          <span
                            key={`${row.channel}-${j}`}
                            style={{
                              height: count * (140 / dailyMaximum),
                              background: colors[j % 5],
                            }}
                            title={`${row.channel}: ${count}`}
                          />
                        );
                      })}
                    </div>
                  );
                })}
              </div>
              <div className="mc-axis">
                <span>{options.from}</span>
                <span>{options.to}</span>
              </div>
              <div className="mc-legend">
                {result.rows.map((r, i) => (
                  <span key={i}>
                    <i style={{ background: colors[i % 5] }} />
                    {r.channel}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <Empty
              title="Your first enquiry starts the story."
              body="Install the website script, map your fields, then confirm a successful form submission."
              onClick={() => onView("Setup")}
              action="Set up tracking"
            />
          )}
        </section>
        <section className="mc-panel mc-coverage">
          <h2>Evidence coverage</h2>
          <div className="mc-coverage-main">
            <div
              className="mc-ring"
              style={{
                background: `conic-gradient(#175c45 ${(coverage ?? 0) * 3.6}deg, #edf1ed 0deg)`,
              }}
            />
            <div>
              <strong>{coverage === null ? "—" : `${coverage}%`}</strong>
              <p>attribution captured</p>
            </div>
          </div>
          <div className="mc-unresolved">
            <strong>{result.unattributed.length}</strong>
            <p>unattributed deals</p>
          </div>
          <button className="mc-link" onClick={() => onView("Tracking health")}>
            Review tracking health <ArrowUpRight />
          </button>
        </section>
      </div>
      <section className="mc-panel mc-table-panel">
        <div className="mc-section-title">
          <h2>{campaigns ? "Campaign performance" : "Channel performance"}</h2>
          <p>
            {result.definition} ·{" "}
            {model === "first" ? "first touch" : "last non-direct"} · {currency}{" "}
            · {w.timezone}
          </p>
        </div>
        <div
          className="mc-table-scroll"
          role="region"
          aria-label={
            campaigns
              ? "Campaign performance table"
              : "Channel performance table"
          }
          tabIndex={0}
        >
          <table>
            <thead>
              <tr>
                <th>{campaigns ? "Campaign / channel" : "Channel"}</th>
                <th>Enquiries</th>
                <th>Qualified</th>
                <th>Opportunities</th>
                <th>Won deals</th>
                <th>Booked value</th>
                <th>Observed spend</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((r, i) => (
                <tr key={i}>
                  <td>
                    <button
                      className="mc-channel-link"
                      onClick={() => setEvidenceChannel(r.channel)}
                    >
                      <i style={{ background: colors[i % 5] }} />
                      {campaigns ? r.campaign || r.channel : r.channel}
                      <ArrowUpRight />
                    </button>
                  </td>
                  <td>{r.submissions.length}</td>
                  <td>{r.qualified.length}</td>
                  <td>{r.deals.length}</td>
                  <td>{r.won.length}</td>
                  <td>
                    {money(r.booked, currency)}
                    {r.missingAmounts > 0 ? " + unknown" : ""}
                  </td>
                  <td>
                    {r.spend === null ? (
                      <span className="mc-muted">Unknown</span>
                    ) : (
                      money(r.spend, currency)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!result.rows.length && (
          <p className="mc-table-empty">
            No confirmed production enquiries in this window. Test submissions
            appear in Leads.
          </p>
        )}
        <div className="mc-footnote">
          <Info />
          Booked deal value is not collected revenue. Attribution does not
          establish causal impact.
        </div>
      </section>
      {evidenceChannel && (
        <section className="mc-panel mc-detail" aria-label="Report evidence">
          <div className="mc-heading-row">
            <h2>
              {evidenceChannel === "all"
                ? "Report evidence"
                : evidenceChannel + " evidence"}
            </h2>
            <button onClick={() => setEvidenceChannel(null)}>
              Close evidence
            </button>
          </div>
          <p>
            {result.definition} ·{" "}
            {model === "first" ? "first touch" : "last non-direct"} ·{" "}
            {options.from} to {options.to} · {currency}
          </p>
          <p>{opportunityDefinition}</p>
          {result.rows
            .filter(
              (r) => evidenceChannel === "all" || r.channel === evidenceChannel,
            )
            .map((r, i) => (
              <div key={i} className="mc-evidence-group">
                <h3>{r.campaign || r.channel}</h3>
                <p>
                  {r.submissions.length} confirmed production submissions ·{" "}
                  {r.qualified.length} distinct qualified contacts ·{" "}
                  {r.deals.length} distinct opportunities · {r.won.length} won
                  deals
                </p>
                <details open>
                  <summary>Contributing submissions</summary>
                  <div className="mc-evidence-links">
                    {r.submissions.map((id) => (
                      <button
                        key={id}
                        className="mc-link"
                        onClick={() => {
                          const lead = w.submissions.find((s) => s.id === id);
                          if (lead) onLead(lead);
                        }}
                      >
                        {id.slice(0, 12)}
                        <ArrowUpRight />
                      </button>
                    ))}
                  </div>
                </details>
                <details>
                  <summary>Contributing contacts and deals</summary>
                  <p>
                    Qualified CRM contact IDs:{" "}
                    {r.qualified.join(", ") || "None"}
                  </p>
                  {r.deals.map((id) => {
                    const d = w.deals.find((d) => d.id === id)!;
                    return (
                      <p key={id}>
                        {d.id} · {d.stage} · {d.amount ?? "Unknown"}{" "}
                        {d.currency} · Primary contact: {d.primaryContactId}
                      </p>
                    );
                  })}
                </details>
                <details>
                  <summary>Observed cost records</summary>
                  {w.costs
                    .filter(
                      (c) =>
                        c.channel === r.channel &&
                        c.currency === currency &&
                        c.date >= options.from &&
                        c.date <= options.to &&
                        (!campaigns || c.campaignId === r.campaignId),
                    )
                    .map((c) => (
                      <p key={c.id}>
                        {c.date} · {c.campaignId} ·{" "}
                        {money(c.amount, c.currency)} · {c.source}
                      </p>
                    ))}
                </details>
              </div>
            ))}
        </section>
      )}
      {campaigns && (
        <section className="mc-panel mc-detail">
          <h2>ChatGPT campaign detail</h2>
          <p>
            Native inventory and delivery metrics are read-only. Campaign IDs
            link observed clicks to CRM evidence; names alone do not establish a
            match.
          </p>
          {(w.adInventory?.campaigns ?? [])
            .filter((c) => !campaign || c.id === campaign)
            .map((c) => (
              <details key={c.id}>
                <summary>
                  {c.name} · {c.status} · {c.id}
                </summary>
                <p>
                  {w.costs
                    .filter(
                      (cost) =>
                        cost.campaignId === c.id &&
                        cost.date >= options.from &&
                        cost.date <= options.to,
                    )
                    .reduce((sum, cost) => sum + (cost.clicks ?? 0), 0)}{" "}
                  observed clicks ·{" "}
                  {w.costs
                    .filter(
                      (cost) =>
                        cost.campaignId === c.id &&
                        cost.date >= options.from &&
                        cost.date <= options.to,
                    )
                    .reduce(
                      (sum, cost) => sum + (cost.impressions ?? 0),
                      0,
                    )}{" "}
                  observed impressions. See Integrations for the provider
                  coverage window.
                </p>
                {w.adInventory?.groups
                  .filter((g) => g.campaignId === c.id)
                  .map((g) => (
                    <div key={g.id}>
                      <h3>
                        {g.name} · {g.status}
                      </h3>
                      <ul>
                        {w.adInventory?.ads
                          .filter((a) => a.groupId === g.id)
                          .map((a) => (
                            <li key={a.id}>
                              {a.name} · {a.id} · {a.status}
                            </li>
                          ))}
                      </ul>
                    </div>
                  ))}
              </details>
            ))}
          {!w.adInventory && (
            <p>
              Native inventory is unavailable until an eligible advertiser
              account completes a successful sync.
            </p>
          )}
          <p className="mc-small">
            Provider click-through and view-through conversion totals are
            unavailable in this release. CRM-attributed outcomes remain
            separate; conversion feedback is disabled.
          </p>
        </section>
      )}
      <p className="mc-small">
        Spend is observed coverage only. Cost ratios remain unavailable until
        campaign and date coverage are verified. Provider-reported conversions
        are separate from CRM outcomes.
      </p>
    </>
  );
}
export function ModeNotice({ w }: { w: Workspace }) {
  return w.mode !== "live" ? (
    <div className="mc-notice">
      <Info />
      {w.mode === "sample"
        ? "Sample data — explore the workflow. These are not live customer results."
        : "Local test workspace — persisted locally. Provider access and payments are not verified."}
    </div>
  ) : null;
}
export function Empty({
  title,
  body,
  action,
  onClick,
}: {
  title: string;
  body: string;
  action?: string;
  onClick?: () => void;
}) {
  return (
    <div className="mc-empty">
      <h3>{title}</h3>
      <p>{body}</p>
      {action && (
        <button className="mc-primary" onClick={onClick}>
          {action}
          <ArrowUpRight />
        </button>
      )}
    </div>
  );
}
export function Leads({
  w,
  onLead,
}: {
  w: Workspace;
  onLead: (s: Submission) => void;
}) {
  const [search, setSearch] = useState(""),
    [channel, setChannel] = useState(""),
    [status, setStatus] = useState(""),
    [stage, setStage] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [page, setPage] = useState(0);
  const rows = w.submissions
    .filter(
      (s) =>
        (!channel || s.evidence.first.channel === channel) &&
        (!stage ||
          (w.contacts.find((c) => c.id === s.contactId)?.stage ??
            "unmatched") === stage) &&
        (!from || localDate(s.at, w.timezone) >= from) &&
        (!to || localDate(s.at, w.timezone) <= to) &&
        (!status ||
          (status === "test"
            ? s.test
            : status === "unmatched"
              ? !s.contactId
              : status === "fields_missing"
                ? Boolean(s.contactId && !s.crmFieldsVerifiedAt)
                : status === "fields_verified"
                  ? Boolean(s.crmFieldsVerifiedAt)
                  : status === "source_unknown"
                    ? s.evidence.first.channel === "Unknown" ||
                      s.evidence.first.conflict
                    : s.status === status)) &&
        [s.id, s.evidence.first.campaign, s.contactId]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const pageCount = Math.max(1, Math.ceil(rows.length / 50));
  const currentPage = Math.min(page, pageCount - 1);
  return (
    <>
      <div className="mc-heading">
        <h1>The journey behind every enquiry.</h1>
        <p>
          Confirmed submissions, CRM identities and the evidence that connects
          them.
        </p>
      </div>
      <ModeNotice w={w} />
      <div className="mc-toolbar">
        <label className="mc-search">
          <Search />
          <input
            aria-label="Search leads"
            placeholder="Search lead, campaign or CRM ID"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select
          aria-label="Filter channel"
          value={channel}
          onChange={(e) => {
            setChannel(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All channels</option>
          {[...new Set(w.submissions.map((s) => s.evidence.first.channel))].map(
            (c) => (
              <option key={c}>{c}</option>
            ),
          )}
        </select>
        <select
          aria-label="Filter status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All submissions</option>
          <option value="confirmed">Confirmed</option>
          <option value="attempted">Awaiting confirmation</option>
          <option value="test">Test submissions</option>
          <option value="unmatched">CRM unmatched</option>
          <option value="fields_missing">CRM fields unverified</option>
          <option value="fields_verified">CRM fields verified</option>
          <option value="source_unknown">Source unknown or conflicting</option>
        </select>
        <select
          aria-label="Filter lifecycle stage"
          value={stage}
          onChange={(e) => {
            setStage(e.target.value);
            setPage(0);
          }}
        >
          <option value="">All stages</option>
          <option value="unmatched">Unmatched</option>
          {[...new Set(w.contacts.map((c) => c.stage))].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <label>
          From{" "}
          <input
            type="date"
            aria-label="Leads from date"
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            aria-label="Leads to date"
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <span className="mc-muted">
          {rows.length} records · {w.timezone}
        </span>
      </div>
      <div
        className="mc-panel mc-table-scroll"
        role="region"
        aria-label="Leads table"
        tabIndex={0}
      >
        <table>
          <thead>
            <tr>
              <th>Lead reference</th>
              <th>First source</th>
              <th>Campaign</th>
              <th>Stage</th>
              <th>Delivery</th>
              <th>Captured</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(currentPage * 50, (currentPage + 1) * 50).map((s) => (
              <tr key={s.id}>
                <td>
                  <button className="mc-link" onClick={() => onLead(s)}>
                    {s.id.slice(0, 12)}
                    <ArrowUpRight />
                  </button>
                  {s.test && <span className="mc-tag">Test</span>}
                </td>
                <td>{s.evidence.first.channel}</td>
                <td>{s.evidence.first.campaign || "Not supplied"}</td>
                <td>
                  {w.contacts.find((c) => c.id === s.contactId)?.stage ||
                    "Unmatched"}
                </td>
                <td>
                  <span
                    className={`mc-status ${s.crmFieldsVerifiedAt ? "good" : ""}`}
                  >
                    {s.crmFieldsVerifiedAt
                      ? "CRM fields verified"
                      : s.crmVerifiedAt
                        ? "Contact matched"
                        : s.status === "confirmed"
                          ? "Form confirmed"
                          : "Attempt only"}
                  </span>
                </td>
                <td>{new Date(s.at).toLocaleDateString("en-IE")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && (
          <Empty
            title="No leads match this view."
            body="Adjust the filters or complete a test form from Websites & forms."
          />
        )}
      </div>
      {rows.length > 50 && (
        <div className="mc-toolbar" aria-label="Lead pages">
          <button
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </button>
          <span>
            Page {currentPage + 1} of {pageCount} · newest first
          </span>
          <button
            disabled={currentPage + 1 === pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </button>
        </div>
      )}
    </>
  );
}
export function LeadDetail({
  w,
  lead,
  onBack,
}: {
  w: Workspace;
  lead: Submission;
  onBack: () => void;
}) {
  const portal = w.connectors.find((c) => c.provider === "hubspot")?.accountId;
  return (
    <>
      <button className="mc-link" onClick={onBack}>
        Back to leads
      </button>
      <div className="mc-heading">
        <h1>Lead {lead.id.slice(0, 12)}</h1>
        <p>
          {lead.test
            ? "Diagnostic submission · excluded from production usage"
            : "Acquisition evidence and CRM outcomes"}
        </p>
      </div>
      <ModeNotice w={w} />
      <div className="mc-detail-layout">
        <section className="mc-panel mc-detail">
          <h2>Acquisition timeline</h2>
          {(
            [
              ["First observed touch", lead.evidence.first],
              ["Latest non-direct touch", lead.evidence.latest],
            ] as const
          ).map(([label, t]) => (
            <div className="mc-timeline-item" key={label}>
              <span className="mc-timeline-dot" />
              <p className="mc-small">
                {label} · {new Date(t.at).toLocaleString("en-IE")}
              </p>
              <h3>{t.channel}</h3>
              <p>
                {t.source} / {t.medium || "not supplied"} ·{" "}
                {t.campaign || "No campaign tag"}
              </p>
              <p>{t.reason}</p>
              <dl>
                <dt>Landing page</dt>
                <dd>{t.landing}</dd>
                <dt>Campaign ID</dt>
                <dd>{t.campaignId || "Missing"}</dd>
                <dt>Click reference</dt>
                <dd>
                  {t.oppref ? "Retained in protected fields" : "Not observed"}
                </dd>
                <dt>Classification rule</dt>
                <dd>{t.rule}</dd>
              </dl>
            </div>
          ))}
        </section>
        <section className="mc-panel mc-detail">
          <h2>Form → CRM handoff</h2>
          <dl>
            <dt>Submission</dt>
            <dd>{lead.status}</dd>
            <dt>Confirmation</dt>
            <dd>{lead.confirmation ?? "Not confirmed"}</dd>
            <dt>Form</dt>
            <dd>{lead.formId}</dd>
            <dt>CRM contact</dt>
            <dd>{lead.contactId || "Unmatched"}</dd>
            <dt>Last contact identity match</dt>
            <dd>
              {lead.crmVerifiedAt
                ? new Date(lead.crmVerifiedAt).toLocaleString()
                : "Not verified"}
            </dd>
            <dt>Attribution field delivery</dt>
            <dd>
              {lead.crmFieldsVerifiedAt
                ? `Verified ${new Date(lead.crmFieldsVerifiedAt).toLocaleString("en-IE")}`
                : "Not verified — a contact match alone does not prove field delivery."}
            </dd>
          </dl>
          {lead.crmFieldDiagnostics?.status === "not_current" && (
            <p className="mc-small">
              This submission appears in contact history. Current CRM field
              values belong to a later submission, so they cannot verify this
              handoff.
            </p>
          )}
          {Boolean(lead.crmFieldDiagnostics?.missing.length) && (
            <p className="mc-error">
              Missing mapped fields:{" "}
              {lead.crmFieldDiagnostics!.missing.join(", ")}. Add these
              dedicated properties to the form, then send a fresh diagnostic
              submission and sync HubSpot.
            </p>
          )}
          {Boolean(lead.crmFieldDiagnostics?.mismatched.length) && (
            <p className="mc-error">
              Different mapped values:{" "}
              {lead.crmFieldDiagnostics!.mismatched.join(", ")}. Review the
              mapping and any manual CRM corrections before retesting. Customer
              corrections are not overwritten.
            </p>
          )}
          {portal && portal !== "example" && lead.contactId && (
            <a
              className="mc-link"
              href={`https://app.hubspot.com/contacts/${encodeURIComponent(portal)}/record/0-1/${encodeURIComponent(lead.contactId)}`}
              target="_blank"
              rel="noreferrer"
            >
              Open HubSpot record <ArrowUpRight />
            </a>
          )}
          <h2 className="mc-space-top">Associated deals</h2>
          {w.deals
            .filter(
              (d) => lead.contactId && d.contacts.includes(lead.contactId),
            )
            .map((d) => (
              <div className="mc-deal" key={d.id}>
                <strong>{d.id}</strong>
                <p>
                  {d.stage} ·{" "}
                  {d.amount === null
                    ? "Unknown amount"
                    : d.currency === "UNKNOWN"
                      ? `${d.amount} (currency unknown)`
                      : money(d.amount, d.currency)}
                </p>
                <p className="mc-small">
                  Primary attribution contact:{" "}
                  {d.primaryContactId || "Unresolved"}
                </p>
                {d.history.map((h, i) => (
                  <p className="mc-small" key={i}>
                    {h.at.slice(0, 10)} · {h.stage}
                  </p>
                ))}
              </div>
            ))}
          {!w.deals.some(
            (d) => lead.contactId && d.contacts.includes(lead.contactId),
          ) && (
            <p className="mc-muted">
              No associated deals in the latest CRM snapshot.
            </p>
          )}
        </section>
      </div>
    </>
  );
}
