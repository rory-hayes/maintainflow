import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { adminPool, closeDatabase, transaction } from '../server/core/db.js';
import { hashPassword } from '../server/core/auth.js';
import { config, defaultPlan } from '../server/core/config.js';

type Account = { id: string; email: string; password: string; workspaceId?: string };
const suffix = randomUUID();
const accounts: Account[] = [];
const workspaceIds = new Set<string>();
const signupEmail = `auth-login-signup-${suffix}@example.test`;
const signupWorkspace = `Owned login signup ${suffix}`;
const failure = { error: 'request_error', message: 'Email or password is incorrect' };
let app: FastifyInstance, owner: Account, shortPassword: Account, noMembership: Account;
let localDatabaseVerified = false;

async function fixture(label: string, password: string, membership = true): Promise<Account> {
  const account = { id: randomUUID(), email: `auth-login-${label}-${suffix}@example.test`, password,
    ...(membership ? { workspaceId: randomUUID() } : {}) };
  const encoded = await hashPassword(password);
  await transaction(adminPool, async client => {
    await client.query('insert into users(id,email,name,password_hash) values($1,$2,$3,$4)',
      [account.id, account.email, `Owned login ${label}`, encoded]);
    if (account.workspaceId) {
      await client.query('insert into workspaces(id,name,slug,plan) values($1,$2,$3,$4)',
        [account.workspaceId, `Owned login ${label}`, account.workspaceId, JSON.stringify(defaultPlan)]);
      await client.query("insert into memberships(workspace_id,user_id,role) values($1,$2,'owner')", [account.workspaceId, account.id]);
    }
  });
  accounts.push(account);
  if (account.workspaceId) workspaceIds.add(account.workspaceId);
  return account;
}

function login(payload: unknown, address: string, target = app, origin = config.origin) {
  return target.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: address,
    headers: { origin, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
}

async function sessionCount() {
  return (await adminPool.query('select count(*)::int n from sessions where user_id=any($1::uuid[])',
    [accounts.map(account => account.id)])).rows[0].n as number;
}

function rejected(response: Awaited<ReturnType<typeof login>>) {
  assert.equal(response.statusCode, 401, response.body);
  assert.deepEqual(response.json(), failure);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.cookies.length, 0);
}

function throttled(response: Awaited<ReturnType<typeof login>>) {
  assert.equal(response.statusCode, 429, response.body);
  assert.deepEqual(response.json(), { error: 'request_error',
    message: 'Too many authentication attempts. Try again in 15 minutes.' });
  assert.equal(response.headers['x-ratelimit-limit'], '30');
  assert.equal(response.headers['x-ratelimit-remaining'], '0');
  const retryAfter = Number(response.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 900);
  assert.equal(response.headers['set-cookie'], undefined);
  assert.equal(response.cookies.length, 0);
}

before(async () => {
  // These fixtures are deliberately local, even if a caller has hosted env vars.
  const options = adminPool.options;
  const host = options.connectionString ? new URL(options.connectionString).hostname : options.host;
  assert.ok(typeof host === 'string' && (host.startsWith('/') || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)),
    'Auth login regression fixtures require a local database.');
  localDatabaseVerified = true;
  app = await buildApp(); await app.ready();
  owner = await fixture('owner', '  MiXeD café Secret  ');
  shortPassword = await fixture('short', 'S7!x');
  noMembership = await fixture('no-membership', 'Owned password without membership', false);
});

after(async () => {
  try {
    await app?.close();
    if (!localDatabaseVerified) return;
    // Also recover a registration accidentally accepted by a failing policy test.
    const signupUsers = (await adminPool.query('select id from users where email=$1', [signupEmail])).rows;
    const signupWorkspaces = (await adminPool.query('select id from workspaces where name=$1', [signupWorkspace])).rows;
    for (const row of signupWorkspaces) workspaceIds.add(row.id);
    for (const id of workspaceIds) await adminPool.query('delete from workspaces where id=$1', [id]);
    const userIds = [...accounts.map(account => account.id), ...signupUsers.map(row => row.id)];
    if (userIds.length) await adminPool.query('delete from users where id=any($1::uuid[])', [userIds]);
  } finally { await closeDatabase(); }
});

test('invalid login bodies and wrong credentials are identical for known and unknown emails and create no sessions', async () => {
  const beforeCount = await sessionCount();
  const unknown = `auth-login-unknown-${suffix}@example.test`;
  for (const email of [owner.email, unknown]) {
    for (const password of ['short', '', 'x'.repeat(129), null, 42, {}, [], 'wrong but long enough']) {
      rejected(await login({ email, password }, '192.0.2.131'));
    }
    rejected(await login({ email }, '192.0.2.131'));
  }
  for (const payload of [{}, [], null, true, { email: 42, password: owner.password },
    { email: 'not-an-address', password: owner.password }, { email: ' ', password: owner.password }]) {
    rejected(await login(payload, '192.0.2.131'));
  }
  assert.equal(await sessionCount(), beforeCount);
});

test('correct credentials without a workspace membership use the same generic failure and create no session', async () => {
  const beforeCount = await sessionCount();
  rejected(await login({ email: noMembership.email, password: noMembership.password }, '192.0.2.132'));
  assert.equal(await sessionCount(), beforeCount);
});

test('login normalizes email but preserves password whitespace, case and Unicode exactly', async () => {
  const beforeCount = await sessionCount();
  const response = await login({ email: ` \t${owner.email.toUpperCase()}\n `, password: owner.password }, '192.0.2.133');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().user.id, owner.id);
  assert.equal(response.json().user.email, owner.email);
  assert.equal(response.json().workspace.id, owner.workspaceId);
  assert.ok(response.cookies.some(cookie => cookie.name === 'folio_session'));
  assert.ok(String(response.headers['set-cookie']).includes('HttpOnly'));
  assert.equal(await sessionCount(), beforeCount + 1);
  for (const password of [owner.password.trim(), owner.password.toLowerCase(), owner.password.normalize('NFD')]) {
    assert.notEqual(password, owner.password);
    rejected(await login({ email: owner.email, password }, '192.0.2.133'));
  }
  assert.equal(await sessionCount(), beforeCount + 1);
});

test('login accepts an exact valid stored password shorter than the current account-creation minimum', async () => {
  const beforeCount = await sessionCount();
  const response = await login({ email: shortPassword.email, password: shortPassword.password }, '192.0.2.134');
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().user.id, shortPassword.id);
  assert.equal(await sessionCount(), beforeCount + 1);
  rejected(await login({ email: shortPassword.email, password: 's7!x' }, '192.0.2.134'));
  assert.equal(await sessionCount(), beforeCount + 1);
});

test('signup and password replacement retain the ten-character creation policy and useful validation errors', async () => {
  const signup = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '192.0.2.135',
    headers: { origin: config.origin }, payload: { name: 'Owned login signup', workspaceName: signupWorkspace,
      email: signupEmail, password: 'Abcdef123' } });
  assert.equal(signup.statusCode, 400, signup.body);
  assert.equal(signup.json().error, 'validation_error');
  assert.match(signup.json().message, /password.*10/i);
  assert.equal(signup.headers['set-cookie'], undefined);
  assert.equal((await adminPool.query('select 1 from users where email=$1', [signupEmail])).rowCount, 0);
  assert.equal((await adminPool.query('select 1 from workspaces where name=$1', [signupWorkspace])).rowCount, 0);

  const authenticated = await login({ email: owner.email, password: owner.password }, '192.0.2.135');
  assert.equal(authenticated.statusCode, 200, authenticated.body);
  const cookie = authenticated.cookies.map(value => `${value.name}=${value.value}`).join('; ');
  const beforeCount = await sessionCount();
  const hashBefore = (await adminPool.query('select password_hash from users where id=$1', [owner.id])).rows[0].password_hash;
  const replacement = await app.inject({ method: 'POST', url: '/api/auth/password', remoteAddress: '192.0.2.135',
    headers: { origin: config.origin, cookie }, payload: { currentPassword: owner.password, newPassword: 'Abcdef123' } });
  assert.equal(replacement.statusCode, 400, replacement.body);
  assert.equal(replacement.json().error, 'validation_error');
  assert.match(replacement.json().message, /newPassword.*10/i);
  assert.equal(replacement.headers['set-cookie'], undefined);
  assert.equal((await adminPool.query('select password_hash from users where id=$1', [owner.id])).rows[0].password_hash, hashBefore);
  assert.equal(await sessionCount(), beforeCount);
});

test('invalid login shapes consume the real authentication budget and preserve a distinct 429 response', async () => {
  const beforeCount = await sessionCount();
  for (let attempt = 0; attempt < 30; attempt++) {
    rejected(await login({ email: owner.email, password: '' }, '192.0.2.136'));
  }
  const response = await login({ email: owner.email, password: owner.password }, '192.0.2.136');
  throttled(response);
  assert.equal(await sessionCount(), beforeCount);
});

test('registration and login share an authentication budget without throttling health or session checks', async () => {
  const beforeCount = await sessionCount();
  const address = '192.0.2.140';
  const invalidRegistration = () => app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: address,
    headers: { origin: config.origin }, payload: {} });
  for (let attempt = 0; attempt < 15; attempt++) {
    const registration = await invalidRegistration();
    assert.equal(registration.statusCode, 400, registration.body);
    assert.equal(registration.json().error, 'validation_error');
    assert.equal(registration.headers['set-cookie'], undefined);
    rejected(await login({ email: owner.email, password: '' }, address));
  }
  throttled(await invalidRegistration());
  throttled(await login({ email: owner.email, password: owner.password }, address));

  const health = await app.inject({ method: 'GET', url: '/api/health', remoteAddress: address });
  assert.equal(health.statusCode, 200, health.body);
  assert.equal(health.json().status, 'ok');
  assert.equal(health.headers['x-ratelimit-limit'], undefined);
  const session = await app.inject({ method: 'GET', url: '/api/auth/me', remoteAddress: address });
  assert.equal(session.statusCode, 401, session.body);
  assert.equal(session.headers['x-ratelimit-limit'], undefined);
  assert.equal(session.headers['set-cookie'], undefined);
  assert.equal(await sessionCount(), beforeCount);
});

test('origin denial and a login database failure remain distinct from incorrect credentials', async context => {
  const beforeCount = await sessionCount();
  const originDenied = await login({ email: owner.email, password: owner.password }, '192.0.2.137', app, 'https://unrelated.example');
  assert.equal(originDenied.statusCode, 403, originDenied.body);
  assert.equal(originDenied.json().message, 'Request origin is not allowed');
  assert.equal(originDenied.headers['set-cookie'], undefined);

  let failedLookups = 0;
  const privateMarker = 'PRIVATE_SYNTHETIC_AUTH_DATABASE_FAILURE';
  const originalQuery = adminPool.query;
  // Only this test account's exact login lookup fails. Other database work
  // delegates to the real pool, and the original method is restored in finally.
  const lookupFailure = context.mock.method(adminPool, 'query', function (this: typeof adminPool, ...args: unknown[]) {
    if (args[0] === 'select * from users where email=$1' && Array.isArray(args[1]) && args[1][0] === owner.email) {
      failedLookups++;
      return Promise.reject(new Error(privateMarker));
    }
    return Reflect.apply(originalQuery, this, args);
  });
  const logLevel = app.log.level;
  app.log.level = 'silent';
  try {
    const response = await login({ email: owner.email, password: owner.password }, '192.0.2.138');
    assert.equal(response.statusCode, 500, response.body);
    assert.deepEqual(response.json(), { error: 'server_error', message: 'The request could not be completed. Check the server status and try again.' });
    assert.ok(!response.body.includes(privateMarker));
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.cookies.length, 0);
    assert.equal(failedLookups, 1);
  } finally {
    lookupFailure.mock.restore();
    app.log.level = logLevel;
  }
  assert.equal(await sessionCount(), beforeCount);
  const recovered = await login({ email: owner.email, password: owner.password }, '192.0.2.139');
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().user.id, owner.id);
  assert.equal(await sessionCount(), beforeCount + 1);
});
