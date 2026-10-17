/** Shared external tick contract. Pure, with no environment, IO or credentials. */
export const externalTitlePrefix = 'Folio monitor: external-run ';
export function parseExternalTick(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/.test(value)) return null;
  const at = Date.parse(value), date = new Date(at);
  return Number.isFinite(at) && date.toISOString() === value && date.getUTCMinutes() % 5 === 2 ? at : null;
}
export function actorId(value: unknown): number | null {
  return typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
export function freshExternalTick(title: string, created: number, now: number, maximumAgeMs: number): number | null {
  if (!title.startsWith(externalTitlePrefix)) return null;
  const tick = parseExternalTick(title.slice(externalTitlePrefix.length));
  return tick !== null && Number.isFinite(created) && Number.isFinite(now) && tick <= created
    && created - tick <= 120_000 && created <= now && now - tick <= maximumAgeMs ? tick : null;
}
