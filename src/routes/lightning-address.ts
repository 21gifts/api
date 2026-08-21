import { Hono } from 'hono';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { CachedLnAddress, LnAddressCache } from '@/lib/ln-address-cache';
import { logEvent } from '@/lib/log';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';

/**
 * Public `GET /lightning-address` — resolve LUD-16 well-known metadata for a
 * guest Donate flow. Returns callback and amount bounds only; never fetches
 * or pays an invoice.
 */

/** Collaborators the Lightning Address resolve route needs. */
export interface LightningAddressRouteDeps {
  /** Successful-resolve cache (in-memory by default). */
  cache: LnAddressCache;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Injected `fetch` for the well-known LNURL-pay GET. */
  fetchImpl: FetchFn;
}

/** Error body shared with `POST /me/lightning-address` for bad LUD-16 shape. */
const INVALID_ADDRESS_ERROR = 'Not a valid Lightning Address (expected name@domain)';

/**
 * Build a response body from a cached or freshly resolved entry.
 *
 * Omits `commentAllowed` when the provider did not send it
 * (`exactOptionalPropertyTypes`).
 *
 * @param entry - Normalised address plus metadata fields.
 * @returns JSON-serialisable 200 body.
 */
function toResponseBody(entry: CachedLnAddress): CachedLnAddress {
  const body: CachedLnAddress = {
    address: entry.address,
    callback: entry.callback,
    minSendable: entry.minSendable,
    maxSendable: entry.maxSendable,
  };
  if (entry.commentAllowed !== undefined) {
    body.commentAllowed = entry.commentAllowed;
  }
  return body;
}

/**
 * Build the `/lightning-address` route group.
 *
 * Mounted at `/lightning-address` so the public path is
 * `GET /lightning-address?address=name@domain`.
 *
 * @param deps - Cache, clock, and fetch.
 * @returns A Hono app with `GET /`.
 */
export function lightningAddressRoutes(deps: LightningAddressRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const raw = c.req.query('address');
    if (raw === undefined || raw === '') {
      return c.json({ error: INVALID_ADDRESS_ERROR }, 400);
    }
    const address = normalizeLightningAddress(raw);
    if (address === null) {
      return c.json({ error: INVALID_ADDRESS_ERROR }, 400);
    }

    const cached = deps.cache.get(address, deps.now());
    if (cached !== null) {
      logEvent('lightning_address.resolved', { address, cached: true });
      return c.json(toResponseBody(cached), 200);
    }

    const resolved = await resolveLnurlp({ address, fetchImpl: deps.fetchImpl });
    if (!resolved.ok) {
      logEvent('lightning_address.resolve_failed', { address });
      return c.json({ error: 'Lightning Address could not be resolved' }, 502);
    }

    const entry: CachedLnAddress = {
      address,
      callback: resolved.metadata.callback,
      minSendable: resolved.metadata.minSendable,
      maxSendable: resolved.metadata.maxSendable,
    };
    if (resolved.metadata.commentAllowed !== undefined) {
      entry.commentAllowed = resolved.metadata.commentAllowed;
    }
    deps.cache.put(entry, deps.now());
    logEvent('lightning_address.resolved', { address, cached: false });
    return c.json(toResponseBody(entry), 200);
  });
}
