/**
 * From the release checkout:
 *   node --import tsx scripts/hosted-preview-e2e.ts --prepare
 *   HOSTED_E2E_URL=https://maintainflow.io node --import tsx scripts/hosted-preview-e2e.ts --run
 * HOSTED_E2E_URL may instead be one explicit HTTPS *.vercel.app deployment origin.
 * --prepare (the default) validates local configuration and fixtures; it makes no HTTP requests.
 * --run creates and retains synthetic QA accounts/documents for browser follow-up.
 * Reads .local/hosted-preview/environment.json; optional VERCEL_AUTOMATION_BYPASS_SECRET
 * (or VERCEL_PROTECTION_BYPASS) is sent only to the exact selected application origin.
 * Credentials go to .local/hosted-preview/account.json (0600); an existing file aborts
 * the run before HTTP. Move prior account files privately before an intentional rerun.
 * Public receipts use unique hosted-e2e-<timestamp>-<uuid>.json names and contain no
 * credentials, response bodies, session cookies, invitation codes, or signed URLs.
 */
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { PLANS } from '../shared/plans.js';

type Json = Record<string, any>;
type Client = { email: string; password: string; name: string; workspaceName: string; cookie: string; userId?: string; workspaceId?: string };
type RequestOptions = { method?: 'GET' | 'POST'; body?: Json; client?: Client; expected?: number; workspaceId?: string; cookie?: string };
class CheckError extends Error {}
function ensure(condition: unknown, message: string): asserts condition { if (!condition) throw new CheckError(message); }
const root = process.cwd(), maxBytes = 10 * 1024 * 1024;
const runId = randomUUID(), startedAt = new Date().toISOString(), deadline = Date.now() + 12 * 60_000;
const accountPath = path.join(root, '.local/hosted-preview/account.json');
const environmentPath = path.join(root, '.local/hosted-preview/environment.json');
const evidencePath = path.join(root, 'docs/evidence/free-preview-2026-09-11/hosted-e2e-' + startedAt.replace(/[:.]/g, '-') + '-' + runId + '.json');
const requests: Json[] = [], checks: Json[] = [];
const evidence: Json = {
  runId, startedAt, status: 'running', synthetic: true, requests, checks,
  scope: 'Deployed HTTP acceptance through the application and signed private storage',
  boundaries: { browserUI: 'not tested by this HTTP runner', realStripe: 'not tested; mock only', outboundEmail: 'not attempted', resendReceiving: 'not tested', googleSheets: 'not tested', aiProvider: 'not called; rules extraction only', expiredStagingCleanup: 'not tested; requires the capability expiry window' },
};
const credentials: Json = { runId };
let phase = 'prepare', appOrigin = '', requestOrigin = '', storageOrigin = '', inviteCode = '', bypass = '';
let accountFile: FileHandle | undefined, evidenceFile: FileHandle | undefined;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function id(value: unknown) { ensure(typeof value === 'string' && uuid.test(value), 'Application returned an invalid resource identifier.'); return value; }
function hostedOrigin(value: unknown) {
  ensure(typeof value === 'string', 'A plain hosted HTTPS origin is required.');
  let url: URL; try { url = new URL(value); } catch { throw new CheckError('Hosted target is not a valid URL.'); }
  ensure(url.protocol === 'https:' && (url.hostname === 'maintainflow.io' || /^[a-z0-9-]+\.vercel\.app$/.test(url.hostname)), 'Only maintainflow.io or one explicit Vercel deployment origin is permitted.');
  ensure(!url.username && !url.password && !url.port && url.pathname === '/' && !url.search && !url.hash, 'Hosted targets must be plain HTTPS origins.');
  return url.origin;
}
function apiPath(value: unknown) {
  ensure(typeof value === 'string' && /^\/api\/[A-Za-z0-9_/-]+$/.test(value) && !value.includes('//'), 'Application returned an unexpected API path.');
  return value;
}
function signedURL(value: unknown, operation: 'upload/sign' | 'sign', key: string) {
  ensure(typeof value === 'string' && value.length <= 12_000, 'Private storage capability is invalid.');
  let url: URL; try { url = new URL(value); } catch { throw new CheckError('Private storage capability is not a valid URL.'); }
  ensure(url.origin === storageOrigin && !url.username && !url.password && !url.hash && url.pathname === '/storage/v1/object/' + operation + '/folio-originals/' + key && Boolean(url.searchParams.get('token')), 'Private storage capability does not match the reserved workspace/object.');
  ensure([...url.searchParams.keys()].every(key => ['token', 'download'].includes(key)), 'Private storage capability contains unexpected parameters.');
  return url;
}
async function writeReceipt(file: FileHandle, value: Json) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await file.write(bytes, 0, bytes.length, 0); await file.truncate(bytes.length); await file.sync();
}
async function saveCredentials() { ensure(accountFile, 'Private account file was not reserved.'); await writeReceipt(accountFile, credentials); }
async function saveEvidence() { if (evidenceFile) await writeReceipt(evidenceFile, evidence); }
async function checked(name: string, details: Json = {}) {
  checks.push({ name, status: 'passed', at: new Date().toISOString(), ...details });
  await saveEvidence(); console.log('PASS ' + name);
}
async function boundedBytes(response: Response, limit = maxBytes) {
  const declared = response.headers.get('content-length');
  ensure(declared === null || (/^\d+$/.test(declared) && Number(declared) <= limit), 'Response exceeds the bounded download limit.');
  ensure(response.body, 'Response body is missing.');
  const reader = response.body.getReader(), chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) { await reader.cancel(); throw new CheckError('Response exceeds the bounded download limit.'); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
async function request(route: string, options: RequestOptions = {}) {
  apiPath(route); ensure(Date.now() < deadline, 'Hosted acceptance exceeded its twelve-minute deadline.');
  const method = options.method || 'GET', began = Date.now(), headers = new Headers({ origin: requestOrigin });
  if (bypass) headers.set('x-vercel-protection-bypass', bypass);
  if (options.cookie !== undefined || options.client?.cookie) headers.set('cookie', options.cookie ?? options.client!.cookie);
  if (options.workspaceId) headers.set('x-workspace-id', id(options.workspaceId));
  let body: string | undefined;
  if (options.body !== undefined) { headers.set('content-type', 'application/json'); body = JSON.stringify(options.body); }
  let response: Response;
  // Manual redirects let the original endpoint prove its 302 without forwarding
  // application cookies or a deployment-protection bypass to storage.
  try { response = await fetch(new URL(route, appOrigin), { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(Math.min(150_000, Math.max(1, deadline - Date.now()))) }); }
  catch { throw new CheckError('Application network request failed: ' + method + ' ' + route); }
  requests.push({ surface: 'application', method, path: route, status: response.status, elapsedMs: Date.now() - began });
  if (options.client) {
    const session = response.headers.getSetCookie().find(cookie => cookie.startsWith('folio_session='));
    if (session) { options.client.cookie = session.split(';', 1)[0]; await saveCredentials(); }
  }
  ensure(response.status === (options.expected ?? 200), 'Unexpected application status for ' + method + ' ' + route + ': expected ' + (options.expected ?? 200) + ', received ' + response.status + '.');
  return response;
}
async function json(route: string, options: RequestOptions = {}): Promise<Json> {
  const response = await request(route, options);
  try { return JSON.parse((await boundedBytes(response, 2 * 1024 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof CheckError) throw error; throw new CheckError('Application returned an invalid JSON response.'); }
}
async function storageRequest(url: URL, method: 'GET' | 'PUT', bytes?: Buffer) {
  ensure(Date.now() < deadline, 'Hosted acceptance exceeded its twelve-minute deadline.');
  const began = Date.now(); let response: Response;
  // Deliberately independent of request(): no cookies, authorization, API keys,
  // invitation, Origin header, or Vercel bypass are forwarded to storage.
  try { response = await fetch(url, {
    method, headers: method === 'PUT' ? { 'content-type': 'application/octet-stream', 'x-upsert': 'false' } : {},
    body: bytes ? new Uint8Array(bytes) : undefined, credentials: 'omit', referrerPolicy: 'no-referrer',
    redirect: 'error', signal: AbortSignal.timeout(Math.min(90_000, Math.max(1, deadline - Date.now()))),
  }); } catch { throw new CheckError('Signed private storage ' + method + ' request failed.'); }
  requests.push({ surface: 'private-storage', method, capability: method === 'PUT' ? 'signed-upload' : 'signed-download', status: response.status, elapsedMs: Date.now() - began });
  ensure(response.ok, 'Signed private storage ' + method + ' returned HTTP ' + response.status + '.');
  return response;
}
async function signup(label: 'owner' | 'outsider') {
  const client: Client = {
    email: 'hosted-preview-' + label + '-' + runId + '@example.test',
    password: 'Hosted-QA-' + randomBytes(24).toString('base64url'),
    name: 'Hosted Preview QA ' + label, workspaceName: 'Hosted Preview QA ' + label + ' ' + runId.slice(0, 8), cookie: '',
  };
  credentials[label] = client; await saveCredentials();
  const result = await json('/api/auth/register', { method: 'POST', expected: 201, client, body: {
    email: client.email, password: client.password, name: client.name, workspaceName: client.workspaceName, inviteCode,
  } });
  client.userId = id(result.user.id); client.workspaceId = id(result.workspace.id);
  ensure(client.cookie.startsWith('folio_session=') && client.cookie.length > 20, 'Registration did not establish a session.');
  await saveCredentials(); return { client, result };
}
function planMatches(plan: Json, name: typeof PLANS[number]['id']) {
  const advertised = PLANS.find(plan => plan.id === name)!;
  return plan.id === name && plan.monthlyPages === advertised.monthlyPages && plan.maxParsers === advertised.maxParsers && plan.maxConcurrent === advertised.maxConcurrent;
}
async function upload(client: Client, parserId: string, bytes: Buffer, filename: string): Promise<Json> {
  const reservation = await json('/api/parsers/' + parserId + '/uploads', { method: 'POST', expected: 201, client, body: { filename, size: bytes.length, sha256: sha256(bytes) } });
  const uploadId = id(reservation.uploadId), stagingKey = id(client.workspaceId) + '/' + uploadId;
  ensure(reservation.method === 'PUT' && reservation.headers?.['Content-Type'] === 'application/octet-stream' && reservation.headers?.['x-upsert'] === 'false', 'Direct upload contract is unexpected.');
  const url = signedURL(reservation.uploadUrl, 'upload/sign', stagingKey);
  await (await storageRequest(url, 'PUT', bytes)).body?.cancel();
  const result = await json('/api/uploads/' + uploadId + '/finalize', { method: 'POST', expected: 202, client, body: {} });
  id(result.document.id); id(result.jobId);
  ensure(!result.duplicate && result.document.sha256 === sha256(bytes) && result.document.byteSize === bytes.length && result.document.pageCount === 2, 'Finalized document does not match the reserved original bytes or page count.');
  ensure(result.document.storageKey === client.workspaceId + '/' + result.document.id && result.document.storageKey !== stagingKey, 'Final original is not a separate immutable object.');
  const replay = await json('/api/uploads/' + uploadId + '/finalize', { method: 'POST', expected: 202, client, body: {} });
  ensure(replay.replayed === true && replay.document.id === result.document.id && replay.jobId === result.jobId, 'Finalization replay created different document/job identifiers.');
  return { ...result, uploadId };
}
async function original(client: Client, document: Json, bytes: Buffer) {
  const route = '/api/documents/' + id(document.id);
  const redirect = await request(route + '/original', { client, expected: 302 });
  const redirected = signedURL(redirect.headers.get('location'), 'sign', document.storageKey);
  ensure(redirect.headers.get('cache-control')?.includes('no-store') && redirect.headers.get('referrer-policy') === 'no-referrer', 'Original redirect lacks private cache/referrer controls.');
  ensure(Boolean(redirected.searchParams.get('download')), 'Original redirect lacks a safe download filename.');
  await redirect.body?.cancel();
  const authorized = await json(route + '/original-url', { client });
  ensure(authorized.external === true, 'Hosted original is not using private remote storage.');
  const response = await storageRequest(signedURL(authorized.url, 'sign', document.storageKey), 'GET');
  ensure(response.headers.get('content-disposition')?.includes('attachment'), 'Private original download is missing attachment metadata.');
  const contents = await boundedBytes(response);
  ensure(contents.length === bytes.length && sha256(contents) === sha256(bytes), 'Downloaded original differs from uploaded bytes.');
  return { bytes: contents.length, sha256: sha256(contents), privateRedirect: true };
}
async function completed(client: Client, uploaded: Json, bytes: Buffer, expected: Json) {
  const began = Date.now(), until = Math.min(deadline, began + 240_000); let detail: Json | undefined;
  while (Date.now() < until) {
    detail = await json('/api/documents/' + id(uploaded.document.id), { client });
    ensure(detail.document.status !== 'failed', 'Hosted durable worker marked the synthetic invoice as failed.');
    if (detail.document.status === 'needs_review' && detail.runs.length) break;
    await delay(2_000);
  }
  ensure(detail?.document.status === 'needs_review' && detail.runs.length === 1, 'Hosted durable worker did not finish the invoice within four minutes.');
  const run = detail.runs[0]; id(run.id);
  ensure(run.engine === 'text-anchors' && run.model === 'deterministic-v2', 'Extraction did not use the rules engine.');
  ensure(run.jobId === uploaded.jobId && run.documentSha256 === sha256(bytes), 'Extraction provenance differs from the original and job.');
  ensure(detail.jobs.some((job: Json) => job.id === uploaded.jobId && job.state === 'completed'), 'Extraction job is not completed.');
  ensure(isDeepStrictEqual(run.normalizedValues, expected) && run.issues.length === 0, 'Extraction differs from the known synthetic fixture expectations.');
  return { run, elapsedMs: Date.now() - began };
}
async function prepare() {
  const stat = await fs.lstat(environmentPath);
  ensure(stat.isFile() && (stat.mode & 0o077) === 0, 'Private environment must be a regular file with no group/other permissions.');
  const privateEnv: Json = JSON.parse(await fs.readFile(environmentPath, 'utf8'));
  appOrigin = hostedOrigin(process.env.HOSTED_E2E_URL || 'https://maintainflow.io');
  requestOrigin = hostedOrigin(privateEnv.APP_ORIGIN);
  const provider = new URL(privateEnv.SUPABASE_URL);
  ensure(provider.protocol === 'https:' && /^[a-z0-9]+\.supabase\.co$/.test(provider.hostname) && provider.pathname === '/' && !provider.username && !provider.password && !provider.port && !provider.search && !provider.hash, 'Private environment must identify a plain Supabase project origin.');
  storageOrigin = provider.origin;
  ensure(privateEnv.FOLIO_PREVIEW_MODE === 'true' && privateEnv.FOLIO_BILLING_MOCK === 'true' && privateEnv.STORAGE_DRIVER === 'supabase' && privateEnv.SUPABASE_STORAGE_BUCKET === 'folio-originals', 'Hosted environment must enable invite-only preview, mocked billing, and the private originals bucket.');
  ensure(typeof privateEnv.FOLIO_PREVIEW_INVITE_CODE === 'string' && privateEnv.FOLIO_PREVIEW_INVITE_CODE.length >= 32, 'Private preview invite is not configured.');
  inviteCode = privateEnv.FOLIO_PREVIEW_INVITE_CODE;
  bypass = privateEnv.VERCEL_AUTOMATION_BYPASS_SECRET || privateEnv.VERCEL_PROTECTION_BYPASS || '';
  ensure(typeof bypass === 'string' && !/[\r\n]/.test(bypass), 'Optional deployment protection bypass is invalid.');
  const fixturePath = 'fixtures/generated/invoice-multipage.pdf';
  const bytes = await fs.readFile(path.join(root, fixturePath));
  const manifest: Json = JSON.parse(await fs.readFile(path.join(root, 'fixtures/generated/manifest.json'), 'utf8'));
  const fixture = manifest.fixtures.find((entry: Json) => entry.filename === 'invoice-multipage.pdf');
  ensure(manifest.synthetic === true && fixture?.category === 'supported' && fixture.pageCount === 2, 'Known two-page synthetic invoice fixture is unavailable.');
  const pdf = await PDFDocument.load(bytes);
  ensure(pdf.getPageCount() === 2, 'Invoice fixture must contain two valid PDF pages.');
  // An incompressible synthetic attachment makes a valid 6 MiB PDF without
  // changing the two visible invoice pages or their expected extraction values.
  await pdf.attach(randomBytes(6 * 1024 * 1024), 'synthetic-padding.bin', { mimeType: 'application/octet-stream', description: 'Synthetic large-transfer QA padding' });
  const largeBytes = Buffer.from(await pdf.save({ useObjectStreams: false }));
  ensure(largeBytes.length > 6 * 1024 * 1024 && largeBytes.length < 7 * 1024 * 1024 && (await PDFDocument.load(largeBytes)).getPageCount() === 2, 'Large fixture must be a valid two-page PDF between six and seven MiB.');
  evidence.targetOrigin = appOrigin; evidence.requestOrigin = requestOrigin; evidence.protectionBypassUsed = Boolean(bypass);
  evidence.runnerSha256 = sha256(await fs.readFile(path.join(root, 'scripts/hosted-preview-e2e.ts')));
  evidence.fixtures = [
    { name: fixturePath, bytes: bytes.length, sha256: sha256(bytes), pageCount: 2 },
    { name: 'generated-in-memory-invoice-with-synthetic-attachment.pdf', bytes: largeBytes.length, sha256: sha256(largeBytes), pageCount: 2, exceedsVercelBodyLimit: true },
  ];
  return { bytes, largeBytes, fixture };
}
async function run() {
  const { bytes, largeBytes, fixture } = await prepare();
  // Open with wx before any HTTP. Held file descriptors prevent later symlink
  // substitution and ensure this run only updates its own newly reserved files.
  await fs.mkdir(path.dirname(accountPath), { recursive: true, mode: 0o700 });
  accountFile = await fs.open(accountPath, 'wx', 0o600); await accountFile.chmod(0o600);
  await fs.mkdir(path.dirname(evidencePath), { recursive: true });
  evidenceFile = await fs.open(evidencePath, 'wx', 0o644);
  credentials.targetOrigin = appOrigin; credentials.requestOrigin = requestOrigin;
  await saveCredentials(); await saveEvidence();

  phase = 'hosted-preview-preflight';
  const health = await json('/api/health'), config = await json('/api/config');
  ensure(health.status === 'ok' && health.name === 'Folio' && health.environment === 'preview' && health.limits?.maxBytes === maxBytes, 'Target is not the expected hosted Folio preview.');
  ensure(config.preview === true && config.inviteRequired === true && config.hosted === true, 'Target must be the invite-only hosted preview.');
  ensure(typeof health.revision === 'string' && /^[0-9a-f]{40}$/.test(health.revision), 'Hosted revision evidence is unavailable.');
  evidence.deployedRevision = health.revision;
  await checked(phase, { environment: 'preview', revision: health.revision, hosted: true, inviteRequired: true });

  phase = 'fresh-owner-and-direct-upload';
  const { client: owner, result: registration } = await signup('owner');
  ensure(planMatches(registration.workspace.plan, 'explore') && registration.workspace.role === 'owner', 'Fresh account did not receive Explore ownership.');
  const strategy = await json('/api/uploads/config', { client: owner });
  ensure(strategy.strategy === 'signed' && strategy.maxBytes === maxBytes, 'Hosted upload strategy does not support signed 10 MiB intake.');
  const created = await json('/api/parsers', { method: 'POST', expected: 201, client: owner, body: { name: 'Hosted QA invoice ' + runId.slice(0, 8), useCase: 'invoice', mode: 'rules', locale: 'en-IE', timezone: 'Europe/Dublin' } });
  const parserId = id(created.parser.id); credentials.parserId = parserId;
  const uploaded = await upload(owner, parserId, bytes, 'synthetic-hosted-invoice.pdf');
  const documentId = id(uploaded.document.id); credentials.documentId = documentId; await saveCredentials();
  const completedInvoice = await completed(owner, uploaded, bytes, fixture.expected);
  const run = completedInvoice.run, extractionRunId = id(run.id), downloadedOriginal = await original(owner, uploaded.document, bytes);
  const usage = await json('/api/workspace/usage', { client: owner });
  ensure(usage.usage.pages === 2 && usage.usage.documents === 1, 'Finalization replay incorrectly increased usage.');
  await checked(phase, { parserId, documentId, uploadId: uploaded.uploadId, jobId: uploaded.jobId, extractionRunId, rulesOnly: true, expectedValuesMatched: true, finalizationReplayPreserved: true, usagePages: 2, original: downloadedOriginal, workerElapsedMs: completedInvoice.elapsedMs });

  phase = 'correction-approval-and-export';
  const correctedValues = { ...fixture.expected, supplier: 'Fern Office Supplies — reviewed hosted QA' };
  const corrected = await json('/api/runs/' + extractionRunId + '/corrections', { method: 'POST', client: owner, body: { expectedRevision: run.effectiveRevision, values: correctedValues } });
  ensure(isDeepStrictEqual(corrected.run.normalizedValues, fixture.expected) && isDeepStrictEqual(corrected.run.effectiveValues, correctedValues) && corrected.issues.length === 0, 'Correction did not preserve immutable extraction and effective reviewed values.');
  const approved = await json('/api/runs/' + extractionRunId + '/approve', { method: 'POST', client: owner, body: { expectedRevision: corrected.run.effectiveRevision } });
  const approvalId = id(approved.approval.id);
  ensure(approved.approval.correctionId === corrected.correction.id && isDeepStrictEqual(approved.approval.values, correctedValues), 'Approval did not pin the corrected values.');
  const columns = [{ source: 'invoice_number', label: 'Invoice number' }, { source: 'supplier', label: 'Supplier' }, { source: 'total', label: 'Total' }, { source: '$item.description', label: 'Description' }, { source: '$item.amount', label: 'Line amount' }, { source: '$approvalId', label: 'Approval ID' }];
  const exports: Json[] = [];
  for (const format of ['csv', 'xlsx', 'json'] as const) {
    const exported = await json('/api/exports', { method: 'POST', client: owner, body: { documentIds: [documentId], format, columns, lineItems: 'line_items' } });
    ensure(exported.revisions[0]?.approvalId === approvalId, 'Export did not pin the reviewed approval.');
    const downloadPath = apiPath(exported.downloadUrl);
    const response = await request(downloadPath, { client: owner }), contents = await boundedBytes(response);
    ensure(contents.length > 0 && response.headers.get('content-disposition')?.includes('attachment'), 'Export download is empty or lacks attachment metadata.');
    if (format === 'json') {
      const output = JSON.parse(contents.toString('utf8'));
      ensure(output.documents.length === 1 && output.documents[0].approvalId === approvalId && output.documents[0].revision === 1 && isDeepStrictEqual(output.documents[0].values, correctedValues), 'JSON export lost corrected values or revision metadata.');
    } else if (format === 'xlsx') {
      const book = new ExcelJS.Workbook(); await book.xlsx.load(contents as any); const sheet = book.getWorksheet(1)!;
      ensure(sheet.rowCount === 5 && sheet.getCell('A2').value === fixture.expected.invoice_number && sheet.getCell('B2').value === correctedValues.supplier && sheet.getCell('C2').value === fixture.expected.total && sheet.getCell('D4').value === 'Desk pads' && sheet.getCell('F5').value === approvalId, 'XLSX export lost reviewed values or line-item rows.');
    } else {
      const rows = contents.toString('utf8').replace(/^\uFEFF/, '').trimEnd().split('\r\n');
      ensure(rows.length === 5 && rows[1].includes('"' + correctedValues.supplier + '"') && rows[1].includes('"' + fixture.expected.total + '"') && rows[3].includes('"Desk pads"') && rows.slice(1).every(row => row.includes(approvalId)), 'CSV export lost reviewed values or line-item rows.');
    }
    exports.push({ id: id(exported.id), format, bytes: contents.length, sha256: sha256(contents), approvalId, downloadPath });
  }
  await checked(phase, { correctionId: id(corrected.correction.id), approvalId, immutableExtraction: true, exports });

  phase = 'large-private-original-and-rules';
  const large = await upload(owner, parserId, largeBytes, 'synthetic-hosted-invoice-6mib.pdf');
  credentials.largeDocumentId = id(large.document.id); await saveCredentials();
  const largeCompleted = await completed(owner, large, largeBytes, fixture.expected);
  const largeOriginal = await original(owner, large.document, largeBytes);
  const largeUsage = await json('/api/workspace/usage', { client: owner });
  ensure(largeUsage.usage.pages === 4 && largeUsage.usage.documents === 2, 'Large finalization replay incorrectly increased usage.');
  await checked(phase, { documentId: large.document.id, uploadId: large.uploadId, jobId: large.jobId, extractionRunId: largeCompleted.run.id, original: largeOriginal, exceedsVercelBodyLimit: true, finalizationReplayPreserved: true, expectedValuesMatched: true, usagePages: 4 });

  phase = 'session-persistence-and-mock-plan-cancel';
  const oldCookie = owner.cookie;
  await json('/api/auth/logout', { method: 'POST', client: owner, body: {} });
  await (await request('/api/auth/me', { cookie: oldCookie, expected: 401 })).body?.cancel();
  const login = await json('/api/auth/login', { method: 'POST', client: owner, body: { email: owner.email, password: owner.password } });
  ensure(login.user.id === owner.userId && login.workspace.id === owner.workspaceId, 'Fresh login did not restore the same workspace.');
  const team = await json('/api/billing/mock/plan', { method: 'POST', client: owner, body: { planId: 'team' } });
  ensure(team.mode === 'mock' && planMatches(team.plan, 'team') && team.plan.mockStatus === 'active', 'Mock Team upgrade failed.');
  const reloaded = await json('/api/auth/me', { client: owner });
  ensure(planMatches(reloaded.workspace.plan, 'team'), 'Mock Team plan did not persist.');
  const canceled = await json('/api/billing/mock/cancel', { method: 'POST', client: owner, body: {} });
  ensure(canceled.mode === 'mock' && planMatches(canceled.plan, 'explore') && canceled.plan.mockStatus === 'canceled', 'Mock cancellation did not restore Explore.');
  const finalUsage = await json('/api/workspace/usage', { client: owner }), preserved = await json('/api/documents/' + documentId, { client: owner }), parsers = await json('/api/parsers', { client: owner });
  ensure(planMatches(finalUsage.plan, 'explore') && finalUsage.usage.pages === 4 && finalUsage.usage.documents === 2 && parsers.parsers.length === 1 && parsers.parsers[0].id === parserId, 'Mock cancellation changed retained documents, parser, or usage.');
  ensure(preserved.document.approvedRunId === extractionRunId && preserved.document.status === 'exported' && preserved.runs[0].approvals.some((approval: Json) => approval.id === approvalId && isDeepStrictEqual(approval.values, correctedValues)), 'Approved values did not persist across login and mock cancellation.');
  const history = await json('/api/exports', { client: owner });
  for (const exported of exports) {
    ensure(history.exports.some((entry: Json) => entry.id === exported.id), 'Export history did not persist.');
    ensure(sha256(await boundedBytes(await request(exported.downloadPath, { client: owner }))) === exported.sha256, 'Export snapshot bytes changed across login.');
  }
  await checked(phase, { revokedSessionRejected: true, sameUserAndWorkspace: true, upgradedPlan: 'team', finalPlan: 'explore', mockStatus: 'canceled', realPaymentVerification: false, usagePages: 4, documentsPreserved: 2, exportSnapshotsUnchanged: true });

  phase = 'cross-tenant-and-unauthenticated-denials';
  const { client: outsider } = await signup('outsider');
  for (const targetId of [documentId, large.document.id]) {
    for (const suffix of ['', '/original', '/original-url']) await (await request('/api/documents/' + targetId + suffix, { client: outsider, expected: 404 })).body?.cancel();
  }
  await (await request(exports[0].downloadPath, { client: outsider, expected: 404 })).body?.cancel();
  await (await request('/api/uploads/' + uploaded.uploadId + '/finalize', { method: 'POST', client: outsider, body: {}, expected: 404 })).body?.cancel();
  await (await request('/api/parsers/' + parserId + '/uploads', { method: 'POST', client: outsider, body: { filename: 'denied.pdf', size: bytes.length, sha256: sha256(bytes) }, expected: 404 })).body?.cancel();
  await (await request('/api/documents/' + documentId, { client: outsider, workspaceId: owner.workspaceId, expected: 403 })).body?.cancel();
  await (await request('/api/documents', { client: owner, workspaceId: outsider.workspaceId, expected: 403 })).body?.cancel();
  const outsiderDocs = await json('/api/documents', { client: outsider });
  ensure(outsiderDocs.total === 0, 'Outsider workspace contains an owner document.');
  for (const route of ['/api/auth/me', '/api/documents/' + documentId + '/original-url', '/api/uploads/config']) await (await request(route, { expected: 401 })).body?.cancel();
  await checked(phase, { outsiderUserId: outsider.userId, outsiderWorkspaceId: outsider.workspaceId, bothOriginalsDenied: true, uploadReservationAndFinalizationDenied: true, exportDenied: true, forgedWorkspaceHeadersDenied: true, unauthenticatedDenied: true });

  phase = 'private-browser-handoff';
  const finalHealth = await json('/api/health');
  ensure(finalHealth.revision === evidence.deployedRevision && finalHealth.environment === 'preview', 'Hosted revision or preview mode changed during acceptance.');
  await saveCredentials();
  ensure(((await accountFile.stat()).mode & 0o777) === 0o600, 'Private credential file is not mode 0600.');
  evidence.browserHandoff = { ownerUserId: owner.userId, workspaceId: owner.workspaceId, parserId, documentId, largeDocumentId: large.document.id, documentPath: '/app/documents/' + documentId, credentialsPath: '.local/hosted-preview/account.json', credentialMode: '0600', finalPlan: 'explore', billingMode: 'mock' };
  await checked(phase, { credentialMode: '0600', syntheticWorkspaceRetained: true });
  evidence.status = 'passed'; evidence.completedAt = new Date().toISOString(); await saveEvidence();
  console.log('Hosted acceptance passed (' + checks.length + ' checks). Safe evidence: ' + path.relative(root, evidencePath));
}
try {
  const args = process.argv.slice(2);
  ensure(args.length <= 1 && (!args.length || ['--prepare', '--run', '--help'].includes(args[0])), 'Usage: node --import tsx scripts/hosted-preview-e2e.ts [--prepare|--run|--help]');
  if (args[0] === '--help') {
    console.log('Prepare (no HTTP): node --import tsx scripts/hosted-preview-e2e.ts --prepare\nRun: HOSTED_E2E_URL=https://maintainflow.io node --import tsx scripts/hosted-preview-e2e.ts --run\nOptional target: one explicit HTTPS *.vercel.app deployment origin. Private config: .local/hosted-preview/environment.json. Existing account.json aborts before HTTP.');
  } else if (args[0] === '--run') await run();
  else {
    const { bytes, largeBytes } = await prepare();
    console.log('Prepared only; no HTTP requests or output files written. Target: ' + appOrigin + '. Valid PDF bytes: ' + bytes.length + ' and ' + largeBytes.length + '. Run with --run after hosted setup is complete.');
  }
} catch (error) {
  const message = error instanceof CheckError ? error.message : (error as NodeJS.ErrnoException)?.code === 'EEXIST'
    ? 'A private account or evidence file already exists. Preserve it before an intentional rerun.'
    : 'Unexpected runner failure; inspect the named phase locally without exposing secrets or response bodies.';
  evidence.status = 'failed'; evidence.completedAt = new Date().toISOString(); evidence.failure = { phase, message };
  try { await saveEvidence(); } catch { /* Never expose raw filesystem/provider errors. */ }
  console.error('Hosted acceptance failed at ' + phase + ': ' + message); process.exitCode = 1;
} finally {
  await accountFile?.close().catch(() => {}); await evidenceFile?.close().catch(() => {});
}
