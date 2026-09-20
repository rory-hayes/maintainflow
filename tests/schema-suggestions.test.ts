import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Actor, ParserSchema, ExtractionResult } from '../shared/types.js';
import type { SchemaSuggestion, SchemaSuggestionResult } from '../shared/schema-suggestions.js';
import { schemaSuggestionLimits } from '../shared/schema-suggestions.js';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase, withWorkspace } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';
import { enforceRetention, processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import { processOneSchemaSuggestion, schemaSuggestionsConfigured, setSchemaSuggestionProvider } from '../server/core/schema-suggestions.js';
import { SchemaSuggestionProviderError } from '../server/core/schema-suggestion-errors.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
type Fixture = { account: Account; parserId: string; baseSchemaId: string; documentId: string; jobId: string; bytes: Buffer };
const accounts: Account[] = [], objects = new Map<string, Buffer>();
const originalSchema: ParserSchema = { fields: [{ key: 'reference', label: 'Reference', type: 'string', required: true }] };
const proposedSchema: ParserSchema = { fields: [
  { key: 'reference', label: 'Reference', type: 'string', required: false },
  { key: 'total', label: 'Total', type: 'currency', required: false },
] };
const suggestionCost = 0.00123, extractionCost = 0.0025;
let app: FastifyInstance, localDatabaseVerified = false;
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); if (!bytes) throw new Error('Missing owned suggestion original'); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
};
const actor = (account: Account): Actor => ({ userId: account.user.id, workspaceId: account.workspace.id, role: 'owner', authType: 'session' });
const result = (overrides: Partial<SchemaSuggestionResult> = {}): SchemaSuggestionResult => ({
  schema: structuredClone(proposedSchema), model: 'controlled-schema-model', promptVersion: 'controlled-schema-v1',
  tokenUsage: { inputTokens: 120, outputTokens: 35, totalTokens: 155 }, costUsd: suggestionCost, ...overrides,
});
const extracted = (): ExtractionResult => ({ rawValues: { reference: 'OWNED-127' }, normalizedValues: { reference: 'OWNED-127' },
  evidence: { reference: [{ page: 1, text: 'Reference: OWNED-127', source: 'matched-text' }] }, issues: [],
  model: 'controlled-extraction-model', engine: 'controlled-ai', promptVersion: 'controlled-extraction-v1', tokenUsage: { inputTokens: 100 }, costUsd: extractionCost });
const configured = () => setSchemaSuggestionProvider({ configured: () => true, suggest: async () => result() });

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function entered(promise: Promise<unknown>) {
  let timer!: ReturnType<typeof setTimeout>;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owned worker did not enter its controlled provider')), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function request(account: Account, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({ method, url, payload: payload as any, headers: { origin: config.origin, cookie: account.cookie, ...headers } });
}
async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: 'Owned suggestions ' + label, workspaceName: 'Owned suggestions ' + label,
    email: `schema-suggestions-${randomUUID()}@example.test`, password: 'Owned schema suggestion fixture password',
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } as Account;
  accounts.push(account);
  await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','20'),'{monthlyPages}','1000') where id=$1", [account.workspace.id]);
  return account;
}
async function createParser(account: Account, mode: 'rules' | 'ai' = 'rules') {
  const response = await request(account, 'POST', '/api/parsers', { name: 'Owned field suggestions', useCase: 'custom', mode, schema: originalSchema, locale: 'en-IE' });
  assert.equal(response.statusCode, 201, response.body);
  return { parserId: response.json().parser.id as string, baseSchemaId: response.json().schema.id as string };
}
async function fixture(label: string, mode: 'rules' | 'ai' = 'rules'): Promise<Fixture> {
  const account = await signup(label), parser = await createParser(account, mode);
  const bytes = Buffer.from(`Reference: OWNED-127\nTotal: 24.50\nOwned sample ${label}`);
  const uploaded = await addDocument(actor(account), parser.parserId, bytes, 'owned-sample.txt');
  assert.ok(uploaded.jobId);
  return { account, ...parser, bytes, documentId: uploaded.document.id, jobId: uploaded.jobId };
}
const endpoint = (item: Fixture) => `/api/parsers/${item.parserId}/schema-suggestions`;
const body = (item: Fixture, requestId = randomUUID()) => ({ documentId: item.documentId, baseSchemaId: item.baseSchemaId, requestId });
async function queue(item: Fixture) {
  const response = await request(item.account, 'POST', endpoint(item), body(item));
  assert.equal(response.statusCode, 202, response.body);
  return response.json().suggestion as SchemaSuggestion;
}
async function row(id: string) { return (await adminPool.query('select * from schema_suggestions where id=$1', [id])).rows[0]; }
async function detail(item: Fixture, id: string) {
  const response = await request(item.account, 'GET', `${endpoint(item)}/${id}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json().suggestion as SchemaSuggestion;
}
async function available(id: string) { await adminPool.query('update schema_suggestions set available_at=now() where id=$1', [id]); }
async function auditCount(item: Fixture, action: string, id: string) {
  return (await adminPool.query('select count(*)::int n from audit_events where workspace_id=$1 and action=$2 and entity_id=$3', [item.account.workspace.id, action, id])).rows[0].n as number;
}
async function unchangedData(item: Fixture) {
  const tables = ['documents', 'jobs', 'extraction_runs', 'approvals', 'usage_ledger'];
  const data: Record<string, unknown> = {};
  for (const table of tables) data[table] = (await adminPool.query(`select * from ${table} where workspace_id=$1 order by id`, [item.account.workspace.id])).rows;
  return data;
}
async function usage(item: Fixture) {
  const response = await request(item.account, 'GET', '/api/workspace/usage');
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}

before(async () => {
  const options = adminPool.options, host = options.connectionString ? new URL(options.connectionString).hostname : options.host;
  assert.ok(typeof host === 'string' && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)), 'Schema suggestion fixtures require a local database');
  localDatabaseVerified = true;
  assert.equal(schemaSuggestionsConfigured(), false);
  setStorageForTests(storage);
  app = await buildApp();
});
afterEach(() => { setSchemaSuggestionProvider(undefined); setExtractionProvider(undefined); });
after(async () => {
  setSchemaSuggestionProvider(undefined); setExtractionProvider(undefined); setStorageForTests(undefined);
  try {
    await app?.close();
    if (!localDatabaseVerified) return;
    for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
    for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
    objects.clear();
  } finally { await closeDatabase(); }
});

test('availability is honest and exact request replays do not create duplicate work or hide conflicting input', async () => {
  const item = await fixture('idempotency'), initial = await request(item.account, 'GET', endpoint(item));
  assert.equal(initial.statusCode, 200, initial.body);
  assert.equal(initial.json().available, false);
  assert.deepEqual(initial.json().suggestions, []);
  assert.deepEqual(initial.json().limits, { perDay: 10, pendingPerWorkspace: 3 });
  assert.equal((await request(item.account, 'POST', endpoint(item), body(item))).statusCode, 503);
  assert.equal((await adminPool.query('select id from schema_suggestions where workspace_id=$1', [item.account.workspace.id])).rowCount, 0);
  configured();
  const payload = body(item), before = await unchangedData(item);
  const [first, replay] = await Promise.all([1, 2].map(() => request(item.account, 'POST', endpoint(item), payload)));
  assert.equal(first.statusCode, 202, first.body); assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(first.json().suggestion.id, replay.json().suggestion.id);
  const suggestion = first.json().suggestion as SchemaSuggestion;
  assert.equal(suggestion.state, 'queued'); assert.equal(suggestion.schema, null); assert.equal(suggestion.appliedSchemaId, null);
  assert.equal(suggestion.baseSchemaId, item.baseSchemaId); assert.equal(suggestion.documentId, item.documentId);
  const pinned = await row(suggestion.id);
  assert.equal(pinned.request_id, payload.requestId);
  assert.equal(pinned.document_sha256, createHash('sha256').update(item.bytes).digest('hex'));
  assert.equal(pinned.base_schema_id, item.baseSchemaId); assert.equal(pinned.config.locale, 'en-IE');
  setSchemaSuggestionProvider(undefined);
  const unavailableReplay = await request(item.account, 'POST', endpoint(item), payload);
  assert.equal(unavailableReplay.statusCode, 202, unavailableReplay.body);
  assert.equal(unavailableReplay.json().suggestion.id, suggestion.id);
  configured();
  const secondDoc = await addDocument(actor(item.account), item.parserId, Buffer.from('Owned alternate suggestion document'), 'other.txt');
  const changed = await request(item.account, 'POST', endpoint(item), { ...payload, documentId: secondDoc.document.id });
  assert.equal(changed.statusCode, 409, changed.body);
  assert.equal((await adminPool.query('select id from schema_suggestions where workspace_id=$1', [item.account.workspace.id])).rowCount, 1);
  assert.equal(await auditCount(item, 'schema.suggestion_requested', suggestion.id), 1);
  // The second upload is an explicit separate fixture; the original document and job are untouched by suggestions.
  assert.deepEqual((await adminPool.query('select * from documents where id=$1', [item.documentId])).rows[0], (before.documents as any[])[0]);
});

test('suggestion routes enforce tenant isolation, editor roles, both API scopes and browser origin', async () => {
  const item = await fixture('access'), outsider = await fixture('outsider'), member = await signup('member'); configured();
  const suggestion = await queue(item), payload = body(item);
  for (const method of ['GET', 'POST'] as const) {
    const denied = await request(outsider.account, method, endpoint(item), method === 'POST' ? payload : undefined);
    assert.equal(denied.statusCode, 404, denied.body);
  }
  assert.equal((await request(outsider.account, 'GET', `${endpoint(item)}/${suggestion.id}`)).statusCode, 404);
  assert.equal((await withWorkspace(outsider.account.workspace.id, client => client.query('select id from schema_suggestions where id=$1', [suggestion.id]))).rowCount, 0);
  const foreignDoc = await request(item.account, 'POST', endpoint(item), { ...payload, documentId: outsider.documentId });
  assert.equal(foreignDoc.statusCode, 404, foreignDoc.body);
  const anotherParser = await createParser(item.account);
  assert.equal((await request(item.account, 'POST', `/api/parsers/${anotherParser.parserId}/schema-suggestions`, { ...payload, baseSchemaId: anotherParser.baseSchemaId })).statusCode, 404);
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [item.account.workspace.id, member.user.id]);
  const memberHeaders = { 'x-workspace-id': item.account.workspace.id };
  assert.equal((await request(member, 'GET', endpoint(item), undefined, memberHeaders)).statusCode, 200);
  assert.equal((await request(member, 'POST', endpoint(item), payload, memberHeaders)).statusCode, 403);
  await adminPool.query("update memberships set role='editor' where workspace_id=$1 and user_id=$2", [item.account.workspace.id, member.user.id]);
  assert.equal((await request(member, 'POST', endpoint(item), payload, memberHeaders)).statusCode, 202);
  const crossed = await request(item.account, 'POST', endpoint(item), body(item), { origin: 'https://unrelated.example' });
  assert.equal(crossed.statusCode, 403, crossed.body);
  const scoped = async (scopes: string[]) => {
    const response = await request(item.account, 'POST', '/api/workspace/api-keys', { name: 'Owned suggestion scope', scopes });
    assert.equal(response.statusCode, 200, response.body);
    return { authorization: `Bearer ${response.json().token}`, cookie: '' };
  };
  for (const scopes of [['parsers:write'], ['documents:read']]) {
    assert.equal((await request(item.account, 'POST', endpoint(item), body(item), await scoped(scopes))).statusCode, 403);
  }
  assert.equal((await request(item.account, 'GET', endpoint(item), undefined, await scoped(['parsers:read']))).statusCode, 403);
  assert.equal((await request(item.account, 'GET', endpoint(item), undefined, await scoped(['parsers:read', 'documents:read']))).statusCode, 200);
  assert.equal((await request(item.account, 'POST', endpoint(item), body(item), await scoped(['parsers:write', 'documents:read']))).statusCode, 202);
});

test('pending and rolling daily limits serialize concurrent requests without consuming extra page credits', async () => {
  const item = await fixture('limits'); configured(); const before = await unchangedData(item);
  const replies = await Promise.all(Array.from({ length: 4 }, () => request(item.account, 'POST', endpoint(item), body(item))));
  assert.deepEqual(replies.map(reply => reply.statusCode).sort(), [202, 202, 202, 429]);
  const accepted = replies.filter(reply => reply.statusCode === 202).map(reply => reply.json().suggestion as SchemaSuggestion);
  for (const suggestion of accepted) assert.equal(await processOneSchemaSuggestion(suggestion.id), true);
  for (let count = 3; count < schemaSuggestionLimits.perDay; count++) {
    const suggestion = await queue(item); assert.equal(await processOneSchemaSuggestion(suggestion.id), true);
  }
  const limited = await request(item.account, 'POST', endpoint(item), body(item));
  assert.equal(limited.statusCode, 429, limited.body);
  assert.equal((await adminPool.query('select id from schema_suggestions where workspace_id=$1', [item.account.workspace.id])).rowCount, 10);
  assert.deepEqual(await unchangedData(item), before);
  const removed = await request(item.account, 'DELETE', `/api/documents/${item.documentId}`);
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal((await adminPool.query('select id from schema_suggestions where workspace_id=$1', [item.account.workspace.id])).rowCount, 0);
  const replacement = await addDocument(actor(item.account), item.parserId, Buffer.from('Owned new source after the daily cap'), 'replacement.txt');
  const replacementItem = { ...item, documentId: replacement.document.id };
  assert.equal((await request(item.account, 'POST', endpoint(item), body(replacementItem))).statusCode, 429, 'Deleting suggestions must not refund the daily provider budget');
  // Age only the owned request audits that define the rolling quota window.
  await adminPool.query("update audit_events set created_at=now()-interval '25 hours' where workspace_id=$1 and action='schema.suggestion_requested'", [item.account.workspace.id]);
  assert.equal((await request(item.account, 'POST', endpoint(item), body(replacementItem))).statusCode, 202);
});

test('ready suggestions require manual application and preserve original runs, approvals, schemas and page usage', async () => {
  const item = await fixture('apply', 'ai');
  setExtractionProvider({ configured: () => true, extract: async () => extracted() });
  assert.equal(await processOneCoreJob(item.jobId), true);
  const doc = await request(item.account, 'GET', `/api/documents/${item.documentId}`), run = doc.json().runs[0];
  const approved = await request(item.account, 'POST', `/api/runs/${run.id}/approve`, { expectedRevision: run.effectiveRevision });
  assert.equal(approved.statusCode, 200, approved.body);
  const before = await unchangedData(item), base = (await adminPool.query('select * from schema_versions where id=$1', [item.baseSchemaId])).rows[0];
  let calls = 0;
  setSchemaSuggestionProvider({ configured: () => true, suggest: async input => {
    calls++; assert.deepEqual(input.bytes, item.bytes); assert.equal(input.mimeType, 'text/plain');
    assert.equal(input.locale, 'en-IE'); assert.match(input.pages[0].text, /OWNED-127/); assert.equal(input.signal?.aborted, false);
    return result();
  } });
  const queued = await queue(item);
  await request(item.account, 'PATCH', `/api/parsers/${item.parserId}`, { locale: 'de-DE' });
  assert.equal(await processOneSchemaSuggestion(queued.id), true); assert.equal(calls, 1);
  const ready = await detail(item, queued.id);
  assert.equal(ready.state, 'ready'); assert.deepEqual(ready.schema, proposedSchema); assert.equal(ready.appliedSchemaId, null);
  assert.equal(ready.baseSchemaId, item.baseSchemaId); assert.equal(ready.model, 'controlled-schema-model'); assert.equal(ready.costUsd, suggestionCost);
  assert.deepEqual(await unchangedData(item), before);
  assert.equal((await adminPool.query('select active_schema_id from parsers where id=$1', [item.parserId])).rows[0].active_schema_id, item.baseSchemaId);
  const totals = (await usage(item)).usage;
  assert.equal(totals.extractionCostUsd, extractionCost); assert.equal(totals.schemaSuggestionCostUsd, suggestionCost);
  assert.equal(totals.schemaSuggestions, 1); assert.ok(Math.abs(totals.costUsd - extractionCost - suggestionCost) < 1e-9);
  const edited: ParserSchema = { fields: proposedSchema.fields.map(field => ({ ...field, label: field.key === 'total' ? 'Reviewed total' : field.label })) };
  const saved = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { ...edited, baseSchemaId: item.baseSchemaId, suggestionId: queued.id });
  assert.equal(saved.statusCode, 200, saved.body); assert.notEqual(saved.json().schema.id, item.baseSchemaId);
  assert.equal(saved.json().schema.version, base.version + 1);
  assert.deepEqual(saved.json().schema.fields, edited.fields);
  assert.equal((await detail(item, queued.id)).appliedSchemaId, saved.json().schema.id);
  assert.deepEqual((await adminPool.query('select * from schema_versions where id=$1', [item.baseSchemaId])).rows[0], base);
  assert.deepEqual(await unchangedData(item), before);
  const replay = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { ...edited, baseSchemaId: saved.json().schema.id, suggestionId: queued.id });
  assert.equal(replay.statusCode, 409, replay.body);
  assert.equal((await adminPool.query('select id from schema_versions where parser_id=$1', [item.parserId])).rowCount, 2);
  assert.equal(await auditCount(item, 'schema.suggestion_ready', queued.id), 1);
});

test('stale bases and unready suggestions cannot replace a newer schema while manual legacy saves remain compatible', async () => {
  const item = await fixture('stale'); configured(); const queued = await queue(item);
  const pending = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { ...proposedSchema, baseSchemaId: item.baseSchemaId, suggestionId: queued.id });
  assert.equal(pending.statusCode, 409, pending.body);
  const manual = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { fields: [{ key: 'manual', label: 'Manual', type: 'string' }] });
  assert.equal(manual.statusCode, 200, manual.body);
  assert.equal(await processOneSchemaSuggestion(queued.id), true);
  assert.equal((await detail(item, queued.id)).baseSchemaId, item.baseSchemaId);
  for (const payload of [{ ...proposedSchema, baseSchemaId: item.baseSchemaId }, { ...proposedSchema, baseSchemaId: item.baseSchemaId, suggestionId: queued.id }]) {
    const response = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, payload);
    assert.equal(response.statusCode, 409, response.body);
  }
  assert.equal((await request(item.account, 'POST', endpoint(item), body(item))).statusCode, 409);
  assert.equal((await adminPool.query('select active_schema_id from parsers where id=$1', [item.parserId])).rows[0].active_schema_id, manual.json().schema.id);
  assert.equal((await detail(item, queued.id)).appliedSchemaId, null);
  assert.equal((await adminPool.query('select id from schema_versions where parser_id=$1', [item.parserId])).rowCount, 2);
});

test('applying an older ready draft does not move its provider cost into the current month', async () => {
  const item = await fixture('cost-date'); configured(); const queued = await queue(item);
  assert.equal(await processOneSchemaSuggestion(queued.id), true);
  // Simulate an owned draft that completed last month, awaiting this month's review.
  await adminPool.query("update schema_suggestions set created_at=date_trunc('month',now())-interval '1 day',completed_at=date_trunc('month',now())-interval '1 day',updated_at=date_trunc('month',now())-interval '1 day' where id=$1", [queued.id]);
  const completedAt = (await row(queued.id)).completed_at;
  const before = (await usage(item)).usage;
  assert.equal(before.schemaSuggestionCostUsd, 0); assert.equal(before.schemaSuggestions, 0); assert.equal(before.costUsd, 0);
  const applied = await request(item.account, 'POST', `/api/parsers/${item.parserId}/schema`, { ...proposedSchema, baseSchemaId: item.baseSchemaId, suggestionId: queued.id });
  assert.equal(applied.statusCode, 200, applied.body);
  const saved = await row(queued.id);
  assert.deepEqual(saved.completed_at, completedAt);
  assert.ok(new Date(saved.updated_at).getTime() > new Date(saved.completed_at).getTime());
  const after = (await usage(item)).usage;
  assert.equal(after.schemaSuggestionCostUsd, 0); assert.equal(after.schemaSuggestions, 0); assert.equal(after.costUsd, 0);
});

test('unknown failures retry safely, typed permanent errors fail once and repeated failures stop at three attempts', async () => {
  const item = await fixture('errors'); configured(); const retry = await queue(item), permanent = await queue(item), exhausted = await queue(item);
  const before = await unchangedData(item); let calls = 0;
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => {
    if (++calls === 1) throw Object.assign(new Error('PRIVATE unknown provider response'), { permanent: true });
    return result();
  } });
  assert.equal(await processOneSchemaSuggestion(retry.id), true);
  let saved = await detail(item, retry.id);
  assert.equal(saved.state, 'queued'); assert.equal(saved.attempts, 1); assert.equal(saved.schema, null); assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
  assert.equal((await row(retry.id)).lease_owner, null); assert.equal((await row(retry.id)).lease_until, null);
  await available(retry.id); assert.equal(await processOneSchemaSuggestion(retry.id), true);
  assert.equal((await detail(item, retry.id)).state, 'ready'); assert.equal(calls, 2);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { throw new SchemaSuggestionProviderError('The owned sample cannot be suggested safely', true); } });
  assert.equal(await processOneSchemaSuggestion(permanent.id), true); assert.equal(await processOneSchemaSuggestion(permanent.id), false);
  saved = await detail(item, permanent.id); assert.equal(saved.state, 'failed'); assert.equal(saved.attempts, 1); assert.equal(saved.schema, null);
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { throw new Error('PRIVATE repeated provider outage'); } });
  for (let attempt = 0; attempt < 3; attempt++) { await available(exhausted.id); assert.equal(await processOneSchemaSuggestion(exhausted.id), true); }
  saved = await detail(item, exhausted.id); assert.equal(saved.state, 'failed'); assert.equal(saved.attempts, 3); assert.equal(saved.schema, null); assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
  assert.equal(await processOneSchemaSuggestion(exhausted.id), false);
  assert.deepEqual(await unchangedData(item), before);
  assert.equal((await usage(item)).usage.schemaSuggestionCostUsd, suggestionCost);
});

test('a deadline aborts the provider and a late result cannot replace its durable retry', async () => {
  const item = await fixture('deadline'); configured(); const queued = await queue(item), late = deferred<SchemaSuggestionResult>();
  const stopped = new AbortController(); stopped.abort();
  assert.equal(await processOneSchemaSuggestion(queued.id, { signal: stopped.signal }), false);
  assert.equal((await row(queued.id)).attempts, 0);
  let signal: AbortSignal | undefined;
  setSchemaSuggestionProvider({ configured: () => true, suggest: async input => { signal = input.signal; return late.promise; } });
  assert.equal(await processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 250 }), true);
  assert.equal(signal?.aborted, true);
  const beforeLate = await row(queued.id);
  assert.equal(beforeLate.state, 'queued'); assert.equal(beforeLate.attempts, 1); assert.equal(beforeLate.proposed_schema, null);
  late.resolve(result({ model: 'late-deadline-model' })); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await row(queued.id), beforeLate);
  configured(); await available(queued.id); assert.equal(await processOneSchemaSuggestion(queued.id), true);
  assert.equal((await detail(item, queued.id)).model, 'controlled-schema-model');
  assert.equal(await auditCount(item, 'schema.suggestion_ready', queued.id), 1);
});

test('a storage read beyond the suggestion deadline leaves a retry and cannot start a late provider call', async context => {
  const item = await fixture('storage-deadline'); configured(); const queued = await queue(item);
  const storageKey = (await adminPool.query('select storage_key from documents where id=$1', [item.documentId])).rows[0].storage_key;
  const started = deferred<void>(), release = deferred<void>(), readDone = deferred<void>();
  const originalRead = storage.read;
  let calls = 0, readEntered = false;
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { calls++; return result(); } });
  const read = context.mock.method(storage, 'read', async function (key: string, maxBytes?: number) {
    if (key !== storageKey) return originalRead.call(storage, key, maxBytes);
    readEntered = true; started.resolve();
    await release.promise;
    try { return await originalRead.call(storage, key, maxBytes); }
    finally { readDone.resolve(); }
  });
  const before = await unchangedData(item);
  const processing = processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 250 });
  try {
    await entered(started.promise);
    assert.equal(await processing, true);
    const timedOut = await row(queued.id);
    assert.equal(timedOut.state, 'queued'); assert.equal(timedOut.attempts, 1); assert.equal(timedOut.proposed_schema, null);
    assert.equal(timedOut.lease_owner, null); assert.equal(timedOut.lease_until, null); assert.equal(calls, 0);
    release.resolve(); await entered(readDone.promise); await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0); assert.deepEqual(await row(queued.id), timedOut);
    assert.deepEqual(await unchangedData(item), before);
  } finally {
    try { release.resolve(); await processing; if (readEntered) await entered(readDone.promise); }
    finally { read.mock.restore(); }
  }
});

test('a changed private original fails its pinned checksum before any provider call', async () => {
  const item = await fixture('original-integrity'); configured(); const queued = await queue(item);
  const original = (await adminPool.query('select storage_key from documents where id=$1', [item.documentId])).rows[0].storage_key as string;
  const before = await unchangedData(item); let calls = 0;
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { calls++; return result(); } });
  objects.set(original, Buffer.from('PRIVATE unexpected replacement bytes'));
  try { assert.equal(await processOneSchemaSuggestion(queued.id), true); }
  finally { objects.set(original, Buffer.from(item.bytes)); }
  const saved = await detail(item, queued.id);
  assert.equal(calls, 0); assert.equal(saved.state, 'failed'); assert.equal(saved.attempts, 1); assert.equal(saved.schema, null);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE')); assert.equal(saved.costUsd, 0);
  assert.deepEqual(await unchangedData(item), before);
  assert.equal((await usage(item)).usage.schemaSuggestionCostUsd, 0);
});

test('a reclaimed lease fences an older overlapping suggestion worker and records only the current result', async () => {
  const item = await fixture('fence'); configured(); const queued = await queue(item);
  const firstEntered = deferred<void>(), secondEntered = deferred<void>(), oldOutput = deferred<SchemaSuggestionResult>(), currentOutput = deferred<SchemaSuggestionResult>();
  let calls = 0;
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { if (++calls === 1) { firstEntered.resolve(); return oldOutput.promise; } secondEntered.resolve(); return currentOutput.promise; } });
  const old = processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 10000 });
  let current: Promise<boolean> | undefined;
  try {
    await entered(firstEntered.promise); const oldLease = (await row(queued.id)).lease_owner;
    await adminPool.query("update schema_suggestions set lease_until=now()-interval '1 second' where id=$1", [queued.id]);
    current = processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 10000 }); await entered(secondEntered.promise);
    assert.notEqual((await row(queued.id)).lease_owner, oldLease);
    oldOutput.resolve(result({ model: 'expired-owner-model' })); await old;
    assert.equal((await row(queued.id)).state, 'processing'); assert.equal((await row(queued.id)).proposed_schema, null);
    currentOutput.resolve(result({ model: 'current-owner-model' })); await current;
  } finally { oldOutput.resolve(result()); currentOutput.resolve(result()); await Promise.all([old, current]); }
  const saved = await detail(item, queued.id);
  assert.equal(saved.state, 'ready'); assert.equal(saved.model, 'current-owner-model'); assert.equal(saved.attempts, 2);
  assert.equal(await auditCount(item, 'schema.suggestion_ready', queued.id), 1);
  assert.equal((await usage(item)).usage.schemaSuggestionCostUsd, suggestionCost);
});

test('suggestion and extraction claims share workspace concurrency in both directions', async () => {
  const item = await fixture('concurrency', 'ai'); configured(); const queued = await queue(item);
  await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxConcurrent}','1') where id=$1", [item.account.workspace.id]);
  const extractEntered = deferred<void>(), extractOutput = deferred<ExtractionResult>();
  setExtractionProvider({ configured: () => true, extract: async () => { extractEntered.resolve(); return extractOutput.promise; } });
  const extraction = processOneCoreJob(item.jobId, { providerTimeoutMs: 10000 });
  try {
    await entered(extractEntered.promise);
    assert.equal(await processOneSchemaSuggestion(queued.id), false); assert.equal((await row(queued.id)).attempts, 0);
  } finally { extractOutput.resolve(extracted()); await extraction; }
  const suggestEntered = deferred<void>(), suggestOutput = deferred<SchemaSuggestionResult>();
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { suggestEntered.resolve(); return suggestOutput.promise; } });
  const suggestion = processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 10000 });
  try {
    await entered(suggestEntered.promise);
    const second = await addDocument(actor(item.account), item.parserId, Buffer.from('Reference: OWNED-SECOND'), 'second.txt');
    assert.ok(second.jobId); assert.equal(await processOneCoreJob(second.jobId), false);
    assert.equal((await adminPool.query('select state from jobs where id=$1', [second.jobId])).rows[0].state, 'queued');
  } finally { suggestOutput.resolve(result()); await suggestion; }
  assert.equal((await detail(item, queued.id)).state, 'ready');
});

test('deleting a document cascades pending suggestion work and prevents a late worker from restoring it', async () => {
  const item = await fixture('deletion'); configured(); const queued = await queue(item), waiting = deferred<SchemaSuggestionResult>(), started = deferred<void>();
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { started.resolve(); return waiting.promise; } });
  const processing = processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 10000 });
  try {
    await entered(started.promise);
    const removed = await request(item.account, 'DELETE', `/api/documents/${item.documentId}`);
    assert.equal(removed.statusCode, 200, removed.body);
    assert.equal(await row(queued.id), undefined);
  } finally { waiting.resolve(result()); await processing; }
  assert.equal(await row(queued.id), undefined);
  assert.equal((await request(item.account, 'GET', `${endpoint(item)}/${queued.id}`)).statusCode, 404);
  assert.equal(await auditCount(item, 'schema.suggestion_ready', queued.id), 0);
  assert.equal((await adminPool.query('select id from documents where id=$1', [item.documentId])).rowCount, 0);
  assert.equal((await usage(item)).usage.schemaSuggestionCostUsd, 0);
});

test('retention preserves sources with queued or processing suggestions and resumes after the draft is ready', async () => {
  const item = await fixture('retention'); configured();
  assert.equal(await processOneCoreJob(item.jobId), true);
  await adminPool.query("update workspaces set settings=jsonb_set(settings,'{retentionDays}','1') where id=$1", [item.account.workspace.id]);
  await adminPool.query("update documents set created_at=now()-interval '2 days' where id=$1", [item.documentId]);
  const queued = await queue(item);
  assert.deepEqual(await enforceRetention(item.account.workspace.id), { removed: 0 });
  assert.equal((await row(queued.id)).state, 'queued');
  const started = deferred<void>(), output = deferred<SchemaSuggestionResult>();
  setSchemaSuggestionProvider({ configured: () => true, suggest: async () => { started.resolve(); return output.promise; } });
  const processing = processOneSchemaSuggestion(queued.id, { providerTimeoutMs: 10000 });
  try {
    await entered(started.promise);
    assert.equal((await row(queued.id)).state, 'processing');
    assert.deepEqual(await enforceRetention(item.account.workspace.id), { removed: 0 });
    assert.equal((await adminPool.query('select id from documents where id=$1', [item.documentId])).rowCount, 1);
  } finally { output.resolve(result()); await processing; }
  assert.equal((await row(queued.id)).state, 'ready');
  assert.deepEqual(await enforceRetention(item.account.workspace.id), { removed: 1 });
  assert.equal((await adminPool.query('select id from documents where id=$1', [item.documentId])).rowCount, 0);
  assert.equal(await row(queued.id), undefined);
  assert.equal([...objects.keys()].some(key => key.startsWith(`${item.account.workspace.id}/`)), false);
});
