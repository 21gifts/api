import { Hono } from 'hono';
import { buildGiftStats } from '@/lib/gift';
import type { GiftStore } from '@/lib/gift-store';
import { logEvent } from '@/lib/log';

/** Collaborators the public gift-stats route needs. */
export interface GiftsStatsRouteDeps {
  /** Outbound gift source. */
  store: GiftStore;
}

/**
 * Build the `/gifts/stats` route group.
 *
 * Mounted at `/gifts/stats` so the public path is `GET /gifts/stats`.
 *
 * @param deps - Gift store.
 * @returns A Hono app with `GET /`.
 */
export function giftsStatsRoutes(deps: GiftsStatsRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    try {
      const rows = await deps.store.listOutbound();
      return c.json(buildGiftStats(rows), 200);
    } catch {
      logEvent('gifts.stats.failed');
      return c.json({ error: 'Gift stats are unavailable' }, 503);
    }
  });
}
