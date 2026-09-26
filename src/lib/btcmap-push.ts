/**
 * Outbound POST to the BTC Map place-submissions API for a new OCP place.
 * Missing env skips the push; the process still boots. Failures never throw.
 */

import type { FetchFn } from '@/lib/lnurlp';
import { logEvent } from '@/lib/log';
import type { OcpPlace } from '@/lib/ocp-place-store';

/** Default HTTP timeout for {@link HttpBtcMapPush}. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Default BTC Map submissions URL when `BTCMAP_SUBMIT_URL` is unset. */
const DEFAULT_SUBMIT_URL = 'https://api.btcmap.org/v4/place-submissions';

/**
 * Outbound BTC Map place submission.
 */
export interface BtcMapPush {
  /**
   * POST the place once. Never throws.
   *
   * @param place - Stored OCP place (only lat/lon/category/name/extra_fields
   *   are sent).
   * @returns `'sent'` on 2xx; `'failed'` on network or non-2xx.
   */
  submit(place: OcpPlace): Promise<'sent' | 'failed'>;
}

/**
 * Build the JSON body for `POST /v4/place-submissions`.
 *
 * @param place - Stored OCP place.
 * @returns Body with `extra_fields.source`; `payment_methods` only when set.
 */
export function btcMapSubmissionBody(place: OcpPlace): {
  lat: number;
  lon: number;
  category: string;
  name: string;
  extra_fields: { source: string; payment_methods?: string };
} {
  const extra_fields: { source: string; payment_methods?: string } = {
    source: place.origin,
  };
  if (place.paymentMethods !== null) {
    extra_fields.payment_methods = place.paymentMethods;
  }
  return {
    lat: place.lat,
    lon: place.lon,
    category: place.category,
    name: place.name,
    extra_fields,
  };
}

/**
 * POST `{ lat, lon, category, name, extra_fields }` to the submissions URL
 * with Bearer `BTCMAP_ACCESS_TOKEN`.
 *
 * 2xx logs `btcmap.push.ok`. Network, abort, and non-2xx log
 * `btcmap.push.failed` and resolve `'failed'`. Never throws. Never logs the
 * token.
 */
export class HttpBtcMapPush implements BtcMapPush {
  readonly #submitUrl: string;
  readonly #token: string;
  readonly #fetchImpl: FetchFn;
  readonly #timeoutMs: number;

  /**
   * @param opts - Already-trimmed URL (no trailing slash), Bearer token,
   *   fetch, optional timeout (default 5000 ms).
   */
  constructor(opts: { submitUrl: string; token: string; fetchImpl: FetchFn; timeoutMs?: number }) {
    this.#submitUrl = opts.submitUrl;
    this.#token = opts.token;
    this.#fetchImpl = opts.fetchImpl;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * POST the place body. Resolves `'sent'` or `'failed'`; never throws.
   *
   * @param place - Stored OCP place.
   */
  async submit(place: OcpPlace): Promise<'sent' | 'failed'> {
    try {
      const response = await this.#fetchImpl(this.#submitUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(btcMapSubmissionBody(place)),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      if (response.ok) {
        logEvent('btcmap.push.ok', { origin: place.origin });
        return 'sent';
      }
      logEvent('btcmap.push.failed', { origin: place.origin });
      return 'failed';
    } catch {
      logEvent('btcmap.push.failed', { origin: place.origin });
      return 'failed';
    }
  }
}

/**
 * Resolve a BTC Map push collaborator from the environment.
 *
 * Unset or blank `BTCMAP_ACCESS_TOKEN` → `undefined` (caller skips). Trims
 * the token. `BTCMAP_SUBMIT_URL` when set and non-empty (trimmed, trailing
 * slashes stripped); otherwise {@link DEFAULT_SUBMIT_URL}.
 *
 * @param env - Process environment slice (injected so tests need not mutate it).
 * @param fetchImpl - HTTP fetch used by {@link HttpBtcMapPush}.
 * @returns {@link HttpBtcMapPush} when the token is set; otherwise `undefined`.
 */
export function resolveBtcMapPush(
  env: Record<string, string | undefined>,
  fetchImpl: FetchFn,
): BtcMapPush | undefined {
  const rawToken = env['BTCMAP_ACCESS_TOKEN'];
  if (rawToken === undefined || rawToken.trim() === '') {
    return undefined;
  }
  const rawUrl = env['BTCMAP_SUBMIT_URL'];
  const submitUrl =
    rawUrl !== undefined && rawUrl.trim() !== ''
      ? rawUrl.trim().replace(/\/+$/u, '')
      : DEFAULT_SUBMIT_URL;
  return new HttpBtcMapPush({
    submitUrl,
    token: rawToken.trim(),
    fetchImpl,
  });
}
