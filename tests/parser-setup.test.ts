import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Actor, ParserSchema, ProviderInput, ExtractionResult } from '../shared/types.js';
import type { SchemaSuggestionResult } from '../shared/schema-suggestions.js';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase, withWorkspace } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';
import { processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import { processOneSchemaSuggestion, setSchemaSuggestionProvider } from '../server/core/schema-suggestions.js';
import { SchemaSuggestionProviderError } from '../server/core/schema-suggestion-errors.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
type Fixture = { account: Account; parserId: string; baseSchemaId: string };
type Setup = { state: 'ready' | 'awaiting_sample' | 'suggesting' | 'failed'; suggestionId: string | null; sourceDocumentId: string | null; sourceDocumentName: string | null; error: string | null; waitingDocuments: number; available: boolean };
const accounts: Account[] = [], objects = new Map<string, Buffer>();
const discovered: ParserSchema = { fields: [{ key: 'reference', label: 'Reference', type: 'string', required: false }, { key: 'total', label: 'Total', type: 'currency', required: false }] };
const manual: ParserSchema = { fields: [{ key: 'manual_reference', label: 'Reference', type: 'string' }] };
const suggestionCost = 0.00123, extractionCost = 0.0025;
let app: FastifyInstance, localVerified = false;
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); if (!bytes) throw new Error('Missing owned setup source'); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
};
const actor = (a: Account): Actor => ({ userId: a.user.id, workspaceId: a.workspace.id, role: 'owner', authType: 'session' });
const suggested = (): SchemaSuggestionResult => ({ schema: structuredClone(discovered), model: 'controlled-setup-model', promptVersion: 'controlled-setup-v1', tokenUsage: { inputTokens: 120, outputTokens: 30 }, costUsd: suggestionCost });
const extracted = (_input: ProviderInput): ExtractionResult => ({ rawValues: { reference: 'OWNED-127', total: '24.50' }, normalizedValues: { reference: 'OWNED-127', total: 24.5 }, evidence: {}, issues: [], model: 'controlled-extraction-model', engine: 'controlled-ai', promptVersion: 'controlled-extraction-v1', tokenUsage: { inputTokens: 100 }, costUsd: extractionCost });
function providers() { setSchemaSuggestionProvider({ configured: () => true, suggest: async () => suggested() }); setExtractionProvider({ configured: () => true, extract: async input => extracted(input) }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function entered(promise: Promise<unknown>) {
  let timer!: ReturnType<typeof setTimeout>;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned setup provider did not start')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function request(a: Account, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, payload: payload as any, headers: { origin: config.origin, cookie: a.cookie, ...headers } });
}
async function account(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: `Owned setup ${label}`, workspaceName: `Owned setup ${label}`, email: `parser-setup-${randomUUID()}@example.test`, password: 'Owned automatic parser setup password',
  } });
  assert.equal(response.statusCode, 201, response.body);
  const a = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } as Account;
  accounts.push(a);
  await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','20'),'{monthlyPages}','1000') where id=$1", [a.workspace.id]);
  return a;
}
async function create(a: Account, extras: Record<string, unknown> = {}): Promise<Fixture> {
  const response = await request(a, 'POST', '/api/parsers', { name: 'Owned sample-driven parser', setupMode: 'sample', useCase: 'custom', mode: 'ai', ...extras });
  assert.equal(response.statusCode, 201, response.body); assert.equal(response.json().parser.fieldSetupState, 'awaiting_sample');
  return { account: a, parserId: response.json().parser.id, baseSchemaId: response.json().schema.id };
}
async function fixture(label: string) { providers(); return create(await account(label)); }
async function setup(item: Fixture): Promise<Setup> {
  const response = await request(item.account, 'GET', `/api/parsers/${item.parserId}/setup`);
  assert.equal(response.statusCode, 200, response.body); return response.json().setup;
}
async function parserRow(item: Fixture) { return (await adminPool.query('select * from parsers where id=$1', [item.parserId])).rows[0]; }
async function suggestionRow(id: string) { return (await adminPool.query('select * from schema_suggestions where id=$1', [id])).rows[0]; }
async function jobs(item: Fixture) { return (await adminPool.query('select j.* from jobs j join documents d on d.id=j.document_id where d.parser_id=$1 order by j.id', [item.parserId])).rows; }
async function suggestions(item: Fixture) { return (await adminPool.query('select * from schema_suggestions where parser_id=$1 order by created_at,id', [item.parserId])).rows; }
async function upload(item: Fixture, label: string, key?: string) {
  const bytes = Buffer.from(`Reference: OWNED-127\nTotal: 24.50\nOwned source ${label}`);
  return { ...(await addDocument(actor(item.account), item.parserId, bytes, `${label}.txt`, undefined, key)), bytes };
}
async function footprint(a: Account) {
  const data: Record<string, number | string[]> = {};
  for (const table of ['documents', 'jobs', 'usage_ledger', 'intake_files', 'schema_suggestions', 'schema_versions', 'extraction_runs', 'approvals']) data[table] = (await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`, [a.workspace.id])).rows[0].n;
  data.originals = [...objects.keys()].filter(key => key.startsWith(`${a.workspace.id}/`)).sort(); return data;
}
async function pageLedger(item: Fixture) { return (await adminPool.query('select * from usage_ledger where workspace_id=$1 order by id', [item.account.workspace.id])).rows; }
async function retry(item: Fixture, documentId: string, requestId = randomUUID()) { return request(item.account, 'POST', `/api/parsers/${item.parserId}/setup/retry`, { documentId, requestId }); }
async function makeAvailable(id: string) { await adminPool.query('update schema_suggestions set available_at=now() where id=$1', [id]); }

before(async () => {
  const options = adminPool.options, host = options.connectionString ? new URL(options.connectionString).hostname : options.host;
  assert.ok(typeof host === 'string' && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)), 'Parser setup fixtures require a local database');
  localVerified = true; setStorageForTests(storage); app = await buildApp();
});
afterEach(() => { setSchemaSuggestionProvider(undefined); setExtractionProvider(undefined); });
after(async () => {
  setSchemaSuggestionProvider(undefined); setExtractionProvider(undefined); setStorageForTests(undefined);
  try {
    await app?.close(); if (!localVerified) return;
    for (const a of accounts) await adminPool.query('delete from workspaces where id=$1', [a.workspace.id]);
    for (const a of accounts) await adminPool.query('delete from users where id=$1', [a.user.id]);
    objects.clear();
  } finally { await closeDatabase(); }
});

test('preset creation remains compatible while sample setup requires both providers and compatible explicit input', async () => {
  const a = await account('creation');
  const preset = await request(a, 'POST', '/api/parsers', { name: 'Owned existing preset', useCase: 'receipt' });
  assert.equal(preset.statusCode, 201, preset.body); assert.equal(preset.json().parser.fieldSetupState, 'ready'); assert.equal(preset.json().parser.mode, 'rules');
  const payload = { name: 'Owned automatic setup', setupMode: 'sample', useCase: 'custom', mode: 'ai' };
  assert.equal((await request(a, 'POST', '/api/parsers', payload)).statusCode, 503);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => suggested() });
  assert.equal((await request(a, 'POST', '/api/parsers', payload)).statusCode, 503);
  setSchemaSuggestionProvider(undefined); setExtractionProvider({ configured: () => true, extract: async input => extracted(input) });
  assert.equal((await request(a, 'POST', '/api/parsers', payload)).statusCode, 503);
  providers();
  for (const invalid of [{ mode: 'rules' }, { useCase: 'invoice' }, { schema: manual }, { setupMode: 'invalid' }]) assert.equal((await request(a, 'POST', '/api/parsers', { ...payload, ...invalid })).statusCode, 400);
  const created = await create(a), state = await setup(created);
  assert.equal(state.state, 'awaiting_sample'); assert.equal(state.suggestionId, null); assert.equal(state.sourceDocumentId, null); assert.equal(state.waitingDocuments, 0); assert.equal(state.available, true);
  assert.equal((await parserRow(created)).mode, 'ai');
  const presetItem = { account: a, parserId: preset.json().parser.id, baseSchemaId: preset.json().schema.id };
  const accepted = await upload(presetItem, 'preset-compatible'); assert.ok(accepted.jobId);
  assert.equal((await jobs(presetItem))[0].waiting_for_schema, false); assert.equal(await processOneCoreJob(accepted.jobId), true);
  assert.equal((await suggestions(presetItem)).length, 0);
});

test('rejected first sources leave setup waiting and concurrent accepted sources create exactly one held setup', async () => {
  const item = await fixture('first-race'), before = await footprint(item.account);
  await assert.rejects(addDocument(actor(item.account), item.parserId, Buffer.from('GIF89a\0OWNED unsupported sample'), 'invalid.pdf'), (error: any) => error.code === 'source_validation_failed');
  assert.deepEqual(await footprint(item.account), before); assert.equal((await setup(item)).state, 'awaiting_sample');
  const [first, second] = await Promise.all([upload(item, 'first', 'first-owned-key'), upload(item, 'second', 'second-owned-key')]);
  assert.ok(first.jobId); assert.ok(second.jobId);
  const state = await setup(item), drafts = await suggestions(item);
  assert.equal(state.state, 'suggesting'); assert.equal(state.waitingDocuments, 2); assert.equal(drafts.length, 1); assert.equal(drafts[0].auto_setup, true);
  assert.equal(state.suggestionId, drafts[0].id); assert.ok([first.document.id, second.document.id].includes(state.sourceDocumentId));
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return extracted(input); } });
  for (const accepted of [first, second]) {
    assert.equal(await processOneCoreJob(accepted.jobId!), false);
    const detail = await request(item.account, 'GET', `/api/documents/${accepted.document.id}`);
    assert.equal(detail.statusCode, 200, detail.body); assert.equal(detail.json().jobs[0].waitingForSchema, true);
    const job = await request(item.account, 'GET', `/api/jobs/${accepted.jobId}`);
    assert.equal(job.statusCode, 200, job.body); assert.equal(job.json().job.waitingForSchema, true); assert.equal(job.json().job.config, undefined);
  }
  assert.equal(calls, 0);
  const acceptedFootprint = await footprint(item.account);
  for (const key of ['first-owned-key', undefined, 'fresh-duplicate-key']) {
    const replay = await addDocument(actor(item.account), item.parserId, first.bytes, 'first-renamed.txt', undefined, key);
    assert.equal(replay.duplicate, true); assert.equal(replay.document.id, first.document.id);
  }
  assert.deepEqual(await footprint(item.account), acceptedFootprint);
  assert.equal((await jobs(item)).every(job => job.state === 'queued' && job.waiting_for_schema && job.attempts === 0), true);
});

test('automatic setup applies version two once, releases the existing jobs with current config and preserves upload credits', async () => {
  const item = await fixture('success'), first = await upload(item, 'initial'), second = await upload(item, 'held');
  const state = await setup(item); assert.ok(state.suggestionId);
  const ledger = await pageLedger(item), held = await jobs(item);
  await request(item.account, 'PATCH', `/api/parsers/${item.parserId}`, { instructions: 'Current extraction instructions', locale: 'de-DE' });
  assert.equal(await processOneSchemaSuggestion(state.suggestionId), true);
  const ready = await setup(item), parser = await parserRow(item), draft = await suggestionRow(state.suggestionId);
  assert.equal(ready.state, 'ready'); assert.equal(ready.waitingDocuments, 0); assert.equal(ready.sourceDocumentId, first.document.id);
  assert.equal(draft.state, 'ready'); assert.equal(draft.applied_schema_id, parser.active_schema_id); assert.notEqual(parser.active_schema_id, item.baseSchemaId);
  const versions = (await adminPool.query('select * from schema_versions where parser_id=$1 order by version', [item.parserId])).rows;
  assert.deepEqual(versions.map(version => version.version), [1, 2]); assert.deepEqual(versions[1].schema, discovered);
  const released = await jobs(item); assert.deepEqual(released.map(job => job.id), held.map(job => job.id));
  for (const job of released) {
    assert.equal(job.waiting_for_schema, false); assert.equal(job.state, 'queued'); assert.equal(job.attempts, 0); assert.equal(job.schema_version_id, parser.active_schema_id);
    assert.equal(job.config.locale, 'de-DE'); assert.equal(job.config.instructions, 'Current extraction instructions');
  }
  assert.deepEqual(await pageLedger(item), ledger); assert.equal(await processOneSchemaSuggestion(state.suggestionId), false);
  let calls = 0;
  setExtractionProvider({ configured: () => true, extract: async input => { calls++; assert.deepEqual(input.schema, discovered); assert.equal(input.instructions, 'Current extraction instructions'); return extracted(input); } });
  assert.equal(await processOneCoreJob(first.jobId!), true); assert.equal(await processOneCoreJob(second.jobId!), true); assert.equal(calls, 2);
  assert.equal((await footprint(item.account)).approvals, 0); assert.equal((await footprint(item.account)).extraction_runs, 2); assert.deepEqual(await pageLedger(item), ledger);
  const usage = await request(item.account, 'GET', '/api/workspace/usage');
  assert.equal(usage.json().usage.schemaSuggestionCostUsd, suggestionCost); assert.ok(Math.abs(usage.json().usage.costUsd - suggestionCost - 2 * extractionCost) < 1e-9);
  const later = await upload(item, 'later'); assert.ok(later.jobId);
  const laterJob = (await jobs(item)).find(job => job.id === later.jobId);
  assert.equal(laterJob.waiting_for_schema, false); assert.equal(laterJob.schema_version_id, parser.active_schema_id); assert.equal((await suggestions(item)).length, 1);
});

test('a schema audit failure rolls back automatic application and held-job release before a retry succeeds', async () => {
  const item = await fixture('atomic'), initial = await upload(item, 'atomic');
  const state = await setup(item); assert.ok(state.suggestionId); const ledger = await pageLedger(item);
  const trigger = `owned_setup_audit_${randomUUID().replaceAll('-', '')}`;
  try {
    await adminPool.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin
      if NEW.workspace_id='${item.account.workspace.id}'::uuid and NEW.action='schema.version_created' and NEW.entity_id='${item.parserId}'::uuid then
        raise exception 'Owned setup schema audit failure';
      end if; return NEW; end $$`);
    await adminPool.query(`create trigger ${trigger} before insert on audit_events for each row execute function ${trigger}()`);
    assert.equal(await processOneSchemaSuggestion(state.suggestionId), true);
    assert.equal((await parserRow(item)).active_schema_id, item.baseSchemaId); assert.equal((await setup(item)).state, 'suggesting');
    assert.equal((await adminPool.query('select id from schema_versions where parser_id=$1', [item.parserId])).rowCount, 1);
    const draft = await suggestionRow(state.suggestionId); assert.equal(draft.state, 'queued'); assert.equal(draft.proposed_schema, null); assert.equal(draft.applied_schema_id, null);
    const job = (await jobs(item))[0]; assert.equal(job.waiting_for_schema, true); assert.equal(job.id, initial.jobId); assert.equal(job.attempts, 0);
    assert.deepEqual(await pageLedger(item), ledger);
  } finally {
    await adminPool.query(`drop trigger if exists ${trigger} on audit_events`); await adminPool.query(`drop function if exists ${trigger}()`);
  }
  await makeAvailable(state.suggestionId); assert.equal(await processOneSchemaSuggestion(state.suggestionId), true);
  assert.equal((await setup(item)).state, 'ready'); assert.equal((await jobs(item))[0].waiting_for_schema, false); assert.deepEqual(await pageLedger(item), ledger);
});

test('terminal setup failure keeps sources and retrying a different document reuses jobs and page reservations', async () => {
  const item = await fixture('retry-source'), first = await upload(item, 'failed-source'), alternative = await upload(item, 'alternative-source');
  const initial = await setup(item); assert.ok(initial.suggestionId); const held = await jobs(item), ledger = await pageLedger(item);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { throw new SchemaSuggestionProviderError('The owned first sample cannot be read safely'); } });
  assert.equal(await processOneSchemaSuggestion(initial.suggestionId), true);
  const failed = await setup(item); assert.equal(failed.state, 'failed'); assert.ok(failed.error); assert.equal(failed.sourceDocumentId, first.document.id);
  for (const job of await jobs(item)) { assert.equal(job.state, 'failed'); assert.equal(job.waiting_for_schema, true); assert.equal(job.attempts, 0); }
  const retained = await footprint(item.account); assert.equal(retained.documents, 2); assert.equal((retained.originals as string[]).length, 2);
  let seen: Buffer | undefined;
  providers(); setSchemaSuggestionProvider({ configured: () => true, suggest: async input => { seen = input.bytes; return suggested(); } });
  const requestId = randomUUID(), retried = await retry(item, alternative.document.id, requestId);
  assert.equal(retried.statusCode, 202, retried.body); const pending = await setup(item); assert.ok(pending.suggestionId); assert.notEqual(pending.suggestionId, initial.suggestionId);
  assert.equal(pending.sourceDocumentId, alternative.document.id); assert.equal((await retry(item, alternative.document.id, requestId)).statusCode, 202);
  assert.equal((await retry(item, first.document.id, requestId)).statusCode, 409); assert.equal((await suggestions(item)).length, 2);
  assert.equal((await jobs(item)).every(job => job.state === 'queued' && job.waiting_for_schema), true);
  assert.equal(await processOneSchemaSuggestion(pending.suggestionId), true); assert.deepEqual(seen, alternative.bytes);
  assert.deepEqual((await jobs(item)).map(job => job.id), held.map(job => job.id)); assert.deepEqual(await pageLedger(item), ledger); assert.equal((await setup(item)).state, 'ready');
});

test('expired setup leases recover once and repeated transient failures stop without extracting placeholder fields', async () => {
  const item = await fixture('lease'), accepted = await upload(item, 'lease'); const state = await setup(item); assert.ok(state.suggestionId);
  await adminPool.query("update schema_suggestions set state='processing',attempts=1,lease_owner=$2,lease_until=now()-interval '1 second' where id=$1", [state.suggestionId, randomUUID()]);
  assert.equal(await processOneSchemaSuggestion(state.suggestionId), true); assert.equal((await suggestionRow(state.suggestionId)).attempts, 2);
  assert.equal((await setup(item)).state, 'ready'); assert.equal((await jobs(item))[0].id, accepted.jobId);
  const failing = await create(item.account), held = await upload(failing, 'exhausted'); const pending = await setup(failing); assert.ok(pending.suggestionId);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { throw new Error('PRIVATE recurring setup outage'); } });
  for (let attempt = 0; attempt < 3; attempt++) { await makeAvailable(pending.suggestionId); assert.equal(await processOneSchemaSuggestion(pending.suggestionId), true); }
  const final = await setup(failing); assert.equal(final.state, 'failed'); assert.ok(!JSON.stringify(final).includes('PRIVATE'));
  assert.equal((await suggestionRow(pending.suggestionId)).attempts, 3); assert.equal(await processOneSchemaSuggestion(pending.suggestionId), false);
  assert.equal(await processOneCoreJob(held.jobId!), false); assert.equal((await jobs(failing))[0].waiting_for_schema, true);
  assert.equal((await adminPool.query('select id from extraction_runs where document_id=$1', [held.document.id])).rowCount, 0);
});

test('manual field recovery releases held jobs and a late automatic suggestion cannot overwrite it', async () => {
  const item = await fixture('manual'), accepted = await upload(item, 'manual'); const state = await setup(item); assert.ok(state.suggestionId);
  const started = deferred<void>(), output = deferred<SchemaSuggestionResult>();
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { started.resolve(); return output.promise; } });
  const processing = processOneSchemaSuggestion(state.suggestionId, { providerTimeoutMs: 10000 });
  let manualId: string | undefined; const ledger = await pageLedger(item);
  try {
    await entered(started.promise); setExtractionProvider(undefined);
    await request(item.account, 'PATCH', `/api/parsers/${item.parserId}`, { mode: 'rules' });
    const saved = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { ...manual, baseSchemaId: item.baseSchemaId });
    assert.equal(saved.statusCode, 200, saved.body); manualId = saved.json().schema.id;
    const recovered = await setup(item); assert.equal(recovered.state, 'ready'); assert.equal(recovered.suggestionId, null); assert.equal(recovered.waitingDocuments, 0);
    assert.equal((await jobs(item))[0].schema_version_id, manualId); assert.equal((await jobs(item))[0].waiting_for_schema, false);
  } finally { output.resolve(suggested()); await processing; }
  assert.equal((await parserRow(item)).active_schema_id, manualId); assert.equal((await suggestionRow(state.suggestionId)).applied_schema_id, null);
  assert.equal((await adminPool.query('select id from schema_versions where parser_id=$1', [item.parserId])).rowCount, 2); assert.deepEqual(await pageLedger(item), ledger);
  assert.equal(await processOneCoreJob(accepted.jobId!), true); assert.deepEqual(await pageLedger(item), ledger);
  const stale = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { ...discovered, baseSchemaId: item.baseSchemaId }); assert.equal(stale.statusCode, 409);
});

test('deleting an active setup source fails remaining held jobs and fences its late completion before another-source retry', async () => {
  const item = await fixture('deletion'), first = await upload(item, 'deleted'), other = await upload(item, 'remaining'); const state = await setup(item); assert.ok(state.suggestionId);
  const started = deferred<void>(), output = deferred<SchemaSuggestionResult>();
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { started.resolve(); return output.promise; } });
  const processing = processOneSchemaSuggestion(state.suggestionId, { providerTimeoutMs: 10000 });
  try {
    await entered(started.promise);
    const removed = await request(item.account, 'DELETE', `/api/documents/${first.document.id}`); assert.equal(removed.statusCode, 200, removed.body);
    const failed = await setup(item); assert.equal(failed.state, 'failed'); assert.equal(failed.suggestionId, null);
    assert.equal((await jobs(item))[0].state, 'failed'); assert.equal((await jobs(item))[0].waiting_for_schema, true);
  } finally { output.resolve(suggested()); await processing; }
  assert.equal(await suggestionRow(state.suggestionId), undefined); assert.equal((await parserRow(item)).active_schema_id, item.baseSchemaId);
  assert.equal((await adminPool.query('select id from documents where id=$1', [first.document.id])).rowCount, 0);
  providers(); const retryResponse = await retry(item, other.document.id); assert.equal(retryResponse.statusCode, 202, retryResponse.body);
  const retried = await setup(item); assert.ok(retried.suggestionId); assert.equal(await processOneSchemaSuggestion(retried.suggestionId), true);
  assert.equal((await setup(item)).state, 'ready'); assert.equal((await jobs(item)).length, 1); assert.equal((await jobs(item))[0].id, other.jobId);
});

test('setup recovery enforces tenant, role, dual-scope and origin boundaries', async () => {
  const item = await fixture('access'), source = await upload(item, 'access'); const state = await setup(item); assert.ok(state.suggestionId);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { throw new SchemaSuggestionProviderError('Owned setup access failure'); } });
  await processOneSchemaSuggestion(state.suggestionId); providers();
  const outsider = await account('outsider'), member = await account('viewer');
  const endpoint = `/api/parsers/${item.parserId}/setup`, payload = { documentId: source.document.id, requestId: randomUUID() };
  assert.equal((await request(outsider, 'GET', endpoint)).statusCode, 404); assert.equal((await request(outsider, 'POST', `${endpoint}/retry`, payload)).statusCode, 404);
  assert.equal((await withWorkspace(outsider.workspace.id, c => c.query('select id from parsers where id=$1', [item.parserId]))).rowCount, 0);
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [item.account.workspace.id, member.user.id]);
  const selected = { 'x-workspace-id': item.account.workspace.id };
  assert.equal((await request(member, 'GET', endpoint, undefined, selected)).statusCode, 200);
  assert.equal((await request(member, 'POST', `${endpoint}/retry`, payload, selected)).statusCode, 403);
  assert.equal((await request(member, 'POST', '/api/parsers', { name: 'Forbidden sample', setupMode: 'sample' }, selected)).statusCode, 403);
  assert.equal((await request(item.account, 'POST', `${endpoint}/retry`, payload, { origin: 'https://unrelated.example' })).statusCode, 403);
  const scoped = async (scopes: string[]) => {
    const key = await request(item.account, 'POST', '/api/workspace/api-keys', { name: 'Owned setup scope', scopes }); assert.equal(key.statusCode, 200, key.body);
    return { authorization: `Bearer ${key.json().token}`, cookie: '' };
  };
  for (const scopes of [['parsers:write'], ['documents:read']]) assert.equal((await request(item.account, 'POST', `${endpoint}/retry`, payload, await scoped(scopes))).statusCode, 403);
  assert.equal((await request(item.account, 'GET', endpoint, undefined, await scoped(['parsers:read']))).statusCode, 403);
  assert.equal((await request(item.account, 'GET', endpoint, undefined, await scoped(['parsers:read', 'documents:read']))).statusCode, 200);
  await adminPool.query("update memberships set role='editor' where workspace_id=$1 and user_id=$2", [item.account.workspace.id, member.user.id]);
  assert.equal((await request(member, 'POST', `${endpoint}/retry`, payload, selected)).statusCode, 202);
  assert.equal((await request(item.account, 'POST', `${endpoint}/retry`, payload, await scoped(['parsers:write', 'documents:read']))).statusCode, 202);
});

test('pending and daily suggestion caps roll back a first upload without abandoning awaiting-sample setup', async () => {
  const item = await fixture('quota');
  const preset = await request(item.account, 'POST', '/api/parsers', { name: 'Owned existing suggestions', useCase: 'custom' }); assert.equal(preset.statusCode, 201, preset.body);
  const existing = { account: item.account, parserId: preset.json().parser.id, baseSchemaId: preset.json().schema.id }, priorSource = await upload(existing, 'prior');
  for (let i = 0; i < 3; i++) assert.equal((await request(item.account, 'POST', `/api/parsers/${existing.parserId}/schema-suggestions`, { documentId: priorSource.document.id, baseSchemaId: existing.baseSchemaId, requestId: randomUUID() })).statusCode, 202);
  const beforePending = await footprint(item.account);
  await assert.rejects(upload(item, 'pending-cap'), (error: any) => error.statusCode === 429);
  assert.deepEqual(await footprint(item.account), beforePending); assert.equal((await setup(item)).state, 'awaiting_sample');
  const removed = await request(item.account, 'DELETE', `/api/documents/${priorSource.document.id}`); assert.equal(removed.statusCode, 200, removed.body);
  // Seven bounded audit fixtures represent earlier owned requests; deleted source audits retain the first three.
  for (let i = 0; i < 7; i++) await adminPool.query("insert into audit_events(workspace_id,user_id,action,entity_id,metadata) values($1,$2,'schema.suggestion_requested',$3,$4)", [item.account.workspace.id, item.account.user.id, randomUUID(), JSON.stringify({ ownedQuotaFixture: true })]);
  const beforeDaily = await footprint(item.account);
  await assert.rejects(upload(item, 'daily-cap'), (error: any) => error.statusCode === 429);
  assert.deepEqual(await footprint(item.account), beforeDaily); assert.equal((await setup(item)).state, 'awaiting_sample'); assert.equal((await setup(item)).suggestionId, null);
});

test('archived setup cannot apply or retry and unavailable providers do not consume a recovery request', async () => {
  const item = await fixture('archive'), source = await upload(item, 'archived'); const state = await setup(item); assert.ok(state.suggestionId);
  await request(item.account, 'PATCH', `/api/parsers/${item.parserId}`, { archived: true });
  assert.equal(await processOneSchemaSuggestion(state.suggestionId), true); assert.equal((await setup(item)).state, 'failed');
  assert.equal((await parserRow(item)).active_schema_id, item.baseSchemaId); assert.equal((await retry(item, source.document.id)).statusCode, 409);
  await request(item.account, 'PATCH', `/api/parsers/${item.parserId}`, { archived: false });
  setExtractionProvider(undefined); const before = await footprint(item.account);
  assert.equal((await retry(item, source.document.id)).statusCode, 503); assert.deepEqual(await footprint(item.account), before);
  providers(); assert.equal((await retry(item, source.document.id)).statusCode, 202);
});

test('released initial jobs leave a busy workspace untouched and claim after the setup lock is released', async () => {
  const item = await fixture('claim-lock'), document = await upload(item, 'claim-lock'); assert.ok(document.jobId);
  const state = await setup(item); await processOneSchemaSuggestion(state.suggestionId!);
  let calls = 0; setExtractionProvider({ configured: () => true, extract: async input => { calls++; return extracted(input); } });
  const lock = await adminPool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [item.account.workspace.id]);
    assert.equal(await processOneCoreJob(document.jobId), false);
    const [job] = await jobs(item); assert.equal(job.state, 'queued'); assert.equal(job.attempts, 0); assert.equal(calls, 0);
    await lock.query('COMMIT');
  } finally { await lock.query('ROLLBACK'); lock.release(); }
  assert.equal(await processOneCoreJob(document.jobId), true); assert.equal(calls, 1);
  assert.equal((await jobs(item))[0].state, 'completed'); assert.equal((await pageLedger(item)).length, 1);
});

test('new uploads after failed setup stay failed until retry while a deleted source allows a new upload to restart setup', async () => {
  const item = await fixture('new-source-recovery'), first = await upload(item, 'first');
  const firstState = await setup(item);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { throw new SchemaSuggestionProviderError('Use a clearer sample.'); } });
  await processOneSchemaSuggestion(firstState.suggestionId!);
  const second = await upload(item, 'second'); assert.ok(second.jobId); assert.equal(second.document.status, 'failed');
  assert.equal((await suggestions(item)).length, 1); assert.equal((await setup(item)).suggestionId, firstState.suggestionId);
  assert.equal(await processOneCoreJob(second.jobId), false);
  const deleted = await request(item.account, 'DELETE', `/api/documents/${first.document.id}`); assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await setup(item)).suggestionId, null);
  providers(); const third = await upload(item, 'third'); const restarted = await setup(item);
  assert.equal(restarted.state, 'suggesting'); assert.equal(restarted.sourceDocumentId, third.document.id);
  assert.equal((await jobs(item)).length, 2); for (const job of await jobs(item)) { assert.equal(job.state, 'queued'); assert.equal(job.attempts, 0); assert.equal(job.waiting_for_schema, true); }
  await processOneSchemaSuggestion(restarted.suggestionId!); assert.equal((await setup(item)).state, 'ready');
  assert.equal((await pageLedger(item)).length, 3); assert.equal((await pageLedger(item)).filter(row => row.event === 'reprocess').length, 0);
});
