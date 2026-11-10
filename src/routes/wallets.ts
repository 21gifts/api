import { Hono } from 'hono';
import { buildWalletStats } from '@/lib/wallet-stats';
import type { WalletStore } from '@/lib/wallet-store';
import { logEvent } from '@/lib/log';

/** Collaborators the public wallet-stats route needs. */
export interface WalletStatsRouteDeps {
  /** Wallet balance snapshot source. */
  store: WalletStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
}

/**
 * Build the public `/wallets/stats` route group.
 *
 * @param deps - Wallet store and clock.
 * @returns A Hono app serving `GET /stats`.
 */
export function walletStatsRoutes(deps: WalletStatsRouteDeps): Hono {
  return new Hono().get('/stats', async (c) => {
    try {
      const rows = await deps.store.dailyBalances();
      return c.json(buildWalletStats(rows, deps.now()), 200);
    } catch {
      logEvent('wallets.stats.failed');
      return c.json({ error: 'Wallet stats are unavailable' }, 503);
    }
  });
}
