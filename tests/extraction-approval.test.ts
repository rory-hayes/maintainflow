import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase } from '../server/core/db.js';
import { addDocument } from '../server/core/intake.js';
import { processOneCoreJob } from '../server/core/worker.js';
import { config } from '../server/core/config.js';
import { presets } from '../shared/presets.js';

let workspaceId: string | undefined, userId: string | undefined;
after(async () => {
  if (workspaceId) {
    await adminPool.query('delete from workspaces where id=$1', [workspaceId]);
    await fs.rm(path.join(config.storageDir, workspaceId), { recursive: true, force: true });
  }
  if (userId) await adminPool.query('delete from users where id=$1', [userId]);
  await closeDatabase();
});

test('actual approval rejects inconsistent totals, accepts a corrected revision and preserves original v2 provenance', async () => {
  const app = await buildApp();
  try {
    const signup = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
      name: 'Owned totals fixture', email: `totals-${randomUUID()}@example.test`, password: 'owned totals fixture password', workspaceName: 'Owned totals approval fixture',
    } });
    assert.equal(signup.statusCode, 201, signup.body);
    const account = signup.json();
    workspaceId = account.workspace.id; userId = account.user.id;
    const headers = { origin: config.origin, cookie: signup.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
    const parserReply = await app.inject({ method: 'POST', url: '/api/parsers', headers, payload: { name: 'Owned totals parser', useCase: 'invoice', mode: 'rules' } });
    assert.equal(parserReply.statusCode, 201, parserReply.body);
    const content = presets.invoice.sample.replace('Subtotal: 450.00', 'Subtotal: 400.00').replace('Total: 553.50', 'Total: 600.00');
    const intake = await addDocument({ userId: userId!, workspaceId: workspaceId!, role: 'owner', authType: 'session' }, parserReply.json().parser.id, Buffer.from(content), 'owned-inconsistent-invoice.txt');
    // Scope this helper to the owned job; it cannot claim or advance any browser work.
    assert.equal(await processOneCoreJob(intake.jobId), true);
    const detail = await app.inject({ method: 'GET', url: `/api/documents/${intake.document.id}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    const run = detail.json().runs[0];
    assert.equal(run.model, 'deterministic-v2');
    assert.equal(run.rawValues.subtotal, '400.00');
    assert.equal(run.normalizedValues.total, 600);
    const rejected = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, headers, payload: { expectedRevision: run.effectiveRevision } });
    assert.equal(rejected.statusCode, 422, rejected.body);
    assert.match(rejected.json().message, /Line-item amounts do not reconcile with the subtotal/);
    assert.match(rejected.json().message, /Subtotal plus tax does not reconcile with total/);
    assert.equal((await adminPool.query('select id from approvals where run_id=$1', [run.id])).rowCount, 0);
    const corrected = { ...run.effectiveValues, subtotal: 450, total: 553.5 };
    const correction = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/corrections`, headers, payload: { values: corrected, expectedRevision: run.effectiveRevision } });
    assert.equal(correction.statusCode, 200, correction.body);
    assert.deepEqual(correction.json().issues, []);
    const approved = await app.inject({ method: 'POST', url: `/api/runs/${run.id}/approve`, headers, payload: { expectedRevision: correction.json().run.effectiveRevision } });
    assert.equal(approved.statusCode, 200, approved.body);
    assert.equal(approved.json().approval.values.subtotal, 450);
    assert.equal(approved.json().approval.values.total, 553.5);
    assert.equal(approved.json().run.rawValues.total, '600.00');
    assert.equal(approved.json().run.normalizedValues.total, 600);
    assert.equal(approved.json().run.model, 'deterministic-v2');
    assert.equal((await adminPool.query('select id from approvals where run_id=$1', [run.id])).rowCount, 1);
  } finally { await app.close(); }
});
