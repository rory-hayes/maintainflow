import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase, databaseSchema, quoteIdentifier, withWorkspace } from '../server/core/db.js';
import { hashToken, newToken } from '../server/core/auth.js';
import { config } from '../server/core/config.js';
import { processOneCoreJob } from '../server/core/worker.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
type Key = { apiKey: { id: string; expiresAt: string | null }; token: string };
const fullScopes = ['parsers:read', 'documents:read', 'documents:write', 'results:read'];
const accounts: Account[] = [];
let app: FastifyInstance, owner: Account, outsider: Account, member: Account;
let parserId: string, documentId: string, jobId: string, runId: string;
const bytes = Buffer.from('SYNTHETIC OWNED API EXPIRY FIXTURE\nReference: EXPIRY-000042');

async function sessionRequest(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, caller = owner, workspaceId?: string) {
  return app.inject({ method, url, payload: payload as any, headers: {
    cookie: caller.cookie, origin: config.origin, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  } });
}

async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: `Owned expiry ${label}`, email: `api-expiry-${label}-${randomUUID()}@example.test`,
    password: 'owned API expiry fixture password', workspaceName: `Owned expiry ${label}`,
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  accounts.push(account); return account;
}

async function futureExpiry() {
  return (await adminPool.query("select now()+interval '1 day' expires_at")).rows[0].expires_at.toISOString() as string;
}

async function makeKey(options: { scopes?: string[]; expiresAt?: string | null; caller?: Account; workspaceId?: string } = {}): Promise<Key> {
  const response = await sessionRequest('POST', '/api/workspace/api-keys', {
    name: `Owned API expiry ${randomUUID()}`, scopes: options.scopes ?? fullScopes,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  }, options.caller ?? owner, options.workspaceId);
  assert.equal(response.statusCode, 200, response.body); return response.json();
}

async function bearerGet(url: string, key: Key) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${key.token}` } });
}

async function upload(key?: Key, content = bytes) {
  const boundary = `owned-expiry-${randomUUID()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned-expiry.txt"\r\nContent-Type: text/plain\r\n\r\n`),
    content, Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({ method: 'POST', url: `/api/parsers/${parserId}/documents`, payload, headers: {
    ...(key ? { authorization: `Bearer ${key.token}` } : { cookie: owner.cookie, origin: config.origin }),
    'content-type': `multipart/form-data; boundary=${boundary}`,
  } });
}

async function keyAndAuditCounts() {
  return (await adminPool.query(`select
    (select count(*)::int from api_keys where workspace_id=$1) keys,
    (select count(*)::int from audit_events where workspace_id=$1 and action='api_key.created') audits`, [owner.workspace.id])).rows[0];
}

async function intakeCounts() {
  const counts: Record<string, number> = {};
  for (const table of ['documents', 'jobs', 'extraction_runs', 'usage_ledger', 'intake_events', 'intake_files']) {
    counts[table] = (await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`, [owner.workspace.id])).rows[0].n;
  }
  return counts;
}

const lastUsed = async (key: Key) => (await adminPool.query('select last_used_at from api_keys where id=$1', [key.apiKey.id])).rows[0].last_used_at?.toISOString() ?? null;

before(async () => {
  app = await buildApp(); await app.ready();
  owner = await signup('owner'); outsider = await signup('outsider'); member = await signup('member');
  const parser = await sessionRequest('POST', '/api/parsers', { name: 'Owned expiry parser', useCase: 'custom', mode: 'rules',
    schema: { fields: [{ key: 'reference', label: 'Reference', type: 'string', required: true }] },
  });
  assert.equal(parser.statusCode, 201, parser.body); parserId = parser.json().parser.id;
  const accepted = await upload(); assert.equal(accepted.statusCode, 202, accepted.body);
  documentId = accepted.json().document.id; jobId = accepted.json().jobId;
  // Process only this owned fixture, never unrelated queued work.
  assert.equal(await processOneCoreJob(jobId), true);
  const detail = await sessionRequest('GET', `/api/documents/${documentId}`);
  assert.equal(detail.statusCode, 200, detail.body); runId = detail.json().document.latestRunId;
  assert.ok(runId);
});

after(async () => {
  await app?.close();
  for (const account of accounts) {
    await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
    await fs.rm(path.join(config.storageDir, account.workspace.id), { recursive: true, force: true });
  }
  for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
  await closeDatabase();
});

test('invalid, timezone-less and past expiry values reject without creating a key or audit', async () => {
  const beforeCounts = await keyAndAuditCounts();
  const past = (await adminPool.query("select now()-interval '1 minute' expires_at")).rows[0].expires_at.toISOString();
  for (const expiresAt of [
    '', 'not-a-date', '2099-01-01', '2099-01-01T12:00:00', '2099-02-30T12:00:00Z',
    '2099-01-01T12:00:00+25:00', '0000-01-01T00:00:00Z', '9999-12-31T23:59:59-23:59', 42, false, {}, past,
  ]) {
    const response = await sessionRequest('POST', '/api/workspace/api-keys', { name: 'Owned rejected expiry', scopes: fullScopes, expiresAt });
    assert.equal(response.statusCode, 400, `expiry ${JSON.stringify(expiresAt)}: ${response.body}`);
    assert.equal(response.json().token, undefined);
  }
  assert.deepEqual(await keyAndAuditCounts(), beforeCounts);
});

test('an explicit offset expiry is normalized, returned, and committed with a redacted audit', async () => {
  const key = await makeKey({ expiresAt: '2099-06-01T13:30:00+01:30', scopes: ['documents:read', 'documents:read'] });
  assert.equal(key.apiKey.expiresAt, '2099-06-01T12:00:00.000Z');
  const stored = (await adminPool.query('select expires_at,token_hash,scopes from api_keys where id=$1', [key.apiKey.id])).rows[0];
  assert.equal(stored.expires_at.toISOString(), key.apiKey.expiresAt);
  assert.equal(stored.token_hash, hashToken(key.token)); assert.deepEqual(stored.scopes, ['documents:read']);
  const audits = (await adminPool.query("select user_id,metadata from audit_events where entity_id=$1 and action='api_key.created'", [key.apiKey.id])).rows;
  assert.equal(audits.length, 1); assert.equal(audits[0].user_id, owner.user.id);
  assert.deepEqual(audits[0].metadata, { scopes: ['documents:read'], expiresAt: key.apiKey.expiresAt });
  assert.ok(!JSON.stringify(audits).includes(key.token)); assert.ok(!JSON.stringify(audits).includes(stored.token_hash));
});

test('a future key works, then expiry rejects original, result, job and upload access before last-used or intake changes', async () => {
  const key = await makeKey({ expiresAt: await futureExpiry() });
  const urls = [`/api/documents/${documentId}`, `/api/documents/${documentId}/original`, `/api/documents/${documentId}/original-url`, `/api/jobs/${jobId}`, `/api/runs/${runId}`];
  for (const url of urls) assert.equal((await bearerGet(url, key)).statusCode, 200, url);
  const accepted = await upload(key, Buffer.from('SYNTHETIC OWNED FUTURE KEY\nReference: EXPIRY-ACTIVE'));
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.ok(await lastUsed(key));
  await adminPool.query('update api_keys set expires_at=now() where id=$1', [key.apiKey.id]);
  const beforeUsed = await lastUsed(key), beforeCounts = await intakeCounts();
  for (const url of urls) {
    const response = await bearerGet(url, key); assert.equal(response.statusCode, 401, `${url}: ${response.body}`);
    assert.match(response.json().message, /expired/);
  }
  assert.equal((await upload(key, Buffer.from('SYNTHETIC OWNED REJECTED UPLOAD\nReference: EXPIRED'))).statusCode, 401);
  assert.equal(await lastUsed(key), beforeUsed); assert.deepEqual(await intakeCounts(), beforeCounts);
  assert.equal((await sessionRequest('GET', `/api/documents/${documentId}`)).statusCode, 200);
});

test('omitted and null expiry preserve non-expiring keys, including inserts using the legacy columns', async () => {
  const omitted = await makeKey(), explicitNull = await makeKey({ expiresAt: null });
  const legacy: Key = { apiKey: { id: randomUUID(), expiresAt: null }, token: `fl_${newToken()}` };
  await adminPool.query(`insert into api_keys(id,workspace_id,user_id,name,prefix,token_hash,scopes,created_at)
    values($1,$2,$3,$4,$5,$6,$7,'2000-01-01T00:00:00Z')`, [legacy.apiKey.id, owner.workspace.id, owner.user.id,
    'Owned legacy key', legacy.token.slice(0, 10), hashToken(legacy.token), JSON.stringify(fullScopes)]);
  for (const key of [omitted, explicitNull, legacy]) {
    assert.equal(key.apiKey.expiresAt, null);
    assert.equal((await adminPool.query('select expires_at from api_keys where id=$1', [key.apiKey.id])).rows[0].expires_at, null);
    assert.equal((await bearerGet(`/api/documents/${documentId}/original`, key)).statusCode, 200);
  }
  const listed = (await sessionRequest('GET', '/api/workspace/api-keys')).json().apiKeys;
  for (const key of [omitted, explicitNull, legacy]) {
    const entry = listed.find((item: any) => item.id === key.apiKey.id);
    assert.equal(entry.expiresAt, null); assert.equal(entry.status, 'active');
  }
});

test('the database-clock boundary excludes exact equality and the past but permits a strictly future instant', async t => {
  const key = await makeKey({ expiresAt: await futureExpiry() });
  // Use an independent connection so a private-schema pool with max=1 can
  // still run its normal BEGIN/search_path/COMMIT wrappers during each request.
  const client = new pg.Client(adminPool.options);
  await client.connect();
  const boundaryQuery = client.query.bind(client), originalQuery = pg.Client.prototype.query;
  try {
    await boundaryQuery('BEGIN');
    await boundaryQuery("select set_config('search_path',$1,true)", [`${quoteIdentifier(databaseSchema)},pg_catalog,pg_temp`]);
    const intercepted = { authentication: 0, lastUsed: 0 };
    // Intercept the actual driver, below scopeDatabasePool's synthesized query
    // method. Only this key's real auth SQL uses the pinned PostgreSQL clock.
    // Forward all arguments, including pg.Pool's callback, without rewriting SQL.
    const queryMock = t.mock.method(pg.Client.prototype, 'query', (function(this: pg.Client, ...args: any[]) {
      const sql = args[0], values = args[1];
      if (typeof sql === 'string' && Array.isArray(values)) {
        if (sql.includes('from api_keys k') && values[0] === hashToken(key.token)) {
          intercepted.authentication++;
          return (boundaryQuery as any)(...args);
        }
        if (sql.includes('update api_keys set last_used_at') && values[0] === key.apiKey.id) {
          intercepted.lastUsed++;
          return (boundaryQuery as any)(...args);
        }
      }
      return (originalQuery as any).apply(this, args);
    }) as typeof pg.Client.prototype.query);
    try {
      for (const [microseconds, expected] of [[-1, 401], [0, 401], [1, 200]] as const) {
        const before = { ...intercepted };
        const boundary = (await boundaryQuery(`update api_keys set expires_at=now()+($2::int*interval '1 microsecond'),last_used_at=null
          where id=$1 returning expires_at=now() at_boundary`, [key.apiKey.id, microseconds])).rows[0];
        assert.equal(boundary.at_boundary, microseconds === 0);
        const response = await bearerGet('/api/parsers', key); assert.equal(response.statusCode, expected, response.body);
        assert.equal(intercepted.authentication, before.authentication + 1, 'the real bearer query reached the boundary transaction');
        assert.equal(intercepted.lastUsed, before.lastUsed + (expected === 200 ? 1 : 0));
        const used = (await boundaryQuery('select last_used_at from api_keys where id=$1', [key.apiKey.id])).rows[0].last_used_at;
        if (expected === 401) assert.equal(used, null); else assert.ok(used);
      }
    } finally {
      queryMock.mock.restore(); await boundaryQuery('ROLLBACK');
    }
  } finally {
    await client.end();
  }
});

test('expiry does not widen scopes, tenant access, roles or session-only key management', async () => {
  const readOnly = await makeKey({ expiresAt: await futureExpiry(), scopes: ['documents:read'] });
  assert.equal((await upload(readOnly)).statusCode, 403);
  assert.equal((await bearerGet(`/api/runs/${runId}`, readOnly)).statusCode, 403);
  assert.equal(await lastUsed(readOnly), null);
  assert.equal((await bearerGet('/api/workspace/api-keys', readOnly)).statusCode, 403);
  await adminPool.query('update api_keys set expires_at=now() where id=$1', [readOnly.apiKey.id]);
  assert.equal((await upload(readOnly)).statusCode, 401);
  assert.equal((await bearerGet(`/api/runs/${runId}`, readOnly)).statusCode, 401);
  assert.equal((await bearerGet('/api/workspace/api-keys', readOnly)).statusCode, 401);

  const foreign = await makeKey({ expiresAt: await futureExpiry(), caller: outsider });
  for (const url of [`/api/documents/${documentId}/original`, `/api/runs/${runId}`]) assert.equal((await bearerGet(url, foreign)).statusCode, 404);
  assert.equal((await upload(foreign)).statusCode, 404);
  assert.equal((await sessionRequest('DELETE', `/api/workspace/api-keys/${readOnly.apiKey.id}`, undefined, outsider)).statusCode, 404);
  assert.equal((await withWorkspace(outsider.workspace.id, c => c.query('select id from api_keys where id=$1', [readOnly.apiKey.id]))).rowCount, 0);

  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'admin')", [owner.workspace.id, member.user.id]);
  const memberKey = await makeKey({ expiresAt: await futureExpiry(), caller: member, workspaceId: owner.workspace.id });
  await adminPool.query("update memberships set role='viewer' where workspace_id=$1 and user_id=$2", [owner.workspace.id, member.user.id]);
  assert.equal((await upload(memberKey)).statusCode, 403);
  const counts = await keyAndAuditCounts();
  assert.equal((await sessionRequest('POST', '/api/workspace/api-keys', { name: 'Owned denied viewer key', scopes: fullScopes, expiresAt: await futureExpiry() }, member, owner.workspace.id)).statusCode, 403);
  assert.deepEqual(await keyAndAuditCounts(), counts);
  await adminPool.query('update api_keys set expires_at=now() where id=$1', [memberKey.apiKey.id]);
  const used = await lastUsed(memberKey);
  assert.equal((await upload(memberKey)).statusCode, 401); assert.equal(await lastUsed(memberKey), used);
});

test('listing returns server-derived expiry states, revoked precedence and no key material across workspaces', async () => {
  const active = await makeKey({ expiresAt: await futureExpiry() }), expired = await makeKey({ expiresAt: await futureExpiry() });
  const revoked = await makeKey({ expiresAt: await futureExpiry() });
  await adminPool.query('update api_keys set expires_at=now() where id=any($1::uuid[])', [[expired.apiKey.id, revoked.apiKey.id]]);
  assert.equal((await sessionRequest('DELETE', `/api/workspace/api-keys/${revoked.apiKey.id}`)).statusCode, 200);
  const response = await sessionRequest('GET', '/api/workspace/api-keys'); assert.equal(response.statusCode, 200, response.body);
  for (const [key, status] of [[active, 'active'], [expired, 'expired'], [revoked, 'revoked']] as const) {
    const entry = response.json().apiKeys.find((item: any) => item.id === key.apiKey.id);
    assert.equal(entry.status, status); assert.ok(entry.expiresAt);
    assert.equal(entry.token, undefined); assert.equal(entry.tokenHash, undefined); assert.equal(entry.token_hash, undefined);
    assert.ok(!response.body.includes(key.token)); assert.ok(!response.body.includes(hashToken(key.token)));
  }
  assert.equal((await bearerGet(`/api/documents/${documentId}`, revoked)).statusCode, 401);
  const foreignList = (await sessionRequest('GET', '/api/workspace/api-keys', undefined, outsider)).json().apiKeys;
  assert.ok(!foreignList.some((entry: any) => [active, expired, revoked].some(key => key.apiKey.id === entry.id)));
});

test('an audit insertion failure rolls back the expiring key and never returns its token', async () => {
  const counts = await keyAndAuditCounts(), fixture = `owned_key_expiry_audit_${randomUUID().replaceAll('-', '')}`;
  try {
    await adminPool.query(`create function ${fixture}() returns trigger language plpgsql as $$ begin
      if NEW.workspace_id='${owner.workspace.id}'::uuid and NEW.action='api_key.created' then
        raise exception 'Owned API expiry audit fixture failure';
      end if;
      return NEW;
    end $$`);
    await adminPool.query(`create trigger ${fixture} before insert on audit_events for each row execute function ${fixture}()`);
    const response = await sessionRequest('POST', '/api/workspace/api-keys', { name: 'Owned rollback key', scopes: fullScopes, expiresAt: await futureExpiry() });
    assert.equal(response.statusCode, 500, response.body); assert.equal(response.json().token, undefined);
    assert.deepEqual(await keyAndAuditCounts(), counts);
  } finally {
    await adminPool.query(`drop trigger if exists ${fixture} on audit_events`);
    await adminPool.query(`drop function if exists ${fixture}()`);
  }
});
