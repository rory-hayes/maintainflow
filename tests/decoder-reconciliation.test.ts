import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decoderLaunchSpec, inspectSource, runDecoder } from '../server/core/source.js';
import { decoderLimits } from '../server/core/decoder-limits.js';
import { reconcileInterruptedIntake } from '../server/core/object-reconciliation.js';
import { adminPool, transaction, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';

const workspaceId = randomUUID(), parserId = randomUUID(), schemaId = randomUUID();
const folder = path.join(config.storageDir, workspaceId);
const keys = { expired: randomUUID(), recent: randomUUID(), active: randomUUID(), referenced: randomUUID(), link: randomUUID() };
const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
before(async () => {
  await transaction(adminPool, async c => {
    await c.query('insert into workspaces(id,name,slug) values($1,$2,$3)', [workspaceId, 'Owned reconciliation fixture', workspaceId]);
    await c.query("insert into parsers(id,workspace_id,name) values($1,$2,'Owned fixture parser')", [parserId, workspaceId]);
    await c.query('insert into schema_versions(id,workspace_id,parser_id,version,schema) values($1,$2,$3,1,$4)', [schemaId, workspaceId, parserId, JSON.stringify({ fields: [{ key: 'reference', label: 'Reference', type: 'string' }] })]);
    await c.query('update parsers set active_schema_id=$2 where id=$1', [parserId, schemaId]);
    await c.query("insert into documents(id,workspace_id,parser_id,name,mime_type,byte_size,sha256,storage_key,status,page_count) values($1,$2,$3,'owned-reference.txt','text/plain',7,$4,$5,'processed',1)", [keys.referenced, workspaceId, parserId, 'e'.repeat(64), `${workspaceId}/${keys.referenced}`]);
    await c.query("insert into intake_files(id,workspace_id,storage_key,lease_expires_at) values($1,$2,$3,now()-interval '2 hours'),($4,$2,$5,now()+interval '1 hour')", [keys.expired, workspaceId, `${workspaceId}/${keys.expired}`, keys.active, `${workspaceId}/${keys.active}`]);
  });
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const key of Object.values(keys).filter(k => k !== keys.link)) {
    const filename = path.join(folder, key); await fs.writeFile(filename, 'fixture', { mode: 0o600 });
    if (key !== keys.recent) await fs.utimes(filename, old, old);
  }
  await fs.writeFile(path.join(folder, 'keep-not-a-storage-key.txt'), 'owned safe fixture');
  await fs.utimes(path.join(folder, 'keep-not-a-storage-key.txt'), old, old);
  await fs.symlink(path.join(folder, 'keep-not-a-storage-key.txt'), path.join(folder, keys.link));
});
after(async () => {
  await adminPool.query('delete from workspaces where id=$1', [workspaceId]);
  await fs.rm(folder, { recursive: true, force: true });
  await closeDatabase();
});

function fakeChild(onCreate?: (child: ChildProcessWithoutNullStreams) => void) {
  const emitter = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(emitter, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false, exitCode: null, signalCode: null });
  emitter.kill = () => { (emitter as any).killed = true; queueMicrotask(() => emitter.emit('close', null, 'SIGKILL')); return true; };
  queueMicrotask(() => onCreate?.(emitter));
  return emitter;
}
const response = JSON.stringify({ ok: true, source: { mimeType: 'text/plain', pages: [{ page: 1, text: 'Owned controlled fixture' }], pageCount: 1 } });

test('decoder subprocess preserves native two-page PDF and actual source evidence', async () => {
  const source = await inspectSource(await fs.readFile('fixtures/generated/invoice-multipage.pdf'), 'invoice-multipage.pdf');
  assert.equal(source.pageCount, 2); assert.match(source.pages[0].text, /INV-00601/); assert.match(source.pages[1].text, /Desk pads/);
});
test('decoder launch removes inherited credential variables and limits V8 heap', () => {
  const launch = decoderLaunchSpec('owned-fixture.txt');
  assert.deepEqual(Object.keys(launch.options.env).sort(), ['LANG', 'NODE_ENV', 'TSX_DISABLE_CACHE', 'TZ']);
  assert.ok(launch.args.includes('--max-old-space-size=192')); assert.equal(launch.args.at(-1), 'owned-fixture.txt');
});
test('decoder rejects oversized input before creating a child', async () => {
  let started = false;
  await assert.rejects(runDecoder(Buffer.alloc(decoderLimits.maxBytes + 1), 'large.txt', { spawnChild: () => { started = true; return fakeChild(); } }), (e: any) => e.statusCode === 413);
  assert.equal(started, false);
});
test('controlled output overflow terminates the decoder and rejects its response', async () => {
  let child!: ChildProcessWithoutNullStreams;
  await assert.rejects(runDecoder(Buffer.from('fixture'), 'fixture.txt', { spawnChild: () => child = fakeChild(c => c.stdout.emit('data', Buffer.alloc(decoderLimits.maxOutputBytes + 1, 65))) }), (e: any) => e.statusCode === 413);
  assert.equal(child.killed, true);
});
test('controlled deadline terminates an idle decoder and releases its slot', async () => {
  let child!: ChildProcessWithoutNullStreams;
  await assert.rejects(runDecoder(Buffer.from('fixture'), 'fixture.txt', { timeoutMs: 20, spawnChild: () => child = fakeChild() }), (e: any) => e.statusCode === 422);
  assert.equal(child.killed, true);
});
test('decoder allows only two active children and validates returned source shape', async () => {
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnChild = () => { const child = fakeChild(); children.push(child); return child; };
  const first = runDecoder(Buffer.from('fixture'), 'one.txt', { spawnChild });
  const second = runDecoder(Buffer.from('fixture'), 'two.txt', { spawnChild });
  await assert.rejects(runDecoder(Buffer.from('fixture'), 'three.txt', { spawnChild }), (e: any) => e.statusCode === 429);
  for (const child of children) { child.stdout.emit('data', Buffer.from(response)); child.emit('close', 0); }
  assert.equal((await first).pageCount, 1); assert.equal((await second).pageCount, 1);
  await assert.rejects(runDecoder(Buffer.from('fixture'), 'shape.txt', { spawnChild: () => fakeChild(c => { c.stdout.emit('data', Buffer.from('{"ok":true,"source":{"pageCount":0}}')); c.emit('close', 0); }) }), (e: any) => e.statusCode === 422);
});
test('scoped reconciliation removes only old unreferenced expired-write originals', async () => {
  const result = await reconcileInterruptedIntake(workspaceId);
  assert.equal(result.removed, 1);
  await assert.rejects(fs.access(path.join(folder, keys.expired)));
  for (const key of [keys.recent, keys.active, keys.referenced, keys.link, 'keep-not-a-storage-key.txt']) await fs.access(path.join(folder, key));
  assert.equal((await adminPool.query('select id from intake_files where id=$1', [keys.expired])).rowCount, 0);
  assert.equal((await adminPool.query('select id from intake_files where id=$1', [keys.active])).rowCount, 1);
  assert.equal((await adminPool.query('select id from jobs where workspace_id=$1', [workspaceId])).rowCount, 0);
});

test('persisted reconciliation cursor reaches an old orphan beyond one hundred ordinary originals', async () => {
  const orphan = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await adminPool.query("update reconciliation_cursors set after_filename='' where workspace_id=$1", [workspaceId]);
  const originals = Array.from({ length: 110 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);
  for (const key of originals) await fs.writeFile(path.join(folder, key), 'recent ordinary fixture', { mode: 0o600 });
  await fs.writeFile(path.join(folder, orphan), 'interrupted older fixture', { mode: 0o600 });
  await fs.utimes(path.join(folder, orphan), old, old);
  const first = await reconcileInterruptedIntake(workspaceId);
  assert.equal(first.examined, 100);
  await fs.access(path.join(folder, orphan));
  const firstCursor = (await adminPool.query('select after_filename from reconciliation_cursors where workspace_id=$1', [workspaceId])).rows[0].after_filename;
  assert.equal(firstCursor, originals[99]);
  const second = await reconcileInterruptedIntake(workspaceId);
  assert.equal(second.removed, 1);
  await assert.rejects(fs.access(path.join(folder, orphan)));
  for (const key of originals) await fs.access(path.join(folder, key));
});

test('expired pre-write reservations with no file are reconciled after grace while live reservations survive', async () => {
  const expired = randomUUID(), active = randomUUID();
  await adminPool.query(
    "insert into intake_files(id,workspace_id,storage_key,lease_expires_at) values($1,$2,$3,now()-interval '2 hours'),($4,$2,$5,now()+interval '1 hour')",
    [expired, workspaceId, `${workspaceId}/${expired}`, active, `${workspaceId}/${active}`],
  );
  const result = await reconcileInterruptedIntake(workspaceId);
  assert.equal(result.expiredIntentsRemoved, 1);
  assert.equal((await adminPool.query('select id from intake_files where id=$1', [expired])).rowCount, 0);
  assert.equal((await adminPool.query('select id from intake_files where id=$1', [active])).rowCount, 1);
  assert.equal((await adminPool.query('select id from jobs where workspace_id=$1', [workspaceId])).rowCount, 0);
});
