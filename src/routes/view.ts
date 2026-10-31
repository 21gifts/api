import { Hono, type Context } from 'hono';
import { buildAccountActivity } from '@/lib/account-activity';
import { serializeViewProfile } from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import { fundingReviewedAt, fundingReviewedByName } from '@/lib/funding';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import { logEvent } from '@/lib/log';
import {
  loadMemberProfileNote,
  memberPublicMessages,
  type MemberFeedKind,
} from '@/lib/member-public-feed';
import { forumPhotoResponse } from '@/lib/message';
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
   * Used by About me and `GET /:viewKey/activity`.
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
  /** LNURL server config for the receiving address on the card; omitted → none. */
  lnurlServer?: LnurlServerConfig;
  /**
   * Funding grants for the same admission mark the member card shows.
   * Omitted → empty store, so the mark is null.
   */
  fundingStore?: FundingStore;
}

/** 64 lowercase hex view-key shape. */
const VIEW_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Build the `/view` route group.
 *
 * Mounted at `/view` so the public paths are `GET /view/:viewKey`,
 * `GET /view/:viewKey/about/photo`, `GET /view/:viewKey/activity`, and the
 * same post, shop, credit, and reply lists as `/members`.
 * No auth. Never calls `resolveSession`. Never accepts the key as Bearer.
 *
 * @param deps - Shared auth store, optional message store for About me, optional activity collaborators including the fiat book, and optional `lnurlServer` for the receiving address.
 * @returns A Hono app exposing the public profile card, its photo, its activity, and its four lists.
 */
export function viewRoutes(deps: ViewRouteDeps): Hono {
  const messageStore = deps.messageStore ?? new InMemoryMessageStore();
  const giftStore = deps.giftStore ?? new InMemoryGiftStore();
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const fiatRates = deps.fiatRates ?? new InMemoryFiatStore();
  const now = deps.now ?? Date.now;

  /**
   * Same list as the member card. `viewerAccountId` stays null.
   *
   * @param kind - Posts, shops, credits, or replies.
   * @param failedLog - Log name when the store throws.
   * @returns The route handler.
   */
  function publicFeed(kind: MemberFeedKind, failedLog: string) {
    return async (c: Context) => {
      const viewKey = c.req.param('viewKey') as string;
      if (!VIEW_KEY_RE.test(viewKey)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const account = await deps.store.getAccountByViewKey(viewKey);
      if (account === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const messages = await memberPublicMessages({
          kind,
          account,
          messageStore,
          authStore: deps.store,
          lnurlServer: deps.lnurlServer,
          viewerAccountId: null,
        });
        return c.json({ messages }, 200);
      } catch {
        logEvent(failedLog);
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    };
  }

  return new Hono()
    .get('/:viewKey/about/photo', async (c) => {
      const viewKey = c.req.param('viewKey');
      if (!VIEW_KEY_RE.test(viewKey)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const account = await deps.store.getAccountByViewKey(viewKey);
      if (account === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const profileId = account.profileMessageId;
        if (typeof profileId !== 'string' || profileId.trim() === '') {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const row = await messageStore.getById(profileId);
        if (row === undefined || row.deletedAt !== null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const photo = await messageStore.getPhoto(profileId);
        if (photo === null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        return forumPhotoResponse(photo);
      } catch {
        logEvent('view.photo.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
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
    .get('/:viewKey/posts', publicFeed('posts', 'view.posts.failed'))
    .get('/:viewKey/shops', publicFeed('shops', 'view.shops.failed'))
    .get('/:viewKey/credits', publicFeed('credits', 'view.credits.failed'))
    .get('/:viewKey/replies', publicFeed('replies', 'view.replies.failed'))
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
      try {
        const note = await loadMemberProfileNote({
          account,
          messageStore,
          lnurlServer: deps.lnurlServer,
          viewerAccountId: null,
        });
        const counts = await messageStore.countByAccount(account.id);
        const shopCount = await messageStore.countShopsByAccount(account.id);
        const creditCount = await messageStore.countCreditsByAccount(account.id);
        const fundingStore = deps.fundingStore ?? new InMemoryFundingStore();
        const grant = await fundingStore.getByAccountId(account.id);
        const reviewedAt = fundingReviewedAt(grant, now());
        return c.json(
          serializeViewProfile(
            account,
            hasPasskey,
            note?.aboutMe ?? null,
            note?.aboutMeHasPhoto ?? false,
            deps.lnurlServer,
            {
              postCount: counts.postCount,
              replyCount: counts.replyCount,
              shopCount,
              creditCount,
              fundingReviewedAt: reviewedAt,
              fundingReviewedByName: await fundingReviewedByName(grant, now(), (accountId) =>
                deps.store.getAccount(accountId),
              ),
            },
            note?.profileMessage ?? null,
          ),
          200,
        );
      } catch {
        logEvent('view.get.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    });
}
