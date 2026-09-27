/** Optional, completed-schedule heartbeat. No .env, application state, or customer data. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repository = 'rory-hayes/maintainflow';
const maxAgeMs = 20 * 60_000;
type Report = {status: 'sent' | 'inactive' | 'rejected'; reason: string; requests: number};
class HeartbeatError extends Error {}
function requireValue(value: unknown, reason: string): asserts value {
  if (!value) throw new HeartbeatError(reason);
}

/** Values are supplied by GitHub's workflow_run context, never by source artifacts. */
export function validateCompletedSchedule(env: NodeJS.ProcessEnv, now: Date): void {
  requireValue(env.GITHUB_EVENT_NAME === 'workflow_run' && env.GITHUB_REPOSITORY === repository
    && env.GITHUB_REF === 'refs/heads/main' && env.GITHUB_RUN_ATTEMPT === '1', 'heartbeat_trigger_invalid');
  requireValue(env.FOLIO_MONITOR_ENABLED === 'true', 'heartbeat_monitor_disabled');
  requireValue(env.SOURCE_EVENT === 'schedule' && env.SOURCE_REPOSITORY === repository
    && env.SOURCE_HEAD_REPOSITORY === repository && env.SOURCE_BRANCH === 'main'
    && env.SOURCE_WORKFLOW === 'Operational monitoring'
    && env.SOURCE_PATH === '.github/workflows/operations-monitor.yml'
    && env.SOURCE_TITLE === 'Folio monitor: run', 'heartbeat_source_invalid');
  requireValue(env.SOURCE_STATUS === 'completed' && env.SOURCE_CONCLUSION === 'success'
    && env.SOURCE_ATTEMPT === '1', 'heartbeat_completion_invalid');
  requireValue(/^[1-9][0-9]{0,15}$/.test(env.SOURCE_RUN_ID ?? '')
    && Number.isSafeInteger(Number(env.SOURCE_RUN_ID))
    && /^[0-9a-f]{40}$/.test(env.SOURCE_SHA ?? ''), 'heartbeat_identity_invalid');
  const parse = (value: string | undefined) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value ?? '')
    ? Date.parse(value!) : NaN;
  const created = parse(env.SOURCE_CREATED_AT), updated = parse(env.SOURCE_UPDATED_AT), current = now.getTime();
  requireValue(Number.isFinite(current) && Number.isFinite(created) && Number.isFinite(updated)
    && created <= updated && updated <= current && current - created <= maxAgeMs, 'heartbeat_source_stale');
}

export async function sendHeartbeat(env: NodeJS.ProcessEnv, transport: typeof fetch = fetch,
  options: {now?: Date; timeoutMs?: number} = {}): Promise<Report> {
  const url = env.FOLIO_MONITOR_HEARTBEAT_URL;
  if (!url) return {status: 'inactive', reason: 'heartbeat_not_configured', requests: 0};
  let requests = 0;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    validateCompletedSchedule(env, options.now ?? new Date());
    // A check-specific ping capability only; no arbitrary destinations, queries or log uploads.
    requireValue(/^https:\/\/hc-ping\.com\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(url), 'heartbeat_destination_invalid');
    const timeoutMs = options.timeoutMs ?? 10_000;
    requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10_000, 'heartbeat_timeout_invalid');
    const work = (async () => {
      requests++;
      const response = await transport(url, {method: 'GET', redirect: 'error', signal: controller.signal,
        headers: {'Accept': 'text/plain', 'User-Agent': 'MaintainFlow-monitor-heartbeat'}});
      requireValue(response.status === 200, 'heartbeat_response_invalid');
      const length = response.headers.get('content-length');
      requireValue(length === null || /^\d+$/.test(length) && Number(length) <= 64, 'heartbeat_response_invalid');
      const reader = response.body?.getReader();
      requireValue(reader, 'heartbeat_response_invalid');
      let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          requireValue(size <= 64, 'heartbeat_response_invalid');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      // Healthchecks also uses HTTP200 for "OK (not found)" and "OK (rate limited)".
      requireValue(Buffer.concat(chunks).toString('utf8') === 'OK', 'heartbeat_not_accepted');
      return {status: 'sent' as const, reason: 'completed_schedule_accepted', requests};
    })();
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new HeartbeatError('heartbeat_timeout')); }, timeoutMs);
    })]);
  } catch (error) {
    return {status: 'rejected', reason: error instanceof HeartbeatError ? error.message : 'heartbeat_transport_failed', requests};
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function main(args = process.argv.slice(2), env = process.env, transport: typeof fetch = fetch) {
  if (args.length === 0 || args.length === 1 && args[0] === '--plan') return {exitCode: 0,
    report: {status: 'inactive', reason: 'plan_only', requests: 0}};
  if (args.length !== 1 || args[0] !== '--send') return {exitCode: 2,
    report: {status: 'rejected', reason: 'heartbeat_arguments_invalid', requests: 0}};
  const report = await sendHeartbeat(env, transport);
  return {exitCode: report.status === 'rejected' ? 1 : 0, report};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => { console.log(JSON.stringify(result.report)); process.exitCode = result.exitCode; })
    .catch(() => { console.error(JSON.stringify({status: 'rejected', reason: 'heartbeat_failed'})); process.exitCode = 1; });
}
