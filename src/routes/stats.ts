import { Hono } from 'hono';
import { buildGiftStats, giftsForRecipient } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import type { BtcUsdRateBook } from '@/lib/btc-usd-store';
import type { FiatRateBook } from '@/lib/usd-fiat-store';
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
  /**
   * Historical USD→CHF/EUR/PHP crosses (default: empty {@link InMemoryFiatStore}).
   * Missing fiat never 503s the page.
   */
  fiatRates?: FiatRateBook;
  /** Clock for rate refresh / "today" (default: `Date.now`). */
  now?: () => number;
}

/**
 * Build the `/gifts/stats` route group.
 *
 * Mounted at `/gifts/stats` so the public path is `GET /gifts/stats`.
 * Optional `?recipient=` filters outbound gifts to one Wallet of Satoshi
 * handle before aggregation (see {@link giftsForRecipient}).
 *
 * @param deps - Gift store, optional BTC-USD book, optional fiat book, and clock.
 * @returns A Hono app with `GET /`.
 */
export function giftsStatsRoutes(deps: GiftsStatsRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    try {
      const raw = (c.req.query('recipient') ?? '').trim();
      const rows = await deps.store.listOutbound();
      const selected = raw === '' ? rows : giftsForRecipient(rows, raw);
      if (selected.length === 0) {
        return c.json(buildGiftStats([], new Map()), 200);
      }

      return c.json(buildGiftStats(selected, new Map()), 200);
    } catch {
      logEvent('gifts.stats.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
