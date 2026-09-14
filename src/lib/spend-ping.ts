/**
 * Outbound ping so the spend worker can pay a listed recipient after a
 * new top-level forum post. Missing env skips the ping; the process still
 * boots. Failures never throw.
 */

import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';

/** Default HTTP timeout for {@link HttpSpendPing}. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Outbound ping so the spend worker can pay a listed recipient.
 */
export interface SpendPing {
  /**
   * Notify spend that `address` just created a top-level forum post.
   *
   * @param address - Recipient Lightning Address.
   */
  ping(address: string): Promise<void>;
}

/**
 * No-op ping when tests inject a collaborator that must not call HTTP.
 */
export class NoopSpendPing implements SpendPing {
  /**
   * Ignore the address.
   *
   * @param _address - Unused.
   */
  ping(_address: string): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * POST `{ address }` to `{spendUrl}/ping` with Bearer `SPEND_API_TOKEN`.
 *
 * 2xx (including 200 skipped and 202 accepted) logs `spend.ping.ok`.
 * Network, abort, and non-2xx log `spend.ping.failed` and resolve.
 * Never throws. Never logs the token.
 */
export class HttpSpendPing implements SpendPing {
  readonly #spendUrl: string;
  readonly #token: string;
  readonly #fetchImpl: FetchFn;
  readonly #timeoutMs: number;

  /**
   * @param opts - Already-trimmed base URL (no trailing slash), Bearer token,
   *   fetch, optional timeout (default 5000 ms).
   */
  constructor(opts: { spendUrl: string; token: string; fetchImpl: FetchFn; timeoutMs?: number }) {
    this.#spendUrl = opts.spendUrl;
    this.#token = opts.token;
    this.#fetchImpl = opts.fetchImpl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * POST `{ address }` to `{spendUrl}/ping`. Resolves on success and failure.
   *
   * @param address - Recipient Lightning Address (JSON body).
   */
  async ping(address: string): Promise<void> {
    try {
      const response = await this.#fetchImpl(`${this.#spendUrl}/ping`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ address }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.ok) {
        logEvent('spend.ping.ok', { address });
        return;
      }
      logEvent('spend.ping.failed', { address });
    } catch {
      logEvent('spend.ping.failed', { address });
    }
  }
}

/**
 * Resolve a spend ping collaborator from the environment.
 *
 * Unset or blank `SPEND_URL` or `SPEND_API_TOKEN` → `undefined` (caller
 * skips). Trims both values and strips trailing slashes from the URL.
 *
 * @param env - Process environment slice (injected so tests need not mutate it).
 * @param fetchImpl - HTTP fetch used by {@link HttpSpendPing}.
 * @returns {@link HttpSpendPing} when both env values are set; otherwise `undefined`.
 */
export function resolveSpendPing(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
): SpendPing | undefined {
  const rawUrl = env['SPEND_URL'];
  const rawToken = env['SPEND_API_TOKEN'];
  if (
    rawUrl === undefined ||
    rawUrl.trim() === '' ||
    rawToken === undefined ||
    rawToken.trim() === ''
  ) {
    return undefined;
  }
  const spendUrl = rawUrl.trim().replace(/\/+$/u, '');
  return new HttpSpendPing({ spendUrl, token: rawToken.trim(), fetchImpl });
}
