import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { ShopNoteRef } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';
import { activeShopDays, WINDOW_DAYS } from '@/lib/shop-activity';

const MS_PER_DAY = 86_400_000;

/** Collaborators the `/shops/activity` route needs. All required. */
export interface ShopActivityRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Live assigned shop notes (hashtag filtered in {@link activeShopDays}). */
  messages: { listLiveAssignedShops(): Promise<ShopNoteRef[]> };
  /** POS charges in the UTC window, every status. */
  pos: { listCreatedBetween(startMs: number, endMs: number): Promise<PosChargeRef[]> };
}

/**
 * Build the `/shops/activity` route group.
 *
 * Mounted at `/shops/activity` so the public path is `GET /shops/activity`.
 *
 * @param deps - Auth store, clock, shop notes, and POS charges.
 * @returns A Hono app with `GET /`.
 */
export function shopActivityRoutes(deps: ShopActivityRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const today = new Date(deps.now()).toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T00:00:00.000Z`);
    const startMs = todayMs - (WINDOW_DAYS - 1) * MS_PER_DAY;
    const endMs = todayMs + MS_PER_DAY;
    try {
      const [notes, charges] = await Promise.all([
        deps.messages.listLiveAssignedShops(),
        deps.pos.listCreatedBetween(startMs, endMs),
      ]);
      return c.json({ days: activeShopDays(notes, charges, today) }, 200);
    } catch {
      logEvent('shops.activity.failed');
      return c.json({ error: 'Shop activity is unavailable' }, 503);
    }
  });
}
