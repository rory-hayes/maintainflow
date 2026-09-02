const UTC_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function validDate(value: string | Date) {
  const date =
    value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function twoDigits(value: number) {
  return String(value).padStart(2, "0");
}

export function formatUtcDate(
  value: string | Date,
  options: { fallback?: string } = {},
) {
  const date = validDate(value);
  if (!date) return options.fallback ?? "—";
  return `${twoDigits(date.getUTCDate())} ${UTC_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

export function formatUtcDateTime(
  value: string | Date,
  options: { fallback?: string; includeTimeZone?: boolean } = {},
) {
  const date = validDate(value);
  if (!date) return options.fallback ?? "—";
  const label = `${formatUtcDate(date)}, ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())}`;
  return options.includeTimeZone ? `${label} UTC` : label;
}

export function formatGroupedInteger(value: number) {
  if (!Number.isFinite(value)) return "—";
  const rounded = Math.trunc(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

export function formatDecimal(value: number, maximumFractionDigits = 2) {
  if (!Number.isFinite(value)) return "—";
  const normalizedDigits = Math.max(0, Math.min(20, maximumFractionDigits));
  const [integer, fraction = ""] = Math.abs(value)
    .toFixed(normalizedDigits)
    .split(".");
  const trimmedFraction = fraction.replace(/0+$/, "");
  const sign = value < 0 ? "-" : "";
  const groupedInteger = formatGroupedInteger(Number(integer));
  return `${sign}${groupedInteger}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
}
