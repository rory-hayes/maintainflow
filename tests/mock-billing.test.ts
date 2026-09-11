import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { buildApp } from '../server/app.js';
import { config } from '../server/core/config.js';
import { adminPool, closeDatabase } from '../server/core/db.js';
import { mockBillingEnabled } from '../server/integrations/mock-billing.js';
import { reconcileStripeCustomer } from '../server/integrations/providers.js';

type Account = { user: { id: string }; workspace: { id: string }; cookie: string };
const keys = ['FOLIO_BILLING_MOCK', 'NODE_ENV', 'RESEND_INBOUND_ENABLED'] as const;
const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
const accounts: Account[] = [];
let app: FastifyInstance, owner: Account, outsider: Account;
async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: 'Owned mock billing fixture', email: `mock-${label}-${randomUUID()}@example.test`, password: 'owned mock billing fixture password', workspaceName: `Owned mock billing ${label}`,
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  accounts.push(account); return account;
}
const request = (url: string, payload: unknown = {}, account = owner, headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: payload as any, headers: { cookie: account.cookie, origin: config.origin, ...headers } });
const select = (planId: string) => request('/api/billing/mock/plan', { planId });
const stored = async () => (await adminPool.query('select plan from workspaces where id=$1', [owner.workspace.id])).rows[0].plan;
const audit = async () => (await adminPool.query("select * from audit_events where workspace_id=$1 and action like 'billing.mock_%' order by created_at,id", [owner.workspace.id])).rows;

before(async () => {
  process.env.FOLIO_BILLING_MOCK = 'true'; process.env.NODE_ENV = 'test'; process.env.RESEND_INBOUND_ENABLED = 'false';
  app = await buildApp(); owner = await signup('owner'); outsider = await signup('outsider');
});
after(async () => {
  await app?.close();
  for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
  for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
  for (const key of keys) { if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key]; }
  await closeDatabase();
});

test('mock billing requires exact explicit opt-in and is unavailable in production', async () => {
  assert.equal(mockBillingEnabled({}), false);
  assert.equal(mockBillingEnabled({ FOLIO_BILLING_MOCK: '1' }), false);
  assert.equal(mockBillingEnabled({ FOLIO_BILLING_MOCK: 'true', NODE_ENV: 'development' }), true);
  assert.equal(mockBillingEnabled({ FOLIO_BILLING_MOCK: 'true', NODE_ENV: 'production' }), false);
  assert.equal(mockBillingEnabled({ FOLIO_BILLING_MOCK: 'true', NODE_ENV: 'production', FOLIO_PREVIEW_MODE:'true' }), false);
  assert.equal(mockBillingEnabled({ FOLIO_BILLING_MOCK: 'true', NODE_ENV: 'production', FOLIO_PREVIEW_MODE:'true', FOLIO_PREVIEW_INVITE_CODE:'owned-preview-fixture-'.repeat(3) }), true);
  const before = await stored();
  for (const mode of ['production', 'disabled']) {
    process.env.NODE_ENV = mode === 'production' ? 'production' : 'test';
    process.env.FOLIO_BILLING_MOCK = mode === 'disabled' ? 'false' : 'true';
    assert.equal((await select('team')).statusCode, 404);
    assert.equal((await request('/api/billing/mock/cancel')).statusCode, 404);
    assert.deepEqual(await stored(), before);
  }
  process.env.NODE_ENV = 'test'; process.env.FOLIO_BILLING_MOCK = 'true';
});

test('mock select, change and cancel persist real local limits and audit across an app restart without billing records', async () => {
  const first = await select('standard'); assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().mode, 'mock'); assert.equal(first.json().changed, true);
  assert.equal((await stored()).monthlyPages, 1000); assert.equal((await stored()).name, 'Standard (local mock)');
  assert.equal((await select('standard')).json().changed, false); assert.equal((await audit()).length, 1);
  assert.equal((await select('team')).statusCode, 200);
  await app.close(); app = await buildApp();
  const usage = await app.inject({ method: 'GET', url: '/api/workspace/usage', headers: { cookie: owner.cookie } });
  assert.equal(usage.statusCode, 200); assert.equal(usage.json().plan.monthlyPages, 5000); assert.equal(usage.json().plan.maxConcurrent, 4);
  const status = await app.inject({ method: 'GET', url: '/api/providers/status', headers: { cookie: owner.cookie } });
  assert.equal(status.json().stripe.mode, 'mock'); assert.equal(status.json().stripe.configured, false); assert.equal(status.json().stripe.verified, false); assert.equal(status.json().stripe.mockPlan.id, 'team');
  const parser = await request('/api/parsers', { name: 'Preserved mock downgrade parser', useCase: 'receipt' }); assert.equal(parser.statusCode, 201, parser.body);
  assert.equal((await request('/api/billing/mock/cancel')).statusCode, 200);
  const canceled = await stored(); assert.equal(canceled.id, 'explore'); assert.equal(canceled.mockStatus, 'canceled'); assert.equal(canceled.monthlyPages, 50);
  assert.equal((await request('/api/parsers', { name: 'Over quota', useCase: 'receipt' })).statusCode, 429);
  assert.equal((await adminPool.query('select id from parsers where id=$1', [parser.json().parser.id])).rowCount, 1);
  assert.equal((await request('/api/billing/mock/cancel')).json().changed, false);
  const events = await audit(); assert.deepEqual(events.map(event => event.action), ['billing.mock_plan_changed', 'billing.mock_plan_changed', 'billing.mock_canceled']);
  assert.ok(events.every(event => event.user_id === owner.user.id && event.metadata.mode === 'mock'));
  for (const table of ['subscriptions', 'billing_checkouts', 'usage_ledger']) assert.equal((await adminPool.query(`select count(*)::int n from ${table} where workspace_id=$1`, [owner.workspace.id])).rows[0].n, 0);
});

test('mock mutation enforces tenant, role, browser session, origin and strict plan input', async () => {
  const before = await stored(), beforeEvents = (await audit()).length;
  assert.equal((await request('/api/billing/mock/plan', { planId: 'team' }, outsider, { 'x-workspace-id': owner.workspace.id })).statusCode, 403);
  await adminPool.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'viewer')", [owner.workspace.id, outsider.user.id]);
  assert.equal((await request('/api/billing/mock/plan', { planId: 'team' }, outsider, { 'x-workspace-id': owner.workspace.id })).statusCode, 403);
  const key = await request('/api/workspace/api-keys', { name: 'Owned mock billing key', scopes: ['documents:read'] }); assert.equal(key.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/billing/mock/plan', payload: { planId: 'team' }, headers: { authorization: `Bearer ${key.json().token}` } })).statusCode, 403);
  assert.equal((await request('/api/billing/mock/plan', { planId: 'team' }, owner, { origin: 'https://cross-site.example.test' })).statusCode, 403);
  for (const body of [{ planId: 'enterprise' }, { planId: 'team', monthlyPages: 999999 }, { planId: 'team', workspaceId: outsider.workspace.id }]) assert.equal((await request('/api/billing/mock/plan', body)).statusCode, 400);
  assert.equal((await request('/api/billing/mock/cancel', { planId: 'team' })).statusCode, 400);
  assert.deepEqual(await stored(), before); assert.equal((await audit()).length, beforeEvents);
});

test('mock mode blocks Checkout, portal, webhooks and reconciliation before any Stripe transport', async () => {
  for (const url of ['/api/billing/checkout', '/api/billing/portal', '/api/billing/webhook']) {
    const result = await request(url, { planId: 'team' }); assert.equal(result.statusCode, 409, result.body); assert.match(result.json().message, /Stripe is disabled/);
  }
  let calls = 0;
  const client = { subscriptions: { list: async () => { calls++; throw new Error('Network must not be called'); } } } as unknown as Stripe;
  await assert.rejects(reconcileStripeCustomer({ id: 'owned-mock-event', type: 'customer.subscription.updated', created: 1, customerId: 'owned-mock-customer' }, client), /Stripe is disabled/);
  assert.equal(calls, 0);
});

test('mock billing cannot overwrite a workspace with existing Stripe customer or checkout state', async () => {
  const before = await stored(), beforeEvents = (await audit()).length;
  await adminPool.query('insert into subscriptions(workspace_id,customer_id) values($1,$2)', [owner.workspace.id, `cus_owned_mock_${randomUUID()}`]);
  try { assert.equal((await select('team')).statusCode, 409); assert.deepEqual(await stored(), before); }
  finally { await adminPool.query('delete from subscriptions where workspace_id=$1', [owner.workspace.id]); }
  await adminPool.query("insert into billing_checkouts(workspace_id,plan_id) values($1,'standard')", [owner.workspace.id]);
  try { assert.equal((await select('team')).statusCode, 409); assert.deepEqual(await stored(), before); }
  finally { await adminPool.query('delete from billing_checkouts where workspace_id=$1', [owner.workspace.id]); }
  assert.equal((await audit()).length, beforeEvents);
});

test('mock plan changes roll back if their audit fails and serialize repeated concurrent selection', async () => {
  const before = await stored(), beforeEvents = (await audit()).length;
  const fn = `owned_mock_${randomUUID().replaceAll('-', '')}`;
  await adminPool.query(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.workspace_id='${owner.workspace.id}'::uuid and NEW.action like 'billing.mock_%' then raise exception 'Owned mock billing audit failure'; end if; return NEW; end $$`);
  await adminPool.query(`create trigger ${fn} before insert on audit_events for each row execute function ${fn}()`);
  try { assert.equal((await select('team')).statusCode, 500); assert.deepEqual(await stored(), before); assert.equal((await audit()).length, beforeEvents); }
  finally { await adminPool.query(`drop trigger ${fn} on audit_events`); await adminPool.query(`drop function ${fn}()`); }
  const results = await Promise.all(Array.from({ length: 4 }, () => select('team')));
  assert.ok(results.every(result => result.statusCode === 200)); assert.equal(results.filter(result => result.json().changed).length, 1);
  assert.equal((await audit()).length, beforeEvents + 1); assert.equal((await stored()).id, 'team');
});
