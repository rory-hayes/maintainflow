export type AccountLocalMonthPeriod = {
  accountTimeZone: string;
  calculatedAt: string;
  rangeStart: number;
  rangeEnd: number;
  periodStart: number;
  periodEnd: number;
  completeAccountLocalDays: number;
  totalAccountLocalDays: number;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string) {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function localDateTimeAt(date: Date, timeZone: string): LocalDateTime {
  const values = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

function utcLikeMilliseconds(value: LocalDateTime) {
  return Date.UTC(
    value.year,
    value.month - 1,
    value.day,
    value.hour,
    value.minute,
    value.second,
  );
}

function localDateTimeToUnixSeconds(
  value: LocalDateTime,
  timeZone: string,
) {
  const target = utcLikeMilliseconds(value);
  let candidate = target;

  // IANA offsets can change across the month (DST). Re-reading the local
  // representation converges on the UTC instant for the requested wall time.
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const observed = utcLikeMilliseconds(
      localDateTimeAt(new Date(candidate), timeZone),
    );
    const difference = target - observed;
    candidate += difference;
    if (difference === 0) break;
  }

  const resolved = localDateTimeAt(new Date(candidate), timeZone);
  if (utcLikeMilliseconds(resolved) !== target) {
    throw new RangeError(
      `The local time could not be resolved in ${timeZone}.`,
    );
  }

  return Math.floor(candidate / 1_000);
}

function monthAfter(year: number, month: number) {
  return month === 12
    ? { year: year + 1, month: 1 }
    : { year, month: month + 1 };
}

/**
 * Returns the current account-local month and its complete-day observation
 * prefix. The current partial local day is deliberately excluded so dashboard
 * performance never compares partial-day rows with complete daily rows.
 */
export function accountLocalMonthPeriod(
  now: Date,
  accountTimeZone: string,
): AccountLocalMonthPeriod {
  if (Number.isNaN(now.getTime())) {
    throw new RangeError("A valid calculation time is required.");
  }

  const localNow = localDateTimeAt(now, accountTimeZone);
  const followingMonth = monthAfter(localNow.year, localNow.month);
  const midnight = { hour: 0, minute: 0, second: 0 };
  const periodStart = localDateTimeToUnixSeconds(
    {
      year: localNow.year,
      month: localNow.month,
      day: 1,
      ...midnight,
    },
    accountTimeZone,
  );
  const rangeEnd = localDateTimeToUnixSeconds(
    {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day,
      ...midnight,
    },
    accountTimeZone,
  );
  const periodEnd = localDateTimeToUnixSeconds(
    {
      year: followingMonth.year,
      month: followingMonth.month,
      day: 1,
      ...midnight,
    },
    accountTimeZone,
  );

  return {
    accountTimeZone,
    calculatedAt: now.toISOString(),
    rangeStart: periodStart,
    rangeEnd,
    periodStart,
    periodEnd,
    completeAccountLocalDays: localNow.day - 1,
    totalAccountLocalDays: new Date(
      Date.UTC(localNow.year, localNow.month, 0),
    ).getUTCDate(),
  };
}
