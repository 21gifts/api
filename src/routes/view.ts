import { Hono } from 'hono';
import { buildAccountActivity } from '@/lib/account-activity';
import { serializeViewProfile } from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import { logEvent } from '@/lib/log';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';

/**
 * Public capability URL for a read-only account profile card.
 * Anyone with the view key can read; they cannot write or mint a session.
 */

/** Collaborators the view routes need. */
export interface ViewRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /**
   * Forum persistence (default: empty {@link InMemoryMessageStore}).
   * Used by `GET /:viewKey/activity`.
   */
  messageStore?: MessageStore;
  /**
   * Outbound house gifts (default: empty {@link InMemoryGiftStore}).
   * Used by `GET /:viewKey/activity`.
   */
  giftStore?: GiftStore;
  /**
   * Historical BTC-USD rates (default: empty {@link InMemoryBtcUsdStore}).
   * Empty activity stays 200 without calling Coinbase.
   */
  rates?: BtcUsdRateBook;
  /**
   * Historical USD→CHF/EUR/PHP crosses (default: empty {@link InMemoryFiatStore}).
   * Missing fiat never 503s the page.
   */
  fiatRates?: FiatRateBook;
  /** Clock returning epoch milliseconds (default: `Date.now`). */
  now?: () => number;
}

/** 64 lowercase hex view-key shape. */
const VIEW_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Build the `/view` route group.
 *
 * Mounted at `/view` so the public paths are `GET /view/:viewKey` and
 * `GET /view/:viewKey/activity`. No auth. Never calls `resolveSession`.
 * Never accepts the key as Bearer.
 *
 * @param deps - Shared auth store and optional activity collaborators including the fiat book.
 * @returns A Hono app exposing `GET /:viewKey/activity` and `GET /:viewKey`.
 */
export function viewRoutes(deps: ViewRouteDeps): Hono {
  const messageStore = deps.messageStore ?? new InMemoryMessageStore();
  const giftStore = deps.giftStore ?? new InMemoryGiftStore();
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const fiatRates = deps.fiatRates ?? new InMemoryFiatStore();
  const now = deps.now ?? Date.now;

  return new Hono()
    .get('/:viewKey/activity', async (c) => {
      const viewKey = c.req.param('viewKey');
      if (!VIEW_KEY_RE.test(viewKey)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const account = await deps.store.getAccountByViewKey(viewKey);
      if (account === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const activity = await buildAccountActivity({
          account,
          gifts: giftStore,
          messages: messageStore,
          rates,
          now,
          fiatRates,
        });
        return c.json(activity, 200);
      } catch (err) {
        const missingFx = err instanceof Error && err.message === 'fx.rate.missing';
        logEvent(missingFx ? 'account.activity.fx_incomplete' : 'account.activity.failed');
        return c.json({ error: 'Gift stats are unavailable' }, 503);
      }
    })
    .get('/:viewKey', async (c) => {
      const viewKey = c.req.param('viewKey');
      if (!VIEW_KEY_RE.test(viewKey)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const account = await deps.store.getAccountByViewKey(viewKey);
      if (account === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const hasPasskey = await deps.store.accountHasPasskey(account.id);
      return c.json(serializeViewProfile(account, hasPasskey), 200);
    });
}
