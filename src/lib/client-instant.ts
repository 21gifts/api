/** Earliest accepted instant: 2009-01-03T00:00:00Z (epoch ms). */
export const CLIENT_INSTANT_MIN_MS = 1_230_940_800_000;

/** Allowed clock skew into the future: 5 minutes. */
export const CLIENT_INSTANT_FUTURE_SKEW_MS = 300_000;

/**
 * Parse a client timestamp: ISO-8601 string (`Date.parse`) or finite number.
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
    ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
      return null;
    }
  } else {
    return null;
  }
  if (ms < CLIENT_INSTANT_MIN_MS || ms > nowMs + CLIENT_INSTANT_FUTURE_SKEW_MS) {
    return null;
  }
  return new Date(ms);
}
