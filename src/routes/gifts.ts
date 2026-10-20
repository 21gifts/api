import { Hono } from 'hono';
import { buildGiftDay, isUtcDay } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import type { BtcUsdRateBook } from '@/lib/btc-usd-store';
import type { FiatRateBook } from '@/lib/usd-fiat-store';
import { logEvent } from '@/lib/log';

/** Collaborators the public per-day gift list needs. */
export interface GiftsRouteDeps {
  /** Outbound gift source. */
  store: GiftStore;
  /**
   * Accepted so existing callers still type-check. This route does not read it.
   * A missing stored amount stays null.
   */
  rates?: BtcUsdRateBook;
  /**
   * Accepted so existing callers still type-check. This route does not read it.
   * A missing stored amount stays null.
   */
  fiatRates?: FiatRateBook;
  /** Accepted so existing callers still type-check. This route does not read it. */
  now?: () => number;
}

const DAY_ERROR = 'Expected a UTC day (YYYY-MM-DD)';

/**
 * Build the `/gifts` route group.
 *
 * Mounted at `/gifts` so the public path is `GET /gifts?day=YYYY-MM-DD`.
 *
 * Amounts are the stored figures. A missing stored amount is not priced from
 * a daily close.
 *
 * @param deps - Gift store. Rate books and the clock are not consulted.
 * @returns A Hono app with `GET /`.
 */
export function giftsRoutes(deps: GiftsRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const day = c.req.query('day');
    if (day === undefined || !isUtcDay(day)) {
      return c.json({ error: DAY_ERROR }, 400);
    }

    try {
      const rows = await deps.store.listOutbound();
      return c.json(buildGiftDay(day, rows, new Map()), 200);
    } catch {
      logEvent('gifts.day.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
