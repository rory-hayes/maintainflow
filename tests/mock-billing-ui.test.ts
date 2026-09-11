import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SessionProvider } from '../src/lib/session';
import BillingPanel from '../src/features/settings/BillingPanel';

function renderBilling(mode: 'mock' | 'test', role = 'owner', failed = false) {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const fetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error('Network is forbidden in this component fixture'); }) as typeof fetch;
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => 'billing-ui-fixture' } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  const key = ['billing-ui-fixture', '/api/providers/status'];
  client.setQueryData(['session', 'billing-ui-fixture'], { user: { id: 'owner' }, workspace: { id: 'billing-ui-fixture', role, plan: { name: 'Team (local mock)' } } });
  client.setQueryData(key, { stripe: { mode, configured: mode === 'test', verified: false, reason: 'Owned fixture', mockPlan: { id: 'team', name: 'Team (local mock)', status: 'active' } } });
  if (failed) client.getQueryCache().find({ queryKey: key, exact: true })!.setState({ status: 'error', error: new Error('Billing status unavailable'), fetchStatus: 'idle' });
  try {
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: ['/app/usage?checkout=returned'] }, createElement(SessionProvider, null, createElement(BillingPanel)))));
    assert.equal(calls, 0); return html;
  } finally { client.clear(); globalThis.fetch = fetch; if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage); else Reflect.deleteProperty(globalThis, 'sessionStorage'); }
}

test('preview billing shows mock pricing, current persisted plan and cancellation without suggesting Checkout success', () => {
  const html = renderBilling('mock');
  assert.match(html, /Mock billing/); assert.match(html, /Mock mode · no payments/);
  assert.match(html, /Current allowance: Team \(local mock\)/); assert.match(html, /illustrative/);
  assert.match(html, /Use Standard mock plan/); assert.match(html, /Current mock plan: Team/); assert.match(html, /Cancel mock subscription/);
  assert.match(html, /Stripe is not contacted/); assert.match(html, /No payment or real subscription is created/);
  assert.doesNotMatch(html, /Open test billing portal|Test Standard checkout|You returned from Checkout/);
});

test('mock billing controls are disabled for viewers and stale provider errors hide plan actions', () => {
  const viewer = renderBilling('mock', 'viewer');
  for (const label of ['Use Standard mock plan', 'Current mock plan: Team', 'Cancel mock subscription']) assert.match(viewer, new RegExp(`<button[^>]*disabled=""[^>]*>${label}</button>`));
  assert.match(viewer, /owner or administrator can manage billing/);
  const failed = renderBilling('mock', 'owner', true);
  assert.match(failed, /Billing status unavailable/); assert.doesNotMatch(failed, /Use Standard mock plan|Cancel mock subscription/);
});

test('the separate real test-mode Checkout and portal interface is preserved when mock is off', () => {
  const html = renderBilling('test');
  assert.match(html, /Test Standard checkout/); assert.match(html, /Open test billing portal/);
  assert.match(html, /You returned from Checkout/);
  assert.doesNotMatch(html, /Use Standard mock plan|Cancel mock subscription|Mock mode · no payments/);
});
