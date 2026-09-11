import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { config } from '../server/core/config.js';
import { adminPool, closeDatabase } from '../server/core/db.js';
import { PLANS } from '../shared/plans.js';

type Account = { user: { id: string; email: string }; workspace: { id: string; plan: Record<string, unknown> }; cookie: string };
const explore = PLANS.find(plan => plan.id === 'explore')!;
const expectedPlan = {
  id: explore.id, name: explore.name, monthlyPages: explore.monthlyPages,
  maxParsers: explore.maxParsers, maxConcurrent: explore.maxConcurrent,
  maxBytes: config.maxBytes, maxPages: config.maxPages,
};
const workspaceIds: string[] = [], userIds: string[] = [];
const password = 'owned signup entitlement fixture password';
let app: FastifyInstance;

async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: 'Owned signup entitlement fixture', email: `signup-${label}-${randomUUID()}@example.test`, password,
    workspaceName: `Owned signup ${label}`, plan: { id: 'team', monthlyPages: 999999, maxParsers: 999999 },
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  workspaceIds.push(account.workspace.id); userIds.push(account.user.id);
  return account;
}
const storedPlan = async (id: string) => (await adminPool.query('select plan from workspaces where id=$1', [id])).rows[0].plan;
const headers = (account: Account) => ({ origin: config.origin, cookie: account.cookie });
async function upload(account: Account, parserId: string, content: string) {
  const boundary = `owned-signup-${randomUUID()}`;
  return app.inject({ method: 'POST', url: `/api/parsers/${parserId}/documents`, headers: {
    ...headers(account), 'content-type': `multipart/form-data; boundary=${boundary}`,
  }, payload: Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owned-signup.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`) });
}

before(async () => { app = await buildApp(); });
after(async () => {
  await app?.close();
  for (const id of workspaceIds) {
    await adminPool.query('delete from workspaces where id=$1', [id]);
    await fs.rm(path.join(config.storageDir, id), { recursive: true, force: true });
  }
  for (const id of userIds) await adminPool.query('delete from users where id=$1', [id]);
  await closeDatabase();
});

test('new registration persists the advertised Explore entitlements and ignores client supplied plan limits', async () => {
  const account = await signup('defaults');
  assert.deepEqual(account.workspace.plan, expectedPlan);
  assert.deepEqual(await storedPlan(account.workspace.id), expectedPlan);
  await app.close(); app = await buildApp();
  for (const url of ['/api/auth/me', '/api/workspace/usage']) {
    const response = await app.inject({ method: 'GET', url, headers: headers(account) });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(url.endsWith('/me') ? response.json().workspace.plan : response.json().plan, expectedPlan);
  }
});

test('a new Explore workspace enforces its parser limit and final monthly page at intake', async () => {
  const account = await signup('limits');
  const parser = await app.inject({ method: 'POST', url: '/api/parsers', headers: headers(account), payload: { name: 'Owned signup parser', useCase: 'receipt' } });
  assert.equal(parser.statusCode, 201, parser.body);
  const extra = await app.inject({ method: 'POST', url: '/api/parsers', headers: headers(account), payload: { name: 'Beyond Explore limit', useCase: 'receipt' } });
  assert.equal(extra.statusCode, 429, extra.body);
  assert.match(extra.json().message, /parser limit/);
  // Model already metered work to exercise the real intake boundary without 49 redundant uploads.
  await adminPool.query('insert into usage_ledger(workspace_id,event,pages,idempotency_key) values($1,$2,$3,$4)',
    [account.workspace.id, 'owned-signup-fixture', explore.monthlyPages - 1, randomUUID()]);
  const accepted = await upload(account, parser.json().parser.id, 'Merchant: Owned signup fixture\nTotal: 12.50\nCurrency: EUR');
  assert.equal(accepted.statusCode, 202, accepted.body);
  const rejected = await upload(account, parser.json().parser.id, 'Merchant: Over quota fixture\nTotal: 13.50\nCurrency: EUR');
  assert.equal(rejected.statusCode, 429, rejected.body);
  assert.match(rejected.json().message, /Monthly page quota/);
  assert.equal((await adminPool.query('select sum(pages)::int pages from usage_ledger where workspace_id=$1', [account.workspace.id])).rows[0].pages, explore.monthlyPages);
  assert.equal((await adminPool.query('select count(*)::int count from documents where workspace_id=$1', [account.workspace.id])).rows[0].count, 1);
});

test('login preserves existing workspace entitlements while an additional workspace starts on Explore', async () => {
  const account = await signup('existing');
  const legacyPlan = { name: 'Local development', monthlyPages: 1000, maxParsers: 25, maxConcurrent: 2, maxBytes: config.maxBytes, maxPages: config.maxPages };
  await adminPool.query('update workspaces set plan=$2 where id=$1', [account.workspace.id, JSON.stringify(legacyPlan)]);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: config.origin }, payload: { email: account.user.email, password } });
  assert.equal(login.statusCode, 200, login.body);
  assert.deepEqual(login.json().workspace.plan, legacyPlan);
  const response = await app.inject({ method: 'POST', url: '/api/workspaces', headers: headers(account), payload: { name: 'Owned additional signup workspace' } });
  assert.equal(response.statusCode, 200, response.body);
  const workspace = response.json().workspace; workspaceIds.push(workspace.id);
  assert.deepEqual(workspace.plan, expectedPlan);
  assert.deepEqual(await storedPlan(workspace.id), expectedPlan);
  assert.deepEqual(await storedPlan(account.workspace.id), legacyPlan);
});
