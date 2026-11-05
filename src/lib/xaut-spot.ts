/** Independent Kraken USD-per-XAUt quote, held in memory between refreshes. */
import type { FetchFn } from '@/lib/lnurlp';
import { BTC_USD_SPOT_TIMEOUT_MS } from '@/lib/btc-usd-spot';
import { FX_SPOT_REFRESH_MS } from '@/lib/fx-spot';
import { parseUsdPerBtc } from '@/lib/money';

/** A rate and the start time of the fetch that obtained it. */
export interface XautSpotQuote {
  /** USD per XAUt as decimal text. */
  rate: string;
  /** Fetch start in epoch milliseconds. */
  asOfMs: number;
}

/**
 * Fetch and validate a single Kraken ticker entry.
 * @param args - URL, fetch implementation and clock.
 * @returns A validated quote, or null on any failure.
 */
export async function fetchXautSpot(args: {
  url: string;
  fetchImpl: FetchFn;
  now: () => number;
}): Promise<XautSpotQuote | null> {
  try {
    const asOfMs = args.now();
    if (!Number.isFinite(asOfMs)) return null;
    const response = await args.fetchImpl(args.url, {
      signal: AbortSignal.timeout(BTC_USD_SPOT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const { error, result } = body as { error?: unknown; result?: unknown };
    if (
      !Array.isArray(error) ||
      error.length !== 0 ||
      typeof result !== 'object' ||
      result === null ||
      Array.isArray(result)
    )
      return null;
    const entries = Object.values(result);
    if (entries.length !== 1) return null;
    const entry: unknown = entries[0];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
    const c: unknown = (entry as { c?: unknown }).c;
    if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'string' || typeof c[1] !== 'string')
      return null;
    parseUsdPerBtc(c[0]);
    return { rate: c[0], asOfMs };
  } catch {
    return null;
  }
}

/**
 * Start a non-overlapping background refresh with the shared FX interval.
 * @param args - URL, fetch implementation and clock.
 * @returns Access to the last good quote and a stop handle.
 */
export function startXautSpotWorker(args: { url: string; fetchImpl: FetchFn; now: () => number }): {
  latest: () => XautSpotQuote | null;
  stop: () => void;
} {
  let latest: XautSpotQuote | null = null;
  let running = false;
  const tick = (): void => {
    if (running) return;
    running = true;
    void fetchXautSpot(args)
      .then((quote) => {
        if (quote !== null) latest = quote;
      })
      .finally(() => {
        running = false;
      });
  };
  tick();
  const timer = setInterval(tick, FX_SPOT_REFRESH_MS);
  return { latest: () => latest, stop: () => clearInterval(timer) };
}
