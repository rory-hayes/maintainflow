import type { ApprovalRecordDto } from "./approval-schema";

export type ChangeAssuranceReport = {
  generatedAt: string;
  dataSource: "demo" | "live";
  account: {
    id: string;
    name: string;
  };
  records: ApprovalRecordDto[];
};

const unresolvedStatuses = new Set([
  "pending",
  "reconciliation_required",
  "rollback_pending",
  "rollback_failed",
  "rollback_reconciliation_required",
]);

const sensitiveKeyPattern =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|credential)/i;

const sensitiveTextPatterns: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "Bearer [REDACTED]",
  },
  {
    pattern: /\b(?:sk|ads|capi)[-_][A-Za-z0-9_-]{12,}\b/gi,
    replacement: "[REDACTED]",
  },
  {
    pattern:
      /([?&](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password)=)[^&#\s]*/gi,
    replacement: "$1[REDACTED]",
  },
] as const;

function redactSensitiveText(value: string) {
  return sensitiveTextPatterns.reduce(
    (redacted, { pattern, replacement }) =>
      redacted.replace(pattern, replacement),
    value,
  );
}

function escapeHtml(value: unknown) {
  return redactSensitiveText(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function sanitizeReportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeReportValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKeyPattern.test(key) ? "[REDACTED]" : sanitizeReportValue(item),
      ]),
    );
  }
  if (typeof value === "string") return redactSensitiveText(value);
  return value;
}

function prettyJson(value: unknown) {
  return escapeHtml(JSON.stringify(sanitizeReportValue(value), null, 2));
}

function dateTime(value: string | null) {
  if (!value) return "Not recorded";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Not recorded"
    : parsed.toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function sentence(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function reportRecord(record: ApprovalRecordDto) {
  const unresolved = unresolvedStatuses.has(record.status);
  const monitoring = record.monitoringPlan;
  const observation = record.monitoringObservation;
  const recommendationEvidence = record.evidence ?? [];
  const evidence = recommendationEvidence.length
    ? `<dl class="evidence">${recommendationEvidence
        .map(
          (item) =>
            `<div><dt>${escapeHtml(item.label)}</dt><dd><strong>${escapeHtml(item.value)}</strong><span>${escapeHtml(item.detail)}</span></dd></div>`,
        )
        .join("")}</dl>`
    : '<p class="muted">No recommendation evidence was retained for this record.</p>';
  const request = record.mutation
    ? `<p class="mono">${escapeHtml(record.mutation.method)} ${escapeHtml(record.mutation.path)}</p><pre>${prettyJson(record.mutation.body)}</pre>`
    : '<p class="muted">The original request metadata is unavailable for this legacy record.</p>';
  const monitoringResult = monitoring
    ? `<dl class="facts">
        <div><dt>Baseline</dt><dd>${escapeHtml(monitoring.baseline.clickAttributedConversions)} click-attributed conversions · ${escapeHtml(monitoring.baseline.currencyCode)} ${escapeHtml(monitoring.baseline.spend)}</dd></div>
        <div><dt>Rollback threshold</dt><dd>More than ${escapeHtml(monitoring.rollbackRule.thresholdPercent)}% conversion decline</dd></div>
        <div><dt>Window</dt><dd>${escapeHtml(dateTime(record.monitoringStartedAt))} to ${escapeHtml(dateTime(record.monitoringEndsAt))}</dd></div>
        <div><dt>Outcome</dt><dd>${escapeHtml(record.monitoringOutcome ? sentence(record.monitoringOutcome) : "Pending")}</dd></div>
        <div><dt>Evaluated</dt><dd>${escapeHtml(dateTime(record.monitoringEvaluatedAt))}</dd></div>
        <div><dt>Observed evidence</dt><dd>${escapeHtml(observation ? sentence(observation.evidenceState) : "Not yet evaluated")}</dd></div>
        <div><dt>Conversion change</dt><dd>${observation?.conversionChangePercent === null || observation?.conversionChangePercent === undefined ? "Not available" : `${escapeHtml(observation.conversionChangePercent)}%`}</dd></div>
      </dl>`
    : '<p class="muted">This change did not include a monitoring plan.</p>';

  return `<article class="record ${unresolved ? "record--attention" : ""}">
    <div class="record__heading">
      <div><p class="eyebrow">${escapeHtml(record.recommendationId)}</p><h2>${escapeHtml(record.recommendationTitle)}</h2></div>
      <span class="status">${escapeHtml(sentence(record.status))}</span>
    </div>
    ${unresolved ? '<p class="attention">Operator attention is still required before this record can be treated as complete.</p>' : ""}
    <dl class="facts">
      <div><dt>Advertiser account</dt><dd>${escapeHtml(record.accountId)}</dd></div>
      <div><dt>Organization</dt><dd>${escapeHtml(record.organizationName ?? "Not recorded")}</dd></div>
      <div><dt>Decision authority</dt><dd>Authenticated operator · ${escapeHtml(record.membershipRole ?? "legacy role unavailable")} / ${escapeHtml(record.accountRole ?? "legacy role unavailable")}</dd></div>
      <div><dt>Entity</dt><dd>${escapeHtml(record.entityId)}</dd></div>
      <div><dt>Created</dt><dd>${escapeHtml(dateTime(record.createdAt))}</dd></div>
      <div><dt>Last updated</dt><dd>${escapeHtml(dateTime(record.updatedAt))}</dd></div>
    </dl>
    <h3>Recommendation evidence</h3>${evidence}
    <div class="request-grid"><section><h3>Exact approved request</h3>${request}</section><section><h3>Stored rollback request</h3><p class="mono">${escapeHtml(record.rollbackMethod)} ${escapeHtml(record.rollbackPath)}</p><pre>${prettyJson(record.rollbackBody)}</pre></section></div>
    <h3>Safeguard</h3><p>${escapeHtml(record.safeguard)}</p>
    <h3>Monitoring result</h3>${monitoringResult}
    <h3>Reconciliation</h3><dl class="facts">
      <div><dt>Provider or operation note</dt><dd>${escapeHtml(record.errorMessage ?? "No provider error recorded")}</dd></div>
      <div><dt>Verified outcome note</dt><dd>${escapeHtml(record.reconciliationNote ?? "No reconciliation note recorded")}</dd></div>
      <div><dt>Applied</dt><dd>${escapeHtml(dateTime(record.appliedAt))}</dd></div>
      <div><dt>Rolled back</dt><dd>${escapeHtml(dateTime(record.rolledBackAt))}</dd></div>
    </dl>
  </article>`;
}

export function changeAssuranceReportSummary(report: ChangeAssuranceReport) {
  const unresolved = report.records.filter((record) =>
    unresolvedStatuses.has(record.status),
  ).length;
  const monitored = report.records.filter(
    (record) => record.monitoringOutcome !== null,
  ).length;
  return {
    total: report.records.length,
    unresolved,
    monitored,
    canExport: report.records.length > 0,
  };
}

export function changeAssuranceReportFileName(report: ChangeAssuranceReport) {
  const account = report.account.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `maintainflow-change-assurance-${account || "account"}-${report.generatedAt.slice(0, 10)}.html`;
}

export function buildChangeAssuranceReportHtml(report: ChangeAssuranceReport) {
  const summary = changeAssuranceReportSummary(report);
  const mode = report.dataSource === "live" ? "LIVE ACCOUNT EVIDENCE" : "SIMULATOR — NOT LIVE EVIDENCE";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MaintainFlow change assurance · ${escapeHtml(report.account.name)}</title>
<style>
  :root{color:#18181b;background:#fff;font:14px/1.55 Arial,sans-serif}*{box-sizing:border-box}body{margin:0}.page{max-width:1040px;margin:auto;padding:40px 32px}.top{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #18181b;padding-bottom:22px}.brand{font-size:13px;font-weight:700;letter-spacing:.08em}.mode,.status{display:inline-block;border:1px solid #a1a1aa;border-radius:999px;padding:4px 9px;font-size:11px;font-weight:700}.mode--demo{border-color:#d97706;color:#92400e}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}.summary div,.facts div,.evidence div{border:1px solid #e4e4e7;border-radius:8px;padding:12px}.summary strong{display:block;font-size:22px}.record{break-inside:avoid;border:1px solid #d4d4d8;border-radius:12px;margin:24px 0;padding:22px}.record--attention{border-color:#d97706}.record__heading{display:flex;justify-content:space-between;gap:16px}.eyebrow,dt{color:#71717a;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}.facts,.evidence{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.facts dt,.evidence dt{margin-bottom:4px}.evidence dd{margin:0}.evidence span{display:block;color:#71717a}.request-grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}.request-grid section{min-width:0}.mono,pre{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#18181b;color:#fafafa;border-radius:8px;padding:13px}.muted{color:#71717a}.attention{background:#fffbeb;border:1px solid #f59e0b;border-radius:8px;padding:10px 12px}.foot{border-top:1px solid #d4d4d8;margin-top:30px;padding-top:18px;color:#71717a;font-size:12px}@media(max-width:700px){.summary,.facts,.evidence,.request-grid{grid-template-columns:1fr}.top,.record__heading{display:block}.mode{margin-top:12px}}@media print{.page{padding:0}.record{break-inside:avoid}}
</style></head><body><main class="page">
<header class="top"><div><p class="brand">MAINTAINFLOW</p><h1>Change assurance report</h1><p>${escapeHtml(report.account.name)} · ${escapeHtml(report.account.id)}</p></div><div><span class="mode ${report.dataSource === "demo" ? "mode--demo" : ""}">${mode}</span><p>Generated ${escapeHtml(dateTime(report.generatedAt))}</p></div></header>
<section class="summary"><div><span>Change records</span><strong>${summary.total}</strong></div><div><span>Monitoring completed</span><strong>${summary.monitored}</strong></div><div><span>Unresolved items</span><strong>${summary.unresolved}</strong></div></section>
${report.records.map(reportRecord).join("")}
<footer class="foot">This report is an evidence record, not a claim of causal lift. It excludes credential material and redacts fields whose names suggest authentication secrets. Confirm any unresolved provider outcome directly in OpenAI Ads Manager before another write.</footer>
</main></body></html>`;
}
