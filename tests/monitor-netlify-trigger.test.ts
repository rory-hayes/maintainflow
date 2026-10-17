import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import handler, {config} from '../deploy/monitor-trigger/netlify/functions/monitor-trigger.mts';

const base = 'https://api.github.com/repos/rory-hayes/maintainflow/actions/workflows/operations-monitor.yml';
const tick = '2026-10-17T23:57:00.000Z', at = Date.parse(tick), next = '2026-10-18T00:02:00.000Z';
const key = '12'.repeat(32), site = '11111111-2222-4333-8444-555555555555';
const context = {account: {id: '66a271919d5b23184c2781f0'}, site: {id: site}, deploy: {id: 'synthetic-deploy-1', context: 'production', published: true}, requestId: 'synthetic-request-1'};
const environment: Record<string, string | undefined> = {
  FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: 'true', FOLIO_MONITOR_NETLIFY_SITE_ID: site,
  FOLIO_MONITOR_TRIGGER_ACTOR_ID: '123', FOLIO_MONITOR_TRIGGER_TOKEN: 'PRIVATE_SYNTHETIC_ACTIONS_TOKEN', FOLIO_MONITOR_TRIGGER_KEY: key,
};
const request = (body = JSON.stringify({next_run: next}), headers?: HeadersInit) => new Request('https://timer.example.test', {method: 'POST', body, headers});
const metadata = {id: 42, path: '.github/workflows/operations-monitor.yml', state: 'active'};
type Call = {url: string; init?: RequestInit};
function fixture(t: TestContext, patch: Record<string, string | undefined> = {}) {
  let time = at + 30_000;
  const reads: string[] = [], calls: Call[] = [], logs: {status: string; reason: string; tick: string; requests: number; runId?: number; nextRun?: string; requestId?: string; deployId?: string}[] = [];
  const old = Object.getOwnPropertyDescriptor(globalThis, 'Netlify');
  Object.defineProperty(globalThis, 'Netlify', {configurable: true, value: {env: {get(name: string) {
    reads.push(name); return {...environment, ...patch}[name];
  }}}});
  t.after(() => { if (old) Object.defineProperty(globalThis, 'Netlify', old); else Reflect.deleteProperty(globalThis, 'Netlify'); });
  t.mock.method(Date, 'now', () => time);
  t.mock.method(console, 'info', (line: string) => { logs.push(JSON.parse(line)); });
  const responses = (url: string): Response => {
    if (url === 'https://api.github.com/user') return Response.json({id: 123});
    if (url === base) return Response.json(metadata);
    if (url === base + '/runs?branch=main&event=workflow_dispatch&per_page=30') return Response.json({total_count: 0, workflow_runs: []});
    assert.equal(url, base + '/dispatches'); return Response.json({workflow_run_id: 46});
  };
  let transport: (call: Call) => Response | Promise<Response> = call => responses(call.url);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call = {url: String(input), init}; calls.push(call); return transport(call);
  });
  return {reads, calls, logs, responses, setTime(value: number) { time = value; },
    transport(value: typeof transport) { transport = value; }};
}
async function failure(f: ReturnType<typeof fixture>, req: Request, reason: string, ctx = context) {
  await assert.rejects(handler(req, ctx), {message: 'monitor_trigger_failed'});
  assert.equal(f.logs.at(-1)?.status, 'failed'); assert.equal(f.logs.at(-1)?.reason, reason);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|Bearer|tick_signature/); assert.doesNotMatch(JSON.stringify(f.logs), new RegExp(key));
}

test('Netlify inactive default handler reads only enable flag, without body, context, credentials or transport', async t => {
  const f = fixture(t, {FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: undefined});
  const unread = new Proxy({} as Request, {get() { throw new Error('PRIVATE_BODY_MUST_NOT_BE_READ'); }});
  const unreadContext = new Proxy(context, {get() { throw new Error('PRIVATE_CONTEXT_MUST_NOT_BE_READ'); }});
  assert.equal((await handler(unread, unreadContext)).status, 204);
  assert.deepEqual(f.reads, ['FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED']); assert.equal(f.calls.length, 0);
  assert.equal(f.logs[0].status, 'inactive');
});

test('Netlify actual handler maps next_run across UTC day rollover and preserves exact signed fixed-target dispatch', async t => {
  const f = fixture(t);
  for (const value of [next, next.replace('.000Z', 'Z')]) {
    assert.equal((await handler(request(JSON.stringify({next_run: value, ignored: {metadata: 'PRIVATE_NOT_REFLECTED'}})), context)).status, 204);
  }
  assert.equal(f.calls.length, 8);
  const signature = createHmac('sha256', Buffer.from(key, 'hex')).update('maintainflow-monitor-tick:v1:' + tick).digest('hex');
  for (const offset of [0, 4]) {
    assert.deepEqual(f.calls.slice(offset, offset + 4).map(c => c.init?.method), ['GET', 'GET', 'GET', 'POST']);
    assert.deepEqual(JSON.parse(String(f.calls[offset + 3].init?.body)), {ref: 'main', inputs: {mode: 'external-run', trigger_at: tick, tick_signature: signature}});
    for (const c of f.calls.slice(offset, offset + 4)) { assert.equal(c.init?.redirect, 'error'); assert.ok(c.init?.signal); }
    assert.equal(new Headers(f.calls[offset + 3].init?.headers).get('x-github-api-version'), '2026-03-10');
  }
  assert.equal(f.logs[0].runId, 46); assert.equal(f.logs[0].tick, tick);
  assert.equal(f.logs[0].nextRun, next); assert.equal(f.logs[0].requestId, context.requestId); assert.equal(f.logs[0].deployId, context.deploy.id);
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|tick_signature|healthy|completed/);
});

test('Netlify enabled handler refuses wrong account, site, preview, unpublished or missing bindings before secrets and body', async t => {
  const patch: Record<string, string | undefined> = {}, f = fixture(t, patch);
  const unread = new Proxy({} as Request, {get() { throw new Error('PRIVATE_BODY_MUST_NOT_BE_READ'); }});
  for (const ctx of [{...context, account: {id: 'other'}}, {...context, site: {id: 'other'}},
    {...context, deploy: {...context.deploy, context: 'deploy-preview'}}, {...context, deploy: {...context.deploy, context: 'branch-deploy'}},
    {...context, deploy: {...context.deploy, published: false}}, {...context, requestId: 'PRIVATE/UNBOUNDED'},
    {...context, deploy: {...context.deploy, id: ''}}]) await failure(f, unread, 'netlify_context_invalid', ctx);
  patch.FOLIO_MONITOR_NETLIFY_SITE_ID = undefined;
  await failure(f, unread, 'netlify_context_invalid');
  assert.deepEqual(new Set(f.reads), new Set(['FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED', 'FOLIO_MONITOR_NETLIFY_SITE_ID']));
  assert.equal(f.calls.length, 0);
});

test('Netlify bounded event parser refuses invalid shapes, invalid UTF8 and noncanonical timestamps before credentials', async t => {
  const f = fixture(t);
  const bodies = ['null', '[]', '{}', '{', '{"next_run":42}', '{"next_run":"PRIVATE"}',
    ...['2026-10-18T00:02:00+00:00', '2026-10-18T00:02:00.001Z', '2026-10-18T00:02:01Z',
      '2026-10-18T00:03:00Z', '2026-02-30T00:02:00Z'].map(next_run => JSON.stringify({next_run})), ' '.repeat(1025)];
  for (const body of bodies) await failure(f, request(body), 'netlify_event_invalid');
  await failure(f, request(undefined, {'content-length': '1025'}), 'netlify_event_invalid');
  await failure(f, request(undefined, {'content-length': 'invalid'}), 'netlify_event_invalid');
  await failure(f, new Request('https://timer.example.test', {method: 'POST', body: new Uint8Array([255])}), 'netlify_event_invalid');
  assert.deepEqual(new Set(f.reads), new Set(['FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED', 'FOLIO_MONITOR_NETLIFY_SITE_ID']));
  assert.equal(f.calls.length, 0);
});

test('Netlify tick mapping preserves inclusive freshness boundaries and refuses delayed, future and nonfinite time', async t => {
  const f = fixture(t);
  for (const age of [0, 120_000]) { f.setTime(at + age); assert.equal((await handler(request(), context)).status, 204); }
  const before = f.calls.length;
  for (const time of [at - 1, at + 120_001, at + 300_000, NaN]) {
    f.setTime(time); await failure(f, request(), 'netlify_tick_stale');
  }
  assert.equal(f.calls.length, before);
});

test('Netlify parser timeout cancels a stalled body and cannot read secrets or dispatch later', async t => {
  const f = fixture(t); let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({cancel() { cancelled++; }});
  const req = new Request('https://timer.example.test', {method: 'POST', body, duplex: 'half'} as RequestInit);
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = assert.rejects(handler(req, context), {message: 'monitor_trigger_failed'});
  await new Promise(resolve => setImmediate(resolve)); t.mock.timers.tick(1000); await pending;
  assert.equal(f.logs.at(-1)?.reason, 'netlify_event_timeout'); assert.equal(cancelled, 1);
  assert.equal(f.calls.length, 0); assert.equal(f.reads.length, 2);
});

test('Netlify actual handler retains the dispatcher deadline and sanitizes timeout without a late request', async t => {
  const f = fixture(t); let release!: (response: Response) => void;
  f.transport(() => new Promise(resolve => { release = resolve; }));
  t.mock.timers.enable({apis: ['setTimeout']});
  const pending = assert.rejects(handler(request(), context), {message: 'monitor_trigger_failed'});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, 1);
  t.mock.timers.tick(15_000); await pending;
  assert.equal(f.logs.at(-1)?.reason, 'trigger_timeout');
  release(Response.json({id: 123})); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].init?.signal?.aborted, true);
});

test('Netlify uncertain POST is signalled as failure once and existing tick reconciliation never posts again', async t => {
  const f = fixture(t);
  f.transport(c => { if (c.init?.method === 'POST') throw new Error('PRIVATE provider response'); return f.responses(c.url); });
  await failure(f, request(), 'trigger_dispatch_uncertain_reconcile_metadata');
  assert.equal(f.calls.filter(c => c.init?.method === 'POST').length, 1);
  f.transport(c => c.url.includes('/runs?') ? Response.json({total_count: 1, workflow_runs: [{id: 46, workflow_id: metadata.id,
    event: 'workflow_dispatch', head_branch: 'main', repository: {full_name: 'rory-hayes/maintainflow'},
    head_repository: {full_name: 'rory-hayes/maintainflow'}, actor: {id: 123}, display_title: 'Folio monitor: external-run ' + tick}]}) : f.responses(c.url));
  assert.equal((await handler(request(), context)).status, 204);
  assert.equal(f.logs.at(-1)?.status, 'skipped'); assert.equal(f.logs.at(-1)?.runId, 46);
  assert.equal(f.calls.filter(c => c.init?.method === 'POST').length, 1);
});

test('Netlify actual handler retains actor denial and pre-POST freshness after provider reads', async t => {
  const f = fixture(t);
  f.transport(c => c.url === 'https://api.github.com/user' ? Response.json({id: 999}) : f.responses(c.url));
  await failure(f, request(), 'trigger_actor_mismatch'); assert.equal(f.calls.length, 1);
  f.transport(c => { const response = f.responses(c.url); if (c.url.includes('/runs?')) f.setTime(at + 120_001); return response; });
  await failure(f, request(), 'trigger_tick_stale');
  assert.equal(f.calls.length, 4); assert.equal(f.calls.some(c => c.init?.method === 'POST'), false);
});

test('Netlify environment failures never reflect arbitrary errors or credentials', async t => {
  const f = fixture(t);
  Object.defineProperty(globalThis, 'Netlify', {configurable: true, value: {env: {get() { throw new Error('PRIVATE credential SDK detail'); }}}});
  await failure(f, request(), 'netlify_adapter_failed'); assert.equal(f.calls.length, 0);
});

test('Netlify deployment defaults contain no function and active handler cannot become a public HTTP endpoint', async () => {
  assert.deepEqual(config, {schedule: '2-59/5 * * * *'});
  const root = new URL('../deploy/monitor-trigger/netlify/', import.meta.url);
  const inactive = await fs.readFile(new URL('netlify.toml', root), 'utf8'), active = await fs.readFile(new URL('netlify.active.toml', root), 'utf8');
  assert.match(inactive, /directory = "functions-disabled"/); assert.match(active, /directory = "functions"/);
  for (const text of [inactive, active]) { assert.match(text, /publish = "public"/); assert.match(text, /base = "deploy\/monitor-trigger\/netlify"/); assert.doesNotMatch(text, /FOLIO_MONITOR_TRIGGER_(TOKEN|KEY)\s*=/); }
  assert.deepEqual(await fs.readdir(new URL('functions-disabled/', root)), ['README.md']);
  const pkg = JSON.parse(await fs.readFile(new URL('package.json', root), 'utf8'));
  assert.equal(pkg.engines.node, '24.x'); assert.equal(pkg.dependencies, undefined); assert.equal(pkg.scripts, undefined);
});
