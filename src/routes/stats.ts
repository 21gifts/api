import { Hono } from 'hono';
import { buildGiftStats } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { logEvent } from '@/lib/log';

/** Collaborators the public gift-stats route needs. */
export interface GiftsStatsRouteDeps {
  /** Outbound gift source. */
  store: GiftStore;
  /**
   * Historical BTC-USD rates (default: empty {@link InMemoryBtcUsdStore}).
   * Empty boots stay empty 200 without calling Coinbase.
   */
  rates?: BtcUsdRateBook;
  /** Clock for rate refresh / "today" (default: `Date.now`). */
  now?: () => number;
}

/**
 * Build the `/gifts/stats` route group.
 *
 * Mounted at `/gifts/stats` so the public path is `GET /gifts/stats`.
 *
 * @param deps - Gift store, optional rate book and clock.
 * @returns A Hono app with `GET /`.
 */
export function giftsStatsRoutes(deps: GiftsStatsRouteDeps): Hono {
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const now = deps.now ?? Date.now;

  return new Hono().get('/', async (c) => {
    try {
      const rows = await deps.store.listOutbound();
      if (rows.length === 0) {
        return c.json(buildGiftStats([], new Map()), 200);
      }

      const giftDays = [...new Set(rows.map((row) => row.paidAt.toISOString().slice(0, 10)))];
      const rateMap = await rates.ensureDays(giftDays, now());
      for (const day of giftDays) {
        if (!rateMap.has(day)) {
          logEvent('gifts.stats.fx_incomplete');
          return c.json({ error: 'Gift stats are unavailable' }, 503);
        }
      }
      return c.json(buildGiftStats(rows, rateMap), 200);
    } catch {
      logEvent('gifts.stats.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
