/**
 * BTC/USD spot rate from Kraken XBTUSD and USD→sats conversion.
 *
 * The daily-gifts worker is fail-closed on a missing or implausible rate:
 * no invoice is paid when the corridor check rejects the ticker.
 */

/** Minimal fetch used by rate and LNDHub clients (tests inject a stub). */
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Successful USD-per-BTC rate, or a collapsed failure reason. */
export type BtcUsdRateResult =
  { ok: true; usdPerBtc: number } | { ok: false; reason: 'unavailable' | 'implausible' };

const KRAKEN_XBTUSD_URL = 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD';

/**
 * Convert a USD amount to integer satoshis at the given USD-per-BTC rate.
 *
 * @param usd - USD amount (may be fractional).
 * @param usdPerBtc - Spot USD price of one BTC.
 * @returns `Math.round(usd / usdPerBtc * 1e8)`.
 */
export function usdToSats(usd: number, usdPerBtc: number): number {
  return Math.round((usd / usdPerBtc) * 1e8);
}

/**
 * Fetch the Kraken XBTUSD last trade price and corridor-check it.
 *
 * GETs the public ticker with a 15s timeout. Requires `error` absent or an
 * empty array and a finite positive `result.XXBTZUSD.c[0]`. Prices outside
 * `[minUsd, maxUsd]` inclusive yield `implausible`; any network/HTTP/JSON/
 * schema failure yields `unavailable`.
 *
 * @param args - Injected fetch and inclusive plausible-rate bounds.
 * @returns The rate or a typed failure reason.
 */
export async function fetchKrakenXbtUsd(args: {
  fetchImpl: FetchFn;
  minUsd: number;
  maxUsd: number;
}): Promise<BtcUsdRateResult> {
  let response: Response;
  try {
    response = await args.fetchImpl(KRAKEN_XBTUSD_URL, {
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (!response.ok) {
    return { ok: false, reason: 'unavailable' };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'unavailable' };
  }

  if (typeof body !== 'object' || body === null) {
    return { ok: false, reason: 'unavailable' };
  }
  const record = body as Record<string, unknown>;
  const error = record['error'];
  if (error !== undefined && !(Array.isArray(error) && error.length === 0)) {
    return { ok: false, reason: 'unavailable' };
  }

  const result = record['result'];
  if (typeof result !== 'object' || result === null) {
    return { ok: false, reason: 'unavailable' };
  }
  const pair = (result as Record<string, unknown>)['XXBTZUSD'];
  if (typeof pair !== 'object' || pair === null) {
    return { ok: false, reason: 'unavailable' };
  }
  const close = (pair as Record<string, unknown>)['c'];
  if (!Array.isArray(close) || close.length === 0) {
    return { ok: false, reason: 'unavailable' };
  }
  const raw = close[0];
  const usdPerBtc = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(usdPerBtc) || usdPerBtc <= 0) {
    return { ok: false, reason: 'unavailable' };
  }

  if (usdPerBtc < args.minUsd || usdPerBtc > args.maxUsd) {
    return { ok: false, reason: 'implausible' };
  }

  return { ok: true, usdPerBtc };
}
