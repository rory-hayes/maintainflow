/** Independent synthetic OpenDocument packages through the real application API. */
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { ParserSchema } from '../shared/types.js';
import { buildApp } from '../server/app.js';
import { adminPool, appPool, closeDatabase, databaseSchema } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import { createOpenAIProvider, openAIExtraction } from '../server/core/openai-provider.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';

const odtMime = 'application/vnd.oasis.opendocument.text';
const officeNs = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';
const textNs = 'urn:oasis:names:tc:opendocument:xmlns:text:1.0';
const tableNs = 'urn:oasis:names:tc:opendocument:xmlns:table:1.0';
const manifestNs = 'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0';
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const tableRows = [['Description', 'Quantity', 'Amount'], ['Parts', '2', '1.000,00'], ['Labour', '1', '234,56']];
const sourceText = (reference = '000042') => [
  'SYNTHETIC ODT WORKFLOW FIXTURE', `Reference: ${reference}`, 'Supplier: Cedar & Pine',
  'Date: 17.09.2026', 'Total: 1.234,56', 'Items:', ...tableRows.map(row => row.join('\t')),
].join('\n');

// This package is deliberately authored here, independently of the decoder's
// fixture builders. ODF versions, ZIP membership and displayed text are explicit.
async function makeOdt(options: { version?: '1.2' | '1.3'; reference?: string; malformed?: boolean } = {}) {
  const version = options.version ?? '1.3', reference = options.reference ?? '000042';
  const paragraphs = [
    '<text:h text:outline-level="1">SYNTHETIC ODT WORKFLOW FIXTURE</text:h>',
    `<text:p>Reference: ${xml(reference)}</text:p>`,
    '<text:p>Supplier: <text:span>Cedar &amp; Pine</text:span></text:p>',
    '<text:p>Date: 17.09.2026</text:p>', '<text:p>Total: 1.234,56</text:p>', '<text:p>Items:</text:p>',
  ].join('');
  const table = '<table:table table:name="Synthetic invoice rows">' + tableRows.map(row =>
    '<table:table-row>' + row.map(value => `<table:table-cell office:value-type="string"><text:p>${xml(value)}</text:p></table:table-cell>`).join('') + '</table:table-row>',
  ).join('') + '</table:table>';
  const body = options.malformed ? '<text:p>PRIVATE SYNTHETIC MALFORMED XML</text:span>' : paragraphs + table;
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="${officeNs}" xmlns:text="${textNs}" xmlns:table="${tableNs}" office:version="${version}"><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  const manifest = `<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="${manifestNs}" manifest:version="${version}"><manifest:file-entry manifest:full-path="/" manifest:media-type="${odtMime}" manifest:version="${version}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`;
  const zip = new JSZip(), date = new Date('2026-01-01T00:00:00Z');
  zip.file('mimetype', odtMime, { compression: 'STORE', date });
  zip.file('META-INF/manifest.xml', manifest, { compression: 'DEFLATE', date, createFolders: false });
  zip.file('content.xml', content, { compression: 'DEFLATE', date });
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const schema: ParserSchema = { fields: [
  { key: 'reference', label: 'Reference', type: 'string', required: true },
  { key: 'supplier', label: 'Supplier', type: 'string', required: true },
  { key: 'date', label: 'Date', type: 'date', required: true },
  { key: 'total', label: 'Total', type: 'currency', required: true },
  { key: 'line_items', label: 'Items', type: 'array', required: true, fields: [
    { key: 'description', label: 'Description', type: 'string', required: true },
    { key: 'quantity', label: 'Quantity', type: 'number', required: true },
    { key: 'amount', label: 'Amount', type: 'currency', required: true },
  ] },
] };
const rawValues = {
  reference: '000042', supplier: 'Cedar & Pine', date: '17.09.2026', total: '1.234,56',
  line_items: [{ description: 'Parts', quantity: '2', amount: '1.000,00' }, { description: 'Labour', quantity: '1', amount: '234,56' }],
};
const normalizedValues = {
  reference: '000042', supplier: 'Cedar & Pine', date: '2026-09-17', total: 1234.56,
  line_items: [{ description: 'Parts', quantity: 2, amount: 1000 }, { description: 'Labour', quantity: 1, amount: 234.56 }],
};
type Account = { userId: string; workspaceId: string; cookie: string };
type Fixture = { account: Account; parserId: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const accounts: Account[] = [], objects = new Map<string, Buffer>();
const originalFetch = globalThis.fetch;
let app: FastifyInstance, databaseVerified = false, networkCalls = 0, valid: Buffer, malformed: Buffer;
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); assert.ok(bytes, 'Owned original or staged bytes must exist'); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
  async signUpload(key) { return `https://synthetic-upload.example.test/${key}`; },
};

before(async () => {
  assert.equal(databaseSchema, 'public');
  const pools = [[adminPool, 'folio_admin'], [appPool, 'folio_app']] as const;
  const urlMode = Boolean(adminPool.options.connectionString || appPool.options.connectionString);
  if (urlMode) {
    assert.equal(process.env.NODE_ENV, 'test'); assert.ok(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true');
    for (const [pool, role] of pools) {
      assert.equal(typeof pool.options.connectionString, 'string'); const url = new URL(pool.options.connectionString!);
      assert.ok(['postgres:', 'postgresql:'].includes(url.protocol)); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
      assert.equal(url.pathname, '/folio'); assert.equal(url.port || '5432', '5432'); assert.equal(decodeURIComponent(url.username), role);
      assert.equal(url.search, ''); assert.equal(url.hash, '');
    }
  } else {
    assert.ok(config.root.startsWith('/private/tmp/') || config.root.startsWith('/tmp/'), 'ODT API fixtures require a private copied checkout, never the shared development database');
    for (const [pool, role] of pools) {
      assert.equal(path.resolve(pool.options.host!), path.resolve(config.root, '.local/socket'));
      assert.equal(pool.options.port, 55432); assert.equal(pool.options.database, 'folio'); assert.equal(pool.options.user, role);
    }
  }
  for (const [pool, role] of pools) {
    const identity = (await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
    assert.equal(identity.db, 'folio'); assert.equal(identity.schema, 'public'); assert.equal(identity.role, role); assert.equal(identity.port, urlMode ? 5432 : 55432);
    if (!urlMode) assert.equal(identity.address, null);
  }
  databaseVerified = true; setStorageForTests(storage);
  globalThis.fetch = async () => { networkCalls++; throw new Error('External transport is forbidden in ODT workflow fixtures'); };
  valid = await makeOdt(); malformed = await makeOdt({ malformed: true });
  app = await buildApp(); await app.ready();
});
afterEach(() => { setExtractionProvider(undefined); assert.equal(networkCalls, 0); });
after(async () => {
  setExtractionProvider(undefined); setStorageForTests(undefined); globalThis.fetch = originalFetch;
  try {
    await app?.close();
    if (databaseVerified) {
      for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspaceId]);
      for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.userId]);
    }
    objects.clear();
  } finally { await closeDatabase(); }
});
const request = (account: Account, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, headers: { origin: config.origin, cookie: account.cookie, ...headers } });
async function account(): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: 'Owned ODT workflow', workspaceName: 'Owned ODT workspace', email: `odt-workflow-${randomUUID()}@example.test`, password: 'Owned ODT workflow fixture password',
  } });
  assert.equal(response.statusCode, 201, response.body); const body = response.json();
  const value = { userId: body.user.id, workspaceId: body.workspace.id, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  accounts.push(value); return value;
}
async function fixture(mode: 'rules' | 'ai' = 'rules', allowedFormats = ['odt']): Promise<Fixture> {
  const owner = await account();
  const response = await request(owner, 'POST', '/api/parsers', { name: 'Owned ODT parser', useCase: 'custom', mode, locale: 'de-DE', timezone: 'Europe/Berlin', allowedFormats, schema });
  assert.equal(response.statusCode, 201, response.body); return { account: owner, parserId: response.json().parser.id };
}
function multipart(bytes: Buffer, filename = 'synthetic-invoice.odt', mimeType = odtMime, fields: Record<string, string> = {}) {
  const boundary = `synthetic-odt-${randomUUID()}`;
  return { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.concat([
    ...Object.entries(fields).map(([key, value]) => Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]) };
}
async function upload(f: Fixture, bytes = valid, options: { key?: string; filename?: string; mimeType?: string; account?: Account; headers?: Record<string, string> } = {}) {
  const body = multipart(bytes, options.filename, options.mimeType);
  return request(options.account ?? f.account, 'POST', `/api/parsers/${f.parserId}/documents`, body.payload, { ...body.headers, 'idempotency-key': options.key ?? randomUUID(), ...options.headers });
}
async function detail(f: Fixture, id: string) {
  const response = await request(f.account, 'GET', `/api/documents/${id}`); assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function counts(f: Fixture) {
  return (await adminPool.query(`select
    (select count(*)::int from documents where workspace_id=$1) documents,
    (select count(*)::int from jobs where workspace_id=$1) jobs,
    (select count(*)::int from extraction_runs where workspace_id=$1) runs,
    (select count(*)::int from usage_ledger where workspace_id=$1) charges,
    (select coalesce(sum(pages),0)::int from usage_ledger where workspace_id=$1) pages`, [f.account.workspaceId])).rows[0];
}
async function key(owner: Account, scopes: string[]) {
  const response = await request(owner, 'POST', '/api/workspace/api-keys', { name: 'Owned ODT key', scopes });
  assert.equal(response.statusCode, 200, response.body); return { cookie: '', authorization: `Bearer ${response.json().token}` };
}
async function archive(f: Fixture, bytes: Buffer, requestId: string, options?: unknown) {
  const body = multipart(bytes, 'synthetic-bundle.zip', 'application/zip', { requestId, ...(options ? { options: JSON.stringify(options) } : {}) });
  return request(f.account, 'POST', `/api/parsers/${f.parserId}/archive-imports${options ? '' : '/preview'}`, body.payload, body.headers);
}

test('ODT 1.3 preserves literal paragraphs and table rows through rules, corrections, approvals and exact historical exports', async () => {
  const f = await fixture(), accepted = await upload(f); assert.equal(accepted.statusCode, 202, accepted.body);
  const source = accepted.json(); assert.equal(source.document.mimeType, odtMime); assert.equal(source.document.pageCount, 1); assert.equal(source.document.sha256, sha(valid));
  const stored = (await adminPool.query('select source_text from documents where id=$1', [source.document.id])).rows[0];
  assert.deepEqual(stored.source_text, [{ page: 1, text: sourceText() }]);
  assert.equal((await adminPool.query('select config from jobs where id=$1', [source.jobId])).rows[0].config.normalizationPolicy, 'regional-v2');
  assert.deepEqual(await counts(f), { documents: 1, jobs: 1, runs: 0, charges: 1, pages: 1 });
  assert.equal(await processOneCoreJob(source.jobId), true);
  const completed = await detail(f, source.document.id); assert.equal(completed.document.status, 'needs_review', completed.document.error);
  const run = completed.runs[0]; assert.ok(run); assert.deepEqual(run.rawValues, rawValues); assert.deepEqual(run.normalizedValues, normalizedValues);
  assert.deepEqual(run.validationIssues, []); assert.equal(run.documentSha256, sha(valid)); assert.equal(run.normalizationContext.version, 'regional-v2'); assert.equal(run.normalizationContext.locale, 'de-DE');
  assert.deepEqual(run.evidence.total, [{ page: 1, text: 'Total: 1.234,56' }]);
  assert.deepEqual(run.evidence.line_items, [{ page: 1, text: 'Parts\t2\t1.000,00' }, { page: 1, text: 'Labour\t1\t234,56' }]);
  const originalEvidence = structuredClone(run.evidence);
  const original = await request(f.account, 'GET', `/api/documents/${source.document.id}/original`);
  assert.equal(original.statusCode, 200, original.body); assert.deepEqual(original.rawPayload, valid);
  assert.match(String(original.headers['content-disposition']), /^attachment/); assert.equal(original.headers['x-content-type-options'], 'nosniff');
  assert.match(String(original.headers['cache-control']), /private, no-store/);
  const firstApproval = await request(f.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: run.effectiveRevision }); assert.equal(firstApproval.statusCode, 200, firstApproval.body);
  const correctedValues = structuredClone(normalizedValues); correctedValues.supplier = 'Cedar & Pine Reviewed'; correctedValues.total = 1500.75; correctedValues.line_items[1].amount = 500.75;
  const correction = await request(f.account, 'POST', `/api/runs/${run.id}/corrections`, { values: correctedValues, expectedRevision: run.effectiveRevision });
  assert.equal(correction.statusCode, 200, correction.body); assert.deepEqual(correction.json().issues, []); assert.deepEqual(correction.json().run.effectiveValues, correctedValues);
  const approval = await request(f.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: correction.json().run.effectiveRevision }); assert.equal(approval.statusCode, 200, approval.body);
  const approvalId = approval.json().approval.id;
  const reprocess = await request(f.account, 'POST', `/api/documents/${source.document.id}/reprocess`); assert.equal(reprocess.statusCode, 200, reprocess.body);
  assert.equal(await processOneCoreJob(reprocess.json().job.id), true); const latest = await detail(f, source.document.id);
  assert.notEqual(latest.runs[0].id, run.id); assert.deepEqual(latest.runs[0].normalizedValues, normalizedValues); assert.deepEqual(latest.runs[0].approvals, []);
  const columns = [['reference', 'Reference'], ['supplier', 'Supplier'], ['date', 'Date'], ['total', 'Total'], ['$item.description', 'Item'], ['$item.quantity', 'Quantity'], ['$item.amount', 'Amount']].map(([source, label]) => ({ source, label }));
  for (const format of ['json', 'csv', 'xlsx']) {
    const exported = await request(f.account, 'POST', '/api/exports', { documentIds: [source.document.id], revisions: [{ documentId: source.document.id, approvalId }], format, columns, lineItems: 'line_items' });
    assert.equal(exported.statusCode, 200, exported.body); assert.deepEqual(exported.json().revisions, [{ documentId: source.document.id, runId: run.id, approvalId }]);
    const bytes = await request(f.account, 'GET', exported.json().downloadUrl); assert.equal(bytes.statusCode, 200, bytes.body);
    if (format === 'json') {
      assert.equal(bytes.json().documents[0].approvalId, approvalId); assert.equal(bytes.json().documents[0].runId, run.id); assert.deepEqual(bytes.json().documents[0].values, correctedValues);
    } else if (format === 'csv') {
      assert.deepEqual(bytes.rawPayload, Buffer.from('\uFEFF"Reference","Supplier","Date","Total","Item","Quantity","Amount"\r\n'
        + '"000042","Cedar & Pine Reviewed","2026-09-17","1500.75","Parts","2","1000"\r\n'
        + '"000042","Cedar & Pine Reviewed","2026-09-17","1500.75","Labour","1","500.75"\r\n'));
    } else {
      const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes.rawPayload as any); const sheet = book.worksheets[0]; assert.equal(sheet.rowCount, 3);
      assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), columns.map(column => column.label));
      assert.deepEqual((sheet.getRow(2).values as unknown[]).slice(1), ['000042', 'Cedar & Pine Reviewed', '2026-09-17', 1500.75, 'Parts', 2, 1000]);
      assert.deepEqual((sheet.getRow(3).values as unknown[]).slice(1), ['000042', 'Cedar & Pine Reviewed', '2026-09-17', 1500.75, 'Labour', 1, 500.75]);
    }
  }
  const earlier = await request(f.account, 'POST', '/api/exports', { documentIds: [source.document.id], revisions: [{ documentId: source.document.id, approvalId: firstApproval.json().approval.id }], format: 'json' });
  assert.equal(earlier.statusCode, 200, earlier.body); assert.deepEqual((await request(f.account, 'GET', earlier.json().downloadUrl)).json().documents[0].values, normalizedValues);
  const saved = (await request(f.account, 'GET', `/api/runs/${run.id}`)).json().run;
  assert.deepEqual(saved.rawValues, rawValues); assert.deepEqual(saved.normalizedValues, normalizedValues); assert.deepEqual(saved.evidence, originalEvidence); assert.equal(saved.approvals.length, 2);
  assert.deepEqual(await counts(f), { documents: 1, jobs: 2, runs: 2, charges: 2, pages: 2 });
});

test('ODT 1.2 reaches the real AI adapter as decoded text without visual attachments or external transport', async () => {
  let controlledCalls = 0;
  const evidence = [
    ['reference', 'Reference: 000042'], ['supplier', 'Supplier: Cedar & Pine'], ['date', 'Date: 17.09.2026'], ['total', 'Total: 1.234,56'],
    ['line_items[0].description', 'Parts'], ['line_items[0].quantity', '2'], ['line_items[0].amount', '1.000,00'],
    ['line_items[1].description', 'Labour'], ['line_items[1].quantity', '1'], ['line_items[1].amount', '234,56'],
  ].map(([field, text]) => ({ field, page: 1, text }));
  setExtractionProvider(createOpenAIProvider({ apiKey: 'SYNTHETIC_ODT_ONLY', fetch: (async (_url, options) => {
    controlledCalls++; const body = JSON.parse(String(options?.body)); const content = body.input[0].content;
    assert.ok(content.every((item: any) => item.type === 'input_text')); assert.ok(content.some((item: any) => item.text.includes(sourceText())));
    assert.equal(body.store, false);
    return new Response(JSON.stringify({ status: 'completed', model: openAIExtraction.model, usage: { input_tokens: 1000, output_tokens: 100 }, output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ rawValues, evidence }) }] }] }), { status: 200 });
  }) as typeof fetch }));
  const f = await fixture('ai'), bytes = await makeOdt({ version: '1.2' }), accepted = await upload(f, bytes);
  assert.equal(accepted.statusCode, 202, accepted.body); assert.equal(await processOneCoreJob(accepted.json().jobId), true);
  const completed = await detail(f, accepted.json().document.id); assert.equal(completed.document.status, 'needs_review', completed.document.error);
  const run = completed.runs[0]; assert.ok(run); assert.equal(run.engine, 'openai'); assert.equal(run.documentSha256, sha(bytes));
  assert.deepEqual(run.rawValues, rawValues); assert.deepEqual(run.normalizedValues, normalizedValues); assert.deepEqual(run.validationIssues, []);
  assert.deepEqual(run.evidence['line_items[1].amount'], [{ page: 1, text: '234,56', source: 'matched-text' }]);
  assert.equal(run.tokenUsage.sourceRendering, undefined); assert.equal(controlledCalls, 1); assert.equal(networkCalls, 0);
});

test('ODT actual-byte policy, viewer access, API scopes, tenant boundaries and browser origin remain enforced', async () => {
  const f = await fixture('rules', ['txt']), foreign = await fixture(), viewer = await account();
  const policy = await upload(f, valid, { filename: 'renamed.txt', mimeType: 'text/plain' }); assert.equal(policy.statusCode, 415, policy.body);
  assert.match(policy.json().message, /does not accept.*ODT|does not accept.*OpenDocument/i);
  assert.deepEqual(await counts(f), { documents: 0, jobs: 0, runs: 0, charges: 0, pages: 0 });
  const receipt = (await adminPool.query('select rejection_format from intake_events where workspace_id=$1', [f.account.workspaceId])).rows;
  assert.deepEqual(receipt, [{ rejection_format: 'odt' }]);
  assert.equal((await request(f.account, 'PATCH', `/api/parsers/${f.parserId}`, { allowedFormats: ['odt'] })).statusCode, 200);
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [f.account.workspaceId, viewer.userId]);
  const readKey = await key(f.account, ['documents:read']), writeKey = await key(f.account, ['documents:write', 'documents:read']), foreignKey = await key(foreign.account, ['documents:write', 'documents:read']);
  const before = await counts(f);
  assert.equal((await upload(f, valid, { account: viewer, headers: { 'x-workspace-id': f.account.workspaceId } })).statusCode, 403);
  assert.equal((await upload(f, valid, { headers: readKey })).statusCode, 403);
  assert.equal((await upload(f, valid, { headers: { origin: 'https://unrelated.example.test' } })).statusCode, 403);
  assert.equal((await upload(f, valid, { account: foreign.account, headers: { ...foreignKey, 'x-workspace-id': f.account.workspaceId } })).statusCode, 404);
  assert.equal((await request(viewer, 'POST', `/api/parsers/${f.parserId}/uploads`, { filename: 'owned.odt', size: valid.length, sha256: sha(valid) }, { 'x-workspace-id': f.account.workspaceId })).statusCode, 403);
  assert.deepEqual(await counts(f), before);
  const accepted = await upload(f, valid, { filename: 'renamed.bin', mimeType: 'application/octet-stream', headers: writeKey }); assert.equal(accepted.statusCode, 202, accepted.body);
  const documentId = accepted.json().document.id; assert.equal(accepted.json().document.mimeType, odtMime);
  const viewerHeaders = { 'x-workspace-id': f.account.workspaceId };
  assert.deepEqual((await request(viewer, 'GET', `/api/documents/${documentId}/original`, undefined, viewerHeaders)).rawPayload, valid);
  assert.equal((await request(viewer, 'POST', `/api/documents/${documentId}/reprocess`, undefined, viewerHeaders)).statusCode, 403);
  assert.equal((await request(viewer, 'DELETE', `/api/documents/${documentId}`, undefined, viewerHeaders)).statusCode, 403);
  assert.equal((await request(foreign.account, 'GET', `/api/documents/${documentId}/original`, undefined, foreignKey)).statusCode, 404);
  assert.equal((await app.inject({ url: `/api/documents/${documentId}/original` })).statusCode, 401);
  assert.deepEqual(await counts(f), { documents: 1, jobs: 1, runs: 0, charges: 1, pages: 1 });
});

test('signed ODT finalization and multipart receipts preserve original bytes, replay identity and deletion tombstones without extra charges', async () => {
  const f = await fixture(), reserved = await request(f.account, 'POST', `/api/parsers/${f.parserId}/uploads`, { filename: 'synthetic.odt', size: valid.length, sha256: sha(valid) });
  assert.equal(reserved.statusCode, 201, reserved.body); const reservation = reserved.json();
  assert.equal(reservation.method, 'PUT'); objects.set(`${f.account.workspaceId}/${reservation.uploadId}`, Buffer.from(valid));
  const finalized = await request(f.account, 'POST', `/api/uploads/${reservation.uploadId}/finalize`, {}); assert.equal(finalized.statusCode, 202, finalized.body);
  const accepted = finalized.json(); assert.equal(accepted.document.mimeType, odtMime); assert.equal(accepted.document.pageCount, 1);
  assert.notEqual(accepted.document.id, reservation.uploadId); assert.deepEqual(objects.get(`${f.account.workspaceId}/${accepted.document.id}`), valid);
  objects.set(`${f.account.workspaceId}/${reservation.uploadId}`, Buffer.from('Changed synthetic staging bytes after successful finalization'));
  const replay = await request(f.account, 'POST', `/api/uploads/${reservation.uploadId}/finalize`, {}); assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().document.id, accepted.document.id); assert.equal(replay.json().jobId, accepted.jobId); assert.equal(replay.json().replayed, true);
  assert.deepEqual((await request(f.account, 'GET', `/api/documents/${accepted.document.id}/original`)).rawPayload, valid);
  const idempotencyKey = randomUUID(), duplicate = await upload(f, valid, { key: idempotencyKey }); assert.equal(duplicate.statusCode, 202, duplicate.body);
  assert.equal(duplicate.json().document.id, accepted.document.id); assert.equal(duplicate.json().duplicate, true); assert.equal(duplicate.json().jobId, null);
  const changed = await makeOdt({ reference: '000043' });
  assert.equal((await upload(f, changed, { key: idempotencyKey })).statusCode, 409);
  assert.deepEqual(await counts(f), { documents: 1, jobs: 1, runs: 0, charges: 1, pages: 1 });
  assert.equal((await request(f.account, 'DELETE', `/api/documents/${accepted.document.id}`)).statusCode, 200);
  assert.equal((await request(f.account, 'POST', `/api/uploads/${reservation.uploadId}/finalize`, {})).statusCode, 410);
  for (const bytes of [valid, changed]) assert.equal((await upload(f, bytes, { key: idempotencyKey })).statusCode, 410);
  assert.deepEqual(await counts(f), { documents: 0, jobs: 0, runs: 0, charges: 1, pages: 1 });
  assert.equal(objects.has(`${f.account.workspaceId}/${accepted.document.id}`), false);
});

test('selective ZIP imports treat ODT as one leaf, refuse internal package expansion and reject an invalid selected leaf atomically', async () => {
  const f = await fixture('rules', ['odt', 'txt']);
  const internal = await archive(f, valid, randomUUID()); assert.equal(internal.statusCode, 400, internal.body); assert.match(internal.json().message, /document package/i);
  const zip = new JSZip(); zip.file('selected/synthetic.odt', valid); zip.file('broken/synthetic.odt', malformed); zip.file('unselected.txt', 'Do not import this synthetic text');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), previewId = randomUUID();
  const preview = await archive(f, bytes, previewId); assert.equal(preview.statusCode, 200, preview.body);
  const good = preview.json().entries.find((entry: any) => entry.path === 'selected/synthetic.odt'), bad = preview.json().entries.find((entry: any) => entry.path === 'broken/synthetic.odt');
  assert.ok(good); assert.equal(good.status, 'ready'); assert.equal(good.format, 'odt'); assert.equal(good.pageCount, 1); assert.equal(good.sha256, sha(valid));
  assert.ok(bad); assert.equal(bad.status, 'unsupported');
  assert.equal(preview.json().entries.filter((entry: any) => entry.path.includes('content.xml') || entry.path.includes('META-INF')).length, 0);
  assert.deepEqual(await counts(f), { documents: 0, jobs: 0, runs: 0, charges: 0, pages: 0 });
  const invalidSpec = { mode: 'zip', version: 1, sourceSha256: sha(bytes), entries: [good.index, bad.index].sort((a, b) => a - b) };
  const rejected = await archive(f, bytes, previewId, invalidSpec); assert.equal(rejected.statusCode, 400, rejected.body);
  assert.deepEqual(await counts(f), { documents: 0, jobs: 0, runs: 0, charges: 0, pages: 0 });
  assert.equal([...objects.keys()].filter(key => key.startsWith(`${f.account.workspaceId}/`)).length, 0);
  const selectedId = randomUUID(), spec = { ...invalidSpec, entries: [good.index] };
  const accepted = await archive(f, bytes, selectedId, spec); assert.equal(accepted.statusCode, 202, accepted.body);
  const result = accepted.json(); assert.equal(result.archive.childCount, 1); assert.equal(result.archive.totalPages, 1); assert.equal(result.documents.length, 1);
  const child = result.documents[0]; assert.equal(child.path, 'selected/synthetic.odt'); assert.equal(child.index, good.index);
  assert.deepEqual(objects.get(`${f.account.workspaceId}/${child.id}`), valid); assert.deepEqual(objects.get(`${f.account.workspaceId}/${result.archive.id}`), bytes);
  assert.equal(await processOneCoreJob(child.jobId), true); const completed = await detail(f, child.id);
  assert.equal(completed.document.status, 'needs_review', completed.document.error); assert.equal(completed.document.mimeType, odtMime); assert.deepEqual(completed.runs[0].normalizedValues, normalizedValues);
  const replay = await archive(f, bytes, selectedId, spec); assert.equal(replay.statusCode, 202, replay.body); assert.equal(replay.json().replayed, true); assert.equal(replay.json().documents[0].id, child.id);
  assert.deepEqual((await request(f.account, 'GET', `/api/documents/${child.id}/archive-original`)).rawPayload, bytes);
  assert.deepEqual(await counts(f), { documents: 1, jobs: 1, runs: 1, charges: 1, pages: 1 });
});

test('malformed ODT XML commits a sanitized durable rejection without partial documents, jobs, usage or originals', async () => {
  const f = await fixture(), idempotencyKey = randomUUID();
  const rejected = await upload(f, malformed, { key: idempotencyKey, filename: 'PRIVATE-synthetic.odt' });
  assert.equal(rejected.statusCode, 400, rejected.body); assert.match(rejected.json().message, /valid OpenDocument Text package/i); assert.ok(!rejected.body.includes('PRIVATE'));
  const before = await counts(f); assert.deepEqual(before, { documents: 0, jobs: 0, runs: 0, charges: 0, pages: 0 });
  const records = async () => (await adminPool.query('select document_id,rejected_parser_id,rejection_code,rejection_reason,rejection_sha256 from intake_events where workspace_id=$1 and idempotency_key=$2', [f.account.workspaceId, `${idempotencyKey}:0`])).rows;
  const receipt = await records(); assert.deepEqual(receipt, [{ document_id: null, rejected_parser_id: f.parserId, rejection_code: 'source_validation_failed', rejection_reason: 'odt_invalid', rejection_sha256: sha(malformed) }]);
  const replay = await upload(f, malformed, { key: idempotencyKey, filename: 'renamed.txt', mimeType: 'text/plain' }); assert.equal(replay.statusCode, 400, replay.body); assert.deepEqual(replay.json(), rejected.json());
  assert.deepEqual(await records(), receipt); assert.deepEqual(await counts(f), before);
  assert.equal((await upload(f, valid, { key: idempotencyKey })).statusCode, 409);
  assert.equal([...objects.keys()].filter(key => key.startsWith(`${f.account.workspaceId}/`)).length, 0);
  const audits = (await adminPool.query("select metadata from audit_events where workspace_id=$1 and action='document.rejected'", [f.account.workspaceId])).rows;
  assert.equal(audits.length, 1); assert.ok(!JSON.stringify(audits).includes('PRIVATE'));
  const repaired = await upload(f, valid); assert.equal(repaired.statusCode, 202, repaired.body);
  assert.deepEqual(await counts(f), { documents: 1, jobs: 1, runs: 0, charges: 1, pages: 1 });
});
