type Cadence = 'daily' | 'weekly';

type ZonedParts = {
  year: string;
  month: string;
  day: string;
  weekday: string;
  hour: number;
};

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((part) => part.type === type);
  /* v8 ignore next 3 -- Intl always emits year, month, day, weekday, and hour */
  if (found === undefined) {
    throw new Error(`Intl part missing: ${type}`);
  }
  return found.value;
}

function zonedParts(nowMs: number, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(new Date(nowMs));
  const hourRaw = partValue(parts, 'hour');
  const hour = Number(hourRaw);
  /* v8 ignore next 3 -- hourCycle h23 only emits integers 0 through 23 */
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`invalid zoned hour: ${hourRaw}`);
  }
  return {
    year: partValue(parts, 'year'),
    month: partValue(parts, 'month'),
    day: partValue(parts, 'day'),
    weekday: partValue(parts, 'weekday'),
    hour,
  };
}

function parseYmd(key: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (match === null) {
    throw new Error(`invalid YYYY-MM-DD: ${key}`);
  }
  const yearStr = match[1];
  const monthStr = match[2];
  const dayStr = match[3];
  /* v8 ignore next 3 -- a successful match of three groups always binds them */
  if (yearStr === undefined || monthStr === undefined || dayStr === undefined) {
    throw new Error(`invalid YYYY-MM-DD: ${key}`);
  }
  return {
    year: Number(yearStr),
    month: Number(monthStr),
    day: Number(dayStr),
  };
}

function addUtcDays(key: string, days: number): string {
  const { year, month, day } = parseYmd(key);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  const y = String(utc.getUTCFullYear()).padStart(4, '0');
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * True only when `zone` is non-empty and `Intl` accepts it as a time zone.
 */
export function isValidTimeZone(zone: string): boolean {
  if (zone === '') {
    return false;
  }
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Calendar date `YYYY-MM-DD` of `nowMs` in `timeZone`.
 */
export function dayKey(nowMs: number, timeZone: string): string {
  const parts = zonedParts(nowMs, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Monday `YYYY-MM-DD` of the calendar week (Monday start) that contains
 * `dayKey(nowMs, timeZone)`. Uses UTC date arithmetic on that Y-M-D.
 */
export function weekKey(nowMs: number, timeZone: string): string {
  const day = dayKey(nowMs, timeZone);
  const { year, month, day: monthDay } = parseYmd(day);
  const utc = new Date(Date.UTC(year, month - 1, monthDay));
  const daysFromMonday = (utc.getUTCDay() + 6) % 7;
  return addUtcDays(day, -daysFromMonday);
}

/**
 * `dayKey` when `cadence` is `daily`, `weekKey` when `weekly`.
 */
export function periodKey(nowMs: number, cadence: Cadence, timeZone: string): string {
  if (cadence === 'daily') {
    return dayKey(nowMs, timeZone);
  }
  return weekKey(nowMs, timeZone);
}

/**
 * Next calendar day, or the Monday seven days later. `key` is `YYYY-MM-DD`.
 */
export function nextPeriod(key: string, cadence: Cadence): string {
  if (cadence === 'daily') {
    return addUtcDays(key, 1);
  }
  return addUtcDays(key, 7);
}

/**
 * Lexical compare of `YYYY-MM-DD`, which is chronological.
 * `-1` when `a < b`, `0` when equal, `1` when `a > b`.
 */
export function comparePeriod(a: string, b: string): -1 | 0 | 1 {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

/**
 * Latest Monday that is ratable at `nowMs` in `timeZone`.
 * A week becomes ratable at 08:00 on the following Monday in that zone.
 */
export function weeklyRatableThrough(nowMs: number, timeZone: string): string {
  const monday = weekKey(nowMs, timeZone);
  const parts = zonedParts(nowMs, timeZone);
  if (parts.weekday === 'Mon' && parts.hour < 8) {
    return addUtcDays(monday, -14);
  }
  return addUtcDays(monday, -7);
}

/**
 * Manila review week: `{ start: weeklyRatableThrough(nowMs, 'Asia/Manila') }`.
 */
export function manilaReviewWeek(nowMs: number): { start: string } {
  return { start: weeklyRatableThrough(nowMs, 'Asia/Manila') };
}
