import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHmac} from 'node:crypto';
import {triggerMonitor, type TriggerEnvironment} from '../scripts/monitor-external-trigger.ts';
import {main as selectorMain, validateExternalTrigger} from '../scripts/monitor-artifact-state.ts';

const base = 'https://api.github.com/repos/rory-hayes/maintainflow/actions/workflows/operations-monitor.yml';
const tick = '2026-10-17T14:22:00.000Z', at = Date.parse(tick), now = () => at + 30_000;
const signingKey = '11'.repeat(32);
const sign = (value: string) => createHmac('sha256', Buffer.from(signingKey, 'hex')).update('maintainflow-monitor-tick:v1:' + value).digest('hex');
const env: TriggerEnvironment = {FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: 'true', FOLIO_MONITOR_TRIGGER_ACTOR_ID: '123', FOLIO_MONITOR_TRIGGER_TOKEN: 'synthetic_dedicated_actions_write_token', FOLIO_MONITOR_TRIGGER_KEY: signingKey};
const metadata = {id: 367642139, path: '.github/workflows/operations-monitor.yml', state: 'active'};
const existing = (patch: Record<string, unknown> = {}) => ({id: 45, workflow_id: metadata.id, event: 'workflow_dispatch',
  head_branch: 'main', repository: {full_name: 'rory-hayes/maintainflow'}, head_repository: {full_name: 'rory-hayes/maintainflow'},
  display_title: 'Folio monitor: external-run ' + tick, actor: {id: 123}, ...patch});
function fixture(runs: unknown[] = [], dispatch = () => Response.json({workflow_run_id: 46})) {
  const calls: {url: string; init?: RequestInit}[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({url, init});
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get('x-github-api-version'), '2026-03-10');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + env.FOLIO_MONITOR_TRIGGER_TOKEN);
    if (url === 'https://api.github.com/user') return Response.json({id: 123});
    if (url === base) return Response.json(metadata);
    if (url === base + '/runs?branch=main&event=workflow_dispatch&per_page=30') return Response.json({total_count: runs.length, workflow_runs: runs});
    assert.equal(url, base + '/dispatches'); assert.equal(init?.method, 'POST'); return dispatch();
  };
  return {calls, fetcher};
}

test('external timer uses only fixed repository, main and tick payload; acceptance binds a run, never health', async () => {
  const f = fixture(), result = await triggerMonitor(at, env, f.fetcher, {now});
  assert.deepEqual(result, {status: 'accepted', reason: 'trigger_dispatch_accepted', tick, requests: 4, runId: 46});
  assert.deepEqual(f.calls.map(c => c.init?.method), ['GET', 'GET', 'GET', 'POST']);
  assert.deepEqual(JSON.parse(String(f.calls[3].init?.body)), {ref: 'main', inputs: {mode: 'external-run', trigger_at: tick, tick_signature: sign(tick)}});
  assert.doesNotMatch(JSON.stringify(result), /synthetic|Bearer|healthy|completed/);
  assert.equal(f.calls[3].init?.signal?.aborted, true);
});

test('disabled timer never reads credentials; bad configuration and stale or noncanonical ticks never contact GitHub', async () => {
  const disabled = new Proxy({FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: 'false'}, {get(target, key) {
    assert.equal(key, 'FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED'); return target.FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED;
  }});
  const noNetwork: typeof fetch = async () => { throw new Error('must not call'); };
  assert.equal((await triggerMonitor(at, disabled, noNetwork)).status, 'inactive');
  for (const value of [at - 300_000, at + 300_000, at + 1, at + 60_000, NaN]) {
    const result = await triggerMonitor(value, env, noNetwork, {now}); assert.equal(result.status, 'failed'); assert.equal(result.requests, 0);
  }
  for (const patch of [{FOLIO_MONITOR_TRIGGER_ACTOR_ID: '01'}, {FOLIO_MONITOR_TRIGGER_ACTOR_ID: '9007199254740993'},
    {FOLIO_MONITOR_TRIGGER_TOKEN: 'short'}, {FOLIO_MONITOR_TRIGGER_TOKEN: 'secret\nwith-space'}, {FOLIO_MONITOR_TRIGGER_KEY: ''}]) {
    assert.equal((await triggerMonitor(at, {...env, ...patch}, noNetwork, {now})).requests, 0);
  }
});

test('uncertain acknowledgement is not retried, and exact tick metadata reconciles a later attempt', async () => {
  const uncertain = fixture([], () => { throw new Error('PRIVATE provider response'); });
  const result = await triggerMonitor(at, env, uncertain.fetcher, {now});
  assert.equal(result.reason, 'trigger_dispatch_uncertain_reconcile_metadata'); assert.equal(uncertain.calls.length, 4);
  const retry = fixture([existing()]);
  assert.deepEqual(await triggerMonitor(at, env, retry.fetcher, {now}), {status: 'skipped', reason: 'trigger_tick_already_created', tick, requests: 3, runId: 45});
  assert.equal(retry.calls.filter(c => c.init?.method === 'POST').length, 0);
  const manual = fixture([existing({display_title: 'Folio monitor: run'})]);
  assert.equal((await triggerMonitor(at, env, manual.fetcher, {now})).status, 'accepted');
});

test('wrong credential actor, inactive workflow, malformed history and forged tick prevent dispatch', async () => {
  for (const [url, body] of [['https://api.github.com/user', {id: 999}], [base, {...metadata, state: 'disabled_manually'}],
    [base + '/runs?branch=main&event=workflow_dispatch&per_page=30', {total_count: 1, workflow_runs: [existing({actor: {id: 999}})]}]] as const) {
    const f = fixture();
    const result = await triggerMonitor(at, env, (input, init) => String(input) === url ? Promise.resolve(Response.json(body)) : f.fetcher(input, init), {now});
    assert.equal(result.status, 'failed'); assert.ok(f.calls.every(c => c.init?.method === 'GET'));
  }
  const f = fixture([existing({head_branch: 'other'})]);
  assert.equal((await triggerMonitor(at, env, f.fetcher, {now})).reason, 'trigger_history_invalid');
});

test('dispatch errors, redirects, missing run bindings and obsolete empty responses remain uncertain', async () => {
  for (const response of [new Response(null, {status: 204}), new Response('PRIVATE', {status: 403}),
    new Response(null, {status: 302, headers: {location: 'https://foreign.example'}}), Response.json({workflow_run_id: 0}), Response.json({})]) {
    const f = fixture([], () => response), result = await triggerMonitor(at, env, f.fetcher, {now});
    assert.equal(result.reason, 'trigger_dispatch_uncertain_reconcile_metadata'); assert.equal(result.requests, 4);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|foreign/);
  }
});

test('oversized or hanging reads and transport failures are bounded, private and cannot cause a late dispatch', async () => {
  const oversized: typeof fetch = async () => new Response('x'.repeat(1024 * 1024 + 1));
  assert.equal((await triggerMonitor(at, env, oversized, {now})).reason, 'trigger_response_invalid');
  let release!: (response: Response) => void; let calls = 0;
  const hanging: typeof fetch = async () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const result = await triggerMonitor(at, env, hanging, {now, timeoutMs: 10});
  assert.equal(result.reason, 'trigger_timeout'); release(Response.json({id: 123}));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
  const failure: typeof fetch = async () => { throw new Error('PRIVATE ' + env.FOLIO_MONITOR_TRIGGER_TOKEN); };
  assert.equal((await triggerMonitor(at, env, failure, {now})).reason, 'trigger_transport_failed');
});

test('tick freshness is checked again after reads, before a dispatch can start', async () => {
  let time = at + 30_000; const f = fixture();
  const transport: typeof fetch = async (input, init) => {
    const response = await f.fetcher(input, init); if (String(input).includes('/runs?')) time = at + 120_001; return response;
  };
  assert.equal((await triggerMonitor(at, env, transport, {now: () => time})).reason, 'trigger_tick_stale'); assert.equal(f.calls.length, 3);
});

test('source-authenticated selector rejects external identity/tick before reading any state', () => {
  const values = {GITHUB_EVENT_NAME: 'workflow_dispatch', FOLIO_MONITOR_ENABLED: 'true', FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: 'true',
    FOLIO_MONITOR_TRIGGER_ACTOR_ID: '123', GITHUB_ACTOR_ID: '123', FOLIO_MONITOR_TRIGGER_AT: tick,
    FOLIO_MONITOR_TRIGGER_KEY: signingKey, FOLIO_MONITOR_TICK_SIGNATURE: sign(tick)};
  validateExternalTrigger(values, at + 20 * 60_000);
  for (const patch of [{GITHUB_EVENT_NAME: 'schedule'}, {FOLIO_MONITOR_ENABLED: 'false'}, {FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: ''},
    {GITHUB_ACTOR_ID: '999'}, {FOLIO_MONITOR_TRIGGER_AT: tick.replace('14:22', '14:23')}, {FOLIO_MONITOR_TRIGGER_AT: tick.replace('17T', '99T')}]) {
    assert.throws(() => validateExternalTrigger({...values, ...patch}, at + 30_000), /external_trigger_invalid/);
  }
  assert.throws(() => validateExternalTrigger(values, at + 20 * 60_000 + 1), /external_trigger_invalid/);
  for (const patch of [{FOLIO_MONITOR_TRIGGER_KEY: ''}, {FOLIO_MONITOR_TICK_SIGNATURE: ''},
    {FOLIO_MONITOR_TICK_SIGNATURE: '00'.repeat(32)}, {FOLIO_MONITOR_TICK_SIGNATURE: sign(tick.replace('14:22', '14:27'))}]) {
    assert.throws(() => validateExternalTrigger({...values, ...patch}, at + 30_000), /external_trigger_signature_invalid/);
  }
});

function selectorEnvironment(eventPath: string, currentTick: string): NodeJS.ProcessEnv {
  return {GITHUB_REPOSITORY: 'rory-hayes/maintainflow', GITHUB_REF: 'refs/heads/main', MONITOR_MODE: 'external-run',
    GITHUB_EVENT_NAME: 'workflow_dispatch', FOLIO_MONITOR_ENABLED: 'true', FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: 'true',
    FOLIO_MONITOR_TRIGGER_ACTOR_ID: '123', GITHUB_ACTOR_ID: '123', FOLIO_MONITOR_TRIGGER_AT: currentTick,
    FOLIO_MONITOR_TRIGGER_KEY: signingKey, GITHUB_EVENT_PATH: eventPath};
}
function currentAlignedTick() {
  const minute = Math.floor(Date.now() / 60_000);
  return new Date((minute - (minute + 3) % 5) * 60_000).toISOString();
}

test('selector authenticates the provider event-file signature before requiring output and makes no network request', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected_selector_network'); });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-monitor-event-'));
  try {
    const eventPath = path.join(directory, 'event.json'), currentTick = currentAlignedTick();
    const event = JSON.stringify({inputs: {mode: 'external-run', trigger_at: currentTick, tick_signature: sign(currentTick)}});
    // A workflow environment signature cannot replace the assertion in the event file.
    for (const content of [event, event.padEnd(128 * 1024, ' ')]) {
      await fs.writeFile(eventPath, content);
      await assert.rejects(selectorMain([], {...selectorEnvironment(eventPath, currentTick), FOLIO_MONITOR_TICK_SIGNATURE: '00'.repeat(32)}), /artifact_output_missing/);
    }
    assert.equal(network.mock.calls.length, 0);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('selector rejects missing or inconsistent event inputs and bad HMAC before inspecting output', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected_selector_network'); });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-monitor-event-inputs-'));
  try {
    const eventPath = path.join(directory, 'event.json'), currentTick = currentAlignedTick(), output = path.join(directory, 'output');
    const inputs = {mode: 'external-run', trigger_at: currentTick, tick_signature: sign(currentTick)};
    const differentTick = new Date(Date.parse(currentTick) - 5 * 60_000).toISOString();
    const cases: {event: unknown; error: RegExp}[] = [
      {event: null, error: /external_trigger_event_invalid/}, {event: {}, error: /external_trigger_event_invalid/},
      {event: {inputs: []}, error: /external_trigger_event_invalid/},
      ...[{mode: undefined}, {mode: 'run'}, {trigger_at: undefined}, {trigger_at: differentTick},
        {tick_signature: undefined}, {tick_signature: 123}].map(patch => ({event: {inputs: {...inputs, ...patch}}, error: /external_trigger_event_invalid/})),
      ...['', '00'.repeat(32), sign(differentTick)].map(signature => ({event: {inputs: {...inputs, tick_signature: signature}}, error: /external_trigger_signature_invalid/})),
    ];
    await fs.writeFile(output, 'untouched'); let outputReads = 0;
    const guarded = new Proxy({...selectorEnvironment(eventPath, currentTick), GITHUB_OUTPUT: output,
      FOLIO_MONITOR_TICK_SIGNATURE: sign(currentTick)}, {get(target, property, receiver) {
      if (property === 'GITHUB_OUTPUT') { outputReads++; throw new Error('output_inspected_before_authentication'); }
      return Reflect.get(target, property, receiver);
    }});
    for (const entry of cases) {
      await fs.writeFile(eventPath, JSON.stringify(entry.event));
      await assert.rejects(selectorMain([], guarded), entry.error);
    }
    assert.equal(outputReads, 0); assert.equal(await fs.readFile(output, 'utf8'), 'untouched'); assert.equal(network.mock.calls.length, 0);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('selector refuses missing, relative, linked, nonregular, oversized and malformed event files before output', async t => {
  const network = t.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected_selector_network'); });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-monitor-event-file-'));
  try {
    const eventPath = path.join(directory, 'event.json'), currentTick = currentAlignedTick(), output = path.join(directory, 'output');
    const linked = path.join(directory, 'linked.json'), oversized = path.join(directory, 'oversized.json'), malformed = path.join(directory, 'malformed.json');
    await fs.writeFile(eventPath, JSON.stringify({inputs: {mode: 'external-run', trigger_at: currentTick, tick_signature: sign(currentTick)}}));
    await fs.symlink(eventPath, linked); await fs.writeFile(oversized, ' '.repeat(128 * 1024 + 1)); await fs.writeFile(malformed, '{"inputs":'); await fs.writeFile(output, 'untouched');
    let outputReads = 0;
    const guarded = (eventFile: string | undefined) => new Proxy({...selectorEnvironment(eventPath, currentTick), GITHUB_EVENT_PATH: eventFile, GITHUB_OUTPUT: output}, {get(target, property, receiver) {
      if (property === 'GITHUB_OUTPUT') { outputReads++; throw new Error('output_inspected_before_authentication'); }
      return Reflect.get(target, property, receiver);
    }});
    for (const eventFile of [undefined, 'event.json', directory, oversized]) await assert.rejects(selectorMain([], guarded(eventFile)), /external_trigger_event_invalid/);
    await assert.rejects(selectorMain([], guarded(path.join(directory, 'missing.json'))), {code: 'ENOENT'});
    await assert.rejects(selectorMain([], guarded(linked)), {code: 'ELOOP'});
    await assert.rejects(selectorMain([], guarded(malformed)), SyntaxError);
    assert.equal(outputReads, 0); assert.equal(await fs.readFile(output, 'utf8'), 'untouched'); assert.equal(network.mock.calls.length, 0);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('deploy source has a scheduled handler only, disabled timer and no public route or application credentials', async () => {
  const worker = await fs.readFile(new URL('../deploy/monitor-trigger/worker.ts', import.meta.url), 'utf8');
  const config = await fs.readFile(new URL('../deploy/monitor-trigger/wrangler.toml', import.meta.url), 'utf8');
  assert.match(worker, /async scheduled/); assert.doesNotMatch(worker, /async fetch|HEARTBEAT|EMAIL|STATE_KEY|MONITOR_SECRET/);
  assert.match(config, /workers_dev = false/); assert.match(config, /crons = \[\]/); assert.match(config, /ENABLED = "false"/);
});
