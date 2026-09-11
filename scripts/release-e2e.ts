/**
 * Run with existing local API, web server and durable worker:
 *   node --import tsx scripts/release-e2e.ts
 * This runner never starts services, imports server modules, or calls a provider.
 * It retains synthetic QA work for the follow-up browser check. Existing evidence
 * and credential files are not overwritten by a subsequent invocation.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { PLANS } from '../shared/plans.js';

type Json = Record<string, any>;
type Client = { email: string; password: string; name: string; workspaceName: string; cookie: string; userId?: string; workspaceId?: string };
type RequestOptions = { method?: 'GET' | 'POST'; body?: Json | FormData; client?: Client; headers?: Record<string, string>; expected?: number };
class E2EError extends Error {}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new E2EError(message); }
function loopbackOrigin(value: string) {
  const url = new URL(value);
  ensure(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Release E2E only permits HTTP loopback targets.');
  ensure(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Release E2E targets must be plain loopback origins.');
  return url.origin;
}
const root = process.cwd();
const apiOrigin = loopbackOrigin(process.env.RELEASE_E2E_API_URL || 'http://127.0.0.1:4318');
const webOrigin = loopbackOrigin(process.env.RELEASE_E2E_WEB_URL || 'http://127.0.0.1:5178');
const evidencePath = path.join(root, 'docs/evidence/migration-2026-09-11/release-e2e.json');
const accountPath = path.join(root, '.local/release-e2e-account.json');
const fixturePath = path.join(root, 'fixtures/generated/invoice-multipage.pdf');
const runId = randomUUID(), startedAt = new Date().toISOString(), runDeadline = Date.now() + 180_000;
const requests: Json[] = [], checks: Json[] = [];
const evidence: Json = {
  runId, startedAt, status: 'running', scope: 'local HTTP through separately running API and durable worker',
  apiOrigin, webOrigin, billingMode: 'local mock', synthetic: true, requests, checks,
  boundaries: { productionDeployment: 'not tested', realStripe: 'not tested', outboundEmail: 'not attempted', resendReceiving: 'not tested', googleSheets: 'not tested', aiProvider: 'not tested; parser uses text-anchor rules' },
};
const credentials: { runId: string; apiOrigin: string; webOrigin: string; owner?: Client; outsider?: Client; documentId?: string; parserId?: string } = { runId, apiOrigin, webOrigin };
let phase = 'prepare', evidenceReserved = false;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function saveCredentials() {
  await fs.writeFile(accountPath, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(accountPath, 0o600);
}
async function saveEvidence() { await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n'); }
async function checked(name: string, details: Json = {}) {
  checks.push({ name, status: 'passed', at: new Date().toISOString(), ...details });
  await saveEvidence(); console.log(`PASS ${name}`);
}
async function request(route: string, options: RequestOptions = {}) {
  ensure(Date.now() < runDeadline, 'Release E2E exceeded its three-minute deadline.');
  ensure(route.startsWith('/api/') && !route.includes('://'), 'Runner request path is not an API-relative path.');
  const method = options.method || 'GET', began = Date.now();
  const headers = new Headers({ origin: webOrigin, ...options.headers });
  if (options.client?.cookie) headers.set('cookie', options.client.cookie);
  let body: BodyInit | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(options.body); }
  let response: Response;
  try { response = await fetch(new URL(route, apiOrigin), { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new E2EError(`Network request failed: ${method} ${route}`); }
  requests.push({ method, path: route, status: response.status, elapsedMs: Date.now() - began });
  if (options.client) {
    const session = response.headers.getSetCookie().find(cookie => cookie.startsWith('folio_session='));
    if (session) { options.client.cookie = session.split(';', 1)[0]; await saveCredentials(); }
  }
  ensure(response.status === (options.expected ?? 200), `Unexpected HTTP status for ${method} ${route}: expected ${options.expected ?? 200}, received ${response.status}.`);
  return response;
}
async function json(route: string, options: RequestOptions = {}): Promise<Json> { return (await request(route, options)).json(); }
async function signup(label: 'owner' | 'outsider') {
  const client: Client = {
    email: `release-${label}-${runId}@example.test`, password: `Release-QA-${randomBytes(24).toString('base64url')}`,
    name: label === 'owner' ? 'Release QA Owner' : 'Release QA Outsider', workspaceName: `Release QA ${label} ${runId.slice(0, 8)}`, cookie: '',
  };
  credentials[label] = client; await saveCredentials();
  const result = await json('/api/auth/register', { method: 'POST', expected: 201, client, body: {
    email: client.email, password: client.password, name: client.name, workspaceName: client.workspaceName,
  } });
  client.userId = result.user.id; client.workspaceId = result.workspace.id; await saveCredentials();
  ensure(client.cookie.startsWith('folio_session=') && client.cookie.length > 20, 'Registration did not set the owner session cookie.');
  return { client, result };
}
async function upload(client: Client, parserId: string, bytes: Buffer) {
  const body = new FormData(); body.set('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'synthetic-release-invoice.pdf');
  return json(`/api/parsers/${parserId}/documents`, { method: 'POST', expected: 202, client, body, headers: { 'idempotency-key': `release-e2e-${runId}` } });
}
function planMatches(plan: Json, id: typeof PLANS[number]['id']) {
  const advertised = PLANS.find(plan => plan.id === id)!;
  return plan.id === id && plan.monthlyPages === advertised.monthlyPages && plan.maxParsers === advertised.maxParsers && plan.maxConcurrent === advertised.maxConcurrent;
}

async function main() {
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  await fs.mkdir(path.dirname(accountPath), { recursive: true, mode: 0o700 });
  // Reserve both paths before making any account or application changes.
  await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' }); evidenceReserved = true;
  await fs.writeFile(accountPath, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const bytes = await fs.readFile(fixturePath);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'fixtures/generated/manifest.json'), 'utf8'));
  const fixture = manifest.fixtures.find((fixture: Json) => fixture.filename === 'invoice-multipage.pdf');
  ensure(fixture?.category === 'supported' && fixture.pageCount === 2, 'Supported two-page invoice fixture is unavailable.');
  evidence.fixture = { path: 'fixtures/generated/invoice-multipage.pdf', bytes: bytes.length, sha256: sha256(bytes), expected: fixture.expected, pageCount: fixture.pageCount, reusedRegressionFixture: true };
  evidence.runnerSha256 = sha256(await fs.readFile(path.join(root, 'scripts/release-e2e.ts')));

  phase = 'local-service-preflight';
  const health = await json('/api/health');
  ensure(health.status === 'ok' && health.environment === 'local', 'API must be running in local mode for the mock billing check.');
  const web = await fetch(webOrigin, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const html = await web.text();
  ensure(web.status === 200 && /id=["']root["']/.test(html), 'Local frontend did not return the application HTML.');
  await checked(phase, { apiStatus: health.status, environment: health.environment, webStatus: web.status });

  phase = 'fresh-registration-and-explore';
  const { client: owner, result: registration } = await signup('owner');
  ensure(planMatches(registration.workspace.plan, 'explore') && registration.workspace.plan.name === 'Explore', 'Fresh registration does not match the advertised Explore plan.');
  ensure(registration.workspace.role === 'owner', 'Fresh user was not granted ownership of its own workspace.');
  await checked(phase, { userId: owner.userId, workspaceId: owner.workspaceId, plan: registration.workspace.plan });

  phase = 'parser-upload-and-durable-worker';
  const created = await json('/api/parsers', { method: 'POST', expected: 201, client: owner, body: {
    name: `Release QA invoice ${runId.slice(0, 8)}`, useCase: 'invoice', mode: 'rules', locale: 'en-IE', timezone: 'Europe/Dublin',
  } });
  const parserId: string = created.parser.id; credentials.parserId = parserId;
  const uploaded = await upload(owner, parserId, bytes), documentId: string = uploaded.document.id, jobId: string = uploaded.jobId;
  credentials.documentId = documentId; await saveCredentials();
  ensure(!uploaded.duplicate && Boolean(jobId) && uploaded.document.pageCount === 2, 'Fresh upload did not persist a two-page document and queued job.');
  const workerStarted = Date.now(), workerDeadline = Date.now() + 60_000;
  let detail: Json | undefined;
  while (Date.now() < workerDeadline) {
    detail = await json(`/api/documents/${documentId}`, { client: owner });
    ensure(detail.document.status !== 'failed', 'The separate durable worker marked the uploaded invoice as failed.');
    if (detail.document.status === 'needs_review' && detail.runs.length) break;
    await delay(750);
  }
  ensure(detail?.document.status === 'needs_review' && detail.runs.length === 1, 'The separate durable worker did not finish the invoice within 60 seconds.');
  const run = detail.runs[0], extractionRunId: string = run.id;
  ensure(run.engine === 'text-anchors' && run.model === 'deterministic-v2', 'Invoice was not processed by the expected text-anchor engine.');
  ensure(run.jobId === jobId && run.documentSha256 === sha256(bytes), 'Worker run provenance does not match the uploaded job and original.');
  ensure(detail.jobs.some((job: Json) => job.id === jobId && job.state === 'completed'), 'Worker job has not reached completed state.');
  ensure(isDeepStrictEqual(run.normalizedValues, fixture.expected), 'Invoice extraction differs from the supported fixture expectations.');
  ensure(run.issues.length === 0, 'Supported invoice unexpectedly has extraction validation issues.');
  const original = Buffer.from(await (await request(`/api/documents/${documentId}/original`, { client: owner })).arrayBuffer());
  ensure(sha256(original) === sha256(bytes), 'Retrieved original does not match uploaded PDF bytes.');
  const duplicate = await upload(owner, parserId, bytes);
  ensure(duplicate.duplicate && duplicate.document.id === documentId && duplicate.jobId === null, 'Replayed upload did not preserve the existing document without another job.');
  const usage = await json('/api/workspace/usage', { client: owner });
  ensure(usage.usage.pages === 2 && usage.usage.documents === 1, 'Upload replay incorrectly consumed extra pages or created another document.');
  await checked(phase, { parserId, documentId, jobId, runId: extractionRunId, engine: run.engine, model: run.model, normalizedValues: run.normalizedValues, elapsedMs: Date.now() - workerStarted, originalSha256: sha256(original), duplicatePrevented: true, usagePages: usage.usage.pages });

  phase = 'correction-approval-and-downloads';
  const correctedValues = { ...fixture.expected, supplier: 'Fern Office Supplies — reviewed QA' };
  const corrected = await json(`/api/runs/${extractionRunId}/corrections`, { method: 'POST', client: owner, body: { expectedRevision: run.effectiveRevision, values: correctedValues } });
  ensure(isDeepStrictEqual(corrected.run.normalizedValues, fixture.expected), 'Correction changed the original normalized extraction.');
  ensure(isDeepStrictEqual(corrected.run.effectiveValues, correctedValues) && corrected.issues.length === 0, 'Correction was not retained as the effective validated result.');
  const approved = await json(`/api/runs/${extractionRunId}/approve`, { method: 'POST', client: owner, body: { expectedRevision: corrected.run.effectiveRevision } });
  const approvalId: string = approved.approval.id;
  ensure(approved.approval.correctionId === corrected.correction.id && isDeepStrictEqual(approved.approval.values, correctedValues), 'Approval did not pin the corrected values.');
  const columns = [{ source: 'invoice_number', label: 'Invoice number' }, { source: 'supplier', label: 'Supplier' }, { source: 'total', label: 'Total' }, { source: '$item.description', label: 'Description' }, { source: '$item.amount', label: 'Line amount' }, { source: '$approvalId', label: 'Approval ID' }];
  const exports: Json[] = [];
  for (const format of ['csv', 'xlsx', 'json'] as const) {
    const exported = await json('/api/exports', { method: 'POST', client: owner, body: { documentIds: [documentId], format, columns, lineItems: 'line_items' } });
    ensure(exported.revisions[0]?.approvalId === approvalId, 'Export did not pin the reviewed approval.');
    const download = await request(exported.downloadUrl, { client: owner });
    ensure(download.headers.get('content-disposition')?.includes('attachment'), 'Export download is missing attachment metadata.');
    const contents = Buffer.from(await download.arrayBuffer());
    ensure(contents.length > 0, 'Export download is empty.');
    if (format === 'json') {
      const output = JSON.parse(contents.toString('utf8'));
      ensure(output.documents.length === 1 && output.documents[0].approvalId === approvalId && output.documents[0].revision === 1, 'JSON export lost its approval revision metadata.');
      ensure(isDeepStrictEqual(output.documents[0].values, correctedValues), 'JSON export does not contain the corrected values.');
    } else if (format === 'xlsx') {
      const book = new ExcelJS.Workbook(); await book.xlsx.load(contents as any); const sheet = book.getWorksheet(1)!;
      ensure(sheet.rowCount === 5 && sheet.getCell('A2').value === fixture.expected.invoice_number && sheet.getCell('B2').value === correctedValues.supplier, 'XLSX cells or four-row line-item expansion are incorrect.');
      ensure(sheet.getCell('C2').value === fixture.expected.total && sheet.getCell('D4').value === 'Desk pads' && sheet.getCell('F5').value === approvalId, 'XLSX lost numeric values, second-page line items, or the pinned approval.');
    } else {
      const rows = contents.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n');
      ensure(rows.length === 5 && rows[1].includes(`"${correctedValues.supplier}"`) && rows[1].includes(`"${fixture.expected.total}"`), 'CSV corrected values or line-item expansion are incorrect.');
      ensure(rows[3].includes('"Desk pads"') && rows.every(row => row.includes('Approval ID') || row.includes(approvalId)), 'CSV lost second-page line items or the pinned approval.');
    }
    exports.push({ id: exported.id, format, bytes: contents.length, sha256: sha256(contents), approvalId, downloadUrl: exported.downloadUrl });
  }
  await checked(phase, { correctionId: corrected.correction.id, approvalId, immutableNormalizedValues: true, correctedValues, exports });

  phase = 'signout-login-and-persisted-approval';
  const oldCookie = owner.cookie;
  await json('/api/auth/logout', { method: 'POST', client: owner, body: {} });
  await request('/api/auth/me', { expected: 401, headers: { cookie: oldCookie } });
  const login = await json('/api/auth/login', { method: 'POST', client: owner, body: { email: owner.email, password: owner.password } });
  ensure(login.user.id === owner.userId && login.workspace.id === owner.workspaceId, 'Login did not restore the original user and workspace.');
  detail = await json(`/api/documents/${documentId}`, { client: owner });
  ensure(detail.document.approvedRunId === extractionRunId && detail.document.status === 'exported', 'Approved document did not survive a fresh login.');
  ensure(detail.runs[0].approvals.some((approval: Json) => approval.id === approvalId && isDeepStrictEqual(approval.values, correctedValues)), 'Pinned approval values did not persist across sessions.');
  const exportHistory = await json('/api/exports', { client: owner });
  ensure(exports.every(exported => exportHistory.exports.some((entry: Json) => entry.id === exported.id)), 'Export history did not persist across sessions.');
  for (const exported of exports) {
    const downloaded = Buffer.from(await (await request(exported.downloadUrl, { client: owner })).arrayBuffer());
    ensure(sha256(downloaded) === exported.sha256, 'Stored export snapshot bytes changed after login.');
  }
  await checked(phase, { sameUserAndWorkspace: true, revokedSessionRejected: true, documentId, approvalId, exportSnapshotsUnchanged: true });

  phase = 'mock-team-upgrade-and-explore-cancellation';
  const team = await json('/api/billing/mock/plan', { method: 'POST', client: owner, body: { planId: 'team' } });
  ensure(team.mode === 'mock' && planMatches(team.plan, 'team') && team.plan.mockStatus === 'active', 'Local Team mock upgrade failed.');
  const reload = await json('/api/auth/me', { client: owner });
  const teamUsage = await json('/api/workspace/usage', { client: owner });
  ensure(planMatches(reload.workspace.plan, 'team') && planMatches(teamUsage.plan, 'team'), 'Mock Team limits did not survive HTTP session/usage reload.');
  const canceled = await json('/api/billing/mock/cancel', { method: 'POST', client: owner, body: {} });
  ensure(canceled.mode === 'mock' && planMatches(canceled.plan, 'explore') && canceled.plan.mockStatus === 'canceled', 'Mock cancellation did not restore Explore limits.');
  const finalUsage = await json('/api/workspace/usage', { client: owner });
  const preserved = await json(`/api/documents/${documentId}`, { client: owner });
  const parsers = await json('/api/parsers', { client: owner });
  ensure(finalUsage.usage.pages === 2 && finalUsage.usage.documents === 1 && parsers.parsers.length === 1 && parsers.parsers[0].id === parserId, 'Mock cancellation changed existing documents, parsers, or metered usage.');
  ensure(preserved.document.approvedRunId === extractionRunId && preserved.runs[0].approvals.some((approval: Json) => approval.id === approvalId), 'Mock cancellation lost the approved result.');
  await checked(phase, { upgradedPlan: team.plan, finalPlan: finalUsage.plan, usagePages: finalUsage.usage.pages, documentsPreserved: 1, parsersPreserved: 1, approvalId, realPaymentVerification: false });

  phase = 'independent-account-isolation';
  const { client: outsider } = await signup('outsider');
  await request(`/api/documents/${documentId}`, { client: outsider, expected: 404 });
  await request(exports[0].downloadUrl, { client: outsider, expected: 404 });
  await request(`/api/documents/${documentId}`, { client: outsider, expected: 403, headers: { 'x-workspace-id': owner.workspaceId! } });
  await request('/api/documents', { client: owner, expected: 403, headers: { 'x-workspace-id': outsider.workspaceId! } });
  const outsiderDocs = await json('/api/documents', { client: outsider });
  ensure(outsiderDocs.total === 0, 'Independent account can see documents from the owner workspace.');
  await request('/api/auth/me', { expected: 401 });
  await checked(phase, { outsiderUserId: outsider.userId, outsiderWorkspaceId: outsider.workspaceId, ownerDocumentDenied: true, exportDenied: true, forgedWorkspaceHeaderDenied: true, unauthenticatedDenied: true });

  phase = 'final-browser-handoff';
  const final = await json('/api/auth/me', { client: owner });
  ensure(planMatches(final.workspace.plan, 'explore'), 'Final browser handoff did not retain Explore mock cancellation.');
  await saveCredentials();
  const credentialMode = (await fs.stat(accountPath)).mode & 0o777;
  ensure(credentialMode === 0o600, 'Private browser handoff credentials do not have mode 0600.');
  evidence.browserHandoff = { ownerUserId: owner.userId, workspaceId: owner.workspaceId, parserId, documentId, documentUrl: `${webOrigin}/app/documents/${documentId}`, credentialsPath: '.local/release-e2e-account.json', credentialMode: '0600', finalPlan: final.workspace.plan };
  evidence.status = 'passed'; evidence.completedAt = new Date().toISOString();
  await saveEvidence();
  console.log(`Release E2E passed (${checks.length} checks). Safe evidence: ${path.relative(root, evidencePath)}`);
}

try { await main(); }
catch (error) {
  const message = error instanceof E2EError ? error.message : error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST'
    ? 'Evidence or private account handoff already exists; preserve the prior files before rerunning.'
    : 'Unexpected runner error; inspect the failing phase without exposing credentials.';
  evidence.status = 'failed'; evidence.completedAt = new Date().toISOString(); evidence.failure = { phase, message, errorType: error instanceof Error ? error.name : 'Unknown' };
  if (evidenceReserved) await saveEvidence();
  console.error(`Release E2E failed at ${phase}: ${message}`); process.exitCode = 1;
}
