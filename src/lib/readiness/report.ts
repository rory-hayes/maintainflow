import type { ConversionMeasurementReadiness } from "../openai-ads/measurement-readiness";
import { formatUtcDateTime } from "../formatting";
import type { ConversionPayloadAudit } from "./conversions-api";
import type { ProductFeedAudit } from "./product-feed";
import type { ReadinessAudit, ReadinessCheck } from "./schema";

export type ReadinessReportInput = {
  generatedAt: string;
  storefront: ReadinessAudit | null;
  productFeed: ProductFeedAudit | null;
  conversionsApi: ConversionPayloadAudit | null;
  accountMeasurement: ConversionMeasurementReadiness;
};

export type ReadinessReportVerdict =
  | "ready_for_review"
  | "partial"
  | "needs_work"
  | "not_ready";

export type ReadinessReportSection = {
  id: "storefront" | "product_feed" | "conversions_api" | "account_measurement";
  label: string;
  complete: boolean;
  result: string;
};

export type ReadinessReportSummary = {
  canExport: boolean;
  isComplete: boolean;
  completedSections: number;
  totalSections: number;
  verdict: ReadinessReportVerdict;
  verdictLabel: string;
  sections: ReadinessReportSection[];
};

const REPORT_SOURCES = [
  [
    "Advertiser crawler guidance",
    "https://help.openai.com/en/articles/20001243-advertiser-guidance-for-allowing-openai-web-crawlers",
  ],
  ["Measurement Pixel", "https://developers.openai.com/ads/measurement-pixel"],
  ["Ads product feeds", "https://developers.openai.com/ads/product-feeds"],
  [
    "Product feed specification",
    "https://developers.openai.com/commerce/specs/file-upload/products",
  ],
  ["Conversions API", "https://developers.openai.com/ads/conversions-api"],
  ["Supported events", "https://developers.openai.com/ads/supported-events"],
  [
    "Conversion setup",
    "https://developers.openai.com/ads/api-reference/conversion-setup",
  ],
] as const;

function reportVerdictLabel(verdict: ReadinessReportVerdict) {
  if (verdict === "ready_for_review") return "Ready for human review";
  if (verdict === "partial") return "Partial evidence";
  if (verdict === "needs_work") return "Needs work";
  return "Not ready";
}

function storefrontLabel(audit: ReadinessAudit | null) {
  if (!audit) return "Not run";
  if (audit.verdict === "ready") return `${audit.score}/100 · ready for review`;
  if (audit.verdict === "needs_work") return `${audit.score}/100 · needs work`;
  return `${audit.score}/100 · not ready`;
}

function productFeedLabel(audit: ProductFeedAudit | null) {
  if (!audit) return "Not run";
  if (audit.verdict === "ready") return "Ready for upload review";
  if (audit.verdict === "invalid") return "Invalid file structure";
  return "Products need attention";
}

function conversionsApiLabel(audit: ConversionPayloadAudit | null) {
  if (!audit) return "Not run";
  if (audit.verdict === "ready_for_validation") return "Ready for validate-only review";
  if (audit.verdict === "needs_attention") return "Warnings need review";
  return "Payload has blockers";
}

function accountMeasurementComplete(readiness: ConversionMeasurementReadiness) {
  return readiness.source === "live" && readiness.status !== "unavailable";
}

function accountMeasurementLabel(readiness: ConversionMeasurementReadiness) {
  if (!accountMeasurementComplete(readiness)) return "Not checked with a live account";
  if (readiness.status === "ready") return "Measurement ready";
  if (readiness.status === "needs_attention") return "Needs attention";
  return "No active conversion campaigns";
}

export function getReadinessReportSummary(
  input: Omit<ReadinessReportInput, "generatedAt">,
): ReadinessReportSummary {
  const sections: ReadinessReportSection[] = [
    {
      id: "storefront",
      label: "Storefront",
      complete: Boolean(input.storefront),
      result: storefrontLabel(input.storefront),
    },
    {
      id: "product_feed",
      label: "Product feed",
      complete: Boolean(input.productFeed),
      result: productFeedLabel(input.productFeed),
    },
    {
      id: "conversions_api",
      label: "Conversions API batch",
      complete: Boolean(input.conversionsApi),
      result: conversionsApiLabel(input.conversionsApi),
    },
    {
      id: "account_measurement",
      label: "Connected-account measurement",
      complete: accountMeasurementComplete(input.accountMeasurement),
      result: accountMeasurementLabel(input.accountMeasurement),
    },
  ];
  const completedSections = sections.filter((section) => section.complete).length;
  const isComplete = completedSections === sections.length;
  const hasHardFailure =
    input.storefront?.verdict === "not_ready" ||
    input.productFeed?.verdict === "invalid" ||
    input.conversionsApi?.verdict === "invalid";
  const hasAttention =
    input.storefront?.verdict === "needs_work" ||
    input.productFeed?.verdict === "needs_work" ||
    input.conversionsApi?.verdict === "needs_attention" ||
    (accountMeasurementComplete(input.accountMeasurement) &&
      input.accountMeasurement.status === "needs_attention");
  const verdict: ReadinessReportVerdict = hasHardFailure
    ? "not_ready"
    : hasAttention
      ? "needs_work"
      : completedSections < sections.length
        ? "partial"
        : "ready_for_review";

  return {
    canExport: completedSections > 0,
    isComplete,
    completedSections,
    totalSections: sections.length,
    verdict,
    verdictLabel: reportVerdictLabel(verdict),
    sections,
  };
}

function escapeHtml(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatUtc(value: string) {
  return formatUtcDateTime(value, { fallback: "Unknown time" });
}

function statusClass(status: "pass" | "warning" | "fail") {
  if (status === "pass") return "pass";
  if (status === "warning") return "warning";
  return "fail";
}

function checkRows(checks: ReadinessCheck[]) {
  if (checks.length === 0) return '<p class="empty">No checks were returned.</p>';
  return `<div class="checks">${checks
    .map(
      (check) => `<article class="check">
        <div class="check-heading">
          <h3>${escapeHtml(check.title)}</h3>
          <span class="pill ${statusClass(check.status)}">${escapeHtml(check.status)}</span>
        </div>
        <p>${escapeHtml(check.evidence)}</p>
        ${
          check.status === "pass"
            ? ""
            : `<p class="recommendation"><strong>Action:</strong> ${escapeHtml(check.recommendation)}</p>`
        }
      </article>`,
    )
    .join("")}</div>`;
}

function notRun(message: string) {
  return `<div class="not-run"><strong>Not evaluated</strong><p>${escapeHtml(message)}</p></div>`;
}

function storefrontSection(audit: ReadinessAudit | null) {
  if (!audit) {
    return `<section><h2>1. Storefront and crawler readiness</h2>${notRun(
      "Run the public landing-page audit to include crawler, metadata, product schema, sitemap, and static Pixel evidence.",
    )}</section>`;
  }

  return `<section>
    <div class="section-heading"><div><p class="eyebrow">Storefront</p><h2>1. Storefront and crawler readiness</h2></div><span class="pill ${
      audit.verdict === "ready" ? "pass" : audit.verdict === "needs_work" ? "warning" : "fail"
    }">${escapeHtml(storefrontLabel(audit))}</span></div>
    <div class="stats">
      <div><span>Storefront page score</span><strong>${audit.score}/100</strong></div>
      <div><span>Checks passed</span><strong>${audit.checks.filter((check) => check.status === "pass").length}/${audit.checks.length}</strong></div>
      <div><span>Scanned</span><strong>${escapeHtml(formatUtc(audit.scannedAt))} UTC</strong></div>
    </div>
    <p class="target"><strong>Observed URL:</strong> <a href="${escapeHtml(audit.finalUrl)}">${escapeHtml(audit.finalUrl)}</a></p>
    ${checkRows(audit.checks)}
    <h3 class="subheading">Static ChatGPT measurement installation</h3>
    ${checkRows(audit.measurement.checks)}
    <div class="boundary"><strong>Evidence boundary</strong><ul>${audit.limitations
      .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
      .join("")}</ul></div>
  </section>`;
}

function productFeedSection(audit: ProductFeedAudit | null) {
  if (!audit) {
    return `<section><h2>2. Product feed preflight</h2>${notRun(
      "Audit a UTF-8 CSV, TSV, or TXT export locally to include product-row structure and Ads eligibility findings.",
    )}</section>`;
  }
  const issueRows =
    audit.issues.length === 0
      ? '<p class="empty">No structural feed issues were found in this local preflight.</p>'
      : `<div class="checks">${audit.issues
          .map(
            (issue) => `<article class="check">
              <div class="check-heading"><h3>${escapeHtml(issue.title)}</h3><span class="pill ${issue.severity === "error" ? "fail" : "warning"}">${escapeHtml(issue.severity)}</span></div>
              <p>${escapeHtml(issue.detail)}</p>
              <p class="recommendation"><strong>Affected:</strong> ${issue.sampleRows
                .map((row) => (row === 1 ? "Header" : `Row ${row}`))
                .map(escapeHtml)
                .join(", ")}${issue.count > issue.sampleRows.length ? ` +${issue.count - issue.sampleRows.length} more` : ""}</p>
            </article>`,
          )
          .join("")}</div>`;

  return `<section>
    <div class="section-heading"><div><p class="eyebrow">Catalogue</p><h2>2. Product feed preflight</h2></div><span class="pill ${audit.verdict === "ready" ? "pass" : audit.verdict === "invalid" ? "fail" : "warning"}">${escapeHtml(productFeedLabel(audit))}</span></div>
    <p class="target"><strong>Local file:</strong> ${escapeHtml(audit.fileName)} · ${escapeHtml(audit.format.toUpperCase())}</p>
    <div class="stats">
      <div><span>Product rows</span><strong>${audit.rowCount}</strong></div>
      <div><span>Ads eligible</span><strong>${audit.adsEligibleRows}</strong></div>
      <div><span>Blocked rows</span><strong>${audit.blockedRows}</strong></div>
    </div>
    ${issueRows}
    <div class="boundary"><strong>Evidence boundary</strong><p>This local result does not prove feed connection, SFTP ingestion, indexing, Ads Manager eligibility, or serving.</p></div>
  </section>`;
}

function conversionsApiSection(audit: ConversionPayloadAudit | null) {
  if (!audit) {
    return `<section><h2>3. Conversions API batch preflight</h2>${notRun(
      "Validate a credential-free JSON body locally to include schema, timestamp, event, data-shape, and user-matching findings.",
    )}</section>`;
  }
  const issueRows =
    audit.issues.length === 0
      ? '<p class="empty">No static payload blockers or warnings were found.</p>'
      : `<div class="checks">${audit.issues
          .map(
            (issue) => `<article class="check">
              <div class="check-heading"><h3>${escapeHtml(issue.title)}</h3><span class="pill ${issue.severity === "blocker" ? "fail" : "warning"}">${escapeHtml(issue.severity)}</span></div>
              <p>${escapeHtml(issue.detail)}</p>
              <p class="recommendation"><strong>Field:</strong> ${escapeHtml(issue.field)} · ${issue.count} finding${issue.count === 1 ? "" : "s"}</p>
            </article>`,
          )
          .join("")}</div>`;
  const eventTypes =
    audit.eventTypes.length === 0
      ? "None observed"
      : audit.eventTypes
          .map((eventType) => `${escapeHtml(eventType.name)} (${eventType.count})`)
          .join(", ");

  return `<section>
    <div class="section-heading"><div><p class="eyebrow">Server events</p><h2>3. Conversions API batch preflight</h2></div><span class="pill ${audit.verdict === "ready_for_validation" ? "pass" : audit.verdict === "invalid" ? "fail" : "warning"}">${escapeHtml(conversionsApiLabel(audit))}</span></div>
    <div class="stats">
      <div><span>Events</span><strong>${audit.eventCount}</strong></div>
      <div><span>Ready</span><strong>${audit.readyEventCount}</strong></div>
      <div><span>Blockers / warnings</span><strong>${audit.blockerCount} / ${audit.warningCount}</strong></div>
    </div>
    <p class="target"><strong>Event types${audit.incomplete ? " (partial scan)" : ""}:</strong> ${eventTypes}</p>
    ${issueRows}
    <div class="boundary"><strong>Evidence boundary</strong><ul>${audit.limitations
      .map((limitation) => `<li>${escapeHtml(limitation)}</li>`)
      .join("")}</ul></div>
  </section>`;
}

function accountMeasurementSection(readiness: ConversionMeasurementReadiness) {
  if (!accountMeasurementComplete(readiness)) {
    return `<section><h2>4. Connected-account measurement</h2>${notRun(
      "Connect an eligible OpenAI Ads account to verify conversion event-setting references without fabricating provider evidence.",
    )}</section>`;
  }
  const checks = readiness.checks.map((check) => ({
    id: check.campaignId,
    title: `${check.campaignName} · ${check.title}`,
    status: check.status,
    weight: 0,
    evidence: check.detail,
    recommendation:
      "Review the conversion definition and source in the selected account before changing a conversion bid.",
  }));

  return `<section>
    <div class="section-heading"><div><p class="eyebrow">Live Ads account</p><h2>4. Connected-account measurement</h2></div><span class="pill ${readiness.status === "ready" || readiness.status === "not_applicable" ? "pass" : "warning"}">${escapeHtml(accountMeasurementLabel(readiness))}</span></div>
    <div class="stats">
      <div><span>Active conversion campaigns</span><strong>${readiness.activeConversionCampaigns}</strong></div>
      <div><span>Healthy measurement</span><strong>${readiness.healthyCampaigns}/${readiness.activeConversionCampaigns}</strong></div>
      <div><span>Checked</span><strong>${escapeHtml(formatUtc(readiness.checkedAt))} UTC</strong></div>
    </div>
    <p class="target">${escapeHtml(readiness.message)}</p>
    ${checkRows(checks)}
    <div class="boundary"><strong>Evidence boundary</strong><p>This read-only configuration check does not prove Pixel execution, Conversions API delivery, deduplication, matching, attribution, or order reconciliation.</p></div>
  </section>`;
}

function reportSlug(input: ReadinessReportInput) {
  let source = input.productFeed?.fileName.replace(/\.[^.]+$/, "") ?? "commerce-audit";
  if (input.storefront) {
    try {
      source = new URL(input.storefront.finalUrl).hostname;
    } catch {
      source = "commerce-audit";
    }
  }
  return (
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "commerce-audit"
  );
}

export function readinessReportFileName(input: ReadinessReportInput) {
  const date = /^\d{4}-\d{2}-\d{2}/.exec(input.generatedAt)?.[0] ?? "undated";
  const scope = getReadinessReportSummary(input).isComplete
    ? "readiness"
    : "partial-readiness";
  return `maintainflow-${scope}-${reportSlug(input)}-${date}.html`;
}

export function buildReadinessReportHtml(input: ReadinessReportInput) {
  const summary = getReadinessReportSummary(input);
  if (!summary.canExport) {
    throw new Error("Complete at least one readiness check before exporting a report.");
  }
  const incompleteSections = summary.totalSections - summary.completedSections;
  const reportTitle = summary.isComplete
    ? "ChatGPT commerce launch readiness"
    : "Partial ChatGPT commerce launch readiness report";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(reportTitle)} · MaintainFlow</title>
  <style>
    :root { color-scheme: light; --ink:#151719; --muted:#62686f; --line:#dfe3e7; --soft:#f5f7f8; --brand:#2f9cdb; --pass:#16794c; --warning:#8a5a00; --fail:#b42318; }
    * { box-sizing:border-box; }
    body { margin:0; background:#eef1f3; color:var(--ink); font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    main { width:min(960px,calc(100% - 32px)); margin:32px auto; background:white; border:1px solid var(--line); border-radius:18px; overflow:hidden; }
    header { padding:36px 40px; border-bottom:1px solid var(--line); background:linear-gradient(135deg,#fff 0%,#f4faff 100%); }
    .brand { display:flex; align-items:center; gap:10px; font-weight:750; }
    .mark { display:grid; place-items:center; width:28px; height:28px; border-radius:7px; background:var(--brand); color:white; }
    h1 { margin:28px 0 10px; font-size:34px; line-height:1.1; letter-spacing:-.035em; }
    h2 { margin:0; font-size:21px; letter-spacing:-.02em; }
    h3 { margin:0; font-size:14px; }
    p { margin:0; }
    a { color:#176998; overflow-wrap:anywhere; }
    .lede { max-width:720px; color:var(--muted); font-size:16px; }
    .meta { display:flex; flex-wrap:wrap; gap:8px 20px; margin-top:22px; color:var(--muted); font-size:12px; }
    .partial-watermark { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; margin-top:22px; padding:14px 16px; border:1px solid #ead7ad; border-radius:10px; background:#fff9e8; color:var(--warning); }
    .partial-watermark strong { flex:none; font-size:12px; letter-spacing:.1em; text-transform:uppercase; }
    .partial-watermark span { color:var(--ink); font-size:12px; }
    .summary { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; padding:24px 40px; background:var(--soft); border-bottom:1px solid var(--line); }
    .summary div,.stats div { display:grid; gap:5px; padding:14px; background:white; border:1px solid var(--line); border-radius:10px; }
    .summary span,.stats span { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.06em; }
    .summary strong,.stats strong { font-size:16px; }
    section { display:grid; gap:18px; padding:32px 40px; border-bottom:1px solid var(--line); }
    .section-heading,.check-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
    .eyebrow { margin-bottom:4px; color:var(--brand); font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.09em; }
    .pill { display:inline-flex; width:fit-content; padding:4px 8px; border:1px solid var(--line); border-radius:999px; background:white; font-size:11px; font-weight:700; text-transform:capitalize; white-space:nowrap; }
    .pill.pass { color:var(--pass); border-color:#b9dfcb; background:#f1fbf5; }
    .pill.warning { color:var(--warning); border-color:#ead7ad; background:#fff9e8; }
    .pill.fail { color:var(--fail); border-color:#f0c2bd; background:#fff4f2; }
    .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
    .checks { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .check { display:grid; align-content:start; gap:8px; padding:14px; border:1px solid var(--line); border-radius:10px; }
    .check > p { color:var(--muted); font-size:12px; }
    .check .recommendation { color:var(--ink); }
    .target { padding:12px 14px; border-radius:9px; background:var(--soft); color:var(--muted); }
    .subheading { margin-top:4px; font-size:16px; }
    .boundary,.not-run { display:grid; gap:8px; padding:14px; border-left:3px solid var(--brand); background:var(--soft); color:var(--muted); }
    .boundary strong,.not-run strong { color:var(--ink); }
    .boundary ul { margin:0; padding-left:18px; }
    .empty { padding:14px; border:1px dashed var(--line); border-radius:10px; color:var(--muted); }
    footer { display:grid; gap:14px; padding:28px 40px; color:var(--muted); font-size:12px; }
    footer ul { display:flex; flex-wrap:wrap; gap:8px 18px; margin:0; padding:0; list-style:none; }
    @media (max-width:700px) { main{width:100%;margin:0;border:0;border-radius:0} header,section,footer{padding:24px 20px}.summary{padding:18px 20px}.summary,.stats,.checks{grid-template-columns:1fr}.section-heading,.partial-watermark{align-items:flex-start;flex-direction:column}h1{font-size:28px} }
    @media print { body{background:white} main{width:100%;margin:0;border:0}.check,section{break-inside:avoid} a{color:inherit;text-decoration:none} body.partial-report::before{content:"PARTIAL REPORT";position:fixed;left:50%;top:48%;z-index:2;transform:translate(-50%,-50%) rotate(-24deg);color:var(--warning);font-size:84px;font-weight:800;letter-spacing:.12em;opacity:.08;pointer-events:none;white-space:nowrap} }
  </style>
</head>
<body${summary.isComplete ? "" : ' class="partial-report"'}>
  <main>
    <header>
      <div class="brand"><span class="mark">M</span> MaintainFlow</div>
      <h1>${escapeHtml(reportTitle)}</h1>
      <p class="lede">${
        summary.isComplete
          ? "A client-ready record of the OpenAI-schema checks completed in MaintainFlow."
          : "A working record of the OpenAI-schema checks completed so far in MaintainFlow."
      } This is an independent technical preflight, not an OpenAI approval or guarantee of ad delivery.</p>
      <div class="meta"><span>Generated ${escapeHtml(formatUtc(input.generatedAt))} UTC</span><span>Report scope: ${summary.completedSections} of ${summary.totalSections} sections evaluated</span></div>
      ${
        summary.isComplete
          ? ""
          : `<div class="partial-watermark" role="note"><strong>Partial report</strong><span>Only ${summary.completedSections} of ${summary.totalSections} evidence sections were evaluated; ${incompleteSections} ${incompleteSections === 1 ? "section remains" : "sections remain"} untested. Treat this as a working preflight, not a complete launch assessment.</span></div>`
      }
    </header>
    <div class="summary">
      <div><span>Overall review</span><strong>${escapeHtml(summary.verdictLabel)}</strong></div>
      <div><span>Completed sections</span><strong>${summary.completedSections}/${summary.totalSections}</strong></div>
      <div><span>Data handling</span><strong>Sanitized results only</strong></div>
    </div>
    ${storefrontSection(input.storefront)}
    ${productFeedSection(input.productFeed)}
    ${conversionsApiSection(input.conversionsApi)}
    ${accountMeasurementSection(input.accountMeasurement)}
    <footer>
      <strong>Documentation basis</strong>
      <ul>${REPORT_SOURCES.map(
        ([label, href]) => `<li><a href="${href}">${escapeHtml(label)}</a></li>`,
      ).join("")}</ul>
      <p>This file was generated locally from bounded audit results. It excludes raw product-feed rows, pasted event payloads, Pixel IDs, API keys, bearer tokens, and stored credential material. Re-run the checks after material storefront, feed, measurement, or OpenAI schema changes.</p>
    </footer>
  </main>
</body>
</html>`;
}
