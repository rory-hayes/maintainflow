import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { adminPool, withWorkspace, transaction, closeDatabase } from '../server/core/db.js';
import { purgeDocument, deleteStoredFile } from '../server/core/retention.js';
import { addDocument } from '../server/core/intake.js';
import { normalizeValue } from '../server/core/extraction.js';
import { parserSchema, validateValues } from '../server/core/schema.js';
import { config } from '../server/core/config.js';
import type { Actor } from '../shared/types.js';

// Owned rows only. This suite creates no jobs and never calls the background worker.
const workspaceId = randomUUID(), otherWorkspaceId = randomUUID(), userId = randomUUID();
const parserId = randomUUID(), documentId = randomUUID(), schemaId = randomUUID();
const storageKey = `${workspaceId}/${documentId}`;
const source = Buffer.from('SYNTHETIC REVIEW FIXTURE\nReference: 000011');
const actor: Actor = { userId, workspaceId, role: 'owner', authType: 'session' };
before(async () => {
  await transaction(adminPool, async c => {
    await c.query('insert into users(id,email,name,password_hash) values($1,$2,$3,$4)', [userId, `defensive-${userId}@example.test`, 'Owned regression fixture', 'unusable-fixture-hash']);
    await c.query('insert into workspaces(id,name,slug) values($1,$2,$3),($4,$5,$6)', [workspaceId, 'Retention fixture', workspaceId, otherWorkspaceId, 'Other retention fixture', otherWorkspaceId]);
    await c.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'owner')", [workspaceId, userId]);
    await c.query("insert into parsers(id,workspace_id,name,use_case) values($1,$2,'Owned duplicate fixture','custom')", [parserId, workspaceId]);
    await c.query('insert into schema_versions(id,workspace_id,parser_id,version,schema) values($1,$2,$3,1,$4)', [schemaId, workspaceId, parserId, JSON.stringify({ fields: [{ key: 'reference', label: 'Reference', type: 'string' }] })]);
    await c.query('update parsers set active_schema_id=$2 where id=$1', [parserId, schemaId]);
    await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count) values($1,$2,$3,'owned-existing.txt','text/plain',$4,$5,$6,'processed',1)", [documentId, workspaceId, parserId, source.length, createHash('sha256').update(source).digest('hex'), storageKey]);
  });
  await fs.mkdir(path.join(config.storageDir, workspaceId), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(config.storageDir, storageKey), source, { mode: 0o600 });
});
after(async () => {
  await adminPool.query('delete from workspaces where id=any($1::uuid[])', [[workspaceId, otherWorkspaceId]]);
  await adminPool.query('delete from users where id=$1', [userId]);
  await fs.rm(path.join(config.storageDir, workspaceId), { recursive: true, force: true });
  await closeDatabase();
});

test('duplicate intake records its event binding and rejects changed replay content', async () => {
  const first = await addDocument(actor, parserId, source, 'owned-replay.txt', 'text/plain', 'owned-regression-event');
  assert.equal(first.duplicate, true); assert.equal(first.document.id, documentId);
  assert.equal((await adminPool.query('select document_id from intake_events where workspace_id=$1 and idempotency_key=$2', [workspaceId, 'owned-regression-event'])).rows[0].document_id, documentId);
  await assert.rejects(addDocument(actor, parserId, Buffer.concat([source, Buffer.from('changed')]), 'owned-changed.txt', 'text/plain', 'owned-regression-event'), (e: any) => e.statusCode === 409);
  assert.equal((await adminPool.query('select id from jobs where workspace_id=$1', [workspaceId])).rowCount, 0);
});
test('failed file removal stays tracked, tenant-scoped and retryable', async () => {
  await withWorkspace(workspaceId, async c => {
    await purgeDocument(c, workspaceId, documentId);
    // Keep the fixture away from the running worker; retry explicitly below.
    await c.query("update file_deletions set available_at=now()+interval '1 hour' where storage_key=$1", [storageKey]);
  });
  const status = await deleteStoredFile(workspaceId, storageKey, async () => {
    throw Object.assign(new Error('Owned controlled filesystem failure'), { code: 'EACCES' });
  });
  assert.equal(status, 'pending');
  const entry = (await withWorkspace(workspaceId, c => c.query('select * from file_deletions where storage_key=$1', [storageKey]))).rows[0];
  assert.equal(entry.attempts, 1); assert.equal(entry.status, 'pending'); assert.match(entry.last_error, /Check storage permissions/);
  assert.equal((await withWorkspace(otherWorkspaceId, c => c.query('select * from file_deletions where storage_key=$1', [storageKey]))).rowCount, 0);
  await fs.access(path.join(config.storageDir, storageKey));
  assert.equal(await deleteStoredFile(workspaceId, storageKey), 'complete');
  await assert.rejects(fs.access(path.join(config.storageDir, storageKey)));
  assert.equal((await adminPool.query('select id from file_deletions where storage_key=$1', [storageKey])).rowCount, 0);
});
test('replayed intake after deletion returns an explicit tombstone response without resurrecting data', async () => {
  await assert.rejects(addDocument(actor, parserId, source, 'owned-replay.txt', 'text/plain', 'owned-regression-event'), (e: any) => e.statusCode === 410);
  assert.equal((await adminPool.query('select id from documents where workspace_id=$1', [workspaceId])).rowCount, 0);
  assert.equal((await adminPool.query('select id from jobs where workspace_id=$1', [workspaceId])).rowCount, 0);
  assert.equal((await fs.readdir(path.join(config.storageDir, workspaceId))).length, 0);
});
test('text allowed choices validate without inventing a replacement value', () => {
  const schema = parserSchema.parse({ fields: [{ key: 'status', label: 'Status', type: 'string', enum: ['Approved', 'Pending'] }] });
  assert.deepEqual(validateValues({ status: 'Approved' }, schema), []);
  assert.ok(validateValues({ status: 'Unknown' }, schema).some(issue => issue.code === 'allowed_choice'));
  assert.throws(() => parserSchema.parse({ fields: [{ key: 'total', label: 'Total', type: 'number', enum: ['5'] }] }));
});
test('normalization preserves ambiguous numeric text for review', () => {
  const currency = { key: 'total', label: 'Total', type: 'currency' as const };
  const number = { key: 'quantity', label: 'Quantity', type: 'number' as const };
  assert.equal(normalizeValue('EUR 1,234.50', currency, 'en-IE'), 1234.5);
  assert.equal(normalizeValue('(€ 12.50)', currency, 'en-IE'), -12.5);
  assert.equal(normalizeValue('not 20', currency, 'en-IE'), 'not 20');
  assert.equal(normalizeValue('12 units', number, 'en-IE'), '12 units');
  assert.equal(normalizeValue('000012', { key: 'identifier', label: 'Identifier', type: 'string' }, 'en-IE'), '000012');
});
