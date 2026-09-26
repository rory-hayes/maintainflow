import test from 'node:test';
import assert from 'node:assert/strict';
import {checkStaleMonitor, evaluateSchedule, main} from '../scripts/stale-monitor.js';

const repo = 'rory-hayes/maintainflow', base = `https://api.github.com/repos/${repo}/actions/workflows/operations-monitor.yml`;
const now = new Date('2026-09-26T17:00:00Z'), token = 'synthetic_observer_read_only_token';
const metadata = {id: 123, path: '.github/workflows/operations-monitor.yml', state: 'active'};
const run = (id = 10, minutes = 5, extra: Record<string, unknown> = {}) => ({
  id, run_number: id, run_attempt: 1, workflow_id: 123, display_title: 'Folio monitor: run',
  event: 'schedule', head_branch: 'main', head_sha: 'e'.repeat(40), status: 'completed', conclusion: 'success',
  created_at: new Date(now.getTime() - minutes * 60_000).toISOString(), updated_at: now.toISOString(),
  repository: {full_name: repo}, head_repository: {full_name: repo}, ...extra,
});
const history = (runs: ReturnType<typeof run>[], total = runs.length) => ({total_count: total, workflow_runs: runs});
const evaluate = (runs: ReturnType<typeof run>[], total = runs.length) => evaluateSchedule(metadata, history(runs, total), now);
function fixture(runs: ReturnType<typeof run>[], workflowMetadata: unknown = metadata) {
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    const headers = new Headers(init?.headers); assert.equal(headers.get('authorization'), `Bearer ${token}`);
    assert.equal(headers.get('x-github-api-version'), '2022-11-28');
    assert.ok(url === base || url === `${base}/runs?branch=main&event=schedule&per_page=30`);
    return Response.json(url === base ? workflowMetadata : history(runs));
  };
  return {calls, transport};
}

test('healthy requires a completed stateful scheduled main run, and reports only fixed metadata', async () => {
  const f = fixture([run()]); const result = await checkStaleMonitor({token, now}, f.transport);
  assert.equal(result.status, 'healthy'); assert.equal(result.reason, 'scheduled_monitor_fresh');
  assert.equal(result.lastSuccessfulScheduledRun?.id, 10); assert.equal(f.calls.length, 2);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('age uses scheduled creation, not rerun completion or recent metadata updates', () => {
  assert.equal(evaluate([run(10, 20)]).status, 'healthy');
  for (const extra of [{}, {run_attempt: 2}, {updated_at: now.toISOString()}]) {
    assert.equal(evaluate([run(10, 20.001, extra)]).reason, 'scheduled_monitor_stale');
  }
});

test('latest scheduled failure cannot be concealed by an older fresh success or a new queued run', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure']) {
    const failed = run(11, 3, {conclusion});
    assert.equal(evaluate([run(10, 5), failed]).reason, 'latest_scheduled_run_failed');
    assert.equal(evaluate([failed, run(12, 1, {status: 'queued', conclusion: null}), run(10, 5)]).reason, 'latest_scheduled_run_failed');
  }
});

test('new completed scheduled success recovers a prior failure', () => {
  assert.equal(evaluate([run(9, 15, {conclusion: 'failure'}), run(10, 5)]).status, 'healthy');
});

test('incomplete runs never count as successful or refresh stale evidence', () => {
  for (const status of ['requested', 'queued', 'pending', 'waiting', 'in_progress']) {
    const pending = run(11, 1, {status, conclusion: null});
    assert.equal(evaluate([pending]).reason, 'no_scheduled_success');
    assert.equal(evaluate([pending, run(10, 25)]).reason, 'scheduled_monitor_stale');
    assert.equal(evaluate([pending, run(10, 10)]).status, 'healthy');
  }
});

test('disabled schedule gate blocks even if skipped job made workflow success or older run is fresh', () => {
  for (const conclusion of ['success', 'skipped']) {
    const disabled = run(11, 3, {display_title: 'Folio monitor: disabled', conclusion});
    assert.equal(evaluate([disabled, run()]).reason, 'schedule_gate_disabled');
    assert.equal(evaluate([run(12, 1, {status: 'queued', conclusion: null}), disabled, run()]).reason, 'schedule_gate_disabled');
  }
});

test('disabled workflow needs no second API call and is never healthy', async () => {
  for (const state of ['deleted', 'disabled_fork', 'disabled_inactivity', 'disabled_manually']) {
    const f = fixture([run()], {...metadata, state});
    const result = await checkStaleMonitor({token, now}, f.transport);
    assert.equal(result.reason, 'workflow_disabled'); assert.equal(result.status, 'unhealthy'); assert.equal(f.calls.length, 1);
  }
});

test('no activation evidence and bounded history without a success stay unhealthy', () => {
  assert.equal(evaluate([]).reason, 'no_scheduled_success');
  const pending = Array.from({length: 30}, (_, i) => run(40 - i, i, {status: 'queued', conclusion: null}));
  assert.equal(evaluate(pending, 100).reason, 'no_success_in_bounded_history');
  pending[1] = run(39, 1);
  assert.equal(evaluate(pending, 100).status, 'healthy');
  assert.throws(() => evaluate(pending.slice(0, 2), 100), /observer_history_invalid/);
});

test('probe, drill, initialize, manual run and wrong workflow/repository/branch cannot establish schedule evidence', () => {
  const patches = [
    {event: 'workflow_dispatch'}, {display_title: 'Folio monitor: probe'}, {display_title: 'Folio monitor: delivery-drill'},
    {display_title: 'Folio monitor: initialize'}, {display_title: 'unknown'}, {workflow_id: 124}, {head_branch: 'other'},
    {repository: {full_name: 'foreign/repo'}}, {head_repository: {full_name: 'foreign/repo'}}, {head_sha: 'bad'},
  ];
  for (const patch of patches) assert.throws(() => evaluate([run(10, 5, patch)]), /observer_run_invalid/);
  for (const patch of [{path: 'foreign.yml'}, {id: 0}, {state: 'unknown'}]) {
    assert.throws(() => evaluateSchedule({...metadata, ...patch}, history([run()]), now), /observer_workflow_invalid/);
  }
});

test('future, malformed or contradictory timestamps and ambiguous history fail closed', () => {
  for (const patch of [{created_at: '2026-09-26T17:01:00Z'}, {updated_at: '2026-09-26T17:01:00Z'},
    {created_at: 'yesterday'}, {created_at: '2026-02-30T12:00:00Z'}, {updated_at: '2026-09-26T16:00:00Z'},
    {status: 'completed', conclusion: null}, {status: 'queued', conclusion: 'success'}, {run_attempt: 0}]) {
    assert.throws(() => evaluate([run(10, 5, patch)]), /observer_run_invalid/);
  }
  for (const runs of [[run(), run()], [run(), run(11, 5, {run_number: 10})], [run(11, 15), run(10, 5)]]) {
    assert.throws(() => evaluate(runs), /observer_history_ambiguous/);
  }
});

test('API and transport failures expose safe fixed reason codes without response details or tokens', async () => {
  for (const response of [new Response(token, {status: 401}), new Response(token, {status: 302, headers: {location: 'https://foreign.test'}}),
    new Response('{broken'), new Response('x'.repeat(1024 * 1024 + 1)), new Response('{}', {headers: {'content-length': String(1024 * 1024 + 1)}})]) {
    const result = await checkStaleMonitor({token, now}, async () => response);
    assert.equal(result.status, 'unavailable'); assert.match(result.reason, /^observer_/);
    assert.equal(JSON.stringify(result).includes(token), false);
  }
  const result = await checkStaleMonitor({token, now}, async () => { throw new Error(token); });
  assert.equal(result.reason, 'observer_api_unavailable');
});

test('deadline bounds a noncooperative transport and prevents late second requests', async () => {
  let release!: (response: Response) => void, calls = 0;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  const transport: typeof fetch = async () => { calls++; return pending; };
  const result = await checkStaleMonitor({token, now, timeoutMs: 10}, transport);
  assert.equal(result.reason, 'observer_api_timeout');
  release(Response.json(metadata)); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('invalid local settings cause no requests and plan ignores all environment values', async () => {
  let calls = 0; const transport: typeof fetch = async () => { calls++; throw new Error('must not contact network'); };
  for (const patch of [{token: ''}, {maxAgeMinutes: 9}, {maxAgeMinutes: 61}, {maxAgeMinutes: NaN}, {now: new Date('bad')}, {timeoutMs: 30_001}]) {
    assert.equal((await checkStaleMonitor({token, now, ...patch}, transport)).status, 'unavailable');
  }
  const env = new Proxy({}, {get: () => { throw new Error('must not read environment'); }});
  assert.equal((await main([], env, transport)).exitCode, 0);
  assert.equal((await main(['--plan'], env, transport)).exitCode, 0);
  assert.equal((await main(['--unknown'], env, transport)).exitCode, 2);
  assert.equal(calls, 0);
});

test('explicit CLI check exits unsuccessfully for missing token, malformed threshold and absent scheduled evidence', async () => {
  for (const env of [{}, {GH_TOKEN: token, STALE_MONITOR_MAX_AGE_MINUTES: '20abc'}]) {
    assert.equal((await main(['--check'], env, async () => { throw new Error('must not request'); })).exitCode, 1);
  }
  const f = fixture([]); const result = await main(['--check'], {GH_TOKEN: token}, f.transport);
  assert.equal(result.exitCode, 1); assert.equal(result.report.reason, 'no_scheduled_success'); assert.equal(f.calls.length, 2);
});
