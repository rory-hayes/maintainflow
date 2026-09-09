"use client";
import { useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import {
  defaultMapping,
  usage,
  workspaceRetentionDays,
  type Workspace,
  type Site,
} from "@/lib/attribution/model";
import { ModeNotice, download, Empty } from "./reporting";
import { NotificationSettings } from "./notification-settings";
export type Act = (body: Record<string, unknown>) => Promise<void>;
export function Setup({
  w,
  act,
  onView,
}: {
  w: Workspace;
  act: Act;
  onView: (view: string) => void;
}) {
  const steps = [
    {
      title: "Add your website",
      body: "Choose the supported form adapter and consent policy.",
      ready: w.sites.length > 0,
      view: "Websites & forms",
    },
    {
      title: "Install and test the script",
      body: "First source survives navigation. The business form keeps its existing handler.",
      ready: w.sites.some((s) => s.installedAt),
      view: "Websites & forms",
    },
    {
      title: "Verify form delivery in HubSpot",
      body: "A test submission must match a CRM contact and its mapped attribution values before this step is complete.",
      ready: w.sites.some((s) => s.verifiedAt),
      view: "Integrations",
    },
    {
      title: "Connect lifecycle and deals",
      body: "Define qualified and won stages, then select primary attribution contacts.",
      ready: w.connectors.some((c) => c.provider === "hubspot" && c.syncedAt),
      view: "Integrations",
    },
    {
      title: "Add campaign costs (optional)",
      body: "Connect an eligible ChatGPT Ads account or import a validated cost CSV.",
      ready: w.costs.length > 0,
      view: "Integrations",
    },
  ];
  return (
    <>
      <div className="mc-heading">
        <h1>From first visit to a won customer.</h1>
        <p>Five clear steps. Each connection earns its own verification.</p>
      </div>
      <ModeNotice w={w} />
      <div className="mc-setup-progress">
        <span>{steps.filter((s) => s.ready).length} of 5 steps complete</span>
        <progress value={steps.filter((s) => s.ready).length} max={5} />
      </div>
      <section className="mc-panel">
        {steps.map((s, i) => (
          <div className="mc-setup-step" key={s.title}>
            <span className={`mc-step-number ${s.ready ? "done" : ""}`}>
              {s.ready ? <Check /> : i + 1}
            </span>
            <div>
              <h2>{s.title}</h2>
              <p>{s.body}</p>
            </div>
            <button onClick={() => onView(s.view)}>
              {s.ready ? "Review" : "Continue"}
              <ExternalLink />
            </button>
          </div>
        ))}
      </section>
      {w.mode === "sample" && (
        <p className="mc-small">
          Sample completion indicators describe example data only. Real CRM
          arrival requires an authorized account.
        </p>
      )}
      {w.mode !== "sample" && (
        <button className="mc-link" onClick={() => act({ action: "purge" })}>
          Apply retention to expired records
        </button>
      )}
    </>
  );
}
export function Websites({ w, act }: { w: Workspace; act: Act }) {
  const [editing, setEditing] = useState<Site | null>(null);
  const [adding, setAdding] = useState(w.sites.length === 0),
    [copied, setCopied] = useState(""),
    [fieldMap, setFieldMap] = useState(JSON.stringify(defaultMapping, null, 2)),
    [formError, setFormError] = useState("");
  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError("");
    const data = new FormData(e.currentTarget);
    try {
      await act({
        action: "site",
        siteId: editing?.id,
        name: data.get("name"),
        origin: data.get("origin"),
        consent: data.get("consent"),
        adapter: data.get("adapter"),
        formSelector: data.get("selector"),
        mapping: JSON.parse(fieldMap),
      });
      setAdding(false);
      setEditing(null);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Could not save website.");
    }
  }
  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setCopied("Copy unavailable. Select the snippet below.");
    }
  }
  return (
    <>
      <div className="mc-heading mc-heading-row">
        <div>
          <h1>Your website. Your forms. Connected.</h1>
          <p>Attribution fields travel with your existing form submission.</p>
        </div>
        <button
          className="mc-primary"
          onClick={() => {
            setEditing(null);
            setFieldMap(JSON.stringify(defaultMapping, null, 2));
            setAdding(!adding);
          }}
        >
          <Plus />
          Add website
        </button>
      </div>
      <ModeNotice w={w} />
      {adding && (
        <form
          key={editing?.id ?? "new"}
          className="mc-panel mc-form"
          onSubmit={add}
        >
          <h2>{editing ? "Edit website and mappings" : "Add a website"}</h2>
          <div className="mc-form-grid">
            <label>
              Website name
              <input
                name="name"
                required
                defaultValue={editing?.name}
                placeholder="Company website"
                minLength={2}
              />
            </label>
            <label>
              Website origin
              <input
                name="origin"
                required
                type="url"
                defaultValue={editing?.origin}
                placeholder="https://example.com"
              />
            </label>
            <label>
              Supported form path
              <select name="adapter" defaultValue={editing?.adapter}>
                <option value="html">Standard same-origin HTML form</option>
                <option value="hubspot_v4">
                  HubSpot updated forms editor (V4)
                </option>
              </select>
            </label>
            <label>
              Consent policy
              <select name="consent" defaultValue={editing?.consent}>
                <option value="required">Wait for consent (recommended)</option>
                <option value="not_required">
                  Consent not required under my configuration
                </option>
              </select>
            </label>
            <label>
              HTML form selector
              <input
                name="selector"
                required
                defaultValue={editing?.formSelector ?? "form[data-attribution]"}
              />
            </label>
          </div>
          <label>
            Explicit field mapping (JSON)
            <textarea
              aria-label="Field mapping"
              rows={6}
              value={fieldMap}
              onChange={(e) => setFieldMap(e.target.value)}
            />
          </label>
          <p className="mc-small">
            Only mapped hidden fields are filled. Create dedicated HubSpot
            contact properties and add them to the form before testing. Existing
            visible fields are never changed.
          </p>
          {formError && (
            <p role="alert" className="mc-error">
              {formError}
            </p>
          )}
          <button className="mc-primary">Save website</button>
        </form>
      )}
      {w.sites.map((site) => {
        const endpoint = typeof location !== "undefined" ? location.origin : "";
        const snippet = `<script async src="${endpoint}/t/${site.id}"></script>`;
        return (
          <section className="mc-panel mc-detail" key={site.id}>
            <div className="mc-heading-row">
              <div>
                <h2>{site.name}</h2>
                <p>
                  {site.origin} ·{" "}
                  {site.adapter === "html" ? "Standard HTML" : "HubSpot V4"}
                </p>
              </div>
              <button
                onClick={() =>
                  act({
                    action: "pause",
                    siteId: site.id,
                    paused: !site.paused,
                  }).catch(() => {})
                }
              >
                {site.paused ? <Play /> : <Pause />}
                {site.paused ? "Resume" : "Pause"}
              </button>
            </div>
            <div className="mc-status-line">
              <span className={`mc-status ${site.installedAt ? "good" : ""}`}>
                {site.installedAt
                  ? "Capture received"
                  : "Awaiting first capture"}
              </span>
              <span className={`mc-status ${site.verifiedAt ? "good" : ""}`}>
                {site.verifiedAt
                  ? "CRM test verified"
                  : "CRM test not verified"}
              </span>
              <span>
                {site.consent === "required"
                  ? "Consent required"
                  : "Consent not required"}{" "}
                · {site.retentionDays} days
              </span>
            </div>
            <button
              onClick={() => {
                setEditing(site);
                setFieldMap(JSON.stringify(site.mapping, null, 2));
                setAdding(true);
              }}
            >
              Edit website and mappings
            </button>
            <h3>1. Install on every page</h3>
            <div className="mc-code">
              <pre>{snippet}</pre>
              <button
                aria-label="Copy installation snippet"
                onClick={() => copy(site.id, snippet)}
              >
                <Copy />
              </button>
            </div>
            {copied === site.id && (
              <p role="status">Copied installation snippet.</p>
            )}
            <h3>2. Connect consent and form success</h3>
            <pre className="mc-code-block">{`// Run after the tracker loads and consent is granted:\nwindow.MaintainCode?.setConsent(true);\n// On withdrawal:\nwindow.MaintainCode?.setConsent(false);\n${site.adapter === "html" ? "// Only after your existing handler confirms success:\nwindow.MaintainCode?.confirm(document.querySelector(" + JSON.stringify(site.formSelector) + "));" : "// V4 on-ready and on-submission:success events are handled automatically."}`}</pre>
            <p>
              The tracker never prevents submission. Standard HTML posts need a
              documented success callback or a later CRM match; a submit attempt
              alone is not counted.
            </p>
            <h3>3. Verify a diagnostic submission</h3>
            <p>
              For a test, install the script with <code>?test=1</code>. Submit
              the form, sync HubSpot, then inspect the matching test lead. The
              contact identity and mapped attribution fields must both match.
            </p>
            <details>
              <summary>View mapped fields</summary>
              <dl>
                {Object.entries(site.mapping).map(([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </details>
            <button
              className="mc-danger"
              onClick={() => {
                if (
                  window.confirm(
                    `Delete ${site.name} and its captured submissions?`,
                  )
                )
                  void act({ action: "delete_site", siteId: site.id }).catch(
                    () => {},
                  );
              }}
            >
              <Trash2 />
              Delete website data
            </button>
          </section>
        );
      })}
      <p className="mc-small">
        Locally tested adapter logic: standard same-origin HTML and HubSpot
        updated-editor V4 events. A real CRM handoff is still required for each
        installation. Legacy HubSpot, Gravity Forms and Webflow-specific
        adapters are not yet supported.
      </p>
    </>
  );
}
export function Integrations({ w, act }: { w: Workspace; act: Act }) {
  const [provider, setProvider] = useState<"hubspot" | "openai" | null>(null),
    [csv, setCsv] = useState(
      "date,campaign_id,campaign,channel,currency,spend\n",
    ),
    [error, setError] = useState("");
  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    try {
      await act({
        action: "connect",
        provider,
        token: data.get("token"),
        accountId: data.get("accountId"),
      });
      setProvider(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Connection failed.");
    }
  }
  return (
    <>
      <div className="mc-heading">
        <h1>Connect the evidence.</h1>
        <p>
          Source capture, CRM outcomes and campaign costs have separate
          connections.
        </p>
      </div>
      <ModeNotice w={w} />
      <section className="mc-panel">
        {(["hubspot", "openai"] as const).map((p) => {
          const c = w.connectors.find((c) => c.provider === p);
          return (
            <div className="mc-integration" key={p}>
              <span className={`mc-provider ${p}`}>
                {p === "hubspot" ? "H" : "AI"}
              </span>
              <div className="mc-integration-info">
                <h2>{p === "hubspot" ? "HubSpot" : "ChatGPT Ads"}</h2>
                <p>
                  {p === "hubspot"
                    ? "Read lifecycle stages, contact identities and associated deals."
                    : "Read campaign spend, clicks and impressions. No campaign modifications."}
                </p>
                <span
                  className={`mc-status ${c?.status === "connected" ? "good" : ""}`}
                >
                  {c?.status ?? "Not connected"}
                </span>
                {c?.syncedAt && (
                  <p className="mc-small">
                    Last successful sync:{" "}
                    {new Date(c.syncedAt).toLocaleString("en-IE")}
                    {c.timezone ? ` · ${c.timezone}` : ""}
                  </p>
                )}
                {c?.coverage && (
                  <p className="mc-small">Coverage: {c.coverage}</p>
                )}
                {c?.error && <p className="mc-error">{c.error}</p>}
              </div>
              <div className="mc-integration-actions">
                {c && c.status !== "revoked" ? (
                  <>
                    <button
                      onClick={() =>
                        act({ action: "sync", provider: p }).catch(() => {})
                      }
                    >
                      <RefreshCw />
                      Sync now
                    </button>
                    <button
                      onClick={() =>
                        act({ action: "revoke", provider: p }).catch(() => {})
                      }
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button onClick={() => setProvider(p)}>
                    Connect
                    <ExternalLink />
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </section>
      {provider && (
        <form className="mc-panel mc-form" onSubmit={connect}>
          <h2>Connect {provider === "hubspot" ? "HubSpot" : "ChatGPT Ads"}</h2>
          <p>
            {provider === "hubspot"
              ? "Use a private app token with crm.objects.contacts.read and crm.objects.deals.read. Create the mapped contact properties first. Portal ID is used for CRM links."
              : "Use the API key from Ads Manager for this advertiser account. An OpenAI Platform key does not work. Read-only account access must be enabled on the server."}
          </p>
          <div className="mc-form-grid">
            <label>
              {provider === "hubspot"
                ? "HubSpot portal ID"
                : "Expected advertiser account ID"}
              <input name="accountId" required autoComplete="off" />
            </label>
            <label>
              Account token
              <input
                name="token"
                required
                type="password"
                autoComplete="new-password"
              />
            </label>
          </div>
          <p className="mc-small">
            Encrypted in the server-side credential vault. The connector
            validates reads before marking the account connected.
          </p>
          {error && (
            <p role="alert" className="mc-error">
              {error}
            </p>
          )}
          <button className="mc-primary">Verify and connect</button>
          <button type="button" onClick={() => setProvider(null)}>
            Cancel
          </button>
        </form>
      )}
      <section className="mc-panel mc-form">
        <h2>Import campaign costs</h2>
        <p>
          Google, Meta and LinkedIn source tags work without native API
          connections. Import costs with stable campaign IDs, original currency
          and one row per day.
        </p>
        <label>
          Cost CSV
          <textarea
            aria-label="Cost CSV"
            rows={6}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
          />
        </label>
        <div className="mc-toolbar">
          <button
            className="mc-primary"
            onClick={() => act({ action: "costs", csv }).catch(() => {})}
          >
            Validate and import
          </button>
          <button
            onClick={() =>
              download(
                "cost-template.csv",
                "date,campaign_id,campaign,channel,currency,spend\n2026-09-01,campaign-123,Search campaign,Paid search,EUR,100.00\n",
              )
            }
          >
            Download template
          </button>
        </div>
        <p className="mc-small">
          Reimports replace matching date/campaign/currency rows. Overlap with
          native OpenAI spend is rejected. Missing costs remain unknown.
        </p>
      </section>
      <section className="mc-panel mc-detail">
        <h2>Conversion feedback</h2>
        <p>
          Not enabled. Connecting reporting does not send conversion events or
          change campaigns. Provider conversion totals remain distinct from
          CRM-attributed outcomes.
        </p>
      </section>
    </>
  );
}
export function Health({
  w,
  act,
  onView,
}: {
  w: Workspace;
  act: Act;
  onView: (v: string) => void;
}) {
  const [healthNow] = useState(() => Date.now());
  const attempts = w.submissions.filter((s) => s.status === "attempted"),
    unmatched = w.submissions.filter((s) => !s.contactId),
    ambiguous = w.submissions.filter(
      (s) =>
        s.evidence.first.channel === "Unknown" || s.evidence.first.conflict,
    );
  return (
    <>
      <div className="mc-heading">
        <h1>Know where evidence goes missing.</h1>
        <p>
          Recover incomplete handoffs without guessing where a sale came from.
        </p>
      </div>
      <ModeNotice w={w} />
      <section className="mc-panel">
        {[
          {
            title: "Form confirmation",
            count: attempts.length,
            body: "Submit attempts still awaiting a success callback or CRM match.",
            view: "Websites & forms",
          },
          {
            title: "CRM matching",
            count: unmatched.length,
            body: "Submissions without one unambiguous CRM contact identity.",
            view: "Integrations",
          },
          {
            title: "Attribution field delivery",
            count: w.submissions.filter(
              (s) => s.contactId && !s.crmFieldsVerifiedAt,
            ).length,
            body: "Matched contacts whose mapped source values have not been verified. Open a lead to inspect missing or different fields.",
            view: "Leads",
          },
          {
            title: "Source classification",
            count: ambiguous.length,
            body: "Ambiguous or conflicting acquisition evidence remains unknown.",
            view: "Leads",
          },
          {
            title: "Connector freshness",
            count: w.connectors.filter(
              (c) =>
                c.status !== "connected" ||
                !c.syncedAt ||
                healthNow - Date.parse(c.syncedAt) > 86400000,
            ).length,
            body: "Failed, revoked or more than 24-hour-old snapshots.",
            view: "Integrations",
          },
        ].map((row) => (
          <div className="mc-health-row" key={row.title}>
            <strong>{row.count}</strong>
            <div>
              <h2>{row.title}</h2>
              <p>{row.body}</p>
            </div>
            <button onClick={() => onView(row.view)}>
              Review
              <ExternalLink />
            </button>
          </div>
        ))}
      </section>
      <section className="mc-panel mc-detail">
        <h2>Unresolved deal attribution</h2>
        <p>
          Choose an explicit primary contact from the deal’s associated
          contacts. Multiple contacts never multiply deal value.
        </p>
        {w.deals
          .filter((d) => !d.primaryContactId)
          .map((d) => (
            <div className="mc-health-row" key={d.id}>
              <span>{d.id}</span>
              <select
                aria-label={`Primary contact for ${d.id}`}
                defaultValue=""
                onChange={(e) =>
                  act({
                    action: "primary",
                    dealId: d.id,
                    contactId: e.target.value,
                  }).catch(() => {})
                }
              >
                <option value="" disabled>
                  Choose primary contact
                </option>
                {d.contacts.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          ))}
        {!w.deals.some((d) => !d.primaryContactId) && (
          <p className="mc-muted">
            No unresolved primary-contact selections in this snapshot.
          </p>
        )}
      </section>
    </>
  );
}
export function Settings({ w, act }: { w: Workspace; act: Act }) {
  const [billingError, setBillingError] = useState("");
  async function billing(action: string, plan = "starter", interval = "month") {
    try {
      const response = await fetch(`/api/attribution/billing`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: w.id, action, plan, interval }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      location.href = result.url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : "Billing unavailable.");
    }
  }
  return (
    <>
      <div className="mc-heading">
        <h1>Your workspace, on your terms.</h1>
        <p>
          Reporting definitions, data retention and subscription administration.
        </p>
      </div>
      <ModeNotice w={w} />
      <NotificationSettings key={w.id} workspaceId={w.id} mode={w.mode} />
      <form
        className="mc-panel mc-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          await act({
            action: "settings",
            name: data.get("name"),
            timezone: data.get("timezone"),
            qualifiedStages: String(data.get("qualified"))
              .split(",")
              .map((s) => s.trim()),
            wonStages: String(data.get("won"))
              .split(",")
              .map((s) => s.trim()),
            retentionDays: Number(data.get("retention")),
            submissionProperty: data.get("submission"),
            primaryContactProperty: data.get("primary"),
          });
        }}
      >
        <h2>Reporting settings</h2>
        <div className="mc-form-grid">
          <label>
            Workspace name
            <input name="name" defaultValue={w.name} required />
          </label>
          <label>
            Account timezone
            <input name="timezone" defaultValue={w.timezone} required />
          </label>
          <label>
            Qualified lifecycle stages
            <input
              name="qualified"
              defaultValue={w.qualifiedStages.join(", ")}
              required
            />
          </label>
          <label>
            Won deal stages
            <input name="won" defaultValue={w.wonStages.join(", ")} required />
          </label>
          <label>
            CRM submission property
            <input
              name="submission"
              defaultValue={w.submissionProperty}
              required
            />
          </label>
          <label>
            CRM primary contact property
            <input
              name="primary"
              defaultValue={w.primaryContactProperty}
              required
            />
          </label>
          <label>
            Retention days
            <input
              name="retention"
              type="number"
              min={1}
              max={90}
              defaultValue={workspaceRetentionDays(w)}
            />
          </label>
        </div>
        <button className="mc-primary">Save settings</button>
      </form>
      <section className="mc-panel mc-detail">
        <h2>Subscription & usage</h2>
        <div className="mc-billing-summary">
          <div>
            <strong>
              {usage(w)} / {w.billing.plan === "agency" ? 2500 : 500}
            </strong>
            <p>confirmed production submissions this month</p>
          </div>
          <div>
            <strong>{w.billing.status}</strong>
            <p>
              {w.billing.status === "trialing"
                ? `Trial ends ${new Date(w.billing.trialEndsAt).toLocaleDateString("en-IE")}`
                : w.billing.plan}
            </p>
          </div>
        </div>
        <p>
          Retries and diagnostic submissions count once or are excluded. No
          automatic overage charges. Your underlying form is never blocked by
          billing.
        </p>
        <div className="mc-price-row">
          <div>
            <h3>Business · €49 / month</h3>
            <p>1 active website · 500 monthly submissions</p>
            <button
              disabled={w.mode === "sample"}
              onClick={() => billing("checkout", "starter")}
            >
              Choose monthly
            </button>
            <button
              disabled={w.mode === "sample"}
              onClick={() => billing("checkout", "starter", "year")}
            >
              Annual · €490
            </button>
          </div>
          <div>
            <h3>Agency · €149 / month</h3>
            <p>5 active websites · 2,500 pooled submissions</p>
            <button
              disabled={w.mode === "sample"}
              onClick={() => billing("checkout", "agency")}
            >
              Choose monthly
            </button>
            <button
              disabled={w.mode === "sample"}
              onClick={() => billing("checkout", "agency", "year")}
            >
              Annual · €1,490
            </button>
          </div>
        </div>
        <button
          disabled={w.mode === "sample"}
          onClick={() => billing("portal")}
        >
          Manage subscription / cancel
        </button>
        {billingError && (
          <p role="alert" className="mc-error">
            {billingError}
          </p>
        )}
        <p className="mc-small">
          {w.mode === "sample"
            ? "Billing is unavailable in sample mode."
            : "If checkout or subscription management is unavailable, contact support for help."}
        </p>
      </section>
      <section className="mc-panel mc-detail">
        <h2>Data controls</h2>
        <p>
          Exports contain attribution and CRM IDs, with click references
          protected. Deleting a website removes its submissions. Retention
          removes expired attribution and unreferenced CRM records.
        </p>
        <div className="mc-toolbar">
          <button
            onClick={() =>
              download(
                `${w.mode}-workspace.json`,
                JSON.stringify(w, null, 2),
                "application/json",
              )
            }
          >
            Export workspace data
          </button>
          <button onClick={() => act({ action: "purge" })}>
            Apply retention
          </button>
        </div>
      </section>
    </>
  );
}
export function NewWorkspace({
  onCreate,
}: {
  onCreate: (name: string, agency: boolean) => Promise<void>;
}) {
  return (
    <div className="mc-onboarding">
      <h1>Give your marketing a clear trail.</h1>
      <p>
        Create a workspace. Website capture works independently of an advertiser
        account.
      </p>
      <form
        className="mc-form"
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          void onCreate(String(data.get("name")), data.get("agency") === "on");
        }}
      >
        <label>
          Workspace name
          <input
            name="name"
            required
            minLength={2}
            placeholder="Your business or client"
          />
        </label>
        <label className="mc-checkbox">
          <input type="checkbox" name="agency" />
          Agency workspace (five active websites)
        </label>
        <button className="mc-primary">
          Create workspace
          <Plus />
        </button>
      </form>
      <Empty
        title="Already have a workspace?"
        body="Sign in with an authorized account. Workspaces are listed only when your account has a membership."
      />
    </div>
  );
}
