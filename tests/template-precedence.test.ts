import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Actor, ExtractionResult, ParserSchema, ProviderInput } from '../shared/types.js';
import type { TemplateRule } from '../shared/template-selection.js';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';
import { processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import { processOneSchemaSuggestion, setSchemaSuggestionProvider } from '../server/core/schema-suggestions.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
type Fixture = { account: Account; parserId: string; schemaId: string };
type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const accounts: Account[] = [], objects = new Map<string, Buffer>();
const simple: ParserSchema = { fields: [
  { key: 'reference', label: 'Reference', type: 'string', required: true },
  { key: 'total', label: 'Total', type: 'currency', required: true },
  { key: 'note', label: 'Note', type: 'string' },
] };
const sample = 'Reference: OWNED-341\nTotal: 24.50';
const fullRules: TemplateRule[] = [{ field: 'reference', anchor: 'Reference' }, { field: 'total', anchor: 'Total' }];
let app: FastifyInstance, localVerified = false;
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); if (!bytes) throw new Error('Missing owned template source'); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
};
const actor = (a: Account): Actor => ({ userId: a.user.id, workspaceId: a.workspace.id, role: 'owner', authType: 'session' });
const controlledResult = (_input: ProviderInput): ExtractionResult => ({
  rawValues: { reference: 'OWNED-341', total: '24.50', note: null },
  normalizedValues: { reference: 'OWNED-341', total: 24.5, note: null },
  evidence: { reference: [{ page: 1, text: 'Reference: OWNED-341' }] }, issues: [],
  engine: 'controlled-ai', model: 'controlled-template-fallback', promptVersion: 'controlled-template-v1',
  tokenUsage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 }, costUsd: 0.00123,
});
async function request(a: Account, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, payload: payload as any, headers: { origin: config.origin, cookie: a.cookie, ...headers } });
}
async function account(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: `Owned template ${label}`, workspaceName: `Owned template ${label}`,
    email: `template-precedence-${randomUUID()}@example.test`, password: 'Owned template precedence password',
  } });
  assert.equal(response.statusCode, 201, response.body);
  const a = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } as Account;
  accounts.push(a);
  await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','20'),'{monthlyPages}','1000') where id=$1", [a.workspace.id]);
  return a;
}
async function create(a: Account, mode: 'ai' | 'rules' = 'ai', schema: ParserSchema = simple): Promise<Fixture> {
  const response = await request(a, 'POST', '/api/parsers', { name: 'Owned template parser', useCase: 'custom', mode, schema, locale: 'en-IE' });
  assert.equal(response.statusCode, 201, response.body);
  return { account: a, parserId: response.json().parser.id, schemaId: response.json().schema.id };
}
function templateBody(name: string, rules: TemplateRule[] = fullRules, matchText = '') { return { name, matchText, rules, enabled: true }; }
async function template(item: Fixture, name: string, rules = fullRules, matchText = '') {
  const response = await request(item.account, 'POST', `/api/parsers/${item.parserId}/templates`, templateBody(name, rules, matchText));
  assert.equal(response.statusCode, 200, response.body); return response.json().template;
}
async function upload(item: Fixture, text = sample) {
  const bytes = Buffer.from(text), accepted = await addDocument(actor(item.account), item.parserId, bytes, `owned-${randomUUID()}.txt`);
  assert.ok(accepted.jobId); return { ...accepted, jobId: accepted.jobId!, bytes };
}
async function job(id: string) { return (await adminPool.query('select * from jobs where id=$1', [id])).rows[0]; }
async function detail(item: Fixture, documentId: string) {
  const response = await request(item.account, 'GET', `/api/documents/${documentId}`);
  assert.equal(response.statusCode, 200, response.body); return response.json();
}
async function check(item: Fixture, documentId: string) {
  return request(item.account, 'POST', `/api/parsers/${item.parserId}/templates/check`, { documentId });
}
async function ledger(a: Account) { return (await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id', [a.workspace.id])).rows; }
async function footprint(a: Account) {
  const result: Record<string, unknown> = {};
  for (const table of ['documents', 'jobs', 'usage_ledger', 'schema_suggestions', 'extraction_runs', 'templates', 'schema_versions', 'audit_events', 'approvals']) {
    result[table] = (await adminPool.query(`select * from ${table} where workspace_id=$1 order by id`, [a.workspace.id])).rows;
  }
  result.objects = [...objects.keys()].filter(key => key.startsWith(`${a.workspace.id}/`)).sort();
  return result;
}
async function scoped(a: Account, scopes: string[]) {
  const response = await request(a, 'POST', '/api/workspace/api-keys', { name: 'Owned template scope', scopes });
  assert.equal(response.statusCode, 200, response.body);
  return { cookie: '', authorization: `Bearer ${response.json().token}` };
}

before(async () => {
  const options = adminPool.options, host = options.connectionString ? new URL(options.connectionString).hostname : options.host;
  assert.ok(typeof host === 'string' && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)), 'Template precedence fixtures require a local database');
  localVerified = true; setStorageForTests(storage); app = await buildApp();
});
afterEach(() => { setExtractionProvider(undefined); setSchemaSuggestionProvider(undefined); });
after(async () => {
  setExtractionProvider(undefined); setSchemaSuggestionProvider(undefined); setStorageForTests(undefined);
  try {
    await app?.close(); if (!localVerified) return;
    for (const a of accounts) await adminPool.query('delete from workspaces where id=$1', [a.workspace.id]);
    for (const a of accounts) await adminPool.query('delete from users where id=$1', [a.user.id]);
    objects.clear();
  } finally { await closeDatabase(); }
});

test('ranked nested and table anchors select a pinned template before a configured AI provider without adding charges', async () => {
  const schema: ParserSchema = { fields: [...simple.fields,
    { key: 'party', label: 'Party', type: 'object', fields: [{ key: 'tax', label: 'Tax ID', type: 'string' }] },
    { key: 'items', label: 'Items', type: 'array', fields: [{ key: 'description', label: 'Description', type: 'string' }, { key: 'quantity', label: 'Quantity', type: 'number' }] },
  ] };
  const item = await create(await account('ranked'), 'ai', schema);
  const rules = [...fullRules, { field: 'party.tax', anchor: 'Tax registration' }, { field: 'items.description', anchor: 'SKU' }, { field: 'items.quantity', anchor: 'Count' }];
  const narrow = await template(item, 'Long phrase but fewer fields', [fullRules[0]], 'Owned exact source phrase');
  const chosen = await template(item, 'Five anchored fields', rules);
  const tied = await template(item, 'Later five anchored fields', rules);
  await adminPool.query("update templates set created_at=case id when $1 then '2026-01-01'::timestamptz when $2 then '2026-01-02'::timestamptz else '2026-01-03'::timestamptz end where parser_id=$3", [narrow.id, chosen.id, item.parserId]);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return controlledResult(input); } });
  const source = await upload(item, `${sample}\nOwned exact source phrase\nTax registration: OWNED-TAX\nSKU|Count\nWidget|2\nGadget|3`);
  const acceptedLedger = await ledger(item.account), pinned = await job(source.jobId);
  assert.equal(pinned.config.templatePolicy, 'complete-v1'); assert.equal(pinned.config.templates.length, 3);
  assert.equal(await processOneCoreJob(source.jobId), true); assert.equal(calls, 0);
  const data = await detail(item, source.document.id), run = data.runs[0];
  assert.equal(data.document.status, 'needs_review'); assert.equal(data.document.approvedRunId, null);
  assert.equal(run.engine, 'text-template'); assert.equal(run.model, 'deterministic-v3'); assert.equal(run.promptVersion, 'folio-text-template-v1');
  assert.deepEqual(run.normalizedValues, { reference: 'OWNED-341', total: 24.5, note: null, party: { tax: 'OWNED-TAX' }, items: [{ description: 'Widget', quantity: 2 }, { description: 'Gadget', quantity: 3 }] });
  assert.deepEqual(run.issues, []); assert.equal(Number(run.costUsd), 0);
  assert.deepEqual(run.selection, { policy: 'complete-v1', outcome: 'template', reason: 'matched', consideredTemplates: 3, eligibleTemplates: 3,
    template: { id: chosen.id, name: chosen.name, fieldCount: 5, tieCount: 2 } });
  assert.notEqual(run.selection.template.id, tied.id); assert.deepEqual(await ledger(item.account), acceptedLedger);
  assert.equal((await adminPool.query('select id from approvals where workspace_id=$1', [item.account.workspace.id])).rowCount, 0);
  const usage = await request(item.account, 'GET', '/api/workspace/usage');
  assert.equal(usage.json().usage.pages, 1); assert.equal(usage.json().usage.extractionCostUsd, 0);
  assert.equal(await processOneCoreJob(source.jobId), false); assert.equal(calls, 0);
});

test('a complete template still works when the AI provider is unconfigured', async () => {
  const item = await create(await account('unconfigured')); await template(item, 'Available native template');
  let calls = 0; setExtractionProvider({ configured: () => false, extract: async input => { calls++; return controlledResult(input); } });
  const source = await upload(item), before = await ledger(item.account);
  assert.equal(await processOneCoreJob(source.jobId), true);
  const data = await detail(item, source.document.id);
  assert.equal(data.document.status, 'needs_review'); assert.equal(data.runs[0].selection.outcome, 'template');
  assert.equal(calls, 0); assert.deepEqual(await ledger(item.account), before);
});

test('an incomplete explicit anchor falls back to one actual controlled AI extraction and records its cost and reason', async () => {
  const item = await create(await account('fallback'));
  await template(item, 'Missing custom total', [fullRules[0], { field: 'total', anchor: 'Amount due' }]);
  const source = await upload(item), before = await ledger(item.account);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => {
    calls++; assert.deepEqual(input.bytes, source.bytes); assert.deepEqual(input.schema, simple); return controlledResult(input);
  } });
  const preview = await check(item, source.document.id); assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().selection.outcome, 'ai'); assert.equal(preview.json().selection.reason, 'no_match');
  assert.equal(preview.json().candidates[0].matched, false); assert.ok(preview.json().candidates[0].unmatchedFields.includes('total')); assert.equal(calls, 0);
  assert.equal(await processOneCoreJob(source.jobId), true); assert.equal(calls, 1);
  const data = await detail(item, source.document.id), run = data.runs[0];
  assert.equal(data.document.status, 'needs_review'); assert.equal(run.engine, 'controlled-ai'); assert.deepEqual(run.normalizedValues, controlledResult({} as ProviderInput).normalizedValues);
  assert.equal(run.selection.outcome, 'ai'); assert.equal(run.selection.reason, 'no_match'); assert.equal(run.selection.eligibleTemplates, 0);
  assert.equal(Number(run.costUsd), 0.00123); assert.deepEqual(await ledger(item.account), before);
  assert.equal(await processOneCoreJob(source.jobId), false); assert.equal(calls, 1);
});

test('rules mode with an enabled nonmatch fails once without label fallback or additional usage', async () => {
  const item = await create(await account('rules-nonmatch'), 'rules'); await template(item, 'Another document family', fullRules, 'NEVER PRESENT');
  const source = await upload(item), before = await ledger(item.account);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return controlledResult(input); } });
  assert.equal(await processOneCoreJob(source.jobId), true);
  const failed = await job(source.jobId), data = await detail(item, source.document.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.attempts, 1); assert.match(failed.error, /template/i);
  assert.equal(data.document.status, 'failed'); assert.equal(data.runs.length, 0);
  assert.equal(await processOneCoreJob(source.jobId), false); assert.equal(calls, 0); assert.deepEqual(await ledger(item.account), before);
  const plain = await create(item.account, 'rules'), plainSource = await upload(plain);
  assert.equal(await processOneCoreJob(plainSource.jobId), true);
  const run = (await detail(plain, plainSource.document.id)).runs[0];
  assert.equal(run.selection.outcome, 'rules'); assert.equal(run.selection.reason, 'no_templates'); assert.equal(run.engine, 'text-anchors');
});

test('job selection and completed provenance remain pinned through template edits, deletion and schema changes', async () => {
  const item = await create(await account('pinned')), original = await template(item, 'Original pinned name');
  const source = await upload(item), snapshot = (await job(source.jobId)).config;
  const edited = await request(item.account, 'PATCH', `/api/templates/${original.id}`, templateBody('Changed current name', [{ field: 'reference', anchor: 'Changed reference' }]));
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal((await request(item.account, 'DELETE', `/api/templates/${original.id}`)).statusCode, 200);
  const changed = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { fields: [{ key: 'different', label: 'Different', type: 'string' }] });
  assert.equal(changed.statusCode, 200, changed.body); assert.notEqual(changed.json().schema.id, item.schemaId);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return controlledResult(input); } });
  const preview = await check(item, source.document.id); assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.json().selection.reason, 'no_templates');
  assert.equal(await processOneCoreJob(source.jobId), true); assert.equal(calls, 0);
  const run = (await detail(item, source.document.id)).runs[0], selection = structuredClone(run.selection);
  assert.equal(run.schemaVersionId, item.schemaId); assert.deepEqual(run.normalizedValues, { reference: 'OWNED-341', total: 24.5, note: null });
  assert.equal(selection.template.id, original.id); assert.equal(selection.template.name, 'Original pinned name'); assert.equal(selection.template.fieldCount, 2);
  assert.deepEqual((await job(source.jobId)).config, snapshot);
  await template(item, 'Current different template', [{ field: 'different', anchor: 'Different' }]);
  const historical = await request(item.account, 'GET', `/api/runs/${run.id}`);
  assert.equal(historical.statusCode, 200, historical.body); assert.deepEqual(historical.json().run.selection, selection);
  const reprocess = await request(item.account, 'POST', `/api/documents/${source.document.id}/reprocess`);
  assert.equal(reprocess.statusCode, 200, reprocess.body);
  const next = await job(reprocess.json().job.id); assert.equal(next.config.templatePolicy, 'complete-v1'); assert.equal(next.schema_version_id, changed.json().schema.id);
  assert.equal(next.config.templates[0].name, 'Current different template'); assert.equal((await ledger(item.account)).length, 2);
  assert.deepEqual((await request(item.account, 'GET', `/api/runs/${run.id}`)).json().run.selection, selection);
});

test('unstamped queued jobs keep legacy AI and rules behavior and never fabricate selection history', async () => {
  const a = await account('legacy'), ai = await create(a), rules = await create(a, 'rules');
  await template(ai, 'Would now preempt AI'); await template(rules, 'Legacy unmatched phrase', fullRules, 'NOT THIS FAMILY');
  const aiSource = await upload(ai), ruleSource = await upload(rules);
  for (const source of [aiSource, ruleSource]) await adminPool.query("update jobs set config=config-'templatePolicy' where id=$1", [source.jobId]);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return controlledResult(input); } });
  assert.equal(await processOneCoreJob(aiSource.jobId), true); assert.equal(await processOneCoreJob(ruleSource.jobId), true); assert.equal(calls, 1);
  const aiRun = (await detail(ai, aiSource.document.id)).runs[0], rulesRun = (await detail(rules, ruleSource.document.id)).runs[0];
  assert.equal(aiRun.engine, 'controlled-ai'); assert.equal(aiRun.selection, null);
  assert.equal(rulesRun.engine, 'text-anchors'); assert.equal(rulesRun.selection, null); assert.equal(rulesRun.normalizedValues.reference, 'OWNED-341');
  assert.ok(rulesRun.issues.some((issue: any) => issue.code === 'no_template')); assert.equal((await ledger(a)).length, 2);
});

test('both automatic initial setup and manual setup release stamp the current policy on the original held jobs', async () => {
  const a = await account('setup-release'); let extractionCalls = 0, suggestionCalls = 0;
  setExtractionProvider({ configured: () => true, extract: async input => { extractionCalls++; return controlledResult(input); } });
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => {
    suggestionCalls++; return { schema: { fields: simple.fields.map(field => ({ ...field, required: false })) }, model: 'controlled-template-setup', promptVersion: 'controlled-setup-v1', tokenUsage: { inputTokens: 20, outputTokens: 10 }, costUsd: 0.0001 };
  } });
  for (const release of ['automatic', 'manual']) {
    const created = await request(a, 'POST', '/api/parsers', { name: `Owned ${release} release`, useCase: 'custom', setupMode: 'sample', mode: 'ai' });
    assert.equal(created.statusCode, 201, created.body);
    const item = { account: a, parserId: created.json().parser.id, schemaId: created.json().schema.id }, source = await upload(item);
    assert.equal((await job(source.jobId)).config.templatePolicy, 'complete-v1'); assert.equal((await job(source.jobId)).waiting_for_schema, true);
    await adminPool.query("update jobs set config=config-'templatePolicy' where id=$1", [source.jobId]);
    const before = await ledger(a);
    if (release === 'automatic') {
      const state = await request(a, 'GET', `/api/parsers/${item.parserId}/setup`); assert.ok(state.json().setup.suggestionId);
      assert.equal(await processOneSchemaSuggestion(state.json().setup.suggestionId), true);
    } else {
      const saved = await request(a, 'POST', `/api/parsers/${item.parserId}/schema`, simple); assert.equal(saved.statusCode, 200, saved.body);
    }
    const released = await job(source.jobId); assert.equal(released.config.templatePolicy, 'complete-v1'); assert.equal(released.waiting_for_schema, false);
    assert.equal(released.state, 'queued'); assert.equal(released.attempts, 0); assert.notEqual(released.schema_version_id, item.schemaId);
    assert.equal((await adminPool.query('select id from jobs where document_id=$1', [source.document.id])).rowCount, 1);
    assert.deepEqual(await ledger(a), before);
  }
  assert.equal(suggestionCalls, 1); assert.equal(extractionCalls, 0);
});

test('template create and edit validate supported schema paths atomically, including nested and long scalar paths', async () => {
  const schema: ParserSchema = { fields: [...simple.fields,
    { key: 'party', label: 'Party', type: 'object', fields: [{ key: 'tax', label: 'Tax ID', type: 'string' }] },
    { key: 'items', label: 'Items', type: 'array', fields: [{ key: 'description', label: 'Description', type: 'string' }, { key: 'quantity', label: 'Quantity', type: 'number' }] },
    { key: 'complex', label: 'Complex table', type: 'array', fields: [{ key: 'object', label: 'Object column', type: 'object', fields: [{ key: 'value', label: 'Value', type: 'string' }] }] },
  ] };
  const item = await create(await account('validation'), 'rules', schema), valid = await template(item, 'Supported fields', [
    { field: 'party.tax', anchor: 'Tax registration' }, { field: 'items', anchor: 'Purchased items' }, { field: 'items.quantity', anchor: 'Count' },
  ]);
  const invalid = [[], [fullRules[0], fullRules[0]], [{ field: 'unknown', anchor: 'Unknown' }], [{ field: 'party', anchor: 'Party' }],
    [{ field: 'complex.object.value', anchor: 'Value' }], [{ field: 'items..quantity', anchor: 'Count' }], [{ field: 'reference', anchor: '   ' }]];
  const before = await footprint(item.account);
  for (const rules of invalid) {
    const body = templateBody('Invalid enabled template', rules);
    assert.equal((await request(item.account, 'POST', `/api/parsers/${item.parserId}/templates`, body)).statusCode, 400);
    assert.equal((await request(item.account, 'PATCH', `/api/templates/${valid.id}`, body)).statusCode, 400);
  }
  assert.deepEqual(await footprint(item.account), before);
  const keys = ['a', 'b', 'c', 'd'].map(letter => letter.repeat(64));
  const deep: ParserSchema = { fields: [{ key: keys[0], label: 'A', type: 'object', fields: [{ key: keys[1], label: 'B', type: 'object', fields: [{ key: keys[2], label: 'C', type: 'object', fields: [{ key: keys[3], label: 'D', type: 'string' }] }] }] }] };
  const deepItem = await create(item.account, 'rules', deep), path = keys.join('.'); assert.equal(path.length, 259);
  const saved = await template(deepItem, 'Maximum supported nested path', [{ field: path, anchor: 'Deep source' }]); assert.equal(saved.rules[0].field, path);
});

test('template checks enforce tenant, parser, scopes and origin boundaries and expose no source values or write effects', async () => {
  const a = await account('guards'), outsider = await account('outsider'), viewer = await account('viewer');
  const item = await create(a), otherParser = await create(a), foreignParser = await create(outsider);
  const saved = await template(item, 'Safe check'), source = await upload(item, `${sample}\nPrivate source sentinel: OWNED-DO-NOT-EXPOSE-784`);
  const other = await upload(otherParser), foreign = await upload(foreignParser), endpoint = `/api/parsers/${item.parserId}/templates/check`, payload = { documentId: source.document.id };
  const parserOnly = await scoped(a, ['parsers:read']), documentOnly = await scoped(a, ['documents:read']), both = await scoped(a, ['parsers:read', 'documents:read']);
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [a.workspace.id, viewer.user.id]);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return controlledResult(input); } });
  const before = await footprint(a), foreignBefore = await footprint(outsider);
  for (const auth of [parserOnly, documentOnly]) assert.equal((await request(a, 'POST', endpoint, payload, auth)).statusCode, 403);
  assert.equal((await request(outsider, 'POST', endpoint, payload)).statusCode, 404);
  for (const documentId of [other.document.id, foreign.document.id, randomUUID()]) assert.equal((await request(a, 'POST', endpoint, { documentId })).statusCode, 404);
  assert.equal((await request(a, 'POST', endpoint, payload, { origin: 'https://unrelated.example' })).statusCode, 403);
  assert.equal((await request(a, 'POST', endpoint, { documentId: 'invalid' })).statusCode, 400);
  assert.equal((await request(a, 'POST', `/api/parsers/${item.parserId}/templates`, templateBody('No write scope'), both)).statusCode, 403);
  assert.equal((await request(a, 'PATCH', `/api/templates/${saved.id}`, templateBody('No write scope'), both)).statusCode, 403);
  assert.equal((await request(outsider, 'PATCH', `/api/templates/${saved.id}`, templateBody('Foreign edit'))).statusCode, 404);
  assert.equal((await request(outsider, 'DELETE', `/api/templates/${saved.id}`)).statusCode, 404);
  const viewerWorkspace = { 'x-workspace-id': a.workspace.id };
  assert.equal((await request(viewer, 'POST', `/api/parsers/${item.parserId}/templates`, templateBody('Viewer cannot create'), viewerWorkspace)).statusCode, 403);
  assert.equal((await request(viewer, 'DELETE', `/api/templates/${saved.id}`, undefined, viewerWorkspace)).statusCode, 403);
  for (const response of [await request(a, 'POST', endpoint, payload), await request(a, 'POST', endpoint, payload, both), await request(viewer, 'POST', endpoint, payload, viewerWorkspace)]) {
    assert.equal(response.statusCode, 200, response.body); const value = response.json();
    assert.equal(value.availableSourceText, true); assert.equal(value.selection.outcome, 'template'); assert.equal(value.candidates[0].matched, true);
    for (const privateValue of ['OWNED-341', '24.50', 'OWNED-DO-NOT-EXPOSE-784', 'rawValues', 'normalizedValues', 'evidence']) assert.equal(response.body.includes(privateValue), false);
  }
  assert.equal(calls, 0); assert.deepEqual(await footprint(a), before); assert.deepEqual(await footprint(outsider), foreignBefore);
  assert.equal((await job(source.jobId)).state, 'queued'); assert.equal((await job(source.jobId)).attempts, 0);
});

test('invalid legacy templates can be disabled or deleted without silently enabling invalid anchors', async () => {
  const item = await create(await account('legacy-recovery'), 'rules');
  for (const rules of [[], [{ field: 'removed_field', anchor: 'Removed field' }], [fullRules[0], fullRules[0]]]) {
    const { rows: [legacy] } = await adminPool.query('insert into templates(workspace_id,parser_id,name,match_text,rules,enabled) values($1,$2,$3,$4,$5,true) returning *', [item.account.workspace.id, item.parserId, 'Owned invalid legacy', '', JSON.stringify(rules)]);
    const body = { ...templateBody(legacy.name, rules), enabled: false };
    const disabled = await request(item.account, 'PATCH', `/api/templates/${legacy.id}`, body); assert.equal(disabled.statusCode, 200, disabled.body);
    assert.equal(disabled.json().template.enabled, false); assert.deepEqual(disabled.json().template.rules, rules);
    const before = await footprint(item.account);
    assert.equal((await request(item.account, 'PATCH', `/api/templates/${legacy.id}`, { ...body, enabled: true })).statusCode, 400);
    assert.deepEqual(await footprint(item.account), before);
    assert.equal((await request(item.account, 'DELETE', `/api/templates/${legacy.id}`)).statusCode, 200);
  }
});

test('the 100-template cap serializes concurrent creates and frees a slot only after a deletion', async () => {
  const item = await create(await account('capacity'), 'rules');
  await adminPool.query("insert into templates(workspace_id,parser_id,name,match_text,rules,enabled) select $1,$2,'Owned capacity '||n,'',$3,true from generate_series(1,99) n", [item.account.workspace.id, item.parserId, JSON.stringify(fullRules)]);
  const before = await footprint(item.account);
  const responses = await Promise.all(['A', 'B'].map(label => request(item.account, 'POST', `/api/parsers/${item.parserId}/templates`, templateBody(`Concurrent ${label}`))));
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 429]);
  const created = responses.find(response => response.statusCode === 200)!.json().template;
  assert.equal((await adminPool.query('select id from templates where parser_id=$1', [item.parserId])).rowCount, 100);
  assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and action='template.created'", [item.account.workspace.id])).rowCount, 1);
  const afterCreate = await footprint(item.account);
  for (const name of ['documents', 'jobs', 'usage_ledger', 'schema_suggestions', 'extraction_runs', 'objects']) assert.deepEqual(afterCreate[name], before[name]);
  assert.equal((await request(item.account, 'DELETE', `/api/templates/${created.id}`)).statusCode, 200);
  await template(item, 'Freed slot'); assert.equal((await adminPool.query('select id from templates where parser_id=$1', [item.parserId])).rowCount, 100);
});
