/** Read-only observer of the monitor's selected trigger. No application probes, state, or notifications. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repository = 'rory-hayes/maintainflow';
const workflow = 'operations-monitor.yml';
const api = `https://api.github.com/repos/${repository}/actions`;
const runLimit = 30;
const responseLimit = 1024 * 1024;
const statuses = ['requested', 'queued', 'pending', 'waiting', 'in_progress', 'completed'];
const conclusions = ['success', 'failure', 'cancelled', 'timed_out', 'action_required', 'neutral', 'skipped', 'stale', 'startup_failure'];

type EvaluationOptions = {externalActorId?: number};
export type ObserverOptions = EvaluationOptions & {token: string; maxAgeMinutes?: number; timeoutMs?: number; now?: Date};
type Run = {
  id: number; run_number: number; run_attempt: number; workflow_id: number;
  display_title: string; event: string; head_branch: string; head_sha: string;
  status: string; conclusion: string | null; created_at: string; updated_at: string;
  repository: {full_name: string}; head_repository: {full_name: string};
  triggerAt?: string;
};
type RunReceipt = {
  id: number; attempt: number; number: number; revision: string;
  createdAt: string; triggerAt?: string; status: string; conclusion: string | null; url: string;
};
export type ObserverReport = {
  observer: 'maintainflow-operational-monitor';
  source: 'github-schedule' | 'external-trigger';
  repository: typeof repository; workflow: typeof workflow; branch: 'main';
  checkedAt: string; maxAgeMinutes: number; status: 'healthy' | 'unhealthy' | 'unavailable';
  reason: string; workflowActive: boolean | null;
  latestScheduledRun: RunReceipt | null; lastSuccessfulScheduledRun: RunReceipt | null;
};
class ObserverError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new ObserverError(code);
}
function timestamp(value: unknown, now: number): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && Date.parse(value) <= now
    && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
}
function receipt(run: Run, external = false): RunReceipt {
  return {id: run.id, attempt: run.run_attempt, number: run.run_number, revision: run.head_sha,
    createdAt: run.created_at, status: run.status, conclusion: run.conclusion,
    ...(external ? {triggerAt: run.triggerAt} : {}),
    url: `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`};
}

function externalTick(title: string, createdAt: string, now: number): string {
  const tick = title.slice('Folio monitor: external-run '.length), instant = new Date(tick);
  requireValue(title.startsWith('Folio monitor: external-run ')
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(tick)
    && timestamp(tick, now) && instant.toISOString() === tick
    && instant.getUTCSeconds() === 0 && instant.getUTCMilliseconds() === 0 && instant.getUTCMinutes() % 5 === 2
    && Date.parse(createdAt) >= instant.getTime() && Date.parse(createdAt) - instant.getTime() <= 120_000,
  'observer_external_tick_invalid');
  return tick;
}

/** Pure classification; the caller supplies metadata, never logs, artifacts, or secret values. */
export function evaluateSchedule(workflowMetadata: unknown, history: unknown, now = new Date(), maxAgeMinutes = 20,
  options: EvaluationOptions = {}): ObserverReport {
  const external = options.externalActorId !== undefined;
  requireValue(Number.isFinite(now.getTime()), 'observer_clock_invalid');
  requireValue(Number.isSafeInteger(maxAgeMinutes) && maxAgeMinutes >= 10 && maxAgeMinutes <= 60, 'observer_threshold_invalid');
  requireValue(!external || positive(options.externalActorId), 'observer_external_actor_invalid');
  const report: ObserverReport = {observer: 'maintainflow-operational-monitor', source: external ? 'external-trigger' : 'github-schedule',
    repository, workflow, branch: 'main',
    checkedAt: now.toISOString(), maxAgeMinutes, status: 'unhealthy', reason: external ? 'no_external_success' : 'no_scheduled_success',
    workflowActive: null, latestScheduledRun: null, lastSuccessfulScheduledRun: null};
  requireValue(object(workflowMetadata) && positive(workflowMetadata.id)
    && workflowMetadata.path === `.github/workflows/${workflow}`
    && typeof workflowMetadata.state === 'string', 'observer_workflow_invalid');
  requireValue(['active', 'deleted', 'disabled_fork', 'disabled_inactivity', 'disabled_manually'].includes(workflowMetadata.state), 'observer_workflow_invalid');
  report.workflowActive = workflowMetadata.state === 'active';
  if (!report.workflowActive) return {...report, reason: 'workflow_disabled'};
  requireValue(object(history) && count(history.total_count) && Array.isArray(history.workflow_runs)
    && history.workflow_runs.length <= runLimit && history.total_count >= history.workflow_runs.length
    && (history.total_count === history.workflow_runs.length || history.workflow_runs.length === runLimit), 'observer_history_invalid');
  // Dispatch history also contains ordinary manual actions. They cannot establish freshness,
  // but must not make an otherwise verifiable external run unavailable. A claimed external
  // title is always validated, including untrusted or malformed claims.
  const selected = external ? history.workflow_runs.filter((entry: unknown) => {
    requireValue(object(entry) && typeof entry.display_title === 'string', 'observer_run_invalid');
    return entry.display_title.startsWith('Folio monitor: external-run');
  }) : history.workflow_runs;
  const runs = selected.map((entry: unknown): Run => {
    requireValue(object(entry) && positive(entry.id) && positive(entry.run_number) && positive(entry.run_attempt)
      && entry.workflow_id === workflowMetadata.id && entry.event === (external ? 'workflow_dispatch' : 'schedule') && entry.head_branch === 'main'
      && typeof entry.head_sha === 'string' && /^[a-f0-9]{40}$/.test(entry.head_sha)
      && object(entry.repository) && entry.repository.full_name === repository
      && object(entry.head_repository) && entry.head_repository.full_name === repository
      && typeof entry.display_title === 'string' && (external || ['Folio monitor: run', 'Folio monitor: disabled'].includes(entry.display_title))
      && typeof entry.status === 'string' && statuses.includes(entry.status)
      && (entry.status === 'completed' ? typeof entry.conclusion === 'string' && conclusions.includes(entry.conclusion) : entry.conclusion === null)
      && timestamp(entry.created_at, now.getTime()) && timestamp(entry.updated_at, now.getTime())
      && Date.parse(entry.updated_at) >= Date.parse(entry.created_at), 'observer_run_invalid');
    if (external) {
      requireValue(object(entry.actor) && entry.actor.id === options.externalActorId, 'observer_external_actor_untrusted');
      return {...entry as unknown as Run, triggerAt: externalTick(entry.display_title, entry.created_at as string, now.getTime())};
    }
    return entry as unknown as Run;
  }).sort((a, b) => b.run_number - a.run_number);
  requireValue(new Set(runs.map(run => run.id)).size === runs.length
    && new Set(runs.map(run => run.run_number)).size === runs.length, 'observer_history_ambiguous');
  requireValue(runs.every((run, index) => index === 0 || Date.parse(run.created_at) <= Date.parse(runs[index - 1]!.created_at)), 'observer_history_ambiguous');
  const latest = runs[0];
  const successful = runs.find(run => (external || run.display_title === 'Folio monitor: run') && run.status === 'completed' && run.conclusion === 'success');
  report.latestScheduledRun = latest ? receipt(latest, external) : null;
  report.lastSuccessfulScheduledRun = successful ? receipt(successful, external) : null;
  if (latest?.display_title === 'Folio monitor: disabled') return {...report, reason: 'schedule_gate_disabled'};
  // A queued run must not hide the most recent completed failure or disabled run.
  const completed = runs.find(run => run.status === 'completed');
  if (completed?.display_title === 'Folio monitor: disabled') return {...report, reason: 'schedule_gate_disabled'};
  if (completed && completed.conclusion !== 'success') return {...report, reason: external ? 'latest_external_run_failed' : 'latest_scheduled_run_failed'};
  if (!successful) return {...report, reason: history.total_count > history.workflow_runs.length ? 'no_success_in_bounded_history'
    : external ? 'no_external_success' : 'no_scheduled_success'};
  // Schedule creation / intended external tick measure trigger progress; reruns and
  // updated_at cannot refresh old evidence. External creation is separately bounded to its tick.
  if (now.getTime() - Date.parse(external ? successful.triggerAt! : successful.created_at) > maxAgeMinutes * 60_000) {
    return {...report, reason: external ? 'external_monitor_stale' : 'scheduled_monitor_stale'};
  }
  return {...report, status: 'healthy', reason: external ? 'external_monitor_fresh' : 'scheduled_monitor_fresh'};
}

async function json(url: string, token: string, transport: typeof fetch, signal: AbortSignal): Promise<unknown> {
  let response: Response | undefined;
  try {
    signal.throwIfAborted();
    response = await transport(url, {method: 'GET', redirect: 'error', signal,
      headers: {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28'}});
    signal.throwIfAborted();
    requireValue(response.status === 200, 'observer_api_unavailable');
    const length = response.headers.get('content-length');
    requireValue(length === null || /^\d+$/.test(length) && Number(length) <= responseLimit, 'observer_response_limit');
    const reader = response.body?.getReader();
    requireValue(reader, 'observer_response_invalid');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const part = await reader.read();
        signal.throwIfAborted();
        if (part.done) break;
        size += part.value.byteLength;
        requireValue(size <= responseLimit, 'observer_response_limit');
        chunks.push(part.value);
      }
    } finally { void reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { throw new ObserverError('observer_response_invalid'); }
  } finally { if (response && !response.bodyUsed) void response.body?.cancel().catch(() => {}); }
}

/** At most two fixed GitHub GET routes, with a shared deadline; no credentials returned. */
export async function checkStaleMonitor(options: ObserverOptions, transport: typeof fetch = fetch): Promise<ObserverReport> {
  const now = options.now ?? new Date(), maxAgeMinutes = options.maxAgeMinutes ?? 20;
  const external = options.externalActorId !== undefined;
  const checkedAt = Number.isFinite(now.getTime()) ? now.toISOString() : '';
  const unavailable = (reason: string): ObserverReport => ({observer: 'maintainflow-operational-monitor', source: external ? 'external-trigger' : 'github-schedule', repository, workflow,
    branch: 'main', checkedAt, maxAgeMinutes, status: 'unavailable', reason, workflowActive: null,
    latestScheduledRun: null, lastSuccessfulScheduledRun: null});
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    requireValue(checkedAt !== '', 'observer_clock_invalid');
    requireValue(Number.isSafeInteger(maxAgeMinutes) && maxAgeMinutes >= 10 && maxAgeMinutes <= 60, 'observer_threshold_invalid');
    requireValue(!external || positive(options.externalActorId), 'observer_external_actor_invalid');
    requireValue(typeof options.token === 'string' && options.token.length >= 16 && !/\s/.test(options.token), 'observer_token_missing');
    const timeoutMs = options.timeoutMs ?? 20_000;
    requireValue(positive(timeoutMs) && timeoutMs <= 30_000, 'observer_timeout_invalid');
    const work = (async () => {
      const metadata = await json(`${api}/workflows/${workflow}`, options.token, transport, controller.signal);
      // Validate workflow identity before issuing the second request, even when disabled.
      const preliminary = evaluateSchedule(metadata, {total_count: 0, workflow_runs: []}, now, maxAgeMinutes, options);
      if (!preliminary.workflowActive) return preliminary;
      const history = await json(`${api}/workflows/${workflow}/runs?branch=main&event=${external ? 'workflow_dispatch' : 'schedule'}&per_page=${runLimit}`, options.token, transport, controller.signal);
      // A live job can update while these requests are in flight; classify at response time.
      return evaluateSchedule(metadata, history, options.now ?? new Date(), maxAgeMinutes, options);
    })();
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ObserverError('observer_api_timeout')); }, timeoutMs);
    })]);
  } catch (error) { return unavailable(error instanceof ObserverError ? error.code : 'observer_api_unavailable'); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function main(args = process.argv.slice(2), env = process.env, transport: typeof fetch = fetch) {
  if (args.length === 0 || args.length === 1 && args[0] === '--plan') return {exitCode: 0, report: {
    observer: 'maintainflow-operational-monitor', mode: 'plan', repository, workflow, branch: 'main',
    maxAgeMinutes: 20, readOnly: true, notificationsSent: 0, externalSchedulingConfigured: false,
    instructions: 'Use --check for GitHub schedules, or --check-external with FOLIO_MONITOR_TRIGGER_ACTOR_ID for external ticks; supply a dedicated Actions-read GH_TOKEN securely. No .env file is loaded.',
  }};
  if (args.length !== 1 || !['--check', '--check-external'].includes(args[0]!)) return {exitCode: 2, report: {status: 'unavailable', reason: 'observer_arguments_invalid'}};
  const supplied = env.STALE_MONITOR_MAX_AGE_MINUTES;
  const maxAgeMinutes = supplied === undefined ? 20 : /^[1-9][0-9]*$/.test(supplied) ? Number(supplied) : NaN;
  const actor = args[0] === '--check-external' ? env.FOLIO_MONITOR_TRIGGER_ACTOR_ID : undefined;
  const externalActorId = actor !== undefined && /^[1-9][0-9]*$/.test(actor) ? Number(actor) : NaN;
  const report = await checkStaleMonitor({token: env.GH_TOKEN ?? '', maxAgeMinutes,
    ...(args[0] === '--check-external' ? {externalActorId} : {})}, transport);
  return {exitCode: report.status === 'healthy' ? 0 : 1, report};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { console.log(JSON.stringify(result.report)); process.exitCode = result.exitCode; })
    .catch(() => { console.error(JSON.stringify({status: 'unavailable', reason: 'observer_failed'})); process.exitCode = 1; });
}
