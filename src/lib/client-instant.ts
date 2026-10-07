/** Earliest accepted instant: 2009-01-03T00:00:00Z (epoch ms). */
export const CLIENT_INSTANT_MIN_MS = 1_230_940_800_000;

/** ISO-8601 instant: date, time to the minute or finer, and `Z` or a numeric offset. */
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|([+-])(\d{2}):?(\d{2}))$/;

/**
 * Epoch milliseconds of an ISO-8601 instant, or `null` when it does not match
 * or names an impossible calendar date, time, or offset (no roll-over into the next month).
 */
function isoInstantMs(value: string): number | null {
  const match = ISO_INSTANT_RE.exec(value);
  if (match === null) {
    return null;
  }
  const [, year, month, day, hour, minute, second, fraction, , sign, offsetHour, offsetMinute] =
    match.map((part) => part ?? '');
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > daysInMonth ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    Number(offsetHour) > 23 ||
    Number(offsetMinute) > 59
  ) {
    return null;
  }
  const offsetMs =
    (sign === '-' ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute)) * 60_000;
  const utc = Date.UTC(
    y,
    mo - 1,
    d,
    Number(hour),
    Number(minute),
    Number(second),
    Number(`${fraction}000`.slice(0, 3)),
  );
  return utc - offsetMs;
}

/** Allowed clock skew into the future: 5 minutes. */
export const CLIENT_INSTANT_FUTURE_SKEW_MS = 300_000;

/**
 * Parse a client timestamp: ISO-8601 instant string (date, time, and `Z` or an offset; impossible
 * calendar values are refused, not rolled over) or finite number.
 *
 * A number below `1e11` is epoch seconds (×1000), otherwise epoch milliseconds.
 *
 * @param value - Raw timestamp from a client body.
 * @param nowMs - Current time (epoch ms) for the future-skew bound.
 * @returns A `Date` when in range, otherwise `null`.
 */
export function parseClientInstant(value: unknown, nowMs: number): Date | null {
  let ms: number;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    ms = value < 1e11 ? value * 1000 : value;
  } else if (typeof value === 'string') {
    const parsed = isoInstantMs(value);
    if (parsed === null) {
      return null;
    }
    ms = parsed;
  } else {
    return null;
  }
  if (ms < CLIENT_INSTANT_MIN_MS || ms > nowMs + CLIENT_INSTANT_FUTURE_SKEW_MS) {
    return null;
  }
  return new Date(ms);
}
