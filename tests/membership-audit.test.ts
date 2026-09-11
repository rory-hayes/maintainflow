import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../server/app.js';
import { adminPool, withWorkspace, closeDatabase } from '../server/core/db.js';
import { config } from '../server/core/config.js';

type Account = { user: { id: string; email: string }; workspace: { id: string }; cookie: string };
type Invitation = { invitation: { id: string }; token: string };
let app: FastifyInstance, owner: Account, outsider: Account;
const accounts: Account[] = [];

async function request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, caller = owner, workspaceId?: string) {
  return app.inject({ method, url, payload: payload as any, headers: {
    cookie: caller.cookie, origin: config.origin, ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
  } });
}

async function signup(label: string): Promise<Account> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/register', headers: { origin: config.origin }, payload: {
    name: `Owned membership audit ${label}`, email: `membership-audit-${label}-${randomUUID()}@example.test`,
    password: 'owned membership audit fixture password', workspaceName: `Owned membership audit ${label}`,
  } });
  assert.equal(response.statusCode, 201, response.body);
  const account = { ...response.json(), cookie: response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
  accounts.push(account); return account;
}

async function invite(email: string, role: 'admin' | 'editor' | 'viewer' = 'viewer'): Promise<Invitation> {
  const response = await request('POST', '/api/workspace/members', { email, role });
  assert.equal(response.statusCode, 200, response.body); return response.json();
}

async function join(account: Account, role: 'admin' | 'editor' | 'viewer' = 'viewer') {
  const invitation = await invite(account.user.email, role);
  const response = await request('POST', '/api/workspace/invitations/accept', { token: invitation.token }, account);
  assert.equal(response.statusCode, 200, response.body); return invitation;
}

async function events() {
  const response = await request('GET', '/api/workspace/audit');
  assert.equal(response.statusCode, 200, response.body); return response.json().events as any[];
}

const matching = async (action: string, entityId: string) => (await events()).filter(event => event.action === action && event.entityId === entityId);
const eventIds = async () => (await events()).map(event => event.id).sort();
const memberRole = async (userId: string) => (await adminPool.query('select role from memberships where workspace_id=$1 and user_id=$2', [owner.workspace.id, userId])).rows[0]?.role;

before(async () => { app = await buildApp(); owner = await signup('owner'); outsider = await signup('outsider'); });
after(async () => {
  await app?.close();
  for (const account of accounts) await adminPool.query('delete from workspaces where id=$1', [account.workspace.id]);
  for (const account of accounts) await adminPool.query('delete from users where id=$1', [account.user.id]);
  await closeDatabase();
});

test('invitation acceptance records its actual actor, destination and role once without invitation secrets', async () => {
  const recipient = await signup('recipient'), invitation = await invite(recipient.user.email);
  const beforeRejection = await eventIds();
  assert.equal((await request('POST', '/api/workspace/invitations/accept', { token: invitation.token }, outsider)).statusCode, 403);
  assert.deepEqual(await eventIds(), beforeRejection);

  const response = await request('POST', '/api/workspace/invitations/accept', { token: invitation.token }, recipient);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), { workspaceId: owner.workspace.id, role: 'viewer' });
  assert.equal(await memberRole(recipient.user.id), 'viewer');
  assert.ok((await adminPool.query('select accepted_at from invitations where id=$1', [invitation.invitation.id])).rows[0].accepted_at);
  const recorded = await matching('member.invitation_accepted', invitation.invitation.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, recipient.user.id);
  assert.equal(recorded[0].workspaceId, owner.workspace.id);
  assert.deepEqual(recorded[0].metadata, { memberId: recipient.user.id, role: 'viewer', membershipCreated: true });
  assert.ok(Number.isFinite(Date.parse(recorded[0].createdAt)));
  assert.equal((await withWorkspace(outsider.workspace.id, c => c.query('select id from audit_events where id=$1', [recorded[0].id]))).rowCount, 0);
  const recipientAudit = await request('GET', '/api/workspace/audit', undefined, recipient);
  assert.equal(recipientAudit.statusCode, 200, recipientAudit.body);
  assert.ok(!recipientAudit.json().events.some((event: any) => event.id === recorded[0].id));
  assert.equal((await request('GET', '/api/workspace/audit', undefined, recipient, owner.workspace.id)).statusCode, 403);

  const beforeReplay = await eventIds();
  assert.equal((await request('POST', '/api/workspace/invitations/accept', { token: invitation.token }, recipient)).statusCode, 400);
  assert.deepEqual(await eventIds(), beforeReplay);

  // Consuming another invitation is a real event but must not upgrade an existing membership.
  const second = await invite(recipient.user.email, 'admin');
  const again = await request('POST', '/api/workspace/invitations/accept', { token: second.token }, recipient);
  assert.equal(again.statusCode, 200, again.body);
  assert.equal(again.json().role, 'viewer');
  assert.equal(await memberRole(recipient.user.id), 'viewer');
  assert.deepEqual((await matching('member.invitation_accepted', second.invitation.id))[0].metadata,
    { memberId: recipient.user.id, role: 'viewer', membershipCreated: false });
  for (const event of [...recorded, ...await matching('member.invitation_accepted', second.invitation.id)]) {
    const serialized = JSON.stringify(event);
    for (const secret of [recipient.user.email, invitation.token, second.token, 'Owned membership audit recipient']) assert.ok(!serialized.includes(secret));
  }
});

test('role changes record previous and resulting roles while denied, missing and unchanged requests create no event', async () => {
  const member = await signup('role'); await join(member);
  const response = await request('PATCH', `/api/workspace/members/${member.user.id}`, { role: 'editor' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await memberRole(member.user.id), 'editor');
  const recorded = await matching('member.role_changed', member.user.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, owner.user.id);
  assert.deepEqual(recorded[0].metadata, { previousRole: 'viewer', role: 'editor' });

  const before = await eventIds();
  assert.equal((await request('PATCH', `/api/workspace/members/${member.user.id}`, { role: 'editor' })).statusCode, 200);
  assert.equal((await request('PATCH', `/api/workspace/members/${member.user.id}`, { role: 'admin' }, member, owner.workspace.id)).statusCode, 403);
  assert.equal((await request('PATCH', `/api/workspace/members/${member.user.id}`, { role: 'admin' }, outsider)).statusCode, 404);
  assert.equal((await request('PATCH', `/api/workspace/members/${owner.user.id}`, { role: 'viewer' })).statusCode, 400);
  assert.equal((await request('PATCH', `/api/workspace/members/${randomUUID()}`, { role: 'viewer' })).statusCode, 404);
  assert.deepEqual(await eventIds(), before);
  assert.equal(await memberRole(member.user.id), 'editor');
});

test('member removal commits its audit with membership, key and session revocation and retains target identity after user deletion', async () => {
  const member = await signup('remove'), invitation = await join(member, 'admin');
  const keyResponse = await request('POST', '/api/workspace/api-keys', { name: 'Owned removal fixture', scopes: ['documents:read'] }, member, owner.workspace.id);
  assert.equal(keyResponse.statusCode, 200, keyResponse.body);
  const key = keyResponse.json();
  assert.equal((await request('POST', `/api/workspaces/${owner.workspace.id}/select`, {}, member)).statusCode, 200);

  const beforeDenied = await eventIds();
  assert.equal((await request('DELETE', `/api/workspace/members/${owner.user.id}`, undefined, member)).statusCode, 403);
  assert.equal((await request('DELETE', `/api/workspace/members/${member.user.id}`, undefined, member)).statusCode, 403);
  assert.deepEqual(await eventIds(), beforeDenied);

  const response = await request('DELETE', `/api/workspace/members/${member.user.id}`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(await memberRole(member.user.id), undefined);
  assert.ok((await adminPool.query('select revoked_at from api_keys where id=$1', [key.apiKey.id])).rows[0].revoked_at);
  assert.equal((await adminPool.query('select id from sessions where workspace_id=$1 and user_id=$2', [owner.workspace.id, member.user.id])).rowCount, 0);
  assert.equal((await request('GET', '/api/auth/me', undefined, member)).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/documents', headers: { authorization: `Bearer ${key.token}` } })).statusCode, 401);
  const recorded = await matching('member.removed', member.user.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, owner.user.id);
  assert.deepEqual(recorded[0].metadata, { role: 'admin' });
  const beforeRepeat = await eventIds();
  assert.equal((await request('DELETE', `/api/workspace/members/${member.user.id}`)).statusCode, 404);
  assert.deepEqual(await eventIds(), beforeRepeat);

  // API-key ownership deliberately has a restrictive user FK. Remove only
  // this already-revoked fixture key before exercising audit actor anonymization.
  await adminPool.query('delete from api_keys where id=$1', [key.apiKey.id]);
  await adminPool.query('delete from users where id=$1', [member.user.id]);
  assert.equal((await matching('member.removed', member.user.id))[0].entityId, member.user.id);
  const acceptance = (await matching('member.invitation_accepted', invitation.invitation.id))[0];
  assert.equal(acceptance.userId, null);
  assert.equal(acceptance.metadata.memberId, member.user.id);
});

test('revoking a pending invitation is scoped and recorded once; deleting accepted history does not claim membership revocation', async () => {
  const pending = await invite(`membership-audit-unused-${randomUUID()}@example.test`, 'editor');
  const beforeDenied = await eventIds();
  assert.equal((await request('DELETE', `/api/workspace/invitations/${pending.invitation.id}`, undefined, outsider)).statusCode, 404);
  assert.deepEqual(await eventIds(), beforeDenied);
  assert.equal((await request('DELETE', `/api/workspace/invitations/${pending.invitation.id}`)).statusCode, 200);
  assert.equal((await adminPool.query('select id from invitations where id=$1', [pending.invitation.id])).rowCount, 0);
  const recorded = await matching('member.invitation_revoked', pending.invitation.id);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, owner.user.id);
  assert.deepEqual(recorded[0].metadata, { role: 'editor' });
  const beforeRepeat = await eventIds();
  assert.equal((await request('DELETE', `/api/workspace/invitations/${pending.invitation.id}`)).statusCode, 404);
  assert.deepEqual(await eventIds(), beforeRepeat);

  const accepted = await invite(owner.user.email);
  assert.equal((await request('POST', '/api/workspace/invitations/accept', { token: accepted.token })).statusCode, 200);
  assert.equal((await request('DELETE', `/api/workspace/invitations/${accepted.invitation.id}`)).statusCode, 200);
  assert.equal(await memberRole(owner.user.id), 'owner');
  assert.equal((await matching('member.invitation_revoked', accepted.invitation.id)).length, 0);
  const deletion = await matching('member.invitation_deleted', accepted.invitation.id);
  assert.equal(deletion.length, 1);
  assert.deepEqual(deletion[0].metadata, { role: 'viewer' });
});

test('an audit insert failure rolls back invitation consumption, role changes, removal side effects and revocation', async () => {
  const recipient = await signup('rollback-new'), invitation = await invite(recipient.user.email);
  const member = await signup('rollback-member'); await join(member, 'admin');
  const pending = await invite(`membership-audit-rollback-${randomUUID()}@example.test`);
  const keyResponse = await request('POST', '/api/workspace/api-keys', { name: 'Owned rollback fixture', scopes: ['documents:read'] }, member, owner.workspace.id);
  assert.equal(keyResponse.statusCode, 200, keyResponse.body);
  const key = keyResponse.json();
  assert.equal((await request('POST', `/api/workspaces/${owner.workspace.id}/select`, {}, member)).statusCode, 200);
  const before = await eventIds();
  const fixtureName = `owned_membership_audit_failure_${randomUUID().replaceAll('-', '')}`;
  try {
    // The temporary database fault matches only this owned workspace and these
    // audit actions. Actual route writes execute before PostgreSQL rejects the
    // audit insert, proving that the surrounding transaction rolls them back.
    await adminPool.query(`create function ${fixtureName}() returns trigger language plpgsql as $$ begin
      if NEW.workspace_id = '${owner.workspace.id}'::uuid and NEW.action in
        ('member.invitation_accepted','member.role_changed','member.removed','member.invitation_revoked') then
        raise exception 'Owned membership audit fixture failure';
      end if;
      return NEW;
    end $$`);
    await adminPool.query(`create trigger ${fixtureName} before insert on audit_events for each row execute function ${fixtureName}()`);

    assert.equal((await request('POST', '/api/workspace/invitations/accept', { token: invitation.token }, recipient)).statusCode, 500);
    assert.equal(await memberRole(recipient.user.id), undefined);
    assert.equal((await adminPool.query('select accepted_at from invitations where id=$1', [invitation.invitation.id])).rows[0].accepted_at, null);

    assert.equal((await request('PATCH', `/api/workspace/members/${member.user.id}`, { role: 'viewer' })).statusCode, 500);
    assert.equal(await memberRole(member.user.id), 'admin');

    assert.equal((await request('DELETE', `/api/workspace/members/${member.user.id}`)).statusCode, 500);
    assert.equal(await memberRole(member.user.id), 'admin');
    assert.equal((await adminPool.query('select revoked_at from api_keys where id=$1', [key.apiKey.id])).rows[0].revoked_at, null);
    assert.equal((await request('GET', '/api/auth/me', undefined, member)).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/documents', headers: { authorization: `Bearer ${key.token}` } })).statusCode, 200);

    assert.equal((await request('DELETE', `/api/workspace/invitations/${pending.invitation.id}`)).statusCode, 500);
    assert.equal((await adminPool.query('select id from invitations where id=$1', [pending.invitation.id])).rowCount, 1);
    assert.deepEqual(await eventIds(), before);
  } finally {
    await adminPool.query(`drop trigger if exists ${fixtureName} on audit_events`);
    await adminPool.query(`drop function if exists ${fixtureName}()`);
  }
});
