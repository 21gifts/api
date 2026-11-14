import { Hono } from 'hono';
import { utcDayKey } from '@/lib/funding';
import { addUtcDays } from '@/lib/member-habit';
import { buildWalletStats } from '@/lib/wallet-stats';
import type { WalletStore } from '@/lib/wallet-store';
import { buildWalletUsage, walletUsageReadSince } from '@/lib/wallet-usage';
import type { WalletUsageStore } from '@/lib/wallet-usage-store';
import { logEvent } from '@/lib/log';

/** CDN and browser cache for a `GET /wallets/usage` body. */
const PUBLIC_CACHE = 'public, max-age=60';

/** Collaborators the public wallet statistics routes need. */
export interface WalletStatsRouteDeps {
  /** Wallet balance snapshot source for `GET /stats`. */
  store: WalletStore;
  /** Completed-payment and activity source for `GET /usage`. */
  usageStore: WalletUsageStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
}

/**
 * Build the public `/wallets` statistics route group.
 *
 * `GET /stats` is unchanged. `GET /usage` is a separate read of payment,
 * forum, and shop aggregates. The payment read is bounded above by the start
 * of the UTC day after `now`, so a future-dated row cannot pair with an
 * in-window row or contribute to its group.
 *
 * @param deps - Wallet store, usage store, and clock.
 * @returns A Hono app serving `GET /stats` and `GET /usage`.
 */
export function walletStatsRoutes(deps: WalletStatsRouteDeps): Hono {
  const app = new Hono();
  app.get('/stats', async (c) => {
    try {
      const rows = await deps.store.dailyBalances();
      return c.json(buildWalletStats(rows, deps.now()), 200);
    } catch {
      logEvent('wallets.stats.failed');
      return c.json({ error: 'Wallet stats are unavailable' }, 503);
    }
  });
  app.get('/usage', async (c) => {
    try {
      const since = walletUsageReadSince();
      const nowMs = deps.now();
      const untilMs = Date.parse(`${addUtcDays(utcDayKey(nowMs), 1)}T00:00:00.000Z`);
      const payments = await deps.usageStore.payments(since.payments, untilMs);
      const forumInvoices = await deps.usageStore.forumInvoices(since.forumInvoices);
      const shopCharges = await deps.usageStore.shopCharges(since.shopCharges);
      const body = buildWalletUsage({ payments, forumInvoices, shopCharges }, nowMs);
      c.header('Cache-Control', PUBLIC_CACHE);
      return c.json(body, 200);
    } catch {
      logEvent('wallets.usage.failed');
      return c.json({ error: 'Wallet usage is unavailable' }, 503);
    }
  });
  return app;
}
