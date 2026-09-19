import { Hono, type Context } from 'hono';
import { aboutMeFromNote } from '@/lib/about-me';
import { buildAccountActivity } from '@/lib/account-activity';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import type { Account, AuthStore } from '@/lib/auth/store';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT, serializeMessage, type MessageRow } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { accountTrust } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';
import { forumVideoFilePresent, resolveMediaDir } from '@/lib/video';
import { bearerToken } from '@/routes/me';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * `/members` — signed-in member profile cards (live identity + profile note + About me),
 * given/received activity, and on-demand latest-200 post/reply feeds.
 */

/** Collaborators the `/members` routes need. */
export interface MembersRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Forum persistence (About me, member feeds, and activity zaps/invoices). */
  messageStore: MessageStore;
  /** Stored trust edges for the `trust` object on GET JSON. */
  trustStore: TrustStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /**
   * Outbound house gifts (default: empty {@link InMemoryGiftStore}).
   * Used by `GET /:accountId/activity`.
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
}

/** Auth or member-load outcome. */
type MemberLoad = { ok: true; account: Account } | { ok: false; response: Response };

/**
 * Delete a `hasVideo` row whose file is missing or empty. Notes without video
 * are unchanged.
 *
 * @param store - Message store.
 * @param row - Store row.
 * @returns The row, or `null` when it was deleted.
 */
async function dropMissingVideoRow(
  store: MessageStore,
  row: MessageRow,
): Promise<MessageRow | null> {
  if (
    row.hasVideo !== true ||
    row.videoContentType === undefined ||
    row.videoContentType === null
  ) {
    return row;
  }
  const present = await forumVideoFilePresent(resolveMediaDir(), row.id, row.videoContentType);
  if (present) {
    return row;
  }
  await store.deleteById(row.id);
  logEvent('messages.video.dropped');
  return null;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MembersRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/**
 * Require a signed-in caller with `forum.read`.
 *
 * @param deps - Auth store and clock.
 * @param c - Request.
 * @returns The caller, or a 401/409 response.
 */
async function requireForumRead(deps: MembersRouteDeps, c: Context): Promise<MemberLoad> {
  const caller = await authedAccount(deps, c.req.header('authorization'));
  if (caller === null) {
    return { ok: false, response: c.json({ error: 'Unauthorized' }, 401) };
  }
  const gate = requireAction(caller, 'forum.read');
  if (!gate.ok) {
    return {
      ok: false,
      response: c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409),
    };
  }
  return { ok: true, account: caller };
}

/**
 * Load the path member after UUID validation.
 *
 * @param deps - Auth store.
 * @param c - Request (`accountId` param).
 * @returns The account, or a 404 response.
 */
async function loadMember(deps: MembersRouteDeps, c: Context): Promise<MemberLoad> {
  const accountId = c.req.param('accountId');
  if (accountId === undefined || !MESSAGE_ID_RE.test(accountId)) {
    return { ok: false, response: c.json({ error: 'Not found' }, 404) };
  }
  const account = await deps.authStore.getAccount(accountId);
  if (account === undefined) {
    return { ok: false, response: c.json({ error: 'Not found' }, 404) };
  }
  return { ok: true, account };
}

/**
 * Build the `/members` route group.
 *
 * Mounted at `/members` so the public paths are `GET /members/:accountId`,
 * `GET /members/:accountId/activity`, `GET /members/:accountId/posts`, and
 * `GET /members/:accountId/replies`. More-specific paths register before
 * `/:accountId`.
 *
 * @param deps - Auth store, message store, trust store, clock, and optional gift/rate/fiat stores.
 * @returns A Hono app with activity, posts, replies, and member GET.
 */
export function membersRoutes(deps: MembersRouteDeps): Hono {
  const giftStore = deps.giftStore ?? new InMemoryGiftStore();
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const fiatRates = deps.fiatRates ?? new InMemoryFiatStore();

  return new Hono()
    .get('/:accountId/activity', async (c) => {
      const auth = await requireForumRead(deps, c);
      if (!auth.ok) {
        return auth.response;
      }
      const member = await loadMember(deps, c);
      if (!member.ok) {
        return member.response;
      }
      try {
        const activity = await buildAccountActivity({
          account: member.account,
          gifts: giftStore,
          messages: deps.messageStore,
          rates,
          now: deps.now,
          fiatRates,
        });
        return c.json(activity, 200);
      } catch (err) {
        const missingFx = err instanceof Error && err.message === 'fx.rate.missing';
        logEvent(missingFx ? 'account.activity.fx_incomplete' : 'account.activity.failed');
        return c.json({ error: 'Gift stats are unavailable' }, 503);
      }
    })
    .get('/:accountId/posts', async (c) => {
      const auth = await requireForumRead(deps, c);
      if (!auth.ok) {
        return auth.response;
      }
      try {
        const member = await loadMember(deps, c);
        if (!member.ok) {
          return member.response;
        }
        const account = member.account;
        const rows = await deps.messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
        const messages = [];
        for (const row of rows) {
          const kept = await dropMissingVideoRow(deps.messageStore, row);
          if (kept === null) {
            continue;
          }
          const children = await deps.messageStore.listReplies(kept.id, MESSAGE_LIST_LIMIT);
          let dropped = 0;
          for (const child of children) {
            const keptChild = await dropMissingVideoRow(deps.messageStore, child);
            if (keptChild === null) {
              dropped += 1;
            }
          }
          const payable =
            kept.eventId !== null &&
            kept.eventId !== '' &&
            account.lightningAddress !== null &&
            account.lightningAddress.trim() !== '';
          messages.push(
            serializeMessage(
              kept,
              payable,
              account.role,
              Math.max(0, row.replyCount - dropped),
              true,
            ),
          );
        }
        return c.json({ messages }, 200);
      } catch {
        logEvent('members.posts.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:accountId/replies', async (c) => {
      const auth = await requireForumRead(deps, c);
      if (!auth.ok) {
        return auth.response;
      }
      try {
        const member = await loadMember(deps, c);
        if (!member.ok) {
          return member.response;
        }
        const account = member.account;
        const rows = await deps.messageStore.listRepliesByAccount(account.id, MESSAGE_LIST_LIMIT);
        const messages = [];
        for (const row of rows) {
          const kept = await dropMissingVideoRow(deps.messageStore, row);
          if (kept === null) {
            continue;
          }
          try {
            const payable =
              kept.eventId !== null &&
              kept.eventId !== '' &&
              account.lightningAddress !== null &&
              account.lightningAddress.trim() !== '';
            messages.push(serializeMessage(kept, payable, account.role, undefined, true));
          } catch {
            continue;
          }
        }
        return c.json({ messages }, 200);
      } catch {
        logEvent('members.replies.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .get('/:accountId', async (c) => {
      const auth = await requireForumRead(deps, c);
      if (!auth.ok) {
        return auth.response;
      }
      try {
        const member = await loadMember(deps, c);
        if (!member.ok) {
          return member.response;
        }
        const account = member.account;
        let profileMessage: ReturnType<typeof serializeMessage> | null = null;
        let aboutMe: string | null = null;
        let aboutMeHasPhoto = false;
        const profileId = account.profileMessageId;
        if (typeof profileId === 'string' && profileId.trim() !== '') {
          const row = await deps.messageStore.getById(profileId);
          if (row !== undefined && row.deletedAt === null) {
            const payable =
              row.eventId !== null &&
              row.eventId !== '' &&
              account.lightningAddress !== null &&
              account.lightningAddress.trim() !== '';
            const children = await deps.messageStore.listReplies(row.id, MESSAGE_LIST_LIMIT);
            profileMessage = serializeMessage(row, payable, account.role, children.length, true);
            aboutMe = aboutMeFromNote(account.name, row.text, row.name);
            aboutMeHasPhoto = row.hasPhoto === true;
          }
        }
        const counts = await deps.messageStore.countByAccount(account.id);
        const edges = await deps.trustStore.listEdgesForSubject(account.id);
        const accounts = await deps.authStore.listAccounts();
        return c.json(
          {
            id: account.id,
            name: account.name,
            location: account.location,
            role: account.role,
            lightningAddress: account.lightningAddress,
            createdAt: new Date(account.createdAt).toISOString(),
            profileMessage,
            aboutMe,
            aboutMeHasPhoto,
            postCount: counts.postCount,
            replyCount: counts.replyCount,
            trust: accountTrust(account.id, accounts, edges),
          },
          200,
        );
      } catch {
        logEvent('members.get.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    });
}
