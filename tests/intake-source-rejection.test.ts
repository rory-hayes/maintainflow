import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../shared/types.js';
import { buildApp } from '../server/app.js';
import { adminPool, withWorkspace, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';
import { addDocument } from '../server/core/intake.js';
import { SourceIntakeRejectedError } from '../server/core/intake-policy.js';
import { SourceValidationError, sourceValidationReasons } from '../server/core/source-validation.js';
import { setStorageForTests, type PrivateStorage } from '../server/core/storage.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
const suffix = randomUUID(), accounts: Account[] = [], objects = new Map<string, Buffer>();
let app: FastifyInstance, owner: Account, other: Account, validPdf: Buffer;
let storageWrites = 0, localDatabaseVerified = false;
const malformedPdf = Buffer.from('%PDF-1.7\nPRIVATE OWNED MALFORMED SOURCE\n%%EOF');
const unsupportedBinary = Buffer.from('GIF89a\0PRIVATE OWNED UNSUPPORTED SOURCE');
const storage: PrivateStorage = {
  kind: 'supabase',
  async write(key, bytes) { storageWrites++; objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); if (!bytes) throw new Error('Missing owned source fixture'); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
};
const actor = (account = owner): Actor => ({ userId: account.user.id, workspaceId: account.workspace.id, role: 'owner', authType: 'session' });
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin },
    payload: { name: `Owned source ${label}`, workspaceName: `Owned source ${label}`, email: `source-rejection-${label}-${suffix}@example.test`, password: 'Owned source rejection password' } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') } as Account;
  accounts.push(account);
  await adminPool.query("update workspaces set plan=jsonb_set(jsonb_set(plan,'{maxParsers}','30'),'{monthlyPages}','1000') where id=$1", [account.workspace.id]);
  return account;
}

async function parser(account = owner) {
  const response = await app.inject({ method: 'POST', url: '/api/parsers', headers: { origin: config.origin, cookie: account.cookie },
    payload: { name: 'Owned source rejection parser', useCase: 'custom' } });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().parser as { id: string };
}

async function footprint(account = owner) {
  const counts: Record<string, number> = {};
  for (const table of ['documents', 'jobs', 'usage_ledger', 'intake_files', 'file_deletions']) {
    counts[table] = (await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`, [account.workspace.id])).rows[0].n;
  }
  return { ...counts, originals: [...objects.keys()].filter(key => key.startsWith(`${account.workspace.id}/`)).sort(), storageWrites };
}

async function receipts(key: string, account = owner) {
  return (await adminPool.query('select * from intake_events where workspace_id=$1 and idempotency_key=$2', [account.workspace.id, key])).rows;
}

async function rejections(parserId: string, account = owner) {
  return (await adminPool.query("select * from audit_events where workspace_id=$1 and action='document.rejected' and metadata->>'parserId'=$2", [account.workspace.id, parserId])).rows;
}

function permanent(parserId: string, reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof SourceIntakeRejectedError);
    assert.equal(error.code, 'source_validation_failed');
    assert.equal(error.parserId, parserId);
    assert.equal(error.reason, reason);
    assert.ok([400, 413, 422].includes(error.statusCode));
    assert.ok(!error.message.includes('PRIVATE'));
    return true;
  };
}

before(async () => {
  const options = adminPool.options, host = options.connectionString ? new URL(options.connectionString).hostname : options.host;
  assert.ok(typeof host === 'string' && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)), 'Source rejection fixtures require a local database');
  localDatabaseVerified = true;
  setStorageForTests(storage);
  app = await buildApp();
  owner = await signup('owner');
  other = await signup('other');
  validPdf = await fs.readFile('fixtures/generated/invoice-multipage.pdf');
});

after(async () => {
  setStorageForTests(undefined);
  try {
    await app?.close();
    if (!localDatabaseVerified) return;
    for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
    for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
    objects.clear();
  } finally { await closeDatabase(); }
});

test('genuine malformed PDF and unsupported binary commit bounded rejection receipts without staging an original', async () => {
  for (const [bytes, reason] of [[malformedPdf, 'pdf_invalid'], [unsupportedBinary, 'binary_format_unsupported']] as const) {
    const p = await parser(), key = `actual-invalid-${randomUUID()}`, before = await footprint();
    await assert.rejects(addDocument(actor(), p.id, bytes, 'PRIVATE-FILENAME.pdf', 'application/pdf', key), permanent(p.id, reason));
    assert.deepEqual(await footprint(), before);
    const rows = await receipts(key);
    assert.equal(rows.length, 1);
    const receipt = rows[0];
    assert.equal(receipt.document_id, null);
    assert.equal(receipt.rejection_code, 'source_validation_failed');
    assert.equal(receipt.rejection_reason, reason);
    assert.equal(receipt.rejection_format, null);
    assert.equal(receipt.rejected_parser_id, p.id);
    assert.equal(receipt.rejection_sha256, sha256(bytes));
    const audits = await rejections(p.id);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].entity_id, null);
    assert.deepEqual(audits[0].metadata, { code: 'source_validation_failed', parserId: p.id,
      reason: new SourceValidationError(reason).message });
    assert.ok(!JSON.stringify([receipt, audits]).includes('PRIVATE'));
    assert.ok(JSON.stringify(audits[0].metadata).length < 500);
  }
});

test('source rejection replay is durable, binds exact bytes and parser before decoding, and permits a repaired fresh attempt', async () => {
  const p = await parser(), another = await parser(), key = `source-replay-${randomUUID()}`, before = await footprint();
  await assert.rejects(addDocument(actor(), p.id, malformedPdf, 'broken.pdf', undefined, key), permanent(p.id, 'pdf_invalid'));
  const originalReceipt = (await receipts(key))[0];
  let inspections = 0;
  const inspectSource = async () => { inspections++; throw new Error('Decoder must not run for a committed receipt'); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(addDocument(actor(), p.id, malformedPdf, 'renamed.pdf', undefined, key, { inspectSource }), permanent(p.id, 'pdf_invalid'));
  }
  await assert.rejects(addDocument(actor(), p.id, validPdf, 'repaired.pdf', undefined, key, { inspectSource }), (error: any) => error.statusCode === 409);
  await assert.rejects(addDocument(actor(), another.id, malformedPdf, 'broken.pdf', undefined, key, { inspectSource }), (error: any) => error.statusCode === 409);
  assert.equal(inspections, 0);
  assert.deepEqual(await receipts(key), [originalReceipt]);
  assert.equal((await rejections(p.id)).length, 1);
  assert.equal((await rejections(another.id)).length, 0);
  assert.deepEqual(await footprint(), before);
  const accepted = await addDocument(actor(), p.id, validPdf, 'repaired.pdf', undefined, `fresh-${key}`);
  assert.equal(accepted.duplicate, false);
  assert.equal(accepted.document.mimeType, 'application/pdf');
  assert.equal((await receipts(`fresh-${key}`))[0].document_id, accepted.document.id);
  assert.deepEqual(await receipts(key), [originalReceipt]);
});

test('accepted and deleted intake receipts cannot be overwritten by an invalid retry', async () => {
  const p = await parser(), key = `accepted-source-${randomUUID()}`, bytes = Buffer.from(`Owned valid original ${suffix}`);
  const accepted = await addDocument(actor(), p.id, bytes, 'owned.txt', undefined, key);
  const originalReceipt = (await receipts(key))[0], before = await footprint();
  let inspections = 0;
  const inspectSource = async () => { inspections++; throw new SourceValidationError('pdf_invalid'); };
  for (const retryKey of [key, undefined, `fresh-${key}`]) {
    const duplicate = await addDocument(actor(), p.id, bytes, 'changed-extension.pdf', undefined, retryKey, { inspectSource });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.document.id, accepted.document.id);
  }
  await assert.rejects(addDocument(actor(), p.id, malformedPdf, 'invalid.pdf', undefined, key, { inspectSource }), (error: any) => error.statusCode === 409);
  assert.equal(inspections, 0);
  assert.deepEqual(await receipts(key), [originalReceipt]);
  assert.deepEqual(await footprint(), before);
  assert.equal((await rejections(p.id)).length, 0);

  const removed = await app.inject({ method: 'DELETE', url: `/api/documents/${accepted.document.id}`, headers: { cookie: owner.cookie, origin: config.origin } });
  assert.equal(removed.statusCode, 200, removed.body);
  const deletedReceipt = (await receipts(key))[0], afterDeletion = await footprint();
  assert.equal(deletedReceipt.document_id, null);
  assert.equal(deletedReceipt.rejection_code, null);
  for (const retryBytes of [bytes, malformedPdf]) {
    await assert.rejects(addDocument(actor(), p.id, retryBytes, 'invalid.pdf', undefined, key, { inspectSource }), (error: any) => error.statusCode === 410);
  }
  assert.equal(inspections, 0);
  assert.deepEqual(await receipts(key), [deletedReceipt]);
  assert.deepEqual(await footprint(), afterDeletion);
  assert.equal((await rejections(p.id)).length, 0);
});

test('concurrent identical permanent failures commit one receipt and one rejection audit', async () => {
  const p = await parser(), key = `concurrent-source-${randomUUID()}`, before = await footprint();
  let inspections = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const inspectSource = async () => {
    inspections++;
    if (inspections === 2) release();
    await gate;
    throw new SourceValidationError('pdf_invalid');
  };
  // Bound the rendezvous so a regression cannot leave a test waiting indefinitely.
  const timer = setTimeout(release, 5000);
  try {
    const outcomes = await Promise.allSettled([1, 2].map(() => addDocument(actor(), p.id, malformedPdf, 'concurrent.pdf', undefined, key, { inspectSource })));
    for (const outcome of outcomes) {
      assert.equal(outcome.status, 'rejected');
      if (outcome.status === 'rejected') permanent(p.id, 'pdf_invalid')(outcome.reason);
    }
  } finally { clearTimeout(timer); release(); }
  assert.equal(inspections, 2);
  assert.equal((await receipts(key)).length, 1);
  assert.equal((await rejections(p.id)).length, 1);
  assert.deepEqual(await footprint(), before);
});

test('an audit insert failure rolls back the permanent rejection receipt and leaves the intake retryable', async () => {
  const p = await parser(), key = `rollback-source-${randomUUID()}`, before = await footprint();
  const trigger = `owned_source_reject_${randomUUID().replaceAll('-', '')}`;
  const inspectSource = async () => { throw new SourceValidationError('pdf_invalid'); };
  try {
    await adminPool.query(`create function ${trigger}() returns trigger language plpgsql as $$ begin
      if NEW.workspace_id='${owner.workspace.id}'::uuid and NEW.action='document.rejected' and NEW.metadata->>'parserId'='${p.id}' then
        raise exception 'Owned source rejection audit failure';
      end if;
      return NEW;
    end $$`);
    await adminPool.query(`create trigger ${trigger} before insert on audit_events for each row execute function ${trigger}()`);
    await assert.rejects(addDocument(actor(), p.id, malformedPdf, 'rollback.pdf', undefined, key, { inspectSource }), (error: any) => {
      assert.ok(!(error instanceof SourceIntakeRejectedError));
      assert.match(error.message, /Owned source rejection audit failure/);
      return true;
    });
    assert.equal((await receipts(key)).length, 0);
    assert.equal((await rejections(p.id)).length, 0);
    assert.deepEqual(await footprint(), before);
  } finally {
    await adminPool.query(`drop trigger if exists ${trigger} on audit_events`);
    await adminPool.query(`drop function if exists ${trigger}()`);
  }
  await assert.rejects(addDocument(actor(), p.id, malformedPdf, 'rollback.pdf', undefined, key, { inspectSource }), permanent(p.id, 'pdf_invalid'));
  assert.equal((await receipts(key)).length, 1);
  assert.equal((await rejections(p.id)).length, 1);
  assert.deepEqual(await footprint(), before);
});

test('untyped 400, 413, 422 and 503 decoder failures create no permanent receipt and can retry successfully', async () => {
  for (const statusCode of [400, 413, 422, 503]) {
    const p = await parser(), key = `retryable-source-${statusCode}-${randomUUID()}`;
    const bytes = Buffer.from(`Owned temporary source failure ${statusCode} ${suffix}`), before = await footprint();
    const failure = Object.assign(new Error('PRIVATE SYNTHETIC DECODER FAILURE'), { statusCode });
    let inspections = 0;
    const inspectSource = async () => { inspections++; throw failure; };
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(addDocument(actor(), p.id, bytes, 'owned.txt', undefined, key, { inspectSource }), error => error === failure);
      assert.equal((await receipts(key)).length, 0);
      assert.equal((await rejections(p.id)).length, 0);
      assert.deepEqual(await footprint(), before);
    }
    assert.equal(inspections, 2);
    const accepted = await addDocument(actor(), p.id, bytes, 'owned.txt', undefined, key);
    assert.equal(accepted.duplicate, false);
    const receipt = (await receipts(key))[0];
    assert.equal(receipt.document_id, accepted.document.id);
    assert.equal(receipt.rejection_code, null);
    assert.equal((await rejections(p.id)).length, 0);
  }
});

test('permanent source receipts and rejection audits respect workspace boundaries before decoder work', async () => {
  const p = await parser(), otherParser = await parser(other), key = `tenant-source-${randomUUID()}`;
  await assert.rejects(addDocument(actor(), p.id, malformedPdf, 'owned.pdf', undefined, key), permanent(p.id, 'pdf_invalid'));
  const ownerReceipt = (await receipts(key))[0], otherBefore = await footprint(other);
  let inspections = 0;
  const inspectSource = async () => { inspections++; throw new SourceValidationError('pdf_invalid'); };
  await assert.rejects(addDocument(actor(other), p.id, malformedPdf, 'foreign.pdf', undefined, key, { inspectSource }), (error: any) => error.statusCode === 404);
  assert.equal(inspections, 0);
  assert.equal((await receipts(key, other)).length, 0);
  assert.deepEqual(await footprint(other), otherBefore);
  assert.equal((await withWorkspace(other.workspace.id, client => client.query('select id from intake_events where id=$1', [ownerReceipt.id]))).rowCount, 0);
  assert.equal((await withWorkspace(other.workspace.id, client => client.query("select id from audit_events where action='document.rejected' and metadata->>'parserId'=$1", [p.id]))).rowCount, 0);

  await assert.rejects(addDocument(actor(other), otherParser.id, malformedPdf, 'owned-other.pdf', undefined, key, { inspectSource }), permanent(otherParser.id, 'pdf_invalid'));
  assert.equal(inspections, 1);
  assert.equal((await receipts(key, other)).length, 1);
  assert.equal((await rejections(otherParser.id, other)).length, 1);
  assert.deepEqual(await receipts(key), [ownerReceipt]);
  assert.equal((await rejections(p.id)).length, 1);
  assert.deepEqual(await footprint(other), otherBefore);
});

test('database receipt constraints accept the source catalogue and reject mixed, incomplete and cross-workspace shapes', async () => {
  const p = await parser(), foreignParser = await parser(other), prefix = `owned-receipt-shape-${randomUUID()}`;
  const document = await addDocument(actor(), p.id, Buffer.from(`Owned receipt constraint original ${suffix}`), 'owned.txt');
  const before = await footprint(), auditsBefore = await rejections(p.id);
  const receiptCountBefore = (await adminPool.query('select count(*)::int n from intake_events where workspace_id=$1', [owner.workspace.id])).rows[0].n;
  type Shape = { documentId: string | null; code: string | null; format: string | null; reason: string | null; hash: string | null; parserId: string | null };
  const empty: Shape = { documentId: null, code: null, format: null, reason: null, hash: null, parserId: null };
  const source: Shape = { ...empty, code: 'source_validation_failed', reason: 'pdf_invalid', hash: sha256(malformedPdf), parserId: p.id };
  const policy: Shape = { ...source, code: 'parser_format_not_allowed', reason: null, format: 'pdf' };
  const invalid: { label: string; shape: Shape; constraint?: string; errorCode?: string }[] = [
    { label: 'accepted-source', shape: { ...source, documentId: document.document.id } },
    { label: 'accepted-policy', shape: { ...policy, documentId: document.document.id } },
    { label: 'accepted-reason', shape: { ...empty, documentId: document.document.id, reason: 'pdf_invalid' } },
    { label: 'accepted-hash', shape: { ...empty, documentId: document.document.id, hash: source.hash } },
    { label: 'unknown-code', shape: { ...source, code: 'unrecognized_rejection' } },
    { label: 'missing-code', shape: { ...source, code: null } },
    { label: 'unknown-reason', shape: { ...source, reason: 'unrecognized_source_reason' } },
    { label: 'missing-reason', shape: { ...source, reason: null } },
    { label: 'source-with-format', shape: { ...source, format: 'pdf' } },
    { label: 'source-missing-hash', shape: { ...source, hash: null } },
    { label: 'source-short-hash', shape: { ...source, hash: 'abc123' } },
    { label: 'source-uppercase-hash', shape: { ...source, hash: 'A'.repeat(64) } },
    { label: 'source-missing-parser', shape: { ...source, parserId: null } },
    { label: 'policy-with-reason', shape: { ...policy, reason: 'pdf_invalid' } },
    { label: 'policy-missing-format', shape: { ...policy, format: null } },
    { label: 'policy-unknown-format', shape: { ...policy, format: 'exe' } },
    { label: 'policy-missing-hash', shape: { ...policy, hash: null } },
    { label: 'policy-missing-parser', shape: { ...policy, parserId: null } },
    { label: 'source-foreign-parser', shape: { ...source, parserId: foreignParser.id }, constraint: 'intake_rejected_parser', errorCode: '23503' },
    { label: 'policy-foreign-parser', shape: { ...policy, parserId: foreignParser.id }, constraint: 'intake_rejected_parser', errorCode: '23503' },
  ];

  // These direct inserts test database shape constraints only. They are removed
  // in this transaction and do not represent application intake decisions.
  await withWorkspace(owner.workspace.id, async client => {
    const insert = (label: string, shape: Shape) => client.query(
      'insert into intake_events(workspace_id,idempotency_key,document_id,rejection_code,rejection_format,rejection_reason,rejection_sha256,rejected_parser_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning id,rejection_reason',
      [owner.workspace.id, `${prefix}-${label}`, shape.documentId, shape.code, shape.format, shape.reason, shape.hash, shape.parserId]);
    const fixtureIds: string[] = [];
    for (const reason of Object.keys(sourceValidationReasons)) {
      const result = await insert(`source-${reason}`, { ...source, reason });
      assert.equal(result.rows[0].rejection_reason, reason);
      fixtureIds.push(result.rows[0].id);
    }
    for (const [label, shape] of [['accepted', { ...empty, documentId: document.document.id }], ['deleted', empty], ['policy', policy]] as const) {
      fixtureIds.push((await insert(label, shape)).rows[0].id);
    }
    assert.equal(new Set(fixtureIds).size, Object.keys(sourceValidationReasons).length + 3);
    for (const item of invalid) {
      await client.query('savepoint owned_invalid_receipt');
      try {
        await assert.rejects(insert(item.label, item.shape), (error: any) => {
          assert.equal(error.code, item.errorCode ?? '23514', item.label);
          assert.equal(error.constraint, item.constraint ?? 'intake_rejection_shape', item.label);
          return true;
        }, item.label);
      } finally {
        await client.query('rollback to savepoint owned_invalid_receipt');
        await client.query('release savepoint owned_invalid_receipt');
      }
    }
    const removed = await client.query('delete from intake_events where workspace_id=$1 and id=any($2::uuid[])', [owner.workspace.id, fixtureIds]);
    assert.equal(removed.rowCount, fixtureIds.length);
  });
  assert.equal((await adminPool.query('select count(*)::int n from intake_events where workspace_id=$1', [owner.workspace.id])).rows[0].n, receiptCountBefore);
  assert.deepEqual(await rejections(p.id), auditsBefore);
  assert.deepEqual(await footprint(), before);
});
