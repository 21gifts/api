import { Hono } from 'hono';
import { buildGiftDay, isUtcDay, utcDayFromPaidAt } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { logEvent } from '@/lib/log';

/** Collaborators the public per-day gift list needs. */
export interface GiftsRouteDeps {
  /** Outbound gift source. */
  store: GiftStore;
  /**
   * Historical BTC-USD rates (default: empty {@link InMemoryBtcUsdStore}).
   * Empty days stay empty 200 without calling Coinbase.
   */
  rates?: BtcUsdRateBook;
  /** Clock for rate refresh / "today" (default: `Date.now`). */
  now?: () => number;
}

const DAY_ERROR = 'Expected a UTC day (YYYY-MM-DD)';

/**
 * Build the `/gifts` route group.
 *
 * Mounted at `/gifts` so the public path is `GET /gifts?day=YYYY-MM-DD`.
 *
 * @param deps - Gift store, optional rate book and clock.
 * @returns A Hono app with `GET /`.
 */
export function giftsRoutes(deps: GiftsRouteDeps): Hono {
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const now = deps.now ?? Date.now;

  return new Hono().get('/', async (c) => {
    const day = c.req.query('day');
    if (day === undefined || !isUtcDay(day)) {
      return c.json({ error: DAY_ERROR }, 400);
    }

    try {
      const rows = await deps.store.listOutbound();
      const matching = rows.filter((row) => utcDayFromPaidAt(row.paidAt) === day);
      if (matching.length === 0) {
        return c.json(buildGiftDay(day, [], new Map()), 200);
      }

      const rateMap = await rates.ensureDays([day], now());
      if (!rateMap.has(day)) {
        logEvent('gifts.day.fx_incomplete');
        return c.json({ error: 'Gift stats are unavailable' }, 503);
      }
      return c.json(buildGiftDay(day, rows, rateMap), 200);
    } catch {
      logEvent('gifts.day.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
