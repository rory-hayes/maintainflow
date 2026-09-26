/** Source-format API contracts. Run only in an isolated copied checkout or disposable CI. */
import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import ExcelJS from 'exceljs';
import type { FastifyInstance } from 'fastify';
import type { ParserSchema } from '../shared/types.js';
import { buildApp } from '../server/app.js';
import { adminPool, appPool, closeDatabase, databaseSchema } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import { setSchemaSuggestionProvider } from '../server/core/schema-suggestions.js';
import { createOpenAIProvider, openAIExtraction } from '../server/core/openai-provider.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';

type Account = { userId: string; workspaceId: string; cookie: string };
type Fixture = { account: Account; parserId: string; schemaId: string };
type Method = 'GET' | 'POST' | 'PATCH';
const accounts: Account[] = [], objects = new Map<string, Buffer>();
const originalFetch = globalThis.fetch;
let app: FastifyInstance, localVerified = false, networkCalls = 0;
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const value = objects.get(key); assert.ok(value, 'Owned source bytes must exist'); return Buffer.from(value); },
  async remove(key) { objects.delete(key); },
};
const simple: ParserSchema = { fields: [{ key: 'amount', label: 'Amount', type: 'currency', required: true }] };
const mixed: ParserSchema = { fields: [
  { key: 'reference', label: 'Reference', type: 'string', required: true },
  { key: 'local_date', label: 'Local date', type: 'date', required: true },
  { key: 'us_date', label: 'US date', type: 'date', sourceLocale: 'en-US', required: true },
  { key: 'german_amount', label: 'German amount', type: 'currency', sourceLocale: 'de-DE', required: true },
  { key: 'french_date', label: 'French date', type: 'date', sourceLocale: 'fr-FR', required: true },
  { key: 'occurred_at', label: 'Occurred at', type: 'timestamp', sourceLocale: 'en-US', timezone: 'America/New_York', required: true },
  { key: 'fallback', label: 'Fallback', type: 'number', sourceLocale: 'de-DE', default: 1234.56 },
  { key: 'state', label: 'State', type: 'string', transform: 'uppercase' },
  { key: 'details', label: 'Details', type: 'object', fields: [
    { key: 'units', label: 'Units', type: 'number', sourceLocale: 'es-ES', required: true },
    { key: 'rows', label: 'Rows', type: 'array', required: true, fields: [
      { key: 'date', label: 'Row date', type: 'date', sourceLocale: 'en-US', required: true },
      { key: 'amount', label: 'Row amount', type: 'currency', sourceLocale: 'de-DE', required: true },
      { key: 'code', label: 'Row code', type: 'string', required: true },
    ] },
  ] },
] };
const mixedText = [
  'Reference: 000127', 'Local date: 04/05/2026', 'US date: 04/05/2026',
  'German amount: 1.234,56', 'French date: 17 septembre 2026', 'Occurred at: 04/05/2026 14:30',
  'State: pending', 'Units: 1.234', 'Rows:', 'Row date|Row amount|Row code',
  '06/07/2026|1.234,50|000010', '08/09/2026|2.000,75|000011',
].join('\n');
const mixedRaw = {
  reference: '000127', local_date: '04/05/2026', us_date: '04/05/2026', german_amount: '1.234,56',
  french_date: '17 septembre 2026', occurred_at: '04/05/2026 14:30', fallback: null, state: 'pending',
  details: { units: '1.234', rows: [{ date: '06/07/2026', amount: '1.234,50', code: '000010' }, { date: '08/09/2026', amount: '2.000,75', code: '000011' }] },
};
const mixedExpected = {
  reference: '000127', local_date: '2026-05-04', us_date: '2026-04-05', german_amount: 1234.56,
  french_date: '2026-09-17', occurred_at: '2026-04-05T18:30:00Z', fallback: 1234.56, state: 'PENDING',
  details: { units: 1234, rows: [{ date: '2026-06-07', amount: 1234.5, code: '000010' }, { date: '2026-08-09', amount: 2000.75, code: '000011' }] },
};

before(async () => {
  assert.equal(databaseSchema, 'public');
  const pools = [[adminPool, 'folio_admin'], [appPool, 'folio_app']] as const;
  const urlMode = Boolean(adminPool.options.connectionString || appPool.options.connectionString);
  if (urlMode) {
    assert.equal(process.env.NODE_ENV, 'test');
    assert.ok(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true');
    for (const [pool, role] of pools) {
      assert.equal(typeof pool.options.connectionString, 'string');
      const url = new URL(pool.options.connectionString!);
      assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
      assert.equal(url.pathname, '/folio'); assert.equal(url.port || '5432', '5432');
      assert.equal(decodeURIComponent(url.username), role); assert.equal(url.search, ''); assert.equal(url.hash, '');
    }
  } else {
    assert.ok(config.root.startsWith('/private/tmp/') || config.root.startsWith('/tmp/'), 'Requires a private copied checkout, never the shared development database');
    for (const [pool, role] of pools) {
      assert.equal(path.resolve(pool.options.host!), path.resolve(config.root, '.local/socket'));
      assert.equal(pool.options.port, 55432); assert.equal(pool.options.database, 'folio'); assert.equal(pool.options.user, role);
    }
  }
  for (const [pool, role] of pools) {
    const identity = (await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
    assert.equal(identity.db, 'folio'); assert.equal(identity.schema, 'public'); assert.equal(identity.role, role);
    assert.equal(identity.port, urlMode ? 5432 : 55432); if (!urlMode) assert.equal(identity.address, null);
  }
  localVerified = true; setStorageForTests(storage);
  globalThis.fetch = async () => { networkCalls++; throw new Error('External transport is forbidden in source-format fixtures'); };
  app = await buildApp(); await app.ready();
});
afterEach(() => { setExtractionProvider(undefined); setSchemaSuggestionProvider(undefined); assert.equal(networkCalls, 0); });
after(async () => {
  setExtractionProvider(undefined); setSchemaSuggestionProvider(undefined); setStorageForTests(undefined); globalThis.fetch = originalFetch;
  try {
    await app?.close();
    if (localVerified) {
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
    name: 'Owned source-format fixture', workspaceName: 'Owned source-format workspace', email: `source-format-${randomUUID()}@example.test`, password: 'Owned source-format fixture password',
  } });
  assert.equal(response.statusCode, 201, response.body);
  const data = response.json(), value = { userId: data.user.id, workspaceId: data.workspace.id, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  accounts.push(value); return value;
}
async function fixture(schema = simple, mode: 'rules' | 'ai' = 'rules'): Promise<Fixture> {
  const owner = await account();
  const response = await request(owner, 'POST', '/api/parsers', { name: 'Owned regional parser', mode, useCase: 'custom', locale: 'en-IE', timezone: 'Europe/Dublin', schema });
  assert.equal(response.statusCode, 201, response.body);
  return { account: owner, parserId: response.json().parser.id, schemaId: response.json().schema.id };
}
async function upload(f: Fixture, text: string) {
  const boundary = `owned-source-format-${randomUUID()}`, bytes = Buffer.from(text), payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned-source-format.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const response = await request(f.account, 'POST', `/api/parsers/${f.parserId}/documents`, payload, { 'content-type': `multipart/form-data; boundary=${boundary}`, 'idempotency-key': randomUUID() });
  assert.equal(response.statusCode, 202, response.body); assert.ok(response.json().jobId); assert.equal(response.json().duplicate, false);
  return { ...response.json(), bytes };
}
async function detail(f: Fixture, id: string) {
  const response = await request(f.account, 'GET', `/api/documents/${id}`); assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function parser(f: Fixture) {
  const response = await request(f.account, 'GET', `/api/parsers/${f.parserId}`); assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function footprint(f: Fixture) {
  return (await adminPool.query('select (select count(*)::int from schema_versions where parser_id=$1) schemas,(select count(*)::int from parsers where workspace_id=$2) parsers,(select count(*)::int from audit_events where workspace_id=$2) audits', [f.parserId, f.account.workspaceId])).rows[0];
}
async function key(owner: Account, scopes: string[]) {
  const response = await request(owner, 'POST', '/api/workspace/api-keys', { name: 'Owned source-format scope', scopes });
  assert.equal(response.statusCode, 200, response.body); return { cookie: '', authorization: `Bearer ${response.json().token}` };
}

test('source-format schema edits round-trip and copy without weakening validation or stale-version protection', async () => {
  const f = await fixture();
  const saved = await request(f.account, 'POST', `/api/parsers/${f.parserId}/schema`, { ...mixed, baseSchemaId: f.schemaId });
  assert.equal(saved.statusCode, 200, saved.body); assert.notEqual(saved.json().schema.id, f.schemaId);
  assert.deepEqual((await parser(f)).schema.fields, mixed.fields);
  const before = await footprint(f);
  const stale = await request(f.account, 'POST', `/api/parsers/${f.parserId}/schema`, { ...simple, baseSchemaId: f.schemaId });
  assert.equal(stale.statusCode, 409, stale.body);
  for (const field of [
    { key: 'bad', label: 'Bad', type: 'date', sourceLocale: 'ja-JP' },
    { key: 'bad', label: 'Bad', type: 'number', sourceLocale: 'en-US-u-nu-arab' },
    { key: 'bad', label: 'Bad', type: 'currency', sourceLocale: null },
    ...['string', 'boolean', 'multiline'].map(type => ({ key: 'bad', label: 'Bad', type, sourceLocale: 'en-US' })),
    ...['array', 'object'].map(type => ({ key: 'bad', label: 'Bad', type, sourceLocale: 'en-US', fields: simple.fields })),
  ]) {
    const invalid = await request(f.account, 'POST', `/api/parsers/${f.parserId}/schema`, { fields: [field], baseSchemaId: saved.json().schema.id });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.deepEqual(await footprint(f), before); assert.deepEqual((await parser(f)).schema.fields, mixed.fields);
  const archived = await request(f.account, 'PATCH', `/api/parsers/${f.parserId}`, { archived: true });
  assert.equal(archived.statusCode, 200, archived.body);
  const copied = await request(f.account, 'POST', `/api/parsers/${f.parserId}/copy`, { name: 'Owned mixed-format copy' });
  assert.equal(copied.statusCode, 201, copied.body); assert.deepEqual(copied.json().schema.fields, mixed.fields);
  assert.equal(copied.json().parser.archived, false);
  assert.notEqual(copied.json().schema.id, saved.json().schema.id); assert.notEqual(copied.json().parser.id, f.parserId);
  assert.equal((await adminPool.query('select id from documents where parser_id=$1', [copied.json().parser.id])).rowCount, 0);
});

test('source-format edits and copies retain tenant, viewer, API-scope and origin boundaries without partial writes', async () => {
  const f = await fixture(), viewer = await account(), foreign = await account();
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [f.account.workspaceId, viewer.userId]);
  const readKey = await key(f.account, ['parsers:read']), writeKey = await key(f.account, ['parsers:write']);
  const foreignKey = await key(foreign, ['parsers:read', 'parsers:write', 'results:read']);
  const before = await footprint(f), url = `/api/parsers/${f.parserId}/schema`, body = { ...mixed, baseSchemaId: f.schemaId };
  assert.equal((await request(viewer, 'POST', url, body, { 'x-workspace-id': f.account.workspaceId })).statusCode, 403);
  assert.equal((await request(f.account, 'POST', url, body, readKey)).statusCode, 403);
  assert.equal((await request(f.account, 'POST', url, body, { origin: 'https://unrelated.example.test' })).statusCode, 403);
  assert.equal((await request(foreign, 'POST', url, body)).statusCode, 404);
  assert.equal((await request(foreign, 'POST', url, body, { ...foreignKey, 'x-workspace-id': f.account.workspaceId })).statusCode, 404);
  assert.equal((await request(viewer, 'POST', `/api/parsers/${f.parserId}/copy`, {}, { 'x-workspace-id': f.account.workspaceId })).statusCode, 403);
  assert.equal((await request(f.account, 'POST', `/api/parsers/${f.parserId}/copy`, {}, writeKey)).statusCode, 403);
  assert.deepEqual(await footprint(f), before);
  const saved = await request(f.account, 'POST', url, body, writeKey); assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual((await parser(f)).schema.fields, mixed.fields);
});

test('queued mixed fields, nested rows, canonical corrections and exact historical exports retain the old schema and locale', async () => {
  const f = await fixture(mixed), source = await upload(f, mixedText);
  const job = (await adminPool.query('select config,schema_version_id from jobs where id=$1', [source.jobId])).rows[0];
  assert.equal(job.config.normalizationPolicy, 'regional-v2'); assert.equal(job.config.locale, 'en-IE'); assert.equal(job.schema_version_id, f.schemaId);
  const changed = structuredClone(mixed);
  changed.fields.find(field => field.key === 'us_date')!.sourceLocale = 'en-GB';
  Object.assign(changed.fields.find(field => field.key === 'occurred_at')!, { sourceLocale: 'en-GB', timezone: 'Europe/Berlin' });
  const schemaB = await request(f.account, 'POST', `/api/parsers/${f.parserId}/schema`, { ...changed, baseSchemaId: f.schemaId }); assert.equal(schemaB.statusCode, 200, schemaB.body);
  assert.equal((await request(f.account, 'PATCH', `/api/parsers/${f.parserId}`, { locale: 'en-US', timezone: 'Asia/Tokyo' })).statusCode, 200);
  assert.equal(await processOneCoreJob(source.jobId), true);
  const completed = await detail(f, source.document.id), run = completed.runs[0];
  assert.equal(completed.document.status, 'needs_review'); assert.deepEqual(run.rawValues, mixedRaw); assert.deepEqual(run.normalizedValues, mixedExpected); assert.deepEqual(run.issues, []);
  assert.equal(run.schemaVersionId, f.schemaId); assert.deepEqual(run.schema.fields, mixed.fields);
  assert.deepEqual(run.normalizationContext, { version: 'regional-v2', locale: 'en-IE', timezone: 'Europe/Dublin', tzdbVersion: process.versions.tz ?? null });
  assert.equal(run.documentSha256, createHash('sha256').update(source.bytes).digest('hex'));
  assert.deepEqual(run.evidence.german_amount, [{ page: 1, text: 'German amount: 1.234,56' }]);
  assert.deepEqual(run.evidence['details.rows'], [{ page: 1, text: '06/07/2026|1.234,50|000010' }, { page: 1, text: '08/09/2026|2.000,75|000011' }]);
  const originalEvidence = structuredClone(run.evidence);
  await adminPool.query('delete from jobs where id=$1', [source.jobId]);
  assert.equal((await detail(f, source.document.id)).runs[0].jobId, null);
  const correctedValues = structuredClone(mixedExpected);
  correctedValues.german_amount = 2000.75; correctedValues.local_date = '2026-09-18';
  correctedValues.occurred_at = '2026-04-06T18:30:00Z';
  correctedValues.details.rows[1].amount = 2500.5; correctedValues.details.rows[1].date = '2026-09-19';
  const corrected = await request(f.account, 'POST', `/api/runs/${run.id}/corrections`, { values: { ...correctedValues, occurred_at: '04/06/2026 14:30' }, expectedRevision: run.effectiveRevision });
  assert.equal(corrected.statusCode, 200, corrected.body); assert.deepEqual(corrected.json().issues, []);
  assert.deepEqual(corrected.json().run.effectiveValues, correctedValues); assert.deepEqual(corrected.json().run.normalizedValues, mixedExpected);
  assert.deepEqual(corrected.json().run.rawValues, mixedRaw); assert.deepEqual(corrected.json().run.evidence, originalEvidence);
  const approved = await request(f.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: corrected.json().run.effectiveRevision });
  assert.equal(approved.statusCode, 200, approved.body); const approvalId = approved.json().approval.id;
  const reprocessed = await request(f.account, 'POST', `/api/documents/${source.document.id}/reprocess`); assert.equal(reprocessed.statusCode, 200, reprocessed.body);
  const newJob = (await adminPool.query('select config,schema_version_id from jobs where id=$1', [reprocessed.json().job.id])).rows[0];
  assert.equal(newJob.schema_version_id, schemaB.json().schema.id); assert.equal(newJob.config.locale, 'en-US'); assert.equal(newJob.config.normalizationPolicy, 'regional-v2');
  assert.equal(await processOneCoreJob(reprocessed.json().job.id), true);
  const newest = (await detail(f, source.document.id)).runs[0]; assert.notEqual(newest.id, run.id);
  assert.equal(newest.normalizedValues.local_date, '2026-04-05'); assert.equal(newest.normalizedValues.us_date, '2026-05-04');
  assert.equal(newest.normalizedValues.occurred_at, '2026-05-04T12:30:00Z'); assert.equal(newest.normalizationContext.timezone, 'Asia/Tokyo');
  const columns = [
    ['reference', 'Reference'], ['local_date', 'Local date'], ['us_date', 'US date'], ['german_amount', 'Amount'],
    ['occurred_at', 'Occurred'], ['details.units', 'Units'], ['$item.date', 'Row date'], ['$item.amount', 'Row amount'], ['$item.code', 'Code'],
  ].map(([source, label]) => ({ source, label }));
  const rows = [
    ['000127', '2026-09-18', '2026-04-05', 2000.75, '2026-04-06T18:30:00Z', 1234, '2026-06-07', 1234.5, '000010'],
    ['000127', '2026-09-18', '2026-04-05', 2000.75, '2026-04-06T18:30:00Z', 1234, '2026-09-19', 2500.5, '000011'],
  ];
  for (const format of ['json', 'csv', 'xlsx']) {
    const exported = await request(f.account, 'POST', '/api/exports', { documentIds: [source.document.id], revisions: [{ documentId: source.document.id, approvalId }], format, columns, lineItems: 'details.rows' });
    assert.equal(exported.statusCode, 200, exported.body);
    assert.deepEqual(exported.json().revisions, [{ documentId: source.document.id, approvalId, runId: run.id }]);
    const bytes = await request(f.account, 'GET', exported.json().downloadUrl); assert.equal(bytes.statusCode, 200, bytes.body);
    if (format === 'json') {
      const record = bytes.json().documents[0]; assert.equal(record.runId, run.id); assert.equal(record.approvalId, approvalId); assert.deepEqual(record.values, correctedValues);
    } else if (format === 'csv') {
      const expected = '\uFEFF"Reference","Local date","US date","Amount","Occurred","Units","Row date","Row amount","Code"\r\n'
        + '"000127","2026-09-18","2026-04-05","2000.75","2026-04-06T18:30:00Z","1234","2026-06-07","1234.5","000010"\r\n'
        + '"000127","2026-09-18","2026-04-05","2000.75","2026-04-06T18:30:00Z","1234","2026-09-19","2500.5","000011"\r\n';
      assert.deepEqual(bytes.rawPayload, Buffer.from(expected));
    } else {
      const book = new ExcelJS.Workbook(); await book.xlsx.load(bytes.rawPayload as any); const sheet = book.worksheets[0];
      assert.equal(sheet.rowCount, 3); assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), columns.map(column => column.label));
      rows.forEach((row, index) => assert.deepEqual((sheet.getRow(index + 2).values as unknown[]).slice(1), row));
    }
  }
  const original = (await request(f.account, 'GET', `/api/runs/${run.id}`)).json().run;
  assert.deepEqual(original.rawValues, mixedRaw); assert.deepEqual(original.normalizedValues, mixedExpected); assert.deepEqual(original.evidence, originalEvidence);
  assert.deepEqual(original.approvals.find((approval: any) => approval.id === approvalId).values, correctedValues);
});

test('the configured AI adapter uses pinned field formats on literal nested output without an external request', async () => {
  let controlledCalls = 0;
  const evidence: { field: string; page: number; text: string }[] = [];
  const visit = (value: unknown, field = '') => {
    if (value === null) return;
    if (Array.isArray(value)) value.forEach((row, index) => visit(row, `${field}[${index}]`));
    else if (typeof value === 'object') Object.entries(value as Record<string, unknown>).forEach(([key, child]) => visit(child, field ? `${field}.${key}` : key));
    else evidence.push({ field, page: 1, text: String(value) });
  };
  visit(mixedRaw);
  setExtractionProvider(createOpenAIProvider({ apiKey: 'SYNTHETIC_SOURCE_FORMAT_ONLY', fetch: (async () => {
    controlledCalls++;
    return new Response(JSON.stringify({ status: 'completed', model: openAIExtraction.model, usage: { input_tokens: 1000, output_tokens: 100 }, output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({ rawValues: mixedRaw, evidence }) }] }] }), { status: 200 });
  }) as typeof fetch }));
  const f = await fixture(mixed, 'ai'), source = await upload(f, mixedText);
  assert.equal((await request(f.account, 'PATCH', `/api/parsers/${f.parserId}`, { locale: 'de-DE', timezone: 'UTC' })).statusCode, 200);
  assert.equal(await processOneCoreJob(source.jobId), true); const completed = await detail(f, source.document.id);
  assert.equal(completed.document.status, 'needs_review', completed.document.error ?? JSON.stringify(completed.jobs));
  const run = completed.runs[0]; assert.ok(run, 'Completed AI extraction must expose its current run');
  assert.equal(controlledCalls, 1); assert.equal(networkCalls, 0); assert.equal(run.engine, 'openai');
  assert.deepEqual(run.rawValues, mixedRaw); assert.deepEqual(run.normalizedValues, mixedExpected); assert.deepEqual(run.issues, []);
  assert.equal(run.normalizationContext.version, 'regional-v2'); assert.equal(run.normalizationContext.locale, 'en-IE');
  assert.deepEqual(run.evidence['details.rows[1].amount'], [{ page: 1, text: '2.000,75', source: 'matched-text' }]);
});

test('new default and overridden malformed grouping stay reviewable until canonical corrections explicitly resolve them', async () => {
  const schema: ParserSchema = { fields: [...simple.fields, { key: 'foreign', label: 'Foreign amount', type: 'currency', sourceLocale: 'de-DE', required: true }] };
  const f = await fixture(schema), source = await upload(f, 'Amount: 1.234,56\nForeign amount: 12.34,56');
  assert.equal(await processOneCoreJob(source.jobId), true); const run = (await detail(f, source.document.id)).runs[0];
  assert.deepEqual(run.rawValues, { amount: '1.234,56', foreign: '12.34,56' }); assert.deepEqual(run.normalizedValues, run.rawValues);
  assert.deepEqual(run.issues.map((issue: any) => [issue.field, issue.code]), [['amount', 'number'], ['foreign', 'number']]);
  assert.deepEqual(run.validationIssues.map((issue: any) => [issue.field, issue.code]), [['amount', 'number'], ['foreign', 'number']]);
  const before = (await adminPool.query('select count(*)::int count from approvals where run_id=$1', [run.id])).rows[0].count;
  const rejected = await request(f.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: run.effectiveRevision }); assert.equal(rejected.statusCode, 422, rejected.body);
  assert.equal((await adminPool.query('select count(*)::int count from approvals where run_id=$1', [run.id])).rows[0].count, before);
  assert.equal((await request(f.account, 'POST', '/api/exports', { documentIds: [source.document.id], format: 'json' })).statusCode, 400);
  const correction = await request(f.account, 'POST', `/api/runs/${run.id}/corrections`, { expectedRevision: run.effectiveRevision, values: { amount: 1234.56, foreign: 1234.56 } });
  assert.equal(correction.statusCode, 200, correction.body); assert.deepEqual(correction.json().issues, []); assert.deepEqual(correction.json().run.effectiveValues, { amount: 1234.56, foreign: 1234.56 });
  assert.deepEqual(correction.json().run.rawValues, run.rawValues); assert.deepEqual(correction.json().run.normalizedValues, run.normalizedValues);
  assert.deepEqual(correction.json().run.validationIssues, []); assert.deepEqual(correction.json().run.issues, run.issues);
  const reloaded = (await request(f.account, 'GET', `/api/runs/${run.id}`)).json().run;
  assert.deepEqual(reloaded.validationIssues, []); assert.deepEqual(reloaded.issues, run.issues);
  const approval = await request(f.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: correction.json().run.effectiveRevision }); assert.equal(approval.statusCode, 200, approval.body);
});

test('legacy queued policies retain historical numeric behavior and v1 context while future policies fail before extraction', async () => {
  const f = await fixture();
  for (const policy of ['timestamp-v1', 'missing', 'null']) {
    const source = await upload(f, `Amount: 12,34\nOwned legacy case: ${policy}`);
    if (policy === 'missing') await adminPool.query("update jobs set config=config-'normalizationPolicy' where id=$1", [source.jobId]);
    else await adminPool.query("update jobs set config=jsonb_set(config,'{normalizationPolicy}',$2::jsonb) where id=$1", [source.jobId, JSON.stringify(policy === 'null' ? null : policy)]);
    assert.equal(await processOneCoreJob(source.jobId), true); const run = (await detail(f, source.document.id)).runs[0];
    assert.deepEqual(run.rawValues, { amount: '12,34' }); assert.deepEqual(run.normalizedValues, { amount: 1234 });
    assert.equal(run.normalizationContext.version, 'timestamp-v1'); assert.deepEqual(run.issues, []);
  }
  const current = await upload(f, 'Amount: 12,34\nOwned regional case'); await processOneCoreJob(current.jobId);
  const currentRun = (await detail(f, current.document.id)).runs[0]; assert.equal(currentRun.normalizationContext.version, 'regional-v2');
  assert.deepEqual(currentRun.normalizedValues, { amount: '12,34' }); assert.equal(currentRun.issues[0].code, 'number');
  const future = await upload(f, 'Amount: 1234.56\nOwned future policy');
  await adminPool.query("update jobs set config=jsonb_set(config,'{normalizationPolicy}','\"regional-future\"') where id=$1", [future.jobId]);
  assert.equal(await processOneCoreJob(future.jobId), true); const rejected = await detail(f, future.document.id);
  assert.equal(rejected.document.status, 'failed'); assert.deepEqual(rejected.runs, []); assert.match(rejected.document.error, /unsupported normalization version/);
});

test('first-schema finalization preserves each held job policy instead of silently upgrading old pending work', async () => {
  let providerCalls = 0;
  setExtractionProvider({ configured: () => true, async extract() { providerCalls++; throw new Error('Held setup must use rules after manual finalization'); } });
  setSchemaSuggestionProvider({ configured: () => true, async suggest() { providerCalls++; throw new Error('Manual schema selection must not invoke discovery'); } });
  const owner = await account();
  const creation = await request(owner, 'POST', '/api/parsers', { name: 'Owned held formats', setupMode: 'sample', useCase: 'custom', mode: 'ai', locale: 'en-IE', timezone: 'Europe/Dublin' });
  assert.equal(creation.statusCode, 201, creation.body);
  const f = { account: owner, parserId: creation.json().parser.id, schemaId: creation.json().schema.id };
  const held: { jobId: string; documentId: string; expected: string }[] = [];
  for (const policy of ['timestamp-v1', 'missing', 'null', 'regional-v2']) {
    const source = await upload(f, `Amount: 12,34\nOwned waiting case: ${policy}`);
    if (policy === 'missing') await adminPool.query("update jobs set config=config-'normalizationPolicy' where id=$1", [source.jobId]);
    else await adminPool.query("update jobs set config=jsonb_set(config,'{normalizationPolicy}',$2::jsonb) where id=$1", [source.jobId, JSON.stringify(policy === 'null' ? null : policy)]);
    assert.equal((await adminPool.query('select waiting_for_schema from jobs where id=$1', [source.jobId])).rows[0].waiting_for_schema, true);
    assert.equal(await processOneCoreJob(source.jobId), false);
    held.push({ jobId: source.jobId, documentId: source.document.id, expected: policy === 'regional-v2' ? 'regional-v2' : 'timestamp-v1' });
  }
  const usageBefore = (await adminPool.query('select event,pages from usage_ledger where workspace_id=$1 order by id', [owner.workspaceId])).rows;
  assert.equal((await request(owner, 'PATCH', `/api/parsers/${f.parserId}`, { mode: 'rules' })).statusCode, 200);
  const saved = await request(owner, 'POST', `/api/parsers/${f.parserId}/schema`, { ...simple, baseSchemaId: f.schemaId }); assert.equal(saved.statusCode, 200, saved.body);
  for (const item of held) {
    const job = (await adminPool.query('select config,schema_version_id,waiting_for_schema,attempts from jobs where id=$1', [item.jobId])).rows[0];
    assert.equal(job.waiting_for_schema, false); assert.equal(job.attempts, 0); assert.equal(job.schema_version_id, saved.json().schema.id); assert.equal(job.config.normalizationPolicy, item.expected);
    assert.equal(await processOneCoreJob(item.jobId), true); const run = (await detail(f, item.documentId)).runs[0];
    assert.equal(run.normalizationContext.version, item.expected); assert.equal(run.normalizedValues.amount, item.expected === 'regional-v2' ? '12,34' : 1234);
  }
  assert.deepEqual((await adminPool.query('select event,pages from usage_ledger where workspace_id=$1 order by id', [owner.workspaceId])).rows, usageBefore);
  assert.equal(providerCalls, 0);
});

test('a legacy held job refuses new nested field formats before its provider while a new held job applies them', async () => {
  let controlledCalls = 0, suggestionCalls = 0;
  setExtractionProvider(createOpenAIProvider({ apiKey: 'SYNTHETIC_HELD_SOURCE_FORMAT_ONLY', fetch: (async () => {
    controlledCalls++;
    return new Response(JSON.stringify({ status: 'completed', model: openAIExtraction.model, usage: { input_tokens: 1000, output_tokens: 100 }, output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify({
      rawValues: { details: { amount: '1.234,56' } }, evidence: [{ field: 'details.amount', page: 1, text: 'Amount: 1.234,56' }],
    }) }] }] }), { status: 200 });
  }) as typeof fetch }));
  setSchemaSuggestionProvider({ configured: () => true, async suggest() { suggestionCalls++; throw new Error('The user selected the initial fields manually'); } });
  const owner = await account();
  const creation = await request(owner, 'POST', '/api/parsers', { name: 'Owned mixed-policy first schema', setupMode: 'sample', useCase: 'custom', mode: 'ai', locale: 'en-IE', timezone: 'Europe/Dublin' });
  assert.equal(creation.statusCode, 201, creation.body);
  const f = { account: owner, parserId: creation.json().parser.id, schemaId: creation.json().schema.id };
  const old = await upload(f, 'Amount: 1.234,56\nOwned old pending source');
  await adminPool.query("update jobs set config=config-'normalizationPolicy' where id=$1", [old.jobId]);
  const current = await upload(f, 'Amount: 1.234,56\nOwned current pending source');
  const initial: ParserSchema = { fields: [{ key: 'details', label: 'Details', type: 'object', fields: [{ key: 'amount', label: 'Amount', type: 'currency', sourceLocale: 'de-DE', required: true }] }] };
  const saved = await request(owner, 'POST', `/api/parsers/${f.parserId}/schema`, { ...initial, baseSchemaId: f.schemaId }); assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(await processOneCoreJob(old.jobId), true);
  const failed = await detail(f, old.document.id); assert.equal(failed.document.status, 'failed'); assert.deepEqual(failed.runs, []);
  assert.match(failed.document.error, /predates field source formats/i);
  assert.match(failed.document.error, /reprocess with current saved settings/i); assert.equal(controlledCalls, 0);
  assert.equal(await processOneCoreJob(current.jobId), true);
  const completed = await detail(f, current.document.id);
  assert.equal(completed.document.status, 'needs_review', completed.document.error ?? JSON.stringify(completed.jobs));
  assert.ok(completed.runs[0], 'The new held job must expose its completed run');
  assert.deepEqual(completed.runs[0].rawValues, { details: { amount: '1.234,56' } });
  assert.deepEqual(completed.runs[0].normalizedValues, { details: { amount: 1234.56 } });
  assert.equal(completed.runs[0].normalizationContext.version, 'regional-v2'); assert.deepEqual(completed.runs[0].issues, []);
  assert.equal(controlledCalls, 1); assert.equal(suggestionCalls, 0); assert.equal(networkCalls, 0);
});
