/**
 * Frankfurter ECB USD→CHF/EUR/PHP daily rate fetch and parse (no SQL).
 */

import type { FetchFn } from '@/lib/btc-usd-candles';

/** Default Frankfurter ECB rates URL (USD base, CHF/EUR/PHP quotes). */
export const DEFAULT_FRANKFURTER_RATES_URL = 'https://api.frankfurter.dev/v2/providers/ecb/rates';

/** One ECB publication-day FX row (quote per 1 USD). */
export interface FiatCandle {
  /** ECB publication day `YYYY-MM-DD` from the JSON `date` field. */
  day: string;
  /** Quote currency. */
  quote: 'CHF' | 'EUR' | 'PHP';
  /** Quote per 1 USD as a decimal string of the JSON `rate` number. */
  rate: string;
}

const MS_PER_DAY = 86_400_000;
const MAX_DAYS_PER_REQUEST = 300;
const DEFAULT_TIMEOUT_MS = 8_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the Frankfurter rates HTTP URL from the environment.
 *
 * Blank or unset `FRANKFURTER_RATES_URL` yields the Frankfurter ECB default
 * so the process still boots without the variable.
 *
 * @param env - Process environment slice.
 * @returns Trimmed override or {@link DEFAULT_FRANKFURTER_RATES_URL}.
 */
export function resolveFrankfurterUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['FRANKFURTER_RATES_URL'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_FRANKFURTER_RATES_URL;
  }
  return raw.trim();
}

/**
 * Parse a Frankfurter ECB rates JSON body into USD-cross candles.
 *
 * Each element is `{ date, base, quote, rate }`. Rows that are not objects,
 * whose `date` is not a real `YYYY-MM-DD`, whose `base` is not `USD`
 * (case-insensitive), whose `quote` is not CHF/EUR/PHP (case-insensitive,
 * stored uppercase), or whose `rate` is not a finite number `> 0` are
 * skipped. Carry-forward onto weekend gift days is the store's job.
 *
 * @param body - Parsed JSON value.
 * @returns Candle rows (order not significant).
 * @throws If `body` is not an array.
 */
export function parseFrankfurterRates(body: unknown): FiatCandle[] {
  if (!Array.isArray(body)) {
    throw new Error('frankfurter rates: expected array');
  }
  const out: FiatCandle[] = [];
  for (const row of body) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      continue;
    }
    const rec = row as Record<string, unknown>;
    const date = rec['date'];
    const base = rec['base'];
    const quote = rec['quote'];
    const rate = rec['rate'];
    if (typeof date !== 'string' || parseDayMs(date) === null) {
      continue;
    }
    if (typeof base !== 'string' || base.toUpperCase() !== 'USD') {
      continue;
    }
    if (typeof quote !== 'string') {
      continue;
    }
    const code = quote.toUpperCase();
    if (code !== 'CHF' && code !== 'EUR' && code !== 'PHP') {
      continue;
    }
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
      continue;
    }
    out.push({ day: date, quote: code, rate: String(rate) });
  }
  return out;
}

/**
 * Fetch USD→CHF/EUR/PHP ECB rates for an inclusive UTC day range.
 *
 * Ranges longer than 300 days are split into chunks. Uses `base=usd`,
 * `quotes=chf,eur,php`, `User-Agent: 21.gifts-api`, and an AbortSignal timeout.
 *
 * @param args - Fetch impl, URL, inclusive day bounds, optional timeout.
 * @returns Parsed candles (weekend publication days may be omitted by ECB).
 * @throws On non-OK HTTP, invalid JSON, or invalid day bounds.
 */
export async function fetchFiatRates(args: {
  fetchImpl: FetchFn;
  url: string;
  fromDay: string;
  toDay: string;
  timeoutMs?: number;
}): Promise<FiatCandle[]> {
  const fromMs = parseDayMs(args.fromDay);
  const toMs = parseDayMs(args.toDay);
  if (fromMs === null || toMs === null || fromMs > toMs) {
    throw new Error('frankfurter rates: invalid day range');
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const all: FiatCandle[] = [];
  for (let startMs = fromMs; startMs <= toMs; startMs += MAX_DAYS_PER_REQUEST * MS_PER_DAY) {
    const endMs = Math.min(startMs + (MAX_DAYS_PER_REQUEST - 1) * MS_PER_DAY, toMs);
    const chunk = await fetchChunk({
      fetchImpl: args.fetchImpl,
      url: args.url,
      fromDay: new Date(startMs).toISOString().slice(0, 10),
      toDay: new Date(endMs).toISOString().slice(0, 10),
      timeoutMs,
    });
    all.push(...chunk);
  }
  return all;
}

/**
 * Parse `YYYY-MM-DD` to UTC midnight epoch ms, or `null` if invalid.
 *
 * @param day - Candidate day string.
 * @returns Epoch ms or `null`.
 */
function parseDayMs(day: string): number | null {
  if (!DAY_RE.test(day)) {
    return null;
  }
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  if (Number.isNaN(ms)) {
    return null;
  }
  if (new Date(ms).toISOString().slice(0, 10) !== day) {
    return null;
  }
  return ms;
}

/**
 * GET one Frankfurter rates chunk and parse it.
 *
 * @param args - Fetch details for one inclusive day span.
 * @returns Parsed candles for the chunk.
 */
async function fetchChunk(args: {
  fetchImpl: FetchFn;
  url: string;
  fromDay: string;
  toDay: string;
  timeoutMs: number;
}): Promise<FiatCandle[]> {
  const endpoint = new URL(args.url);
  endpoint.searchParams.set('base', 'usd');
  endpoint.searchParams.set('quotes', 'chf,eur,php');
  endpoint.searchParams.set('from', args.fromDay);
  endpoint.searchParams.set('to', args.toDay);

  const response = await args.fetchImpl(endpoint.toString(), {
    headers: { 'User-Agent': '21.gifts-api' },
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`frankfurter rates: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('frankfurter rates: invalid JSON');
  }
  return parseFrankfurterRates(body);
}
