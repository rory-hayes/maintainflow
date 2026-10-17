import {triggerMonitor, type TriggerEnvironment} from '../../../../scripts/monitor-external-trigger.ts';
import {parseExternalTick} from '../../../../scripts/monitor-trigger-contract.ts';

// This export must remain present: omitting schedule would create an HTTP function.
export const config = {schedule: '2-59/5 * * * *'};

const maximumBodyBytes = 1024;
const parseDeadlineMs = 1000;
const accountId = '66a271919d5b23184c2781f0';
type NetlifyRuntime = {env: {get(name: string): string | undefined}};
type ScheduledContext = {account: {id: string}; site: {id: string}; deploy: {id: string; context: string; published: boolean}; requestId: string};
type Report = Awaited<ReturnType<typeof triggerMonitor>>;
class EventError extends Error {}

function value(name: keyof TriggerEnvironment | 'FOLIO_MONITOR_NETLIFY_SITE_ID'): string | undefined {
  return (globalThis as typeof globalThis & {Netlify?: NetlifyRuntime}).Netlify?.env.get(name);
}

async function scheduledTime(request: Request): Promise<{tick: number; nextRun: string}> {
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximumBodyBytes)) throw new EventError('netlify_event_invalid');
  const reader = request.body?.getReader();
  if (!reader) throw new EventError('netlify_event_invalid');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = (async () => {
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximumBodyBytes) throw new EventError('netlify_event_invalid');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let event: unknown;
      try { event = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); }
      catch { throw new EventError('netlify_event_invalid'); }
      if (event === null || typeof event !== 'object' || Array.isArray(event)) throw new EventError('netlify_event_invalid');
      // Netlify promises next_run, not a one-field envelope. Ignore all other data.
      const nextRun = (event as Record<string, unknown>).next_run;
      if (typeof nextRun !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(?:\.000)?Z$/.test(nextRun)) throw new EventError('netlify_event_invalid');
      const next = Date.parse(nextRun);
      if (!Number.isFinite(next)) throw new EventError('netlify_event_invalid');
      const canonical = new Date(next).toISOString();
      if ((nextRun !== canonical && nextRun !== canonical.replace('.000Z', 'Z')) || parseExternalTick(canonical) === null) throw new EventError('netlify_event_invalid');
      // next_run is the NEXT invocation, not an attested original firing time.
      const tick = next - 300_000, now = Date.now();
      if (!Number.isFinite(now) || tick > now || now - tick > 120_000) throw new EventError('netlify_tick_stale');
      return {tick, nextRun: canonical};
    })();
    return await Promise.race([read, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new EventError('netlify_event_timeout')), parseDeadlineMs);
    })]);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Called only by Netlify's scheduled-function runtime; no public request route. */
export default async function handler(request: Request, context: ScheduledContext): Promise<Response> {
  let report: Report;
  let invocation: {requestId: string; deployId: string; nextRun?: string} | undefined;
  try {
    // No body, secret or transport access while absent/disabled.
    if (value('FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED') !== 'true') {
      report = {status: 'inactive', reason: 'trigger_disabled', tick: '', requests: 0};
    } else {
      const site = value('FOLIO_MONITOR_NETLIFY_SITE_ID');
      if (typeof site !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(site) || context?.account?.id !== accountId
        || context?.site?.id !== site || context?.deploy?.context !== 'production' || context?.deploy?.published !== true
        || typeof context.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context.requestId)
        || typeof context.deploy.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(context.deploy.id)) throw new EventError('netlify_context_invalid');
      invocation = {requestId: context.requestId, deployId: context.deploy.id};
      const event = await scheduledTime(request);
      invocation.nextRun = event.nextRun;
      report = await triggerMonitor(event.tick, {
        FOLIO_MONITOR_EXTERNAL_TRIGGER_ENABLED: 'true',
        FOLIO_MONITOR_TRIGGER_ACTOR_ID: value('FOLIO_MONITOR_TRIGGER_ACTOR_ID'),
        FOLIO_MONITOR_TRIGGER_TOKEN: value('FOLIO_MONITOR_TRIGGER_TOKEN'),
        FOLIO_MONITOR_TRIGGER_KEY: value('FOLIO_MONITOR_TRIGGER_KEY'),
      });
    }
  } catch (error) {
    report = {status: 'failed', reason: error instanceof EventError ? error.message : 'netlify_adapter_failed', tick: '', requests: 0};
  }
  console.info(JSON.stringify({adapter: 'netlify', ...report, ...invocation}));
  if (report.status === 'failed') throw new Error('monitor_trigger_failed');
  return new Response(null, {status: 204});
}
