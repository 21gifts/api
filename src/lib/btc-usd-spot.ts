/** Coinbase BTC-USD spot lookup used to freeze fiat at payment time. */

import type { FetchFn } from '@/lib/btc-usd-candles';

/** Default Coinbase spot endpoint. */
const DEFAULT_BTC_USD_SPOT_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';

/**
 * Fetch the current positive BTC-USD spot without ever throwing.
 *
 * @param fetchImpl - Fetch implementation (injectable for tests).
 * @param url - Explicit endpoint; a blank value falls through to env/default.
 * @returns Coinbase decimal text, or `null` for every transport/shape/value failure.
 */
export async function fetchBtcUsdSpot(
  fetchImpl: FetchFn = fetch,
  url?: string,
): Promise<string | null> {
  const explicit = url?.trim() ?? '';
  const env = process.env['BTC_USD_SPOT_URL']?.trim() ?? '';
  const endpoint = explicit !== '' ? explicit : env !== '' ? env : DEFAULT_BTC_USD_SPOT_URL;
  try {
    const response = await fetchImpl(endpoint);
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('data' in body)) {
      return null;
    }
    const data = (body as { data?: unknown }).data;
    if (typeof data !== 'object' || data === null || !('amount' in data)) {
      return null;
    }
    const amount = (data as { amount?: unknown }).amount;
    if (typeof amount !== 'string' && typeof amount !== 'number') {
      return null;
    }
    const numeric = Number(amount);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    return typeof amount === 'number' ? String(amount) : amount;
  } catch {
    return null;
  }
}
