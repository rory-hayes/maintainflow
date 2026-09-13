import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Actor, ParserSchema } from '../shared/types.js';
import { buildApp } from '../server/app.js';
import { adminPool, appPool, databaseSchema, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';
import { processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import { setSchemaSuggestionProvider } from '../server/core/schema-suggestions.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
type Fixture = { account: Account; parserId: string; schemaId: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const accounts: Account[] = [], objects = new Map<string, Buffer>();
const simple: ParserSchema = { fields: [{ key: 'reference', label: 'Reference', type: 'string', required: true }] };
const operationalTables = ['documents', 'jobs', 'extraction_runs', 'corrections', 'approvals', 'document_events', 'usage_ledger', 'intake_events', 'intake_files', 'schema_suggestions', 'export_snapshots', 'integrations', 'email_routes', 'oauth_states', 'sheet_cursors', 'sheet_writes', 'webhook_deliveries', 'api_keys'];
const allTables = ['parsers', 'schema_versions', 'templates', 'export_mappings', 'audit_events', ...operationalTables];
const io = { read: 0, write: 0, remove: 0, provider: 0, fetch: 0 };
const originalFetch = globalThis.fetch;
let app: FastifyInstance, localVerified = false;
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { io.write++; objects.set(key, Buffer.from(bytes)); },
  async read(key) { io.read++; const bytes = objects.get(key); if (!bytes) throw new Error('Missing owned parser-copy source'); return Buffer.from(bytes); },
  async remove(key) { io.remove++; objects.delete(key); },
};
const actor = (a: Account): Actor => ({ userId: a.user.id, workspaceId: a.workspace.id, role: 'owner', authType: 'session' });
async function request(a: Account, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, payload: payload as any, headers: { origin: config.origin, cookie: a.cookie, ...headers } });
}
async function account(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: `Owned copy ${label}`, workspaceName: `Owned copy ${label}`, email: `parser-copy-${randomUUID()}@example.test`, password: 'Owned parser-copy fixture password',
  } });
  assert.equal(response.statusCode, 201, response.body);
  const a = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } as Account;
  accounts.push(a);
  await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','25'),'{monthlyPages}','1000') where id=$1", [a.workspace.id]);
  return a;
}
async function create(a: Account, extras: Record<string, unknown> = {}): Promise<Fixture> {
  const response = await request(a, 'POST', '/api/parsers', { name: 'Owned source parser', useCase: 'custom', mode: 'ai', schema: simple, ...extras });
  assert.equal(response.statusCode, 201, response.body);
  return { account: a, parserId: response.json().parser.id, schemaId: response.json().schema.id };
}
async function copy(item: Fixture, payload: unknown = {}, a = item.account, headers: Record<string, string> = {}) {
  return request(a, 'POST', `/api/parsers/${item.parserId}/copy`, payload, headers);
}
function asFixture(a: Account, result: any): Fixture { return { account: a, parserId: result.parser.id, schemaId: result.schema.id }; }
async function parser(item: Fixture) {
  const response = await request(item.account, 'GET', `/api/parsers/${item.parserId}`); assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function sourceRow(item: Fixture) { return (await adminPool.query('select * from parsers where id=$1', [item.parserId])).rows[0]; }
async function addTemplate(item: Fixture, name = 'Owned reference template', rules = [{ field: 'reference', anchor: 'Reference' }], enabled = true, matchText = '') {
  const response = await request(item.account, 'POST', `/api/parsers/${item.parserId}/templates`, { name, rules, enabled, matchText });
  assert.equal(response.statusCode, 200, response.body); return response.json().template;
}
async function mapping(item: Fixture, name = 'Owned mapping', columns = [{ source: 'reference', label: 'Reference' }], lineItems?: string) {
  const response = await request(item.account, 'POST', '/api/export-mappings', { parserId: item.parserId, name, columns, ...(lineItems === undefined ? {} : { lineItems }) });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function upload(item: Fixture, text = 'Reference: OWNED-341') {
  const result = await addDocument(actor(item.account), item.parserId, Buffer.from(text), `owned-copy-${randomUUID()}.txt`);
  assert.ok(result.jobId); return { ...result, jobId: result.jobId! };
}
async function document(item: Fixture, id: string) {
  const response = await request(item.account, 'GET', `/api/documents/${id}`); assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function fingerprint(a: Account, tables = allTables) {
  const result: Record<string, { count: number; sha256: string }> = {};
  for (const table of tables) {
    const rows = (await adminPool.query(`select to_jsonb(t) value from ${table} t where workspace_id=$1 order by to_jsonb(t)::text`, [a.workspace.id])).rows;
    result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  return result;
}
async function scopes(a: Account, values: string[]) {
  const response = await request(a, 'POST', '/api/workspace/api-keys', { name: 'Owned copy scopes', scopes: values }); assert.equal(response.statusCode, 200, response.body);
  return { cookie: '', authorization: `Bearer ${response.json().token}` };
}
async function seedConnections(item: Fixture) {
  const workspaceId = item.account.workspace.id, integrationId = randomUUID(), globalId = randomUUID();
  await adminPool.query("insert into integrations(id,workspace_id,parser_id,name,kind,config,secret_ciphertext,enabled) values($1,$2,$3,'Owned parser connection','google_sheets',$4,'controlled-opaque-placeholder',false),($5,$2,null,'Owned workspace connection','webhook',$6,'controlled-global-placeholder',false)", [integrationId, workspaceId, item.parserId, JSON.stringify({ spreadsheetId: 'controlled-copy-sheet' }), globalId, JSON.stringify({ url: 'https://owned.example.test/copy' })]);
  await adminPool.query('insert into oauth_states(state_hash,workspace_id,user_id,integration_id,verifier_ciphertext,expires_at) values($1,$2,$3,$4,$5,now()+interval \'1 hour\')', [randomUUID(), workspaceId, item.account.user.id, integrationId, 'controlled-verifier-placeholder']);
  await adminPool.query('insert into sheet_cursors(integration_id,workspace_id,next_row) values($1,$2,7)', [integrationId, workspaceId]);
  await adminPool.query("insert into sheet_writes(integration_id,workspace_id,event_key,spreadsheet_id,header_range,data_range,headers,cells,status,delivered_at) values($1,$2,'owned-copy-event','controlled-copy-sheet','Owned!A1','Owned!A6',$3,$4,'delivered',now())", [integrationId, workspaceId, JSON.stringify(['Reference']), JSON.stringify(['OWNED-HISTORY'])]);
  await adminPool.query("insert into webhook_deliveries(id,workspace_id,integration_id,event_key,payload,status) values($1,$2,$3,'owned-copy-delivery',$4,'delivered')", [randomUUID(), workspaceId, globalId, JSON.stringify({ fixture: 'owned-copy-history' })]);
  await adminPool.query('insert into email_routes(workspace_id,parser_id,address,provider_domain_id,parse_body,parse_attachments,allowed_senders,enabled,created_by,domain_verified_at) values($1,$2,$3,$4,false,true,$5,false,$6,now())', [workspaceId, item.parserId, `owned-${randomUUID()}@example.test`, 'controlled-copy-domain', JSON.stringify(['owned-sender@example.test']), item.account.user.id]);
}

before(async () => {
  assert.equal(databaseSchema, 'public', 'Parser copy fixtures require the disposable public application schema');
  const pools = [[adminPool, 'folio_admin'], [appPool, 'folio_app']] as const;
  const urlMode = Boolean(adminPool.options.connectionString || appPool.options.connectionString);
  if (urlMode) {
    assert.equal(process.env.NODE_ENV, 'test', 'URL databases are permitted only for controlled CI tests');
    assert.ok(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true', 'URL databases require the disposable CI environment');
    assert.ok(process.env.DATABASE_ADMIN_URL && process.env.DATABASE_URL, 'CI must supply both database URLs');
    for (const [pool, role] of pools) {
      assert.equal(typeof pool.options.connectionString, 'string', 'CI must use explicit URLs for both database roles');
      const url = new URL(pool.options.connectionString!);
      assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Parser copy CI databases must be loopback only');
      assert.equal(url.port || '5432', '5432'); assert.equal(url.pathname, '/folio'); assert.equal(decodeURIComponent(url.username), role);
      assert.equal(url.search, '', 'CI database URLs cannot override host, role or connection settings'); assert.equal(url.hash, '');
    }
  } else {
    for (const [pool, role] of pools) {
      const options = pool.options;
      assert.equal(typeof options.host, 'string');
      assert.equal(path.resolve(options.host!), path.resolve(config.root, '.local/socket'), 'Parser copy fixtures require this checkout\'s isolated local Unix socket');
      assert.equal(options.port, 55432); assert.equal(options.database, 'folio'); assert.equal(options.user, role);
    }
  }
  // Check both actual sessions before any fixture mutations; never echo URL credentials.
  for (const [pool, role] of pools) {
    const { rows: [connected] } = await pool.query("select current_database() name,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address");
    assert.equal(connected.name, 'folio'); assert.equal(connected.schema, 'public'); assert.equal(connected.role, role); assert.equal(connected.port, urlMode ? 5432 : 55432);
    if (urlMode) assert.ok(['127.0.0.1', '::1'].includes(connected.address)); else assert.equal(connected.address, null);
  }
  localVerified = true; setStorageForTests(storage);
  globalThis.fetch = async () => { io.fetch++; throw new Error('External requests are forbidden in parser-copy fixtures'); };
  app = await buildApp();
});
beforeEach(() => {
  setExtractionProvider({ configured: () => false, extract: async () => { io.provider++; throw new Error('Parser copy must not invoke extraction'); } });
  setSchemaSuggestionProvider({ configured: () => false, suggest: async () => { io.provider++; throw new Error('Parser copy must not invoke field discovery'); } });
});
afterEach(() => { assert.equal(io.provider, 0); assert.equal(io.fetch, 0); setExtractionProvider(undefined); setSchemaSuggestionProvider(undefined); });
after(async () => {
  setExtractionProvider(undefined); setSchemaSuggestionProvider(undefined); setStorageForTests(undefined); globalThis.fetch = originalFetch;
  try {
    await app?.close(); if (!localVerified) return;
    for (const a of accounts) await adminPool.query('delete from workspaces where id=$1', [a.workspace.id]);
    for (const a of accounts) await adminPool.query('delete from users where id=$1', [a.user.id]);
    objects.clear();
  } finally { await closeDatabase(); }
});

test('copy preserves the complete active configuration and source-only mappings with fresh identities and no operational clones', async () => {
  const a = await account('complete'), item = await create(a, { name: 'Owned configured source', useCase: 'invoice', instructions: 'Keep the saved source instructions', locale: 'de-DE', timezone: 'Europe/Berlin', allowedFormats: ['txt', 'pdf'] });
  const schema: ParserSchema = { fields: [
    { key: 'reference', label: 'Reference', type: 'string', required: true, anchor: 'Document reference', transform: 'uppercase', instructions: 'Preserve identifier characters.' },
    { key: 'state', label: 'State', type: 'string', default: 'Ready', enum: ['Ready', 'Hold'] },
    { key: 'details', label: 'Details', type: 'object', fields: [{ key: 'tax_id', label: 'Tax ID', type: 'string', default: 'Unknown', transform: 'trim', instructions: 'Use the tax registration.' }] },
    { key: 'line_items', label: 'Items', type: 'array', fields: [{ key: 'description', label: 'Description', type: 'string', required: true }, { key: 'quantity', label: 'Quantity', type: 'number', required: true }] },
  ] };
  const saved = await request(a, 'POST', `/api/parsers/${item.parserId}/schema`, schema); assert.equal(saved.statusCode, 200, saved.body);
  // Persisted legacy extensions must survive without impersonating authoritative response metadata.
  const storedSchema = { ...schema, id: 'owned-stored-schema-extension', version: 901, ownedExtension: { preserve: true } };
  await adminPool.query('update schema_versions set schema=$2 where id=$1', [saved.json().schema.id, JSON.stringify(storedSchema)]);
  const enabled = await addTemplate(item, 'Source enabled', [{ field: 'reference', anchor: 'Document reference' }], true, 'Document reference');
  const disabled = await addTemplate(item, 'Source disabled legacy', [{ field: 'removed_field', anchor: 'Removed source' }], false);
  const savedMapping = await mapping(item, 'Exact nested rows', [{ source: 'details.tax_id', label: 'VAT' }, { source: '$item.description', label: 'Line' }, { source: '$revision', label: 'Revision' }, { source: 'stale.source', label: 'Preserved stale column' }], 'line_items');
  await mapping(item, 'Default columns', []);
  const other = await create(a), otherMapping = await mapping(other, 'Other parser mapping');
  const source = await upload(item, 'Document reference: owned-341'); assert.equal(await processOneCoreJob(source.jobId), true);
  const run = (await document(item, source.document.id)).runs[0];
  assert.equal((await request(a, 'POST', `/api/runs/${run.id}/approve`, {})).statusCode, 200);
  assert.equal((await request(a, 'POST', '/api/exports', { documentIds: [source.document.id], format: 'json' })).statusCode, 200);
  const suggestionId = randomUUID();
  await adminPool.query("insert into schema_suggestions(id,workspace_id,parser_id,document_id,base_schema_id,requested_by,request_id,document_sha256,config,state,attempts,error) select $1,$2,$3,id,$4,$5,$6,sha256,'{}','failed',1,'Owned historic setup failure' from documents where id=$7", [suggestionId, a.workspace.id, item.parserId, saved.json().schema.id, a.user.id, randomUUID(), source.document.id]);
  await adminPool.query("update parsers set field_setup_suggestion_id=$2,field_setup_error='Owned historic setup failure' where id=$1", [item.parserId, suggestionId]);
  await seedConnections(item);
  const beforeOps = await fingerprint(a, operationalTables), beforeSource = await sourceRow(item), beforeIo = { ...io }, originals = [...objects.keys()].sort();
  const response = await copy(item, { name: '  Independent destination  ' }); assert.equal(response.statusCode, 201, response.body);
  const result = response.json(), destination = asFixture(a, result), row = await sourceRow(destination);
  assert.notEqual(row.id, item.parserId); assert.equal(row.workspace_id, a.workspace.id); assert.equal(row.name, 'Independent destination'); assert.equal(row.archived, false);
  for (const field of ['use_case', 'mode', 'instructions', 'locale', 'timezone', 'allowed_formats']) assert.deepEqual(row[field], beforeSource[field], field);
  assert.equal(row.field_setup_state, 'ready'); assert.equal(row.field_setup_suggestion_id, null); assert.equal(row.field_setup_error, null);
  assert.notEqual(result.schema.id, saved.json().schema.id); assert.equal(result.schema.version, 1); assert.deepEqual(result.schema.fields, schema.fields);
  const versions = (await adminPool.query('select * from schema_versions where parser_id=$1', [row.id])).rows;
  assert.equal(versions.length, 1); assert.equal(versions[0].created_by, a.user.id); assert.deepEqual(versions[0].schema, storedSchema); assert.equal(row.active_schema_id, versions[0].id);
  assert.equal(result.templates.length, 2);
  for (const original of [enabled, disabled]) {
    const cloned = result.templates.find((entry: any) => entry.name === original.name); assert.ok(cloned); assert.notEqual(cloned.id, original.id);
    for (const field of ['name', 'matchText', 'rules', 'enabled']) assert.deepEqual(cloned[field], original[field]);
    assert.equal(cloned.parserId, row.id); assert.equal(cloned.workspaceId, a.workspace.id);
  }
  assert.equal(result.mappings.length, 2);
  const clonedMapping = result.mappings.find((entry: any) => entry.name === savedMapping.name); assert.ok(clonedMapping); assert.notEqual(clonedMapping.id, savedMapping.id);
  assert.equal(clonedMapping.parserId, row.id); assert.deepEqual(clonedMapping.columns, savedMapping.columns); assert.equal(clonedMapping.lineItems, savedMapping.lineItems);
  assert.ok(result.mappings.some((entry: any) => entry.name === 'Default columns' && entry.columns.length === 0 && entry.lineItems === null));
  assert.equal(result.mappings.some((entry: any) => entry.id === otherMapping.id || entry.name === otherMapping.name), false);
  assert.deepEqual(await fingerprint(a, operationalTables), beforeOps); assert.deepEqual(io, beforeIo); assert.deepEqual([...objects.keys()].sort(), originals); assert.deepEqual(await sourceRow(item), beforeSource);
  const audits = (await adminPool.query('select * from audit_events where entity_id=$1', [row.id])).rows;
  assert.equal(audits.length, 1); assert.equal(audits[0].action, 'parser.copied'); assert.equal(audits[0].user_id, a.user.id);
  assert.deepEqual(audits[0].metadata, { sourceParserId: item.parserId, sourceSchemaId: saved.json().schema.id, templateCount: 2, mappingCount: 2 });
  const reloaded = await parser(destination); assert.equal(reloaded.schemas.length, 1); assert.deepEqual(reloaded.schema.fields, schema.fields); assert.equal(reloaded.templates.length, 2);
  assert.equal(reloaded.schema.id, result.schema.id); assert.equal(reloaded.schema.version, 1); assert.equal(reloaded.schemas[0].id, result.schema.id); assert.equal(reloaded.schemas[0].version, 1);
  assert.deepEqual(reloaded.schema.ownedExtension, storedSchema.ownedExtension); assert.deepEqual(result.schema.ownedExtension, storedSchema.ownedExtension);
  const listing = await request(a, 'GET', '/api/parsers'); assert.equal(listing.json().parsers.find((entry: any) => entry.id === row.id).documentCount, 0);
  assert.equal((await request(a, 'PATCH', `/api/parsers/${item.parserId}`, { instructions: 'Source edit only' })).statusCode, 200);
  assert.equal((await request(a, 'POST', `/api/parsers/${item.parserId}/schema`, simple)).statusCode, 200);
  assert.equal((await request(a, 'DELETE', `/api/templates/${enabled.id}`)).statusCode, 200);
  assert.equal((await request(a, 'DELETE', `/api/export-mappings/${savedMapping.id}`)).statusCode, 200);
  assert.deepEqual((await parser(destination)).schema.fields, schema.fields); assert.equal((await sourceRow(destination)).instructions, beforeSource.instructions);
  assert.equal((await adminPool.query('select id from export_mappings where id=$1', [clonedMapping.id])).rowCount, 1);
  assert.equal((await request(a, 'PATCH', `/api/parsers/${row.id}`, { locale: 'en-US', allowedFormats: ['pdf'] })).statusCode, 200);
  assert.equal((await sourceRow(item)).locale, 'de-DE'); assert.deepEqual((await sourceRow(item)).allowed_formats, beforeSource.allowed_formats);
});

test('fresh template IDs preserve selector priority including equal millisecond timestamps with different database microseconds', async () => {
  const item = await create(await account('priority')); const first = await addTemplate(item, 'Temporary A'), second = await addTemplate(item, 'Temporary B');
  const [winnerId, otherId] = [first.id, second.id].sort();
  await adminPool.query("update templates set name=case id when $1 then 'ID priority wins' else 'Earlier database microsecond' end,created_at=case id when $1 then '2026-01-01 00:00:00.000900+00'::timestamptz else '2026-01-01 00:00:00.000100+00'::timestamptz end where parser_id=$2", [winnerId, item.parserId]);
  assert.equal((await adminPool.query('select id from templates where parser_id=$1 order by created_at,id', [item.parserId])).rows[0].id, otherId);
  const source = await upload(item), beforeIo = { ...io }, response = await copy(item); assert.equal(response.statusCode, 201, response.body); assert.deepEqual(io, beforeIo);
  const destination = asFixture(item.account, response.json()), target = await upload(destination);
  for (const [fixture, uploaded] of [[item, source], [destination, target]] as const) {
    const checked = await request(item.account, 'POST', `/api/parsers/${fixture.parserId}/templates/check`, { documentId: uploaded.document.id }); assert.equal(checked.statusCode, 200, checked.body);
    assert.equal(checked.json().selection.template.name, 'ID priority wins'); assert.equal(checked.json().selection.template.tieCount, 2);
  }
  const cloned = response.json().templates; assert.equal(cloned.every((entry: any) => ![first.id, second.id].includes(entry.id)), true);
  assert.equal(cloned.map((entry: any) => entry.id).sort()[0], cloned.find((entry: any) => entry.name === 'ID priority wins').id);
  assert.equal(new Set(cloned.map((entry: any) => entry.createdAt)).size, 1);
});

test('copy names are trimmed and bounded, default names fit, and archived ready sources yield active copies', async () => {
  const a = await account('names'), item = await create(a, { name: 'X'.repeat(100) });
  await request(a, 'PATCH', `/api/parsers/${item.parserId}`, { archived: true });
  const original = await sourceRow(item), defaulted = await copy(item); assert.equal(defaulted.statusCode, 201, defaulted.body);
  assert.equal(defaulted.json().parser.name, 'X'.repeat(93) + ' (copy)'); assert.equal(defaulted.json().parser.archived, false); assert.equal(defaulted.json().parser.allowedFormats, null);
  const maximum = await copy(item, { name: 'Y'.repeat(100) }); assert.equal(maximum.statusCode, 201, maximum.body); assert.equal(maximum.json().parser.name.length, 100);
  const trimmed = await copy(item, { name: '  A  ' }); assert.equal(trimmed.statusCode, 201, trimmed.body); assert.equal(trimmed.json().parser.name, 'A');
  const before = await fingerprint(a);
  for (const payload of [{ name: '' }, { name: '   ' }, { name: 'Z'.repeat(101) }, { name: null }, { name: 12 }, { name: 'Allowed', mode: 'rules' }]) assert.equal((await copy(item, payload)).statusCode, 400);
  assert.deepEqual(await fingerprint(a), before); assert.deepEqual(await sourceRow(item), original);
  const unicode = await create(a, { name: '😀'.repeat(50) }), unicodeCopy = await copy(unicode); assert.equal(unicodeCopy.statusCode, 201, unicodeCopy.body);
  const unicodeName = unicodeCopy.json().parser.name; assert.equal(unicodeName, '😀'.repeat(46) + ' (copy)'); assert.ok(unicodeName.length <= 100);
  assert.equal(Buffer.from(unicodeName).toString('utf8'), unicodeName); assert.equal((await sourceRow(unicode)).name, '😀'.repeat(50));
});

test('unfinished setup and missing active schemas fail without manufacturing a ready copy', async () => {
  const item = await create(await account('setup'));
  for (const state of ['awaiting_sample', 'suggesting', 'failed']) {
    await adminPool.query('update parsers set field_setup_state=$2 where id=$1', [item.parserId, state]); const before = await fingerprint(item.account);
    const response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /setup|fields/i); assert.deepEqual(await fingerprint(item.account), before);
  }
  await adminPool.query("update parsers set field_setup_state='ready',active_schema_id=null where id=$1", [item.parserId]); const before = await fingerprint(item.account);
  const response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.deepEqual(await fingerprint(item.account), before);
});

test('copy, create and restore share the one remaining active slot and leave no partial copies at capacity', async () => {
  const a = await account('capacity'), active = await create(a), source = await create(a), restoring = await create(a);
  for (const item of [source, restoring]) assert.equal((await request(a, 'PATCH', `/api/parsers/${item.parserId}`, { archived: true })).statusCode, 200);
  await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','2') where id=$1", [a.workspace.id]);
  const responses = await Promise.all([copy(source), request(a, 'POST', '/api/parsers', { name: 'Concurrent create', useCase: 'custom' }), request(a, 'PATCH', `/api/parsers/${restoring.parserId}`, { archived: false })]);
  assert.equal(responses.filter(response => [200, 201].includes(response.statusCode)).length, 1); assert.equal(responses.filter(response => response.statusCode === 429).length, 2);
  const counts = (await adminPool.query('select count(*)::int total,count(*) filter(where not archived)::int active from parsers where workspace_id=$1', [a.workspace.id])).rows[0];
  assert.equal(counts.active, 2); assert.equal((await adminPool.query('select id from schema_versions where workspace_id=$1', [a.workspace.id])).rowCount, counts.total);
  assert.equal((await sourceRow(source)).archived, true); assert.equal((await sourceRow(active)).archived, false);
  const before = await fingerprint(a); assert.equal((await copy(source)).statusCode, 429); assert.deepEqual(await fingerprint(a), before);
});

test('copy enforces tenant, editor roles, all three read/write scopes and normal browser origin without needing document scope', async () => {
  const a = await account('authorization'), outsider = await account('outsider'), member = await account('member'), item = await create(a);
  const grants = await Promise.all([
    ['parsers:read', 'parsers:write'], ['parsers:read', 'results:read'], ['parsers:write', 'results:read'], ['parsers:read', 'parsers:write', 'results:read'],
  ].map(values => scopes(a, values)));
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [a.workspace.id, member.user.id]);
  const selected = { 'x-workspace-id': a.workspace.id }, before = await fingerprint(a);
  const foreign = await copy(item, {}, outsider), missing = await copy({ ...item, parserId: randomUUID() }, {}, outsider);
  assert.equal(foreign.statusCode, 404); assert.equal(missing.statusCode, 404); assert.deepEqual(foreign.json(), missing.json());
  assert.equal((await copy(item, {}, member, selected)).statusCode, 403);
  assert.equal((await copy(item, {}, a, { origin: 'https://unrelated.example' })).statusCode, 403);
  assert.equal((await copy(item, {}, a, { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  for (const grant of grants.slice(0, 3)) assert.equal((await copy(item, {}, a, grant)).statusCode, 403);
  // API key last-used timestamps are authentication metadata, not copied parser state.
  const afterDenied = await fingerprint(a); delete before.api_keys; delete afterDenied.api_keys; assert.deepEqual(afterDenied, before);
  for (const role of ['editor', 'admin']) {
    await adminPool.query('update memberships set role=$3 where workspace_id=$1 and user_id=$2', [a.workspace.id, member.user.id, role]);
    const response = await copy(item, { name: `Owned ${role} copy` }, member, selected); assert.equal(response.statusCode, 201, response.body);
    assert.equal((await adminPool.query('select created_by from schema_versions where id=$1', [response.json().schema.id])).rows[0].created_by, member.user.id);
  }
  assert.equal((await copy(item)).statusCode, 201); assert.equal((await copy(item, {}, a, grants[3])).statusCode, 201);
});

test('invalid enabled or structurally malformed legacy templates fail atomically while a disabled unsupported template remains copyable', async () => {
  const item = await create(await account('invalid-templates')); await addTemplate(item);
  const cases: Array<{ rules: unknown; enabled: boolean; name?: string }> = [
    { rules: [], enabled: true }, { rules: [{ field: 'removed', anchor: 'Removed' }], enabled: true },
    { rules: [{ field: 'reference', anchor: 'Reference' }, { field: 'reference', anchor: 'Reference' }], enabled: true },
    { rules: { invalid: true }, enabled: false }, { rules: [{ field: 'reference', anchor: '' }], enabled: false }, { rules: [], enabled: false, name: 'X'.repeat(101) },
  ];
  for (const entry of cases) {
    const { rows: [invalid] } = await adminPool.query('insert into templates(workspace_id,parser_id,name,rules,enabled) values($1,$2,$3,$4,$5) returning id', [item.account.workspace.id, item.parserId, entry.name ?? 'Owned invalid legacy', JSON.stringify(entry.rules), entry.enabled]);
    const before = await fingerprint(item.account), response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /template/i); assert.deepEqual(await fingerprint(item.account), before);
    await adminPool.query('delete from templates where id=$1', [invalid.id]);
  }
  const disabled = await addTemplate(item, 'Preserved disabled legacy', [{ field: 'removed', anchor: 'Removed' }], false);
  const response = await copy(item); assert.equal(response.statusCode, 201, response.body);
  const saved = response.json().templates.find((entry: any) => entry.name === disabled.name); assert.equal(saved.enabled, false); assert.deepEqual(saved.rules, disabled.rules);
});

test('mapping validation preserves stale and metadata paths but rejects malformed settings without a partial copy', async () => {
  const item = await create(await account('invalid-mappings'));
  const invalid = [
    { name: '', columns: [] }, { name: 'X'.repeat(101), columns: [] }, { columns: {} },
    { columns: [{ source: '', label: 'Empty source' }] }, { columns: [{ source: 'reference', label: '' }] },
    { columns: Array.from({ length: 101 }, () => ({ source: 'reference', label: 'Ref' })) }, { columns: [], lineItems: 'x'.repeat(101) },
  ];
  for (const entry of invalid) {
    const id = randomUUID(); await adminPool.query('insert into export_mappings(id,workspace_id,parser_id,name,columns,line_items) values($1,$2,$3,$4,$5,$6)', [id, item.account.workspace.id, item.parserId, 'name' in entry ? entry.name : 'Owned invalid mapping', JSON.stringify(entry.columns), 'lineItems' in entry ? entry.lineItems : null]);
    const before = await fingerprint(item.account), response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /mapping/i); assert.deepEqual(await fingerprint(item.account), before);
    await adminPool.query('delete from export_mappings where id=$1', [id]);
  }
  const valid = await mapping(item, 'Preserve structural configuration', [{ source: '$item.old.path', label: 'Old line' }, { source: 'no_longer_in_schema', label: 'Historic' }, { source: '$filename', label: 'File' }], 'old_table');
  const response = await copy(item); assert.equal(response.statusCode, 201, response.body); assert.deepEqual(response.json().mappings[0].columns, valid.columns); assert.equal(response.json().mappings[0].lineItems, 'old_table');
});

test('template, mapping and aggregate configuration limits reject whole copies without truncation', async () => {
  const item = await create(await account('size-limits'));
  await adminPool.query("insert into templates(workspace_id,parser_id,name,rules,enabled) select $1,$2,'Owned template '||n,$3,true from generate_series(1,101) n", [item.account.workspace.id, item.parserId, JSON.stringify([{ field: 'reference', anchor: 'Reference' }])]);
  let before = await fingerprint(item.account), response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /100 templates/i); assert.deepEqual(await fingerprint(item.account), before);
  await adminPool.query('delete from templates where parser_id=$1', [item.parserId]);
  await adminPool.query("insert into export_mappings(id,workspace_id,parser_id,name,columns) select gen_random_uuid(),$1,$2,'Owned mapping '||n,'[]'::jsonb from generate_series(1,101) n", [item.account.workspace.id, item.parserId]);
  before = await fingerprint(item.account); response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /100 export mappings/i); assert.deepEqual(await fingerprint(item.account), before);
  await adminPool.query('delete from export_mappings where parser_id=$1', [item.parserId]);
  const columns = Array.from({ length: 100 }, () => ({ source: 's'.repeat(120), label: 'L'.repeat(120) }));
  assert.ok(Buffer.byteLength(JSON.stringify(columns)) * 100 > 2 * 1024 * 1024);
  await adminPool.query("insert into export_mappings(id,workspace_id,parser_id,name,columns) select gen_random_uuid(),$1,$2,'Owned large mapping '||n,$3 from generate_series(1,100) n", [item.account.workspace.id, item.parserId, JSON.stringify(columns)]);
  before = await fingerprint(item.account); response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /2 MiB/i); assert.deepEqual(await fingerprint(item.account), before);
  // Settings count toward the same UTF-8 byte budget, even when schema JSON alone fits.
  await adminPool.query('delete from export_mappings where parser_id=$1', [item.parserId]);
  const extended = { ...simple, ownedPadding: 'x'.repeat(2 * 1024 * 1024 - 16_000) }, instructions = '€'.repeat(8_000);
  assert.ok(Buffer.byteLength(JSON.stringify(extended)) < 2 * 1024 * 1024);
  assert.ok(JSON.stringify(extended).length + instructions.length < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(extended)) + Buffer.byteLength(instructions) > 2 * 1024 * 1024);
  await adminPool.query('update schema_versions set schema=$2 where id=$1', [item.schemaId, JSON.stringify(extended)]);
  assert.equal((await request(item.account, 'PATCH', `/api/parsers/${item.parserId}`, { instructions })).statusCode, 200);
  before = await fingerprint(item.account); response = await copy(item); assert.equal(response.statusCode, 409, response.body); assert.match(response.json().message, /2 MiB/i); assert.deepEqual(await fingerprint(item.account), before);
});

test('a failure in the copy audit rolls back destination parser, schema, templates and mappings together', async () => {
  const item = await create(await account('audit-rollback')); await addTemplate(item); await mapping(item);
  const trigger = `owned_copy_audit_${randomUUID().replaceAll('-', '')}`, before = await fingerprint(item.account), beforeIo = { ...io };
  try {
    await adminPool.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${item.account.workspace.id}'::uuid and NEW.action='parser.copied' then raise exception 'Owned copy audit failure'; end if; return NEW; end $$`);
    await adminPool.query(`create trigger ${trigger} before insert on audit_events for each row execute function ${trigger}()`);
    const response = await copy(item); assert.equal(response.statusCode, 500, response.body); assert.deepEqual(await fingerprint(item.account), before); assert.deepEqual(io, beforeIo);
  } finally {
    await adminPool.query(`drop trigger if exists ${trigger} on audit_events`); await adminPool.query(`drop function if exists ${trigger}()`);
  }
  const response = await copy(item); assert.equal(response.statusCode, 201, response.body); assert.equal(response.json().templates.length, 1); assert.equal(response.json().mappings.length, 1);
});

test('an owned upload to the copied parser extracts with its own template, requires approval and exports exact mapped CSV bytes', async () => {
  const schema: ParserSchema = { fields: [...simple.fields, { key: 'total', label: 'Total', type: 'currency', required: true },
    { key: 'line_items', label: 'Items', type: 'array', fields: [{ key: 'description', label: 'Description', type: 'string', required: true }, { key: 'quantity', label: 'Quantity', type: 'number', required: true }] },
  ] };
  const item = await create(await account('usable'), { schema });
  const originalTemplate = await addTemplate(item, 'Invoice table', [{ field: 'reference', anchor: 'Reference' }, { field: 'total', anchor: 'Total' }, { field: 'line_items', anchor: 'Items' }]);
  await mapping(item, 'Invoice lines', [{ source: 'reference', label: 'Document' }, { source: '$item.description', label: 'Item' }, { source: '$item.quantity', label: 'Units' }, { source: 'total', label: 'Total' }], 'line_items');
  const response = await copy(item); assert.equal(response.statusCode, 201, response.body);
  const result = response.json(), destination = asFixture(item.account, result), savedMapping = result.mappings[0];
  const source = await upload(destination, 'Reference: OWNED-341\nTotal: 24.50\nItems:\nDescription|Quantity\nWidget|2\nGadget|3');
  const job = (await adminPool.query('select * from jobs where id=$1', [source.jobId])).rows[0]; assert.equal(job.config.templatePolicy, 'complete-v1'); assert.equal(job.schema_version_id, destination.schemaId);
  assert.equal(await processOneCoreJob(source.jobId), true);
  const data = await document(destination, source.document.id), run = data.runs[0];
  assert.equal(data.document.parserId, destination.parserId); assert.equal(data.document.status, 'needs_review'); assert.equal(run.selection.template.id, result.templates[0].id); assert.notEqual(run.selection.template.id, originalTemplate.id);
  assert.equal(run.engine, 'text-template'); assert.equal(Number(run.costUsd), 0); assert.deepEqual(run.issues, []);
  const exportInput = { documentIds: [source.document.id], format: 'csv', columns: savedMapping.columns, lineItems: savedMapping.lineItems };
  assert.equal((await request(item.account, 'POST', '/api/exports', exportInput)).statusCode, 400);
  const approved = await request(item.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: run.effectiveRevision }); assert.equal(approved.statusCode, 200, approved.body);
  const exported = await request(item.account, 'POST', '/api/exports', exportInput); assert.equal(exported.statusCode, 200, exported.body);
  const downloaded = await request(item.account, 'GET', exported.json().downloadUrl); assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.deepEqual(downloaded.rawPayload, Buffer.from('\uFEFF"Document","Item","Units","Total"\r\n"OWNED-341","Widget","2","24.5"\r\n"OWNED-341","Gadget","3","24.5"\r\n'));
  const credits = (await adminPool.query('select event,pages from usage_ledger where workspace_id=$1', [item.account.workspace.id])).rows; assert.deepEqual(credits, [{ event: 'upload', pages: 1 }]);
  assert.equal((await adminPool.query('select id from documents where parser_id=$1', [item.parserId])).rowCount, 0);
  assert.equal((await adminPool.query('select id from jobs where document_id=$1', [source.document.id])).rowCount, 1); assert.equal((await document(destination, source.document.id)).document.status, 'exported');
  assert.equal(io.provider, 0); assert.equal(io.fetch, 0);
});
