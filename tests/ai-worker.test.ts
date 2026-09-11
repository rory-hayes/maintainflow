import test, { before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { extractRules } from '../server/core/extraction.js';
import { aiConfigured, processOneCoreJob, setExtractionProvider } from '../server/core/worker.js';
import type { Actor, ExtractionResult, ParserSchema, ProviderInput } from '../shared/types.js';

let app: FastifyInstance, actor: Actor, headers: Record<string, string>;
const schema: ParserSchema = { fields: [
  { key: 'merchant', label: 'Merchant', type: 'string', required: true },
  { key: 'total', label: 'Total', type: 'currency', required: true },
  { key: 'currency', label: 'Currency', type: 'string', required: true },
] };
const sample = Buffer.from('Merchant: Owned AI fixture\nTotal: 24.50\nCurrency: EUR');
const model = 'controlled-model-2026-09-07';
const promptVersion = 'controlled-extraction-v2';
const tokenUsage = { input_tokens: 120, output_tokens: 32, total_tokens: 152 };
function result(input: ProviderInput): ExtractionResult {
  const extracted = extractRules(input.pages, input.schema, input.locale);
  return { ...extracted, engine: 'controlled-ai', model, promptVersion, tokenUsage, costUsd: 0.00123,
    evidence: { merchant: [{ page: 1, text: 'Owned AI fixture', source: 'matched-text' }] } };
}
async function request(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) {
  return app.inject({ method, url, headers, payload: payload as any });
}
async function intake(label: string, mode: 'ai' | 'rules' = 'ai') {
  const created = await request('POST', '/api/parsers', { name: `Owned AI ${label}`, useCase: 'custom', mode,
    schema, instructions: 'Original job instructions', locale: 'en-IE' });
  assert.equal(created.statusCode, 201, created.body);
  const parser = created.json().parser;
  const uploaded = await addDocument(actor, parser.id, sample, `owned-${label}.txt`);
  assert.ok(uploaded.jobId);
  return { ...uploaded, jobId: uploaded.jobId!, parser, schemaId: created.json().schema.id };
}
async function detail(documentId: string) {
  const response = await request('GET', `/api/documents/${documentId}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function makeAvailable(jobId: string) {
  await adminPool.query('update jobs set available_at=now() where id=$1', [jobId]);
}
async function lease(jobId: string) {
  return (await adminPool.query('select lease_owner,lease_until from jobs where id=$1', [jobId])).rows[0];
}
async function usageCount(documentId: string) {
  return (await adminPool.query('select count(*)::int n from usage_ledger where document_id=$1', [documentId])).rows[0].n;
}
before(async () => {
  // Entrypoint imports are inert, even when the local application has an approved key.
  assert.equal(aiConfigured(), false);
  await import('../server/worker.js');
  assert.equal(aiConfigured(), false);
  app = await buildApp();
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: 'Owned AI worker fixture', email: `ai-worker-${randomUUID()}@example.test`,
    password: 'owned AI worker fixture password', workspaceName: 'Owned AI worker fixture',
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = response.json();
  actor = { userId: account.user.id, workspaceId: account.workspace.id, role: 'owner', authType: 'session' };
  // Each worker case needs an independent parser; this fixture explicitly has capacity for all cases.
  await adminPool.query("update workspaces set plan=jsonb_set(plan,'{maxParsers}','25'::jsonb) where id=$1", [actor.workspaceId]);
  headers = { origin: config.origin, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
});
afterEach(() => { setExtractionProvider(undefined); });
after(async () => {
  setExtractionProvider(undefined);
  await app?.close();
  if (actor) {
    await adminPool.query('delete from workspaces where id=$1', [actor.workspaceId]);
    await fs.rm(path.join(config.storageDir, actor.workspaceId), { recursive: true, force: true });
    await adminPool.query('delete from users where id=$1', [actor.userId]);
  }
  await closeDatabase();
});

test('imported app remains unconfigured and AI jobs fail honestly without calling any provider', async () => {
  assert.equal(aiConfigured(), false);
  const presets = await request('GET', '/api/presets');
  assert.equal(presets.json().providers.ai.configured, false);
  const item = await intake('unconfigured');
  assert.equal(await processOneCoreJob(item.jobId), true);
  const body = await detail(item.document.id);
  assert.equal(body.document.status, 'failed');
  assert.equal(body.jobs[0].attempts, 1);
  assert.match(body.document.error, /AI extraction is not configured/);
  assert.equal(body.runs.length, 0);
});

test('AI processing persists actual provenance and pinned schema while reprocessing preserves the earlier approval and original', async () => {
  const item = await intake('provenance');
  const updatedSchema: ParserSchema = { fields: [...schema.fields, { key: 'note', label: 'Note', type: 'string' }] };
  const updated = await request('POST', `/api/parsers/${item.parser.id}/schema`, updatedSchema);
  assert.equal(updated.statusCode, 200, updated.body);
  const patch = await request('PATCH', `/api/parsers/${item.parser.id}`, { instructions: 'New instructions', locale: 'en-US' });
  assert.equal(patch.statusCode, 200, patch.body);
  assert.equal(patch.json().parser.mode, 'ai', 'omitted parser mode must be preserved');
  for (const change of [{ name: 'Owned AI renamed' }, { archived: true }, { archived: false }]) {
    const response = await request('PATCH', `/api/parsers/${item.parser.id}`, change);
    assert.equal(response.statusCode, 200, response.body);
    const saved = response.json().parser;
    assert.deepEqual({ mode: saved.mode, instructions: saved.instructions, locale: saved.locale, timezone: saved.timezone },
      { mode: 'ai', instructions: 'New instructions', locale: 'en-US', timezone: 'Europe/Dublin' });
  }
  let calls = 0;
  setExtractionProvider({ configured: () => true, extract: async input => {
    calls++;
    assert.deepEqual(input.bytes, sample);
    assert.equal(input.mimeType, 'text/plain');
    assert.deepEqual(input.schema, schema);
    assert.equal(input.instructions, 'Original job instructions');
    assert.equal(input.locale, 'en-IE');
    assert.equal(input.signal?.aborted, false);
    return result(input);
  } });
  assert.equal((await request('GET', '/api/presets')).json().providers.ai.configured, true);
  assert.equal(await processOneCoreJob(item.jobId), true);
  assert.equal(calls, 1);
  const original = await request('GET', `/api/documents/${item.document.id}/original`);
  assert.equal(original.statusCode, 200);
  assert.deepEqual(original.rawPayload, sample);
  const first = (await detail(item.document.id)).runs[0];
  assert.equal(first.schemaVersionId, item.schemaId);
  assert.equal(first.engine, 'controlled-ai');
  assert.equal(first.model, model);
  assert.equal(first.promptVersion, promptVersion);
  assert.deepEqual(first.tokenUsage, tokenUsage);
  assert.equal(Number(first.costUsd), 0.00123);
  assert.equal(first.documentSha256, createHash('sha256').update(sample).digest('hex'));
  assert.equal(first.rawValues.total, '24.50');
  assert.equal(first.normalizedValues.total, 24.5);
  assert.deepEqual(first.evidence.merchant, [{ page: 1, text: 'Owned AI fixture', source: 'matched-text' }]);
  const approvalResponse = await request('POST', `/api/runs/${first.id}/approve`, { expectedRevision: first.effectiveRevision });
  assert.equal(approvalResponse.statusCode, 200, approvalResponse.body);
  const approvalBefore = (await adminPool.query('select * from approvals where run_id=$1', [first.id])).rows[0];
  const firstBefore = (await adminPool.query('select * from extraction_runs where id=$1', [first.id])).rows[0];
  const reprocess = await request('POST', `/api/documents/${item.document.id}/reprocess`, {});
  assert.equal(reprocess.statusCode, 200, reprocess.body);
  setExtractionProvider({ configured: () => true, extract: async input => {
    assert.deepEqual(input.schema, updatedSchema);
    assert.equal(input.instructions, 'New instructions');
    assert.equal(input.locale, 'en-US');
    return { ...result(input), model: 'controlled-later-model', promptVersion: 'controlled-later-prompt' };
  } });
  await processOneCoreJob(reprocess.json().job.id);
  const body = await detail(item.document.id);
  assert.equal(body.document.status, 'needs_review');
  assert.equal(body.runs.length, 2);
  assert.equal(body.runs[0].schemaVersionId, updated.json().schema.id);
  assert.equal(body.runs[0].promptVersion, 'controlled-later-prompt');
  assert.deepEqual((await adminPool.query('select * from extraction_runs where id=$1', [first.id])).rows[0], firstBefore);
  assert.deepEqual((await adminPool.query('select * from approvals where run_id=$1', [first.id])).rows[0], approvalBefore);
  assert.deepEqual((await request('GET', `/api/documents/${item.document.id}/original`)).rawPayload, sample);
});

test('permanent provider rejection fails once without a successful run or extra page reservation', async () => {
  const item = await intake('permanent');
  let calls = 0;
  setExtractionProvider({ configured: () => true, extract: async () => {
    calls++; throw Object.assign(new Error('Controlled unsupported provider input'), { permanent: true });
  } });
  await processOneCoreJob(item.jobId);
  assert.equal(await processOneCoreJob(item.jobId), false);
  const body = await detail(item.document.id);
  assert.equal(calls, 1); assert.equal(body.jobs[0].attempts, 1);
  assert.equal(body.jobs[0].state, 'failed'); assert.equal(body.document.status, 'failed');
  assert.equal(body.runs.length, 0); assert.equal(await usageCount(item.document.id), 1);
});

test('transient provider failure retries the same job and saves only its eventual successful result', async () => {
  const item = await intake('retry');
  let calls = 0;
  setExtractionProvider({ configured: () => true, extract: async input => {
    if (++calls === 1) throw new Error('Controlled temporary provider outage');
    return result(input);
  } });
  await processOneCoreJob(item.jobId);
  let body = await detail(item.document.id);
  assert.equal(body.document.status, 'queued'); assert.equal(body.runs.length, 0);
  assert.equal(body.jobs[0].attempts, 1); assert.deepEqual(await lease(item.jobId), { lease_owner: null, lease_until: null });
  await makeAvailable(item.jobId); await processOneCoreJob(item.jobId);
  body = await detail(item.document.id);
  assert.equal(calls, 2); assert.equal(body.jobs[0].attempts, 2);
  assert.equal(body.jobs[0].state, 'completed'); assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].promptVersion, promptVersion); assert.equal(await usageCount(item.document.id), 1);
});

test('deadline aborts the controlled provider and ignores a late response after durable retry is scheduled', async () => {
  const item = await intake('deadline');
  let signal: AbortSignal | undefined, finish!: (value: ExtractionResult) => void, captured!: ProviderInput;
  setExtractionProvider({ configured: () => true, extract: async input => {
    captured = input; signal = input.signal;
    return new Promise<ExtractionResult>(resolve => { finish = resolve; });
  } });
  await processOneCoreJob(item.jobId, { providerTimeoutMs: 20 });
  assert.equal(signal?.aborted, true);
  let body = await detail(item.document.id);
  assert.equal(body.jobs[0].state, 'queued'); assert.equal(body.jobs[0].attempts, 1);
  assert.match(body.document.error, /provider exceeded.*timeout/);
  assert.equal(body.runs.length, 0);
  finish(result(captured)); await new Promise(resolve => setImmediate(resolve));
  body = await detail(item.document.id);
  assert.equal(body.runs.length, 0); assert.equal(body.document.status, 'queued');
});

test('worker cancellation aborts extraction, leaves a retryable job, and a pre-aborted worker claims nothing', async () => {
  const item = await intake('shutdown');
  const controller = new AbortController();
  let entered!: () => void, signal: AbortSignal | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  setExtractionProvider({ configured: () => true, extract: async input => {
    signal = input.signal; entered();
    return new Promise<ExtractionResult>((_resolve, reject) => input.signal?.addEventListener('abort', () => reject(new Error('Controlled provider aborted')), { once: true }));
  } });
  const processing = processOneCoreJob(item.jobId, { signal: controller.signal });
  await started; controller.abort(); await processing;
  assert.equal(signal?.aborted, true);
  const body = await detail(item.document.id);
  assert.equal(body.jobs[0].state, 'queued'); assert.deepEqual(await lease(item.jobId), { lease_owner: null, lease_until: null });
  assert.equal(body.runs.length, 0);
  assert.match(body.document.error, /worker shutdown/);
  await makeAvailable(item.jobId);
  assert.equal(await processOneCoreJob(item.jobId, { signal: controller.signal }), false);
  assert.equal((await detail(item.document.id)).jobs[0].attempts, 1);
});

test('repeated transient failures stop at the durable maximum with no invented output', async () => {
  const item = await intake('exhausted');
  setExtractionProvider({ configured: () => true, extract: async () => { throw new Error('Controlled recurring provider outage'); } });
  for (let attempt = 0; attempt < 3; attempt++) { await makeAvailable(item.jobId); await processOneCoreJob(item.jobId); }
  const body = await detail(item.document.id);
  assert.equal(body.jobs[0].attempts, body.jobs[0].maxAttempts);
  assert.equal(body.jobs[0].state, 'failed'); assert.equal(body.document.status, 'failed');
  assert.equal(body.runs.length, 0); assert.equal(await usageCount(item.document.id), 1);
  assert.equal(await processOneCoreJob(item.jobId), false);
});

test('rules processing keeps its existing prompt provenance and never consults a configured AI provider', async () => {
  const item = await intake('rules', 'rules');
  let called = false;
  setExtractionProvider({ configured: () => true, extract: async () => { called = true; throw new Error('Rules must not call AI'); } });
  await processOneCoreJob(item.jobId);
  const body = await detail(item.document.id);
  assert.equal(called, false); assert.equal(body.runs[0].engine, 'text-anchors');
  assert.equal(body.runs[0].model, 'deterministic-v2'); assert.equal(body.runs[0].promptVersion, 'folio-extraction-v1');
});


test('AI image processing receives the preserved original and retains model-visual evidence for review', async () => {
  const created = await request('POST', '/api/parsers', { name: 'Owned AI image', useCase: 'custom', mode: 'ai', schema });
  assert.equal(created.statusCode, 201, created.body);
  const bytes = await fs.readFile('fixtures/source-formats/receipt-image.jpg');
  const item = await addDocument(actor, created.json().parser.id, bytes, 'owned-ai-image.jpg');
  setExtractionProvider({ configured: () => true, extract: async input => {
    assert.deepEqual(input.bytes, bytes);
    assert.equal(input.mimeType, 'image/jpeg');
    assert.ok(input.pages.every(page => page.text.trim() === ''));
    return { engine: 'controlled-ai', model, promptVersion, tokenUsage, costUsd: 0.00123,
      rawValues: { merchant: 'Controlled visual transcription', total: '24.50', currency: 'EUR' },
      normalizedValues: { merchant: 'Controlled visual transcription', total: 24.5, currency: 'EUR' },
      evidence: { merchant: [{ page: 1, text: 'Controlled visual transcription', source: 'model-visual' }] }, issues: [] };
  } });
  await processOneCoreJob(item.jobId!);
  const body = await detail(item.document.id);
  assert.equal(body.document.status, 'needs_review');
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].evidence.merchant[0].source, 'model-visual');
  assert.equal(body.runs[0].promptVersion, promptVersion);
  assert.deepEqual((await request('GET', `/api/documents/${item.document.id}/original`)).rawPayload, bytes);
});

test('a reclaimed lease fences an older overlapping invocation in the same warm process',async()=>{
  const item=await intake('lease-fence');
  const pending:Array<{input:ProviderInput;finish:(value:ExtractionResult)=>void}>=[];
  const entered:Array<()=>void>=[];
  const firstEntered=new Promise<void>(resolve=>entered.push(resolve));
  const secondEntered=new Promise<void>(resolve=>entered.push(resolve));
  setExtractionProvider({configured:()=>true,extract:input=>new Promise<ExtractionResult>(finish=>{pending.push({input,finish});entered[pending.length-1]!();})});
  const old=processOneCoreJob(item.jobId);await firstEntered;
  const oldLease=await lease(item.jobId);
  await adminPool.query("update jobs set lease_until=now()-interval '1 second' where id=$1",[item.jobId]);
  const current=processOneCoreJob(item.jobId);await secondEntered;
  assert.notEqual((await lease(item.jobId)).lease_owner,oldLease.lease_owner);
  pending[0]!.finish({...result(pending[0]!.input),model:'expired-owner-output'});await old;
  let body=await detail(item.document.id);
  assert.equal(body.jobs[0].state,'processing');assert.equal(body.runs.length,0);
  pending[1]!.finish({...result(pending[1]!.input),model:'current-owner-output'});await current;
  body=await detail(item.document.id);
  assert.equal(body.jobs[0].state,'completed');assert.equal(body.runs.length,1);
  assert.equal(body.runs[0].model,'current-owner-output');assert.equal(await usageCount(item.document.id),1);
});

test('authenticated hosted wake recovers a crashed worker from its expired durable lease',async()=>{
  const {default:Fastify}=await import('fastify');
  const {createHostedWorker,registerHostedWorker,workerRoute}=await import('../server/hosted-worker.js');
  const item=await intake('hosted-recovery','rules');
  await adminPool.query("update jobs set state='processing',attempts=1,lease_owner=$2,lease_until=now()-interval '1 second' where id=$1",[item.jobId,randomUUID()]);
  await adminPool.query("update documents set status='processing' where id=$1",[item.document.id]);
  // The fresh scheduler has no knowledge of the crashed invocation or its token.
  const wake=createHostedWorker({enqueue:async()=>{},core:budget=>processOneCoreJob(item.jobId,{signal:budget.signal}),provider:async()=>false,delivery:async()=>false,deletion:async()=>false,maintenance:async()=>{}});
  const endpoint=Fastify();const attached:Promise<unknown>[]=[];
  const secret='controlled-hosted-recovery-secret-0123456789';
  registerHostedWorker(endpoint,{secret:()=>secret,waitUntil:work=>attached.push(work),wake});
  try{
    const response=await endpoint.inject({method:'POST',url:workerRoute,headers:{authorization:`Bearer ${secret}`},payload:{}});
    assert.equal(response.statusCode,202);await Promise.all(attached);
    const body=await detail(item.document.id);
    assert.equal(body.jobs[0].attempts,2);assert.equal(body.jobs[0].state,'completed');
    assert.equal(body.runs.length,1);assert.equal(body.document.status,'needs_review');
    assert.equal(await usageCount(item.document.id),1);
    await wake();assert.equal((await detail(item.document.id)).runs.length,1);
  }finally{await endpoint.close();}
});
