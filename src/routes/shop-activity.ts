import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import type { MessageStore } from '@/lib/message-store';
import type { PosChargeRef } from '@/lib/pos-store';
import { shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { activeShopDays, activeShopList, activeShops, WINDOW_DAYS } from '@/lib/shop-activity';
import { requireStaff } from '@/routes/funding';

const MS_PER_DAY = 86_400_000;

/** Collaborators the `/shops/activity` routes need. All required. */
export interface ShopActivityRouteDeps {
  /** Shared auth persistence port (staff session and till usernames). */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Live assigned shop notes (hashtag filtered in {@link activeShops}) and their pins. */
  messages: Pick<MessageStore, 'listLiveAssignedShops' | 'getByIds'>;
  /** POS charges in the UTC window and each account's latest charge, every status. */
  pos: {
    listCreatedBetween(startMs: number, endMs: number): Promise<PosChargeRef[]>;
    listLatestCreatedByAccount(accountIds: readonly string[]): Promise<PosChargeRef[]>;
  };
  /** Shop identities (npub of each shop). */
  identities: Pick<ShopIdentityStore, 'listAll'>;
}

/** Today's UTC day and the half-open 30-day window `[startMs, endMs)` ending on it. */
function activityWindow(nowMs: number): { today: string; startMs: number; endMs: number } {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  return {
    today,
    startMs: todayMs - (WINDOW_DAYS - 1) * MS_PER_DAY,
    endMs: todayMs + MS_PER_DAY,
  };
}

/**
 * Build the `/shops/activity` route group.
 *
 * Mounted at `/shops/activity`: the public `GET /shops/activity` and the
 * staff-only `GET /shops/activity/shops`.
 *
 * @param deps - Auth store, clock, shop notes, POS charges, and shop identities.
 * @returns A Hono app with `GET /` and `GET /shops`.
 */
export function shopActivityRoutes(deps: ShopActivityRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const { today, startMs, endMs } = activityWindow(deps.now());
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
    })
    .get('/shops', async (c) => {
      const staff = await requireStaff(deps, c.req.header('authorization'));
      if ('status' in staff) {
        return c.json({ error: staff.error }, staff.status);
      }
      const { today, startMs, endMs } = activityWindow(deps.now());
      try {
        const notes = await deps.messages.listLiveAssignedShops();
        const shops = activeShops(notes);
        const accountIds = [...new Set(shops.map((shop) => shop.accountId))];
        const [charges, latest, rows, identities, accounts] = await Promise.all([
          deps.pos.listCreatedBetween(startMs, endMs),
          deps.pos.listLatestCreatedByAccount(accountIds),
          deps.messages.getByIds(shops.map((shop) => shop.id)),
          deps.identities.listAll(),
          deps.authStore.getAccounts(accountIds),
        ]);
        const list = activeShopList(
          shops,
          charges,
          {
            places: new Map(rows.map((row) => [row.id, row.place ?? null])),
            npubs: new Map(identities.map((row) => [row.messageId, shopNpub(row)])),
            usernames: new Map(accounts.map((account) => [account.id, account.username ?? null])),
            lastChargeMs: new Map(latest.map((ref) => [ref.accountId, ref.createdAtMs])),
          },
          today,
        );
        return c.json({ windowDays: WINDOW_DAYS, today, shops: list }, 200);
      } catch {
        logEvent('shops.activity.list.failed');
        return c.json({ error: 'Shop activity is unavailable' }, 503);
      }
    });
}
