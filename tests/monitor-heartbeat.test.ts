import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {main, sendHeartbeat} from '../scripts/monitor-heartbeat.js';

// Synthetic event and ping capability; every request is intercepted in memory.
const now = new Date('2026-09-27T15:30:00Z');
const url = 'https://hc-ping.com/11111111-2222-4333-8444-555555555555';
const fixture = (): NodeJS.ProcessEnv => ({
  GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REPOSITORY: 'rory-hayes/maintainflow',
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ATTEMPT: '1', FOLIO_MONITOR_ENABLED: 'true',
  FOLIO_MONITOR_HEARTBEAT_URL: url, SOURCE_EVENT: 'schedule', SOURCE_REPOSITORY: 'rory-hayes/maintainflow',
  SOURCE_HEAD_REPOSITORY: 'rory-hayes/maintainflow', SOURCE_BRANCH: 'main',
  SOURCE_WORKFLOW: 'Operational monitoring', SOURCE_PATH: '.github/workflows/operations-monitor.yml',
  SOURCE_TITLE: 'Folio monitor: run', SOURCE_STATUS: 'completed', SOURCE_CONCLUSION: 'success',
  SOURCE_ATTEMPT: '1', SOURCE_RUN_ID: '123456789', SOURCE_SHA: 'a'.repeat(40),
  SOURCE_CREATED_AT: '2026-09-27T15:25:00Z', SOURCE_UPDATED_AT: '2026-09-27T15:26:00Z',
});
function transport(body = 'OK', status = 200, headers?: HeadersInit) {
  const calls: {url: string; init: RequestInit | undefined}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({url: String(input), init});
    return new Response(body, {status, headers});
  };
  return {calls, fetcher};
}
async function rejected(patch: NodeJS.ProcessEnv, reason?: string) {
  const f = transport(); const report = await sendHeartbeat({...fixture(), ...patch}, f.fetcher, {now});
  assert.equal(report.status, 'rejected');
  if (reason) assert.equal(report.reason, reason);
  assert.equal(f.calls.length, 0); assert.equal(report.requests, 0);
  assert.deepEqual(Object.keys(report).sort(), ['reason', 'requests', 'status']);
  assert.match(report.reason, /^heartbeat_(?:trigger_invalid|monitor_disabled|source_invalid|completion_invalid|identity_invalid|source_stale|destination_invalid)$/);
}

test('completed genuine schedule sends one minimal heartbeat without customer data or credentials in headers', async () => {
  const f = transport(); const report = await sendHeartbeat(fixture(), f.fetcher, {now});
  assert.deepEqual(report, {status: 'sent', reason: 'completed_schedule_accepted', requests: 1});
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, url);
  const init = f.calls[0].init!;
  assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error'); assert.equal(init.body, undefined);
  assert.ok(init.signal); assert.equal(init.signal.aborted, true);
  assert.deepEqual(Object.keys(Object.fromEntries(new Headers(init.headers))).sort(), ['accept', 'user-agent']);
});

test('missing configuration and plan mode never use the network or certify activation', async () => {
  const f = transport();
  for (const value of [undefined, '']) assert.deepEqual(await sendHeartbeat({...fixture(), FOLIO_MONITOR_HEARTBEAT_URL: value}, f.fetcher, {now}),
    {status: 'inactive', reason: 'heartbeat_not_configured', requests: 0});
  for (const args of [[], ['--plan']]) assert.equal((await main(args, fixture(), f.fetcher)).report.reason, 'plan_only');
  assert.equal((await main(['--send', 'PRIVATE_ARGUMENT'], fixture(), f.fetcher)).exitCode, 2);
  assert.equal(f.calls.length, 0);
});

test('manual, disabled, untrusted and rerun events cannot manufacture freshness', async () => {
  const patches = [
    {GITHUB_EVENT_NAME: 'workflow_dispatch'}, {GITHUB_REPOSITORY: 'foreign/repo'}, {GITHUB_REF: 'refs/pull/1/merge'},
    {GITHUB_RUN_ATTEMPT: '2'}, {FOLIO_MONITOR_ENABLED: 'false'}, {FOLIO_MONITOR_ENABLED: undefined},
    {SOURCE_EVENT: 'workflow_dispatch'}, {SOURCE_REPOSITORY: 'foreign/repo'}, {SOURCE_HEAD_REPOSITORY: 'foreign/repo'},
    {SOURCE_BRANCH: 'other'}, {SOURCE_WORKFLOW: 'Fake monitor'}, {SOURCE_PATH: '.github/workflows/ci.yml'},
    {SOURCE_TITLE: 'Folio monitor: disabled'}, {SOURCE_TITLE: 'Folio monitor: probe'},
    {SOURCE_TITLE: 'Folio monitor: initialize'}, {SOURCE_TITLE: 'Folio monitor: delivery-drill'},
    {SOURCE_ATTEMPT: '2'}, {SOURCE_ATTEMPT: undefined}, {SOURCE_RUN_ID: '0'}, {SOURCE_RUN_ID: '9007199254740993'},
    {SOURCE_SHA: 'not-a-commit'},
  ];
  for (const patch of patches) await rejected(patch);
});

test('incomplete, failed, skipped and cancelled primary monitors cannot send a success heartbeat', async () => {
  for (const status of ['in_progress', 'queued', 'waiting', undefined]) await rejected({SOURCE_STATUS: status});
  for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', undefined]) await rejected({SOURCE_CONCLUSION: conclusion});
});

test('freshness includes queue delay and cannot be extended by a recent update or subscriber replay', async () => {
  const f = transport();
  const boundary = {...fixture(), SOURCE_CREATED_AT: '2026-09-27T15:10:00Z'};
  assert.equal((await sendHeartbeat(boundary, f.fetcher, {now})).status, 'sent');
  const queued = transport();
  assert.equal((await sendHeartbeat(boundary, queued.fetcher, {now: new Date(now.getTime() + 1)})).reason, 'heartbeat_source_stale');
  assert.equal(queued.calls.length, 0);
  await rejected({SOURCE_CREATED_AT: '2026-09-27T15:09:59Z', SOURCE_UPDATED_AT: now.toISOString()}, 'heartbeat_source_stale');
  await rejected({SOURCE_CREATED_AT: '2026-09-27T15:31:00Z'}, 'heartbeat_source_stale');
  await rejected({SOURCE_UPDATED_AT: '2026-09-27T15:31:00Z'}, 'heartbeat_source_stale');
  await rejected({SOURCE_UPDATED_AT: '2026-09-27T15:24:00Z'}, 'heartbeat_source_stale');
  for (const value of ['invalid', '', '2026-09-27', undefined]) await rejected({SOURCE_CREATED_AT: value}, 'heartbeat_source_stale');
  assert.equal((await sendHeartbeat(fixture(), queued.fetcher, {now: new Date(NaN)})).status, 'rejected');
});

test('only the exact single-check HTTPS ping destination is permitted', async () => {
  for (const destination of [url + '/', url + '?data=private', url + '#secret', url + '/log', url + '/fail',
    url.replace('https:', 'http:'), url.replace('hc-ping.com', 'hc-ping.com.evil.test'),
    url.replace('hc-ping.com', 'user:password@hc-ping.com'), url.replace('hc-ping.com', 'hc-ping.com:443'),
    url.replace('hc-ping.com', '127.0.0.1'), url.replace('11111111', 'not-uuid'), url + '\n']) {
    await rejected({FOLIO_MONITOR_HEARTBEAT_URL: destination}, 'heartbeat_destination_invalid');
  }
});

test('HTTP200 ignored pings and nonexact bodies do not count as acceptance', async () => {
  for (const body of ['OK (not found)', 'OK (rate limited)', 'ok', 'OK\n', '', '<html>OK</html>']) {
    const f = transport(body); const report = await sendHeartbeat(fixture(), f.fetcher, {now});
    assert.equal(report.status, 'rejected'); assert.equal(report.reason, 'heartbeat_not_accepted'); assert.equal(f.calls.length, 1);
  }
});

test('redirects and HTTP errors are not followed or echoed', async () => {
  for (const status of [302, 400, 403, 429, 500]) {
    const f = transport('PRIVATE_RESPONSE', status, {location: 'https://private.example.test'});
    const report = await sendHeartbeat(fixture(), f.fetcher, {now});
    assert.equal(report.status, 'rejected'); assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init?.redirect, 'error'); assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
});

test('oversized or misdeclared responses stop within bounded reads', async () => {
  for (const [body, headers] of [['X'.repeat(65), {}], ['OK', {'content-length': '65'}], ['OK', {'content-length': 'invalid'}]] as [string, HeadersInit][]) {
    const f = transport(body, 200, headers); const report = await sendHeartbeat(fixture(), f.fetcher, {now});
    assert.equal(report.status, 'rejected'); assert.equal(report.reason, 'heartbeat_response_invalid');
  }
});

test('transport and streaming deadlines fail without leaking the ping capability', async () => {
  const failed: typeof fetch = async () => { throw new Error(`PRIVATE ${url}`); };
  const report = await sendHeartbeat(fixture(), failed, {now});
  assert.deepEqual(report, {status: 'rejected', reason: 'heartbeat_transport_failed', requests: 1});
  const hanging: typeof fetch = async () => new Promise<Response>(() => {});
  assert.equal((await sendHeartbeat(fixture(), hanging, {now, timeoutMs: 10})).reason, 'heartbeat_timeout');
  const streaming: typeof fetch = async () => new Response(new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('O')); }}));
  assert.equal((await sendHeartbeat(fixture(), streaming, {now, timeoutMs: 10})).reason, 'heartbeat_timeout');
});

test('workflow uses trusted default-branch code and never downloads source artifacts or shares diagnostic credentials', async () => {
  const workflow = await fs.readFile(new URL('../.github/workflows/monitor-heartbeat.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:\s+workflows: \[Operational monitoring\]\s+types: \[completed\]\s+branches: \[main\]/);
  assert.match(workflow, /ref: \$\{\{ github.sha \}\}/); assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /ref:.*workflow_run|download-artifact|pull_request_target|workflow_dispatch/);
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/g)].map(match => match[1]), ['FOLIO_MONITOR_HEARTBEAT_URL']);
  assert.match(workflow, /permissions:\s+contents: read/); assert.doesNotMatch(workflow, /: write/);
  for (const key of Object.keys(fixture()).filter(key => key.startsWith('SOURCE_'))) assert.match(workflow, new RegExp(`${key}: \\$\\{\\{ github.event.workflow_run\\.`));
});
