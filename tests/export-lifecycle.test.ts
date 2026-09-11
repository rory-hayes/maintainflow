import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { ZodError } from 'zod';
import { registerCore } from '../server/core/index.js';
import { adminPool, closeDatabase, transaction, withWorkspace } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { registerExports } from '../server/integrations/exports.js';
import { renderExport } from '../server/integrations/export-format.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
const accounts: Account[] = [];
const applications: FastifyInstance[] = [];
let app: FastifyInstance, owner: Account, outsider: Account, parser: any;

async function makeApp(render?: typeof renderExport) {
  const instance = Fastify();
  applications.push(instance);
  await instance.register(cookie); await instance.register(multipart);
  instance.setErrorHandler((error: any, _request, reply) => {
    reply.code(error instanceof ZodError ? 400 : error.statusCode || 500).send({ error: error.message });
  });
  await registerCore(instance); await registerExports(instance, { render }); await instance.ready();
  return instance;
}
async function signup(name: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name, email: `export-lifecycle-${name}-${randomUUID()}@example.test`, password: 'owned export lifecycle fixture password', workspaceName: `Owned export lifecycle ${name}`,
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(c => `${c.name}=${c.value}`).join('; ') };
  accounts.push(account); return account;
}
async function request(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, account = owner, instance = app) {
  return instance.inject({ method, url, payload: payload as any, headers: { cookie: account.cookie, origin: config.origin } });
}
async function fixture(options: { approved?: boolean; newerReview?: boolean } = {}) {
  const id = randomUUID(), runId = randomUUID(), approvalId = randomUUID();
  const latestRunId = options.newerReview ? randomUUID() : runId;
  const original = Buffer.from(`Reference: owned-${id}\nAmount: 12.50`);
  const sha = createHash('sha256').update(original).digest('hex');
  const storageKey = `${owner.workspace.id}/${id}`;
  const values = { reference: `approved-${id}`, amount: 12.5 };
  await fs.mkdir(path.join(config.storageDir, owner.workspace.id), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config.storageDir, storageKey), original, { mode: 0o600 });
  await transaction(adminPool, async c => {
    await c.query(`insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count)
      values($1,$2,$3,'owned-export-lifecycle.txt','text/plain',$4,$5,$6,'needs_review',1)`, [id, owner.workspace.id, parser.id, original.length, sha, storageKey]);
    for (const candidate of [...new Set([runId, latestRunId])]) {
      const runValues = candidate === runId ? values : { reference: 'newer-unapproved-value', amount: 999 };
      await c.query(`insert into extraction_runs(id,workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues)
        values($1,$2,$3,$4,'owned-test-fixture','fixture-v1','fixture-v1',$5,$6,$6,'{}','[]')`, [candidate, owner.workspace.id, id, parser.activeSchemaId, sha, JSON.stringify(runValues)]);
    }
    if (options.approved !== false) {
      await c.query('insert into approvals(id,workspace_id,run_id,user_id,values) values($1,$2,$3,$4,$5)', [approvalId, owner.workspace.id, runId, owner.user.id, JSON.stringify(values)]);
    }
    await c.query('update documents set latest_run_id=$2,approved_run_id=$3,status=$4 where id=$1', [id, latestRunId, options.approved === false ? null : runId, options.newerReview || options.approved === false ? 'needs_review' : 'processed']);
  });
  return { id, runId, latestRunId, approvalId, values, storageKey };
}
async function events(documentIds: string[]) {
  return (await adminPool.query("select *,created_at::text actual_time from document_events where document_id=any($1::uuid[]) and phase='export' order by sequence", [documentIds])).rows;
}
async function storedState(documentIds: string[]) {
  return (await adminPool.query('select id,status,latest_run_id,approved_run_id,updated_at from documents where id=any($1::uuid[]) order by id', [documentIds])).rows;
}
async function snapshotCount() {
  return (await adminPool.query('select count(*)::int count from export_snapshots where workspace_id=$1', [owner.workspace.id])).rows[0].count;
}

before(async () => {
  app = await makeApp(); owner = await signup('owner'); outsider = await signup('outsider');
  const response = await request('POST', '/api/parsers', { name: 'Owned lifecycle parser', useCase: 'custom', mode: 'rules', schema: { fields: [
    { key: 'reference', label: 'Reference', type: 'string' }, { key: 'amount', label: 'Amount', type: 'number' },
  ] } });
  assert.equal(response.statusCode, 201, response.body); parser = response.json().parser;
});
after(async () => {
  for (const instance of applications) await instance.close();
  for (const account of accounts) {
    await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
    await fs.rm(path.join(config.storageDir, account.workspace.id), { recursive: true, force: true });
    await adminPool.query('delete from users where id=$1', [account.user.id]);
  }
  await closeDatabase();
});

test('export phases surround actual rendering and preserve an approved historical revision with newer review work', async () => {
  const historical = await fixture({ newerReview: true }), current = await fixture();
  let renderStarted = '', renderCompleted = '', calls = 0;
  const instance = await makeApp(async (records, options) => {
    calls++;
    renderStarted = (await adminPool.query('select clock_timestamp()::text at')).rows[0].at;
    const result = await renderExport(records, options);
    renderCompleted = (await adminPool.query('select clock_timestamp()::text at')).rows[0].at;
    return result;
  });
  const response = await request('POST', '/api/exports', {
    documentIds: [current.id, historical.id, current.id], format: 'json',
    revisions: [{ documentId: historical.id, approvalId: historical.approvalId }, { documentId: current.id, approvalId: current.approvalId }],
  }, owner, instance);
  assert.equal(response.statusCode, 200, response.body); assert.equal(calls, 1);
  const result = response.json(); assert.equal(result.documentCount, 2);
  const history = await events([historical.id, current.id]);
  assert.equal(history.length, 4); assert.equal(new Set(history.map(e => e.operation_id)).size, 1);
  assert.ok(history.every(e => e.operation_id === result.id));
  assert.deepEqual(history.map(e => e.state), ['exporting', 'exporting', 'exported', 'exported']);
  const timing = (await adminPool.query(`select bool_and(case when state='exporting' then created_at<$2::timestamptz else created_at>$3::timestamptz end) ordered
    from document_events where operation_id=$1`, [result.id, renderStarted, renderCompleted])).rows[0];
  assert.equal(timing.ordered, true, 'Start is recorded before renderer entry; completion after renderer return, using the database clock.');
  for (const document of [historical, current]) {
    const phases = history.filter(e => e.document_id === document.id);
    assert.deepEqual(phases.map(e => e.state), ['exporting', 'exported']);
    assert.deepEqual(phases[0].details, { format: 'json', approvalId: document.approvalId, runId: document.runId });
  }
  const states = await storedState([historical.id, current.id]);
  const historicalState = states.find(row => row.id === historical.id);
  assert.equal(historicalState.status, 'needs_review'); assert.equal(historicalState.latest_run_id, historical.latestRunId); assert.equal(historicalState.approved_run_id, historical.runId);
  assert.equal(states.find(row => row.id === current.id).status, 'exported');
  const download = await request('GET', result.downloadUrl);
  assert.equal(download.statusCode, 200);
  const exported = download.json().documents.find((d: any) => d.documentId === historical.id);
  assert.deepEqual(exported.values, historical.values); assert.equal(exported.runId, historical.runId);
  const detail = await request('GET', `/api/documents/${historical.id}`);
  assert.equal(detail.statusCode, 200, detail.body);
  const publicHistory = detail.json().lifecycle.filter((e: any) => e.phase === 'export');
  assert.deepEqual(publicHistory.map((e: any) => e.state), ['exported', 'exporting']);
  assert.ok(publicHistory.every((e: any) => e.operationId === result.id && !Object.hasOwn(e, 'sequence')));
  assert.equal((await request('GET', result.downloadUrl, undefined, outsider)).statusCode, 404);
  assert.equal((await request('GET', `/api/documents/${historical.id}`, undefined, outsider)).statusCode, 404);
  assert.equal(await withWorkspace(outsider.workspace.id, async c => (await c.query('select id from document_events where document_id=$1', [historical.id])).rowCount), 0);
});

test('invalid, unauthenticated, foreign and unapproved requests create no export phases or snapshots', async () => {
  const approved = await fixture(), unapproved = await fixture({ approved: false });
  let calls = 0;
  const instance = await makeApp(async () => { calls++; throw new Error('Renderer must not run for an ineligible selection.'); });
  const beforeCount = await snapshotCount();
  for (const [payload, account, expected] of [
    [{ documentIds: [approved.id], format: 'invalid' }, owner, 400],
    [{ documentIds: [approved.id], format: 'json' }, outsider, 404],
    [{ documentIds: [approved.id, unapproved.id], format: 'json' }, owner, 400],
    [{ documentIds: [approved.id], format: 'json', revisions: [] }, owner, 400],
    [{ documentIds: [approved.id], format: 'json', revisions: [{ documentId: approved.id, approvalId: randomUUID() }] }, owner, 400],
  ] as const) assert.equal((await request('POST', '/api/exports', payload, account, instance)).statusCode, expected);
  assert.equal((await instance.inject({ method: 'POST', url: '/api/exports', payload: { documentIds: [approved.id], format: 'json' } })).statusCode, 401);
  assert.equal(calls, 0); assert.deepEqual(await events([approved.id, unapproved.id]), []); assert.equal(await snapshotCount(), beforeCount);
});

test('controlled renderer failure commits a safe failed phase for every selected document without changing snapshots or review state', async () => {
  const historical = await fixture({ newerReview: true }), current = await fixture();
  const existing = await request('POST', '/api/exports', { documentIds: [current.id], format: 'json' });
  const originalBytes = (await request('GET', existing.json().downloadUrl)).rawPayload;
  const ids = [historical.id, current.id], beforeState = await storedState(ids), beforeCount = await snapshotCount();
  const privateMarker = `private-render-content-${randomUUID()}`;
  const instance = await makeApp(async () => { throw new Error(privateMarker); });
  const response = await request('POST', '/api/exports', { documentIds: ids, format: 'xlsx' }, owner, instance);
  assert.equal(response.statusCode, 500); assert.ok(!response.body.includes(privateMarker));
  const attempts = (await events(ids)).filter(e => e.operation_id !== existing.json().id);
  assert.deepEqual(attempts.map(e => e.state), ['exporting', 'exporting', 'failed', 'failed']);
  assert.equal(new Set(attempts.map(e => e.operation_id)).size, 1);
  assert.ok(!JSON.stringify(attempts).includes(privateMarker));
  assert.ok(attempts.filter(e => e.state === 'failed').every(e => e.details.reason === 'Export generation failed. Try again or select another format.'));
  assert.deepEqual(await storedState(ids), beforeState); assert.equal(await snapshotCount(), beforeCount);
  assert.deepEqual((await request('GET', existing.json().downloadUrl)).rawPayload, originalBytes);
  const failedOperation = attempts[0].operation_id;
  assert.equal((await adminPool.query("select id from audit_events where workspace_id=$1 and action='export.created' and entity_id=$2", [owner.workspace.id, failedOperation])).rowCount, 0);
  const detail = await request('GET', `/api/documents/${historical.id}`);
  assert.equal(detail.json().lifecycle[0].state, 'failed'); assert.equal(detail.json().document.status, 'needs_review');
});

test('format limit remains actionable and records failure without persisting a partial export', async () => {
  const document = await fixture();
  const beforeState = await storedState([document.id]), beforeCount = await snapshotCount();
  const instance = await makeApp(async () => {
    throw Object.assign(new Error('Controlled detailed renderer error must not be recorded.'), { statusCode: 413 });
  });
  const response = await request('POST', '/api/exports', { documentIds: [document.id], format: 'csv' }, owner, instance);
  assert.equal(response.statusCode, 413); assert.match(response.json().error, /smaller selection/);
  const history = await events([document.id]);
  assert.deepEqual(history.map(e => e.state), ['exporting', 'failed']);
  assert.match(history[1].details.reason, /supported size limits/);
  assert.ok(!JSON.stringify(history).includes('Controlled detailed'));
  assert.deepEqual(await storedState([document.id]), beforeState); assert.equal(await snapshotCount(), beforeCount);
});

test('a persistence constraint failure recovers the transaction and retains only the attempt journal', async () => {
  const document = await fixture();
  const beforeState = await storedState([document.id]), beforeCount = await snapshotCount();
  // The controlled renderer violates the snapshot's NOT NULL constraint, exercising
  // PostgreSQL's aborted-transaction recovery rather than only a JavaScript throw.
  const instance = await makeApp(async () => ({ bytes: Buffer.from('owned fixture'), mime: null as unknown as string, extension: 'json' }));
  const response = await request('POST', '/api/exports', { documentIds: [document.id], format: 'json' }, owner, instance);
  assert.equal(response.statusCode, 500);
  const history = await events([document.id]); assert.deepEqual(history.map(e => e.state), ['exporting', 'failed']);
  assert.equal(history[0].operation_id, history[1].operation_id);
  assert.deepEqual(await storedState([document.id]), beforeState); assert.equal(await snapshotCount(), beforeCount);
  assert.ok(!JSON.stringify(history).includes('null value')); assert.ok(!response.body.includes('mime_type'));
  // A later real attempt succeeds; the original failed operation remains distinct.
  const retry = await request('POST', '/api/exports', { documentIds: [document.id], format: 'json' });
  assert.equal(retry.statusCode, 200, retry.body); assert.notEqual(retry.json().id, history[0].operation_id);
  assert.deepEqual((await events([document.id])).map(e => e.state), ['exporting', 'failed', 'exporting', 'exported']);
});

test('document deletion removes successful snapshots and all failed and completed export phases', async () => {
  const document = await fixture();
  const instance = await makeApp(async () => { throw new Error('Controlled export failure.'); });
  assert.equal((await request('POST', '/api/exports', { documentIds: [document.id], format: 'json' }, owner, instance)).statusCode, 500);
  const response = await request('POST', '/api/exports', { documentIds: [document.id], format: 'json' });
  assert.equal(response.statusCode, 200, response.body); assert.equal((await events([document.id])).length, 4);
  assert.equal((await request('DELETE', `/api/documents/${document.id}`, undefined, outsider)).statusCode, 404);
  assert.equal((await request('DELETE', `/api/documents/${document.id}`)).statusCode, 200);
  assert.equal((await adminPool.query('select id from document_events where document_id=$1', [document.id])).rowCount, 0);
  assert.equal((await adminPool.query('select id from export_snapshots where $1::uuid=any(document_ids)', [document.id])).rowCount, 0);
  assert.equal((await request('GET', response.json().downloadUrl)).statusCode, 404);
  assert.equal((await request('GET', `/api/documents/${document.id}`)).statusCode, 404);
  await assert.rejects(fs.access(path.join(config.storageDir, document.storageKey)));
});
