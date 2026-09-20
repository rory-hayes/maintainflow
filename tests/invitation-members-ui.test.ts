import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import MembersPanel from '../src/features/settings/MembersPanel';
import { SessionProvider } from '../src/lib/session';
import type { Role } from '../shared/types';

const { convert } = createRequire(import.meta.url)('html-to-text');

const workspace = 'invitation-members-ui';
const invitation = (id: string, overrides: Record<string, unknown> = {}) => ({ id, email: `${id}@example.test`, role: 'editor', expiresAt: '2099-09-19T12:00:00.000Z', acceptedAt: null, createdAt: '2026-09-19T12:00:00.000Z', delivery: 'email', emailStatus: 'accepted', retryAt: null, ...overrides });
function render(options: { role?: Role; available?: unknown; stale?: boolean; invitations?: ReturnType<typeof invitation>[] } = {}) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage'), previousFetch = globalThis.fetch;
  let calls = 0;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => workspace } });
  globalThis.fetch = (async () => { calls++; throw new Error('Network is forbidden in this rendering fixture'); }) as typeof fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const key = [workspace, '/api/workspace/members'];
  client.setQueryData(key, { members: [{ id: 'owner', name: 'Workspace owner', email: 'owner@example.test', role: 'owner', createdAt: '2026-09-19T12:00:00.000Z' }], invitations: options.invitations || [invitation('recipient')], invitationEmail: { available: options.available === undefined ? true : options.available } });
  if (options.stale) client.getQueryCache().find({ queryKey: key, exact: true })!.setState({ status: 'error', error: new Error('PRIVATE transport diagnostics'), fetchStatus: 'idle' });
  client.setQueryData(['session', workspace], { user: { id: 'owner', name: 'Workspace owner', email: 'owner@example.test', emailVerifiedAt: null, emailVerificationRequired: false }, workspace: { id: workspace, name: 'Fixture', role: options.role || 'owner' }, workspaces: [] });
  try {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(SessionProvider, null, createElement(MembersPanel))));
    assert.equal(calls, 0);
    return html;
  } finally {
    client.clear(); globalThis.fetch = previousFetch;
    if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage); else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
}
function button(html: string, label: string) {
  const match = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(item => convert(item[2], { wordwrap: false }).trim() === label);
  assert.ok(match, `Missing button: ${label}`); return match[1];
}

test('invitation list distinguishes provider acceptance, queue states, manual sharing and expiry without claiming delivery', () => {
  const html = render({ invitations: [invitation('accepted'), invitation('queued', { emailStatus: 'pending' }), invitation('sending', { emailStatus: 'sending' }), invitation('failed', { emailStatus: 'failed' }), invitation('cancelled', { emailStatus: 'cancelled' }), invitation('manual', { delivery: 'manual', emailStatus: null }), invitation('expired', { expiresAt: '2000-01-01T00:00:00.000Z' }), invitation('joined', { acceptedAt: '2026-09-19T13:00:00.000Z' })] });
  for (const label of ['Accepted by email provider', 'Queued', 'Sending', 'Email failed', 'Email cancelled', 'Manual link', 'Expired']) assert.match(html, new RegExp(label));
  assert.match(html, /Email provider acceptance does not confirm inbox delivery/);
  assert.doesNotMatch(html, /joined@example.test|Delivered|Email sent|token=|invitation link copied/i);
  assert.doesNotMatch(button(html, 'Email invitation'), /disabled/);
  assert.match(html, /aria-label="Pending invitations"/);
});

test('unavailable, malformed and stale sender state disables email actions while preserving explicit manual setup', () => {
  for (const options of [{ available: false }, { available: 'yes' }, { stale: true }]) {
    const html = render(options);
    assert.match(button(html, 'Email again'), /disabled/);
    assert.doesNotMatch(button(html, 'Invite member'), /disabled/);
    assert.match(html, /Refresh status/);
    assert.doesNotMatch(html, /PRIVATE transport diagnostics/);
  }
});

test('cooldown disables resend and owner-only administrator invitations do not expose an admin resend action', () => {
  const html = render({ invitations: [invitation('cooldown', { retryAt: '2099-09-19T12:00:00.000Z' })] });
  const cooldown = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(item => /Email again in \d+s/.test(item[2]));
  assert.ok(cooldown); assert.match(cooldown[1], /disabled/);
  const admin = render({ role: 'admin', invitations: [invitation('admin-target', { role: 'admin' })] });
  assert.match(admin, /Only the owner can email this admin invitation/);
  assert.doesNotMatch(admin, />Email again</);
  assert.doesNotMatch(button(render({ invitations: [invitation('admin-target', { role: 'admin' })] }), 'Email again'), /disabled/);
});

test('viewers have no invitation controls or recipient list', () => {
  const html = render({ role: 'viewer' });
  assert.doesNotMatch(html, /Invite member|Pending invitations|recipient@example.test|Email again|Refresh status/);
  assert.match(html, /Workspace members/);
});
