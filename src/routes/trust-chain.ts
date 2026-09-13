import { Hono } from 'hono';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { buildTrustChain, isChainAccount } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';

/**
 * Public trust-chain graph. No auth. Nodes and edges come from stored
 * accounts and trust edges only — never inferred.
 *
 * Bare `GET /trust-chain` returns founder seeds (no edges) so a thousand-person
 * chain is not dumped on first paint. `?around=<id>` returns that account plus
 * one hop of stored public edges.
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
      const around = c.req.query('around');
      if (around !== undefined && around !== '') {
        return c.json(await neighborhood(deps, around), 200);
      }
      const accounts = (await deps.authStore.listAccounts()).filter(
        (account) => account.role === 'founder',
      );
      return c.json(buildTrustChain(accounts, []), 200);
    } catch (error) {
      if (error instanceof NeighborhoodNotFound) {
        return c.json({ error: 'Not found' }, 404);
      }
      logEvent('trust.chain.failed');
      return c.json({ error: 'Trust chain is unavailable' }, 503);
    }
  });
}

/** Focus account is missing or not on the public chain. */
class NeighborhoodNotFound extends Error {}

/**
 * One hop around `aroundId`: the focus account, stored public edges that
 * touch it, and the accounts on those edges.
 *
 * @param deps - Auth and trust stores.
 * @param aroundId - Focus account id.
 * @returns Public `{ nodes, edges }`.
 */
async function neighborhood(
  deps: TrustChainRouteDeps,
  aroundId: string,
): Promise<ReturnType<typeof buildTrustChain>> {
  const focus = await deps.authStore.getAccount(aroundId);
  if (focus === undefined || !isChainAccount(focus)) {
    throw new NeighborhoodNotFound();
  }
  const edges = await deps.trustStore.listEdgesTouching(aroundId);
  const ids = new Set<string>([aroundId]);
  for (const edge of edges) {
    ids.add(edge.actorId);
    ids.add(edge.subjectId);
  }
  const accounts: Account[] = [];
  for (const id of ids) {
    const account = await deps.authStore.getAccount(id);
    if (account !== undefined) {
      accounts.push(account);
    }
  }
  return buildTrustChain(accounts, edges);
}
