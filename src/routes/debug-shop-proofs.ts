import { Hono } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import type { ShopPayments } from '@/lib/shop-payment';
import { retryStuckProof } from '@/lib/shop-proof';
import { normalizeUuid } from '@/lib/uuid';

/**
 * Operator debug surface for shop payment proofs. Authenticated by
 * `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/** Collaborators the debug shop proof routes need. */
export interface DebugShopProofsRouteDeps {
  /** Shop payment service. */
  shop: ShopPayments;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/**
 * Build the `/debug/shop-proofs` route group.
 *
 * `POST /:id/retry` moves a `stuck` proof back to unresolved, sets
 * `give_up_at` 24 h ahead, and logs `shop.proof.retried`. A malformed or
 * unknown id is **404**; a proof that is not `stuck` is **409**.
 *
 * @param deps - Shop payment service and optional debug token.
 * @returns A Hono app exposing `POST /:id/retry`.
 */
export function debugShopProofsRoutes(deps: DebugShopProofsRouteDeps): Hono {
  return new Hono().post('/:id/retry', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const id = normalizeUuid(c.req.param('id'));
    const result = id === null ? 'not_found' : await retryStuckProof(deps.shop, id);
    if (result === 'not_found') {
      return c.json({ error: 'Not found' }, 404);
    }
    if (result === 'not_stuck') {
      return c.json({ error: 'The proof is not stuck' }, 409);
    }
    return c.json({ id, result: null }, 200);
  });
}
