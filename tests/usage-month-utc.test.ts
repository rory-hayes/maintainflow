/** Real routes and owned fixtures only; requires an isolated copied database or CI. */
import test, {before, after, mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import {ZodError} from 'zod';
import {registerCore} from '../server/core/index.js';
import {adminPool, appPool, closeDatabase, databaseSchema, withWorkspace} from '../server/core/db.js';
import {config} from '../server/core/config.js';
import {setStorageForTests, type PrivateStorage} from '../server/core/storage.js';

type Account = {user: {id: string}; workspace: {id: string}; cookie: string};
const accounts: Account[] = [], objects = new Map<string, Buffer>();
let app: FastifyInstance, isolated = false, networkCalls = 0;
const storage: PrivateStorage = {
  kind: 'filesystem',
  async write(key, bytes) { objects.set(key, Buffer.from(bytes)); },
  async read(key) { const bytes = objects.get(key); assert.ok(bytes); return Buffer.from(bytes); },
  async remove(key) { objects.delete(key); },
};
const request = (account: Account, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({method, url, payload: payload as any, headers: {cookie: account.cookie, origin: config.origin, ...headers}});
async function upload(account: Account, parserId: string) {
  const boundary = `owned-${randomUUID()}`;
  const payload = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="utc-month.txt"\r\nContent-Type: text/plain\r\n\r\nSYNTHETIC UTC MONTH FIXTURE ${randomUUID()}\r\n--${boundary}--\r\n`);
  return request(account, 'POST', `/api/parsers/${parserId}/documents`, payload, {'content-type': `multipart/form-data; boundary=${boundary}`});
}
async function usage(account: Account) {
  const response = await request(account, 'GET', '/api/workspace/usage');
  assert.equal(response.statusCode, 200, response.body);
  return response.json().usage;
}

before(async () => {
  assert.equal(databaseSchema, 'public');
  assert.equal(process.env.NODE_ENV, 'test');
  const pools = [[adminPool, 'folio_admin'], [appPool, 'folio_app']] as const;
  const urlMode = Boolean(adminPool.options.connectionString || appPool.options.connectionString);
  if (urlMode) {
    assert.ok(process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true');
    for (const [pool, role] of pools) {
      assert.equal(typeof pool.options.connectionString, 'string');
      const url = new URL(pool.options.connectionString!);
      assert.ok(['postgres:', 'postgresql:'].includes(url.protocol));
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
      assert.equal(url.pathname, '/folio'); assert.equal(url.port || '5432', '5432');
      assert.equal(decodeURIComponent(url.username), role); assert.equal(url.search, ''); assert.equal(url.hash, '');
    }
  } else {
    assert.ok(config.root.startsWith('/private/tmp/') || config.root.startsWith('/tmp/'), 'Never use the ordinary checkout database');
    for (const [pool, role] of pools) {
      assert.equal(path.resolve(pool.options.host!), path.resolve(config.root, '.local/socket'));
      assert.equal(pool.options.port, 55432); assert.equal(pool.options.database, 'folio'); assert.equal(pool.options.user, role);
    }
  }
  // Keep exactly one application session alive so its deliberately non-UTC
  // timezone applies to every real route transaction in this isolated file.
  assert.equal(appPool.totalCount, 0);
  appPool.options.max = 1;
  appPool.options.idleTimeoutMillis = 0;
  for (const [pool, role] of pools) {
    const row = (await pool.query("select current_database() db,current_schema() schema,current_user role,current_setting('port')::int port,inet_server_addr()::text address")).rows[0];
    assert.equal(row.db, 'folio'); assert.equal(row.schema, 'public'); assert.equal(row.role, role);
    assert.equal(row.port, urlMode ? 5432 : 55432); if (!urlMode) assert.equal(row.address, null);
  }
  isolated = true;
  setStorageForTests(storage);
  const deny = () => { networkCalls++; throw new Error('External requests are forbidden in UTC month fixtures'); };
  mock.method(globalThis, 'fetch', deny); mock.method(http, 'request', deny); mock.method(https, 'request', deny);
  app = Fastify({logger: false});
  await app.register(cookie); await app.register(multipart);
  app.setErrorHandler((error: any, _req, reply) => reply.code(error instanceof ZodError ? 400 : error.statusCode || 500).send({message: error.message}));
  await registerCore(app); await app.ready();
});
after(async () => {
  try {
    await app?.close();
    if (isolated) {
      for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
      for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
    }
    assert.equal(networkCalls, 0);
  } finally { mock.restoreAll(); setStorageForTests(undefined); objects.clear(); await closeDatabase(); }
});

test('UTC month boundary governs real upload quotas and usage/cost totals in east and west database sessions', async () => {
  for (const timezone of ['Pacific/Kiritimati', 'Pacific/Honolulu']) {
    await appPool.query("select set_config('TimeZone',$1,false)", [timezone]);
    const registration = await app.inject({method: 'POST', url: '/api/auth/register', headers: {origin: config.origin},
      payload: {name: 'Owned UTC month fixture', workspaceName: 'Owned UTC month fixture', email: `utc-month-${randomUUID()}@example.test`, password: 'Owned UTC month fixture password'}});
    assert.equal(registration.statusCode, 201, registration.body);
    const account: Account = {...registration.json(), cookie: registration.cookies.map(c => `${c.name}=${c.value}`).join('; ')};
    accounts.push(account);
    const workspaceId = account.workspace.id;
    const session = await withWorkspace(workspaceId, async c => (await c.query("select now() instant,current_setting('TimeZone') timezone")).rows[0]);
    assert.equal(session.timezone, timezone);
    // Derive expected boundaries from UTC calendar fields, not the SQL being tested.
    const instant = new Date(session.instant), start = Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), 1);
    const stamps = [new Date(start - 1), new Date(start), new Date(start + 1)];
    await adminPool.query("update workspaces set plan=jsonb_set(plan,'{monthlyPages}','3') where id=$1", [workspaceId]);
    const created = await request(account, 'POST', '/api/parsers', {name: 'Owned UTC month parser', useCase: 'custom', mode: 'rules',
      schema: {fields: [{key: 'reference', label: 'Reference', type: 'string', required: false}]}});
    assert.equal(created.statusCode, 201, created.body);
    const parserId = created.json().parser.id;
    const first = await upload(account, parserId);
    assert.equal(first.statusCode, 202, first.body);
    const documentId = first.json().document.id;
    const doc = (await adminPool.query('select d.sha256,p.active_schema_id from documents d join parsers p on p.id=d.parser_id where d.id=$1', [documentId])).rows[0];
    await adminPool.query('update usage_ledger set created_at=$2 where document_id=$1', [documentId, stamps[1]]);
    for (const [index, pages] of [[0, 100], [2, 1]]) {
      await adminPool.query("insert into usage_ledger(workspace_id,event,pages,idempotency_key,created_at) values($1,'synthetic-month-boundary',$2,$3,$4)", [workspaceId, pages, randomUUID(), stamps[index]]);
    }
    for (const [index, extractionCost, suggestionCost] of [[0, 7, 9], [1, 0.01, 0.04], [2, 0.02, 0.05]]) {
      await adminPool.query(`insert into extraction_runs(workspace_id,document_id,schema_version_id,engine,model,prompt_version,document_sha256,raw_values,normalized_values,evidence,issues,cost_usd,created_at)
        values($1,$2,$3,'synthetic-fixture','synthetic-fixture','synthetic-fixture',$4,'{}','{}','[]','[]',$5,$6)`, [workspaceId, documentId, doc.active_schema_id, doc.sha256, extractionCost, stamps[index]]);
      await adminPool.query(`insert into schema_suggestions(workspace_id,parser_id,document_id,base_schema_id,request_id,document_sha256,config,state,proposed_schema,model,prompt_version,cost_usd,created_at,completed_at)
        values($1,$2,$3,$4,$5,$6,'{}','ready','{"fields":[]}','synthetic-fixture','synthetic-fixture',$7,$8,$8)`, [workspaceId, parserId, documentId, doc.active_schema_id, randomUUID(), doc.sha256, suggestionCost, stamps[index]]);
    }
    const initial = await usage(account);
    assert.equal(initial.pages, 2); assert.equal(initial.events, 2);
    assert.equal(initial.extractionCostUsd, 0.03); assert.equal(initial.schemaSuggestionCostUsd, 0.09);
    assert.equal(initial.schemaSuggestions, 2); assert.equal(initial.costUsd, 0.12);
    const allowed = await upload(account, parserId);
    assert.equal(allowed.statusCode, 202, allowed.body);
    const refused = await upload(account, parserId);
    assert.equal(refused.statusCode, 429, refused.body);
    assert.match(refused.json().message, /Monthly page quota reached/);
    const full = await usage(account);
    assert.equal(full.pages, 3); assert.equal(full.events, 3); assert.equal(full.documents, 2);
    assert.equal(full.costUsd, 0.12); assert.equal(full.schemaSuggestions, 2);
    assert.equal((await withWorkspace(workspaceId, async c => (await c.query("show TimeZone")).rows[0])).TimeZone, timezone);
  }
});
