/**
 * Balance of a Spark address from the public Sparkscan explorer, read
 * anonymously: no API key and no `authorization` header. The value is
 * information only. No route or app action depends on it, and the explorer
 * can lag behind the wallet.
 */

import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';

/** Origin of the public Sparkscan API. */
export const SPARK_EXPLORER_BASE_URL = 'https://api.sparkscan.io';

/** Abort the explorer request after this many milliseconds. */
export const SPARK_EXPLORER_TIMEOUT_MS = 5_000;

/**
 * `balance.btcSoftBalanceSats` of an explorer address body, when it is a safe
 * non-negative integer.
 *
 * @param body - Parsed JSON body.
 * @returns The soft balance in sats, or `null` for any other shape.
 */
function softBalanceSats(body: unknown): number | null {
  if (typeof body !== 'object' || body === null) {
    return null;
  }
  const balance = (body as { balance?: unknown }).balance;
  if (typeof balance !== 'object' || balance === null) {
    return null;
  }
  const sats = (balance as { btcSoftBalanceSats?: unknown }).btcSoftBalanceSats;
  return typeof sats === 'number' && Number.isSafeInteger(sats) && sats >= 0 ? sats : null;
}

/**
 * Read the balance of a Spark address from the explorer without ever throwing.
 *
 * Sends `GET {@link SPARK_EXPLORER_BASE_URL}/v1/address/<address>?network=MAINNET`
 * with only `accept: application/json`, `redirect: 'error'`, and a
 * {@link SPARK_EXPLORER_TIMEOUT_MS} timeout. Returns `balance.btcSoftBalanceSats`,
 * which includes incoming transfers that are not claimed yet;
 * `btcHardBalanceSats` is not read. Any failure logs
 * `spark_explorer.unavailable` (with the HTTP `status` when there was an
 * answer), never the address.
 *
 * @param fetchImpl - Fetch implementation (injectable for tests).
 * @param sparkAddress - Spark address (`spark1…`).
 * @returns The soft balance in sats, or `null` for a throw, timeout, non-2xx
 *   answer (a bad address answers 400), bad JSON, or another shape.
 */
export async function fetchSparkAddressBalance(
  fetchImpl: FetchFn,
  sparkAddress: string,
): Promise<number | null> {
  let status: number | undefined;
  try {
    const response = await fetchImpl(
      `${SPARK_EXPLORER_BASE_URL}/v1/address/${encodeURIComponent(sparkAddress)}?network=MAINNET`,
      {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(SPARK_EXPLORER_TIMEOUT_MS),
      },
    );
    status = response.status;
    if (response.ok) {
      const sats = softBalanceSats(await response.json());
      if (sats !== null) {
        return sats;
      }
    }
  } catch {
    // Network error, timeout, or a body that is not JSON: logged below.
  }
  logEvent('spark_explorer.unavailable', status === undefined ? undefined : { status });
  return null;
}
