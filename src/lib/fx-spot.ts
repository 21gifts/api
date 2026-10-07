/**
 * Current BTC price in USD, CHF, EUR, and PHP for `GET /fx/spot`.
 *
 * One Coinbase request returns every pair. A background tick stores the last
 * good quote; HTTP requests only read the store and never call the provider.
 */

import type { FetchFn } from '@/lib/btc-usd-candles';
import { BTC_USD_SPOT_TIMEOUT_MS } from '@/lib/btc-usd-spot';
import type { FxSpotStore } from '@/lib/fx-spot-store';
import { errorLogFields, logEvent } from '@/lib/log';

/** Default Coinbase endpoint: every currency per 1 BTC in one response. */
const DEFAULT_BTC_FIAT_SPOT_URL = 'https://api.coinbase.com/v2/exchange-rates?currency=BTC';

/** Source tag stored with each quote and returned as `source`. */
export const FX_SPOT_SOURCE_COINBASE = 'coinbase-exchange-rates';

/** Refresh the stored quote this often (milliseconds). */
export const FX_SPOT_REFRESH_MS = 5 * 60_000;

/** Fiat currencies quoted per 1 BTC. */
export type SpotFiat = 'USD' | 'CHF' | 'EUR' | 'PHP';

/** The four quoted currencies, in response order. */
export const SPOT_FIATS: readonly SpotFiat[] = ['USD', 'CHF', 'EUR', 'PHP'];

/** Fiat per 1 BTC as decimal text. A currency without a usable quote is omitted. */
export type SpotRates = Partial<Record<SpotFiat, string>>;

/** One stored quote. */
export interface FxSpotQuote {
  /** ISO-8601 time the quote was fetched. */
  asOf: string;
  /** Provider tag, e.g. {@link FX_SPOT_SOURCE_COINBASE}. */
  source: string;
  /** Fiat per 1 BTC; at least one currency is present. */
  rates: SpotRates;
}

const DECIMAL_RE = /^\d{1,24}(?:\.\d{1,24})?$/;

/**
 * Resolve the provider URL from the environment.
 *
 * Blank or unset `BTC_FIAT_SPOT_URL` yields the Coinbase default so the process
 * still boots without the variable.
 *
 * @param env - Process environment slice.
 * @returns Trimmed override or the Coinbase exchange-rates URL.
 */
export function resolveFxSpotUrl(env: NodeJS.ProcessEnv): string {
  const raw = env['BTC_FIAT_SPOT_URL']?.trim() ?? '';
  return raw === '' ? DEFAULT_BTC_FIAT_SPOT_URL : raw;
}

/**
 * Keep a provider rate only when it is a positive decimal string. A JSON number
 * is refused: parsing may already have rounded it, so it is not provider precision.
 *
 * @param value - Raw value from the provider body.
 * @returns The decimal text, or `null` when it is not usable.
 */
function usableRate(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value) || !(Number(value) > 0)) {
    return null;
  }
  return value;
}

/**
 * Fetch the current BTC price in the four fiats without ever throwing.
 *
 * Expects the Coinbase body `{ data: { currency: "BTC", rates: { USD: "…", … } } }`.
 * A currency whose rate is missing or not positive decimal text is omitted.
 * `asOf` is the time the request started, so of two overlapping fetches the one
 * sent later is the newer quote.
 *
 * @param args - Fetch implementation, provider URL, and clock for `asOf`.
 * @returns A quote with at least one currency, or `null` for every clock, transport,
 * shape, or value failure, including a fetch that aborts after
 * `BTC_USD_SPOT_TIMEOUT_MS`.
 */
export async function fetchFxSpot(args: {
  fetchImpl: FetchFn;
  url: string;
  now: () => number;
}): Promise<FxSpotQuote | null> {
  try {
    const asOf = new Date(args.now()).toISOString();
    const response = await args.fetchImpl(args.url, {
      signal: AbortSignal.timeout(BTC_USD_SPOT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    const data =
      typeof body === 'object' && body !== null ? (body as { data?: unknown }).data : undefined;
    if (typeof data !== 'object' || data === null) {
      return null;
    }
    const { currency, rates } = data as { currency?: unknown; rates?: unknown };
    if (currency !== 'BTC' || typeof rates !== 'object' || rates === null) {
      return null;
    }
    const out: SpotRates = {};
    for (const fiat of SPOT_FIATS) {
      const rate = usableRate((rates as Record<string, unknown>)[fiat]);
      if (rate !== null) {
        out[fiat] = rate;
      }
    }
    if (Object.keys(out).length === 0) {
      return null;
    }
    return {
      asOf,
      source: FX_SPOT_SOURCE_COINBASE,
      rates: out,
    };
  } catch {
    return null;
  }
}

/** Collaborators for the spot refresh tick. */
export interface FxSpotWorkerDeps {
  /** Where the last good quote is kept. */
  store: FxSpotStore;
  /** Fetch implementation. */
  fetchImpl: FetchFn;
  /** Provider URL ({@link resolveFxSpotUrl}). */
  url: string;
  /** Clock for `asOf`. */
  now: () => number;
}

/**
 * Fetch one quote and store it. A failed fetch keeps the stored quote.
 *
 * @param deps - Store, fetch, URL, and clock.
 * @returns `true` when a fetched quote was saved (the store still keeps a newer
 * stored quote over an older one), `false` when the fetch failed.
 * @throws When the store write fails.
 */
export async function runFxSpotTick(deps: FxSpotWorkerDeps): Promise<boolean> {
  const quote = await fetchFxSpot(deps);
  if (quote === null) {
    logEvent('fx.spot.fetch_failed');
    return false;
  }
  await deps.store.save(quote);
  return true;
}

/**
 * Run {@link runFxSpotTick} now and then every `intervalMs`. Ticks never overlap;
 * a throwing tick logs `fx.spot.tick.failed` and the next interval retries.
 *
 * @param deps - Store, fetch, URL, and clock.
 * @param intervalMs - Delay between ticks (default {@link FX_SPOT_REFRESH_MS}).
 * @returns Handle that stops the interval.
 */
export function startFxSpotWorker(
  deps: FxSpotWorkerDeps,
  intervalMs: number = FX_SPOT_REFRESH_MS,
): { stop: () => void } {
  let running = false;
  const tick = (): void => {
    if (running) {
      return;
    }
    running = true;
    void runFxSpotTick(deps)
      .catch((error: unknown) => {
        logEvent('fx.spot.tick.failed', errorLogFields(error));
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
