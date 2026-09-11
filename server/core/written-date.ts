const localeMonths = new Map<string, Map<string, number>>();
const token = (value: string, locale: string) => value.replace(/[.,]/g, '').trim().toLocaleLowerCase(locale);

/** Unambiguous written month names only; no Date.parse timezone or rollover inference. */
export function normalizeWrittenDate(value: string, locale: string): string | undefined {
  if (new Intl.DateTimeFormat(locale).resolvedOptions().calendar !== 'gregory') return;
  const cleaned = token(value, locale).replace(/\s+/g, ' ');
  const dayFirst = cleaned.match(/^(\d{1,2})(?:st|nd|rd|th)? ([\p{L}\p{M}]+) (\d{4})$/u);
  const monthFirst = cleaned.match(/^([\p{L}\p{M}]+) (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/u);
  if (!dayFirst && !monthFirst) return;
  let months = localeMonths.get(locale);
  if (!months) {
    months = new Map();
    for (let index = 0; index < 12; index++) {
      const date = new Date(Date.UTC(2026, index, 15));
      for (const month of ['long', 'short'] as const) {
        const alone = new Intl.DateTimeFormat(locale, { month, timeZone: 'UTC' }).format(date);
        const inDate = new Intl.DateTimeFormat(locale, { month, day: 'numeric', timeZone: 'UTC' }).formatToParts(date).find(part => part.type === 'month')?.value;
        for (const name of [alone, inDate]) if (name) months.set(token(name, locale), index + 1);
      }
    }
    if (localeMonths.size >= 100) localeMonths.clear();
    localeMonths.set(locale, months);
  }
  const month = months.get(dayFirst ? dayFirst[2] : monthFirst![1]);
  if (!month) return;
  const day = Number(dayFirst ? dayFirst[1] : monthFirst![2]);
  const year = dayFirst ? dayFirst[3] : monthFirst![3];
  // Calendar validity remains the responsibility of validateValues; do not roll over.
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
