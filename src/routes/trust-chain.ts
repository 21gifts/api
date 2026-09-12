import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { buildTrustChain } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';

/**
 * Public trust-chain graph. No auth. Nodes and edges come from stored
 * accounts and trust edges only — never inferred.
 */

/** Collaborators the public trust-chain route needs. */
export interface TrustChainRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Trust-edge persistence port. */
  trustStore: TrustStore;
}

/**
 * Build the `/trust-chain` route group.
 *
 * Mounted at `/trust-chain` so the public path is `GET /trust-chain`.
 *
 * @param deps - Auth store and trust-edge store.
 * @returns A Hono app with `GET /`.
 */
export function trustChainRoutes(deps: TrustChainRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    try {
      const accounts = await deps.authStore.listAccounts();
      const edges = await deps.trustStore.listEdges();
      return c.json(buildTrustChain(accounts, edges), 200);
    } catch {
      logEvent('trust.chain.failed');
      return c.json({ error: 'Trust chain is unavailable' }, 503);
    }
  });
}
