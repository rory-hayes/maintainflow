import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { adminPool, appPool, withWorkspace, closeDatabase } from '../server/core/db.js';
import { addDocument } from '../server/core/intake.js';
import { appendDocumentEvent } from '../server/core/document-events.js';
import { processOneCoreJob } from '../server/core/worker.js';
import { config } from '../server/core/config.js';
import { presets } from '../shared/presets.js';
import type { Actor } from '../shared/types.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string; actor: Actor };
let app: FastifyInstance, account: Account, other: Account;
let parserId: string, documentId: string, initialJobId: string, failedDocumentId: string;
const accounts: Account[] = [];
async function request(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, caller = account) {
  return app.inject({ method, url, payload: payload as any, headers: { cookie: caller.cookie, origin: config.origin } });
}
async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: `Owned lifecycle ${label}`, email: `lifecycle-${label}-${randomUUID()}@example.test`, password: 'owned lifecycle fixture password', workspaceName: `Owned lifecycle ${label}`,
  } });
  assert.equal(response.statusCode, 201, response.body);
  const body = response.json();
  const value = { ...body, cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '), actor: {
    userId: body.user.id, workspaceId: body.workspace.id, role: 'owner', authType: 'session',
  } as Actor };
  accounts.push(value); return value;
}
async function detail(id = documentId) {
  const response = await request('GET', `/api/documents/${id}`);
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
const chronological = (body: any) => [...body.lifecycle].reverse();
before(async () => {
  app = await buildApp(); account = await signup('primary'); other = await signup('other');
  const response = await request('POST', '/api/parsers', { name: 'Owned lifecycle invoice parser', useCase: 'invoice', mode: 'rules' });
  assert.equal(response.statusCode, 201, response.body); parserId = response.json().parser.id;
});
after(async () => {
  await app?.close();
  for (const value of accounts) {
    await adminPool.query('delete from workspaces where id=$1', [value.workspace.id]);
    await fs.rm(path.join(config.storageDir, value.workspace.id), { recursive: true, force: true });
    await adminPool.query('delete from users where id=$1', [value.user.id]);
  }
  await closeDatabase();
});

test('atomic intake journals received and queued, then actual processing and approval preserve ordered phases', async () => {
  const intake = await addDocument(account.actor, parserId, Buffer.from(presets.invoice.sample), 'owned-lifecycle-invoice.txt');
  documentId = intake.document.id; initialJobId = intake.jobId;
  assert.equal(intake.document.status, 'queued');
  const initial = chronological(await detail());
  assert.deepEqual(initial.map(event => event.state), ['received', 'queued']);
  assert.equal(initial[0].operationId, null);
  assert.equal(initial[1].operationId, initialJobId);
  assert.equal((await adminPool.query('select state from jobs where id=$1', [initialJobId])).rows[0].state, 'queued');
  assert.equal(await processOneCoreJob(initialJobId), true);
  const processed = await detail();
  assert.deepEqual(chronological(processed).map(event => event.state), ['received', 'queued', 'processing', 'needs_review']);
  const run = processed.runs[0];
  const approved = await request('POST', `/api/runs/${run.id}/approve`, { expectedRevision: run.effectiveRevision });
  assert.equal(approved.statusCode, 200, approved.body);
  const events = chronological(await detail());
  assert.deepEqual(events.map(event => event.state), ['received', 'queued', 'processing', 'needs_review', 'processed']);
  assert.ok(events.every(event => event.phase === 'processing'));
  assert.ok(events.slice(1).every(event => event.operationId === initialJobId));
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ['createdAt', 'details', 'id', 'operationId', 'phase', 'state']);
    assert.deepEqual(event.details, {});
    assert.ok(Number.isFinite(Date.parse(event.createdAt)));
  }
});

test('duplicate intake and unchanged status do not fabricate phases; reprocessing gets its own operation identity', async () => {
  const before = (await detail()).lifecycle.map((event: any) => event.id);
  const duplicate = await addDocument(account.actor, parserId, Buffer.from(presets.invoice.sample), 'owned-duplicate.txt');
  assert.equal(duplicate.duplicate, true);
  await withWorkspace(account.workspace.id, c => c.query('update documents set status=status where id=$1', [documentId]));
  assert.deepEqual((await detail()).lifecycle.map((event: any) => event.id), before);
  const reprocess = await request('POST', `/api/documents/${documentId}/reprocess`, {});
  assert.equal(reprocess.statusCode, 200, reprocess.body);
  const jobId = reprocess.json().job.id;
  assert.notEqual(jobId, initialJobId);
  assert.equal(await processOneCoreJob(jobId), true);
  const events = chronological(await detail());
  assert.deepEqual(events.slice(-3).map(event => event.state), ['queued', 'processing', 'needs_review']);
  assert.ok(events.slice(-3).every(event => event.operationId === jobId));
  assert.equal(events.filter(event => event.state === 'received').length, 1);
});

test('real no-text failure journals the exact owned job without creating a successful run', async () => {
  const intake = await addDocument(account.actor, parserId, await fs.readFile('fixtures/source-formats/receipt-image.jpg'), 'owned-lifecycle-image.jpg');
  failedDocumentId = intake.document.id;
  assert.equal(await processOneCoreJob(intake.jobId), true);
  const body = await detail(failedDocumentId), events = chronological(body);
  assert.equal(body.document.status, 'failed'); assert.equal(body.runs.length, 0);
  assert.deepEqual(events.map(event => event.state), ['received', 'queued', 'processing', 'failed']);
  assert.ok(events.slice(1).every(event => event.operationId === intake.jobId));
  assert.deepEqual(events.at(-1).details, {});
});

test('history is tenant scoped and app privileges deny direct edits and deletes', async () => {
  assert.equal((await request('GET', `/api/documents/${documentId}`, undefined, other)).statusCode, 404);
  assert.equal((await withWorkspace(other.workspace.id, c => c.query('select id from document_events where document_id=$1', [documentId]))).rowCount, 0);
  assert.equal((await appPool.query('select id from document_events')).rowCount, 0);
  await assert.rejects(withWorkspace(account.workspace.id, c => c.query("update document_events set state='failed' where document_id=$1", [documentId])), /permission denied/);
  await assert.rejects(withWorkspace(account.workspace.id, c => c.query('delete from document_events where document_id=$1', [documentId])), /permission denied/);
  await assert.rejects(withWorkspace(other.workspace.id, c => appendDocumentEvent(c, account.workspace.id, documentId, { phase: 'export', state: 'exporting' })), /row-level security/);
});

test('a failed job insert rolls back both received history and document acceptance', async () => {
  const count = async (table: string) => Number((await adminPool.query(`select count(*) n from ${table} where workspace_id=$1`, [account.workspace.id])).rows[0].n);
  const before = await Promise.all(['documents', 'document_events', 'jobs', 'usage_ledger'].map(count));
  const files = (await fs.readdir(path.join(config.storageDir, account.workspace.id))).sort();
  const schemaId = (await adminPool.query('select active_schema_id from parsers where id=$1', [parserId])).rows[0].active_schema_id;
  try {
    // A deliberately incomplete owned parser configuration makes queue insertion
    // fail after document insertion; the entire acceptance transaction must roll back.
    await adminPool.query('update parsers set active_schema_id=null where id=$1', [parserId]);
    await assert.rejects(addDocument(account.actor, parserId, Buffer.from(presets.invoice.sample + '\nOwned rollback fixture'), 'owned-rollback.txt'), (error: any) => error.code === '23502');
    assert.deepEqual(await Promise.all(['documents', 'document_events', 'jobs', 'usage_ledger'].map(count)), before);
    assert.deepEqual((await fs.readdir(path.join(config.storageDir, account.workspace.id))).sort(), files);
  } finally { await adminPool.query('update parsers set active_schema_id=$2 where id=$1', [parserId, schemaId]); }
});

test('public history is bounded and insertion ordered even when operation timestamps tie', async () => {
  const ids: string[] = [], occurredAt = new Date();
  await withWorkspace(account.workspace.id, async c => {
    for (let index = 0; index < 205; index++) {
      const event = await appendDocumentEvent(c, account.workspace.id, documentId, {
        phase: 'export', state: 'exported', operationId: randomUUID(), createdAt: occurredAt, details: { format: 'json' },
      });
      assert.equal('sequence' in event, false); ids.push(event.id);
    }
  });
  const body = await detail();
  assert.equal(body.lifecycle.length, 200);
  assert.deepEqual(body.lifecycle.map((event: any) => event.id), ids.slice(-200).reverse());
  assert.ok(body.lifecycle.every((event: any) => !('sequence' in event) && !('workspaceId' in event)));
});

test('document deletion cascades history despite revoked direct history-delete privileges', async () => {
  for (const id of [documentId, failedDocumentId]) {
    assert.ok((await adminPool.query('select id from document_events where document_id=$1', [id])).rowCount! > 0);
    const response = await request('DELETE', `/api/documents/${id}`);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((await adminPool.query('select id from document_events where document_id=$1', [id])).rowCount, 0);
    assert.equal((await request('GET', `/api/documents/${id}`)).statusCode, 404);
  }
});
