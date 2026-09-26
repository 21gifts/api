import type { MiddlewareHandler } from 'hono';

/**
 * True when a non-empty `Time-Zone` header names a zone that is in Sunday.
 *
 * @param nowMs - Epoch milliseconds on the server clock.
 * @param timeZoneHeader - Raw `Time-Zone` header. Missing, blank, or invalid does not count as Sunday.
 * @returns True only when the header names a valid IANA zone whose local calendar day is Sunday.
 */
export function isSundayRestHeader(nowMs: number, timeZoneHeader: string | undefined): boolean {
  const zone = (timeZoneHeader ?? '').trim();
  if (zone === '') {
    return false;
  }
  return isSundayInZone(nowMs, zone);
}

/**
 * Sunday 00:00 inclusive through Monday 00:00 exclusive in an IANA zone.
 * Invalid timeZone returns false. Does not default to Asia/Manila.
 *
 * @param nowMs - Epoch milliseconds.
 * @param timeZone - IANA zone name.
 * @returns True when that zone's local weekday is Sunday. False for an invalid zone.
 */
export function isSundayInZone(nowMs: number, timeZone: string): boolean {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(nowMs) === 'Sun';
  } catch {
    return false;
  }
}

const SUNDAY_REST_WRITES: ReadonlyArray<readonly [string, RegExp]> = [
  ['POST', /^\/messages$/],
  ['POST', /^\/messages\/[^/]+\/invoice$/],
  ['POST', /^\/messages\/[^/]+\/repayment$/],
  ['DELETE', /^\/messages\/[^/]+$/],
  ['PATCH', /^\/messages\/[^/]+\/place$/],
  ['PATCH', /^\/messages\/[^/]+\/shop-account$/],
  ['POST', /^\/funding\/apply$/],
  ['POST', /^\/funding\/trial$/],
  ['POST', /^\/funding\/admit$/],
  ['POST', /^\/funding\/reject$/],
  ['POST', /^\/me\/name$/],
  ['POST', /^\/me\/username$/],
  ['POST', /^\/me\/location$/],
  ['PUT', /^\/me\/about$/],
  ['POST', /^\/me\/lightning-address$/],
  ['DELETE', /^\/me\/lightning-address$/],
  ['POST', /^\/me\/lightning-address\/verification$/],
  ['POST', /^\/me\/lightning-address\/verification\/confirm$/],
  ['POST', /^\/trust\/verify$/],
  ['POST', /^\/trust\/propose-moderator$/],
  ['POST', /^\/trust\/confirm-moderator$/],
  ['POST', /^\/trust\/reject-moderator$/],
  ['POST', /^\/trust\/appoint-moderator$/],
  ['GET', /^\/conversations\/moderator-group$/],
];

function isSundayRestWrite(method: string, path: string): boolean {
  for (const [want, pattern] of SUNDAY_REST_WRITES) {
    if (method === want && pattern.test(path)) {
      return true;
    }
  }
  return false;
}

/**
 * Refuse listed public writes with 403 `SUNDAY_REST` when `Time-Zone` is Sunday.
 *
 * Uses the injected clock. Missing, blank, or invalid zones call `next()`.
 * Does not pause the process, `/healthz`, or workers.
 *
 * @param now - Epoch milliseconds (the same callback `createApp` already uses).
 * @returns Hono middleware.
 */
export function sundayRest(now: () => number): MiddlewareHandler {
  return async (c, next) => {
    const zone = (c.req.header('Time-Zone') ?? '').trim();
    if (zone === '') {
      await next();
      return;
    }
    if (!isSundayInZone(now(), zone) || !isSundayRestWrite(c.req.method, c.req.path)) {
      await next();
      return;
    }
    return c.json({ error: 'SUNDAY_REST' }, 403);
  };
}
