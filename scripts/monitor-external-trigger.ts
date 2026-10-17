/** Fixed-target external timer. No application or mail credentials; no automatic POST retry. */
import {actorId, externalTitlePrefix, parseExternalTick} from './monitor-trigger-contract.ts';

const repository = 'rory-hayes/maintainflow';
const base = `https://api.github.com/repos/${repository}/actions/workflows/operations-monitor.yml`;
const maximumBytes = 1024 * 1024;
export type TriggerEnvironment = {
  FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED?: string;
  FOLIO_MONITOR_TRIGGER_ACTOR_ID?: string;
  FOLIO_MONITOR_TRIGGER_TOKEN?: string;
  FOLIO_MONITOR_TRIGGER_KEY?: string;
};
type Report = {status: 'inactive' | 'accepted' | 'skipped' | 'failed'; reason: string; tick: string; requests: number; runId?: number};
class TriggerError extends Error {}
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new TriggerError(reason); }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

async function json(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length');
  requireValue(declared === null || /^\d+$/.test(declared) && Number(declared) <= maximumBytes, 'trigger_response_invalid');
  const reader = response.body?.getReader(); requireValue(reader, 'trigger_response_invalid');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      signal.throwIfAborted(); const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength; requireValue(size <= maximumBytes, 'trigger_response_invalid'); chunks.push(part.value);
    }
  } finally { void reader.cancel().catch(() => {}); }
  try { return JSON.parse(new TextDecoder().decode(concat(chunks, size))) as unknown; }
  catch { throw new TriggerError('trigger_response_invalid'); }
}
function concat(chunks: Uint8Array[], size: number) {
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

/** Only a provider's scheduled handler should supply scheduledTime, never a public HTTP route. */
export async function triggerMonitor(scheduledTime: number, env: TriggerEnvironment, transport: typeof fetch = fetch,
  options: {now?: () => number; timeoutMs?: number} = {}): Promise<Report> {
  let requests = 0, tick = '';
  const report = (status: Report['status'], reason: string, runId?: number): Report => ({status, reason, tick, requests, ...(runId ? {runId} : {})});
  if (env.FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED !== 'true') return report('inactive', 'trigger_disabled');
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  let postStarted = false;
  try {
    requireValue(Number.isSafeInteger(scheduledTime), 'trigger_tick_invalid');
    tick = new Date(scheduledTime).toISOString();
    const now = options.now ?? Date.now;
    const fresh = () => requireValue(parseExternalTick(tick) !== null && Number.isFinite(now())
      && scheduledTime <= now() && now() - scheduledTime <= 120_000, 'trigger_tick_stale');
    fresh();
    const actor = actorId(env.FOLIO_MONITOR_TRIGGER_ACTOR_ID), token = env.FOLIO_MONITOR_TRIGGER_TOKEN, signingKey = env.FOLIO_MONITOR_TRIGGER_KEY ?? '';
    requireValue(actor !== null && typeof token === 'string' && token.length >= 16 && !/\s/.test(token)
      && /^[0-9a-f]{64}$/.test(signingKey), 'trigger_configuration_invalid');
    const timeoutMs = options.timeoutMs ?? 15_000;
    requireValue(positive(timeoutMs) && timeoutMs <= 20_000, 'trigger_timeout_invalid');
    const headers = {accept: 'application/vnd.github+json', authorization: `Bearer ${token}`,
      'x-github-api-version': '2026-03-10', 'user-agent': 'MaintainFlow-monitor-trigger'};
    const get = async (url: string) => {
      controller.signal.throwIfAborted(); requests++;
      const response = await transport(url, {method: 'GET', redirect: 'error', signal: controller.signal, headers});
      try { requireValue(response.status === 200, 'trigger_api_unavailable'); return await json(response, controller.signal); }
      finally { if (!response.bodyUsed) void response.body?.cancel().catch(() => {}); }
    };
    const work = (async () => {
      const user = await get('https://api.github.com/user');
      requireValue(object(user) && user.id === actor, 'trigger_actor_mismatch');
      const metadata = await get(base);
      requireValue(object(metadata) && positive(metadata.id) && metadata.path === '.github/workflows/operations-monitor.yml'
        && metadata.state === 'active', 'trigger_workflow_invalid');
      const history = await get(`${base}/runs?branch=main&event=workflow_dispatch&per_page=30`);
      requireValue(object(history) && Number.isSafeInteger(history.total_count) && Number(history.total_count) >= 0
        && Array.isArray(history.workflow_runs) && history.workflow_runs.length <= 30
        && Number(history.total_count) >= history.workflow_runs.length
        && (history.total_count === history.workflow_runs.length || history.workflow_runs.length === 30), 'trigger_history_invalid');
      // An uncertain acknowledgement is reconciled through the fixed title, not a second POST.
      for (const run of history.workflow_runs) {
        requireValue(object(run) && positive(run.id) && run.workflow_id === metadata.id && run.event === 'workflow_dispatch'
          && run.head_branch === 'main' && object(run.repository) && run.repository.full_name === repository
          && object(run.head_repository) && run.head_repository.full_name === repository, 'trigger_history_invalid');
        if (run.display_title !== externalTitlePrefix + tick) continue;
        requireValue(object(run.actor) && run.actor.id === actor, 'trigger_history_invalid');
        return report('skipped', 'trigger_tick_already_created', run.id);
      }
      const keyBytes = Uint8Array.from(signingKey.match(/../g)!, byte => parseInt(byte, 16));
      const key = await crypto.subtle.importKey('raw', keyBytes, {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
      const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('maintainflow-monitor-tick:v1:' + tick)));
      const tickSignature = [...signature].map(byte => byte.toString(16).padStart(2, '0')).join('');
      fresh(); controller.signal.throwIfAborted(); requests++; postStarted = true;
      const response = await transport(`${base}/dispatches`, {method: 'POST', redirect: 'error', signal: controller.signal,
        headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({ref: 'main', inputs: {mode: 'external-run', trigger_at: tick, tick_signature: tickSignature}})});
      try {
        // Version 2026-03-10 returns a run binding. Acceptance is never monitor completion.
        requireValue(response.status === 200, 'trigger_dispatch_not_accepted');
        const accepted = await json(response, controller.signal);
        requireValue(object(accepted) && positive(accepted.workflow_run_id), 'trigger_acceptance_invalid');
        return report('accepted', 'trigger_dispatch_accepted', accepted.workflow_run_id);
      } finally { if (!response.bodyUsed) void response.body?.cancel().catch(() => {}); }
    })();
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new TriggerError('trigger_timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    return report('failed', postStarted ? 'trigger_dispatch_uncertain_reconcile_metadata'
      : error instanceof TriggerError ? error.message : 'trigger_transport_failed');
  } finally { clearTimeout(timer); controller.abort(); }
}
