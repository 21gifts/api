/**
 * Coinbase Exchange BTC-USD daily candle fetch and parse (no SQL).
 */

/** Default Coinbase Exchange candles URL for BTC-USD. */
export const DEFAULT_BTC_USD_CANDLES_URL =
  'https://api.exchange.coinbase.com/products/BTC-USD/candles';

/** Minimal fetch used by the candle client (tests inject a stub). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One UTC calendar day close price. */
export interface CandleClose {
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  /** USD per BTC as a decimal string. */
  usdPerBtc: string;
}

const MS_PER_DAY = 86_400_000;
const MAX_DAYS_PER_REQUEST = 300;
const DEFAULT_TIMEOUT_MS = 8_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Resolve the candles HTTP URL from the environment.
 *
 * Blank or unset `BTC_USD_CANDLES_URL` yields the Coinbase default so the
 * process still boots without the variable.
 *
 * @param env - Process environment slice.
 * @returns Trimmed override or {@link DEFAULT_BTC_USD_CANDLES_URL}.
 */
export function resolveCandlesUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['BTC_USD_CANDLES_URL'];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_BTC_USD_CANDLES_URL;
  }
  return raw.trim();
}

/**
 * Parse a Coinbase candles JSON body into daily closes.
 *
 * Each element is `[time, low, high, open, close, volume]` with `time` as
 * unix seconds at UTC midnight. Rows with a non-positive close or bad shape
 * are skipped.
 *
 * @param body - Parsed JSON value.
 * @returns Close rows (order not significant).
 * @throws If `body` is not an array.
 */
export function parseCoinbaseCandles(body: unknown): CandleClose[] {
  if (!Array.isArray(body)) {
    throw new Error('coinbase candles: expected array');
  }
  const out: CandleClose[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 5) {
      continue;
    }
    const time = row[0];
    const close = row[4];
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      continue;
    }
    if (typeof close !== 'number' || !Number.isFinite(close) || close <= 0) {
      continue;
    }
    const day = new Date(time * 1000).toISOString().slice(0, 10);
    out.push({ day, usdPerBtc: String(close) });
  }
  return out;
}

/**
 * Fetch daily BTC-USD closes for an inclusive UTC day range.
 *
 * Ranges longer than 300 days are split into chunks. Uses
 * `granularity=86400`, `User-Agent: 21.gifts-api`, and an AbortSignal timeout.
 *
 * @param args - Fetch impl, URL, inclusive day bounds, optional timeout.
 * @returns Parsed closes (may omit days Coinbase did not return).
 * @throws On non-OK HTTP, invalid JSON, or invalid day bounds.
 */
export async function fetchDailyCloses(args: {
  fetchImpl: FetchFn;
  url: string;
  fromDay: string;
  toDay: string;
  timeoutMs?: number;
}): Promise<CandleClose[]> {
  const fromMs = parseDayMs(args.fromDay);
  const toMs = parseDayMs(args.toDay);
  if (fromMs === null || toMs === null || fromMs > toMs) {
    throw new Error('coinbase candles: invalid day range');
  }
  const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const all: CandleClose[] = [];
  for (let startMs = fromMs; startMs <= toMs; startMs += MAX_DAYS_PER_REQUEST * MS_PER_DAY) {
    const endMs = Math.min(startMs + (MAX_DAYS_PER_REQUEST - 1) * MS_PER_DAY, toMs);
    const chunk = await fetchChunk({
      fetchImpl: args.fetchImpl,
      url: args.url,
      startMs,
      endMs,
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
 * GET one Coinbase candle chunk and parse it.
 *
 * @param args - Fetch details for one inclusive day span.
 * @returns Parsed closes for the chunk.
 */
async function fetchChunk(args: {
  fetchImpl: FetchFn;
  url: string;
  startMs: number;
  endMs: number;
  timeoutMs: number;
}): Promise<CandleClose[]> {
  const startIso = new Date(args.startMs).toISOString();
  const endIso = new Date(args.endMs).toISOString();
  const endpoint = new URL(args.url);
  endpoint.searchParams.set('granularity', '86400');
  endpoint.searchParams.set('start', startIso);
  endpoint.searchParams.set('end', endIso);

  const response = await args.fetchImpl(endpoint.toString(), {
    headers: { 'User-Agent': '21.gifts-api' },
    signal: AbortSignal.timeout(args.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`coinbase candles: HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('coinbase candles: invalid JSON');
  }
  return parseCoinbaseCandles(body);
}
