import { Hono } from 'hono';
import { z } from 'zod';
import { buildAccountActivity } from '@/lib/account-activity';
import { serializeOwnerAccountWithPosts, type OwnerAccountResponse } from '@/lib/auth/account-json';
import { InMemoryFundingStore, type FundingStore } from '@/lib/funding-store';
import { ensureProfileMessage } from '@/lib/auth/profile-message';
import { MISSING_REQUIREMENTS_ERROR } from '@/lib/auth/requirements';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { isWrongAccount, WRONG_ACCOUNT_ERROR } from '@/lib/auth/wrong-account';
import { SESSION_TTL_MS } from '@/lib/config';
import { InMemoryBtcUsdStore, type BtcUsdRateBook } from '@/lib/btc-usd-store';
import { InMemoryGiftStore, type GiftStore } from '@/lib/gift-store';
import type { InvoicePayer } from '@/lib/invoice-payer';
import { InMemoryFiatStore, type FiatRateBook } from '@/lib/usd-fiat-store';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { normalizeLocation } from '@/lib/location';
import { logEvent } from '@/lib/log';
import { resolveLnurlp, type FetchFn } from '@/lib/lnurlp';
import {
  decodeForumPhoto,
  forumPhotoResponse,
  normalizeForumText,
  unsignedNostrDefaults,
  type ForumPhoto,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { normalizeDisplayName } from '@/lib/name';
import { normalizeUsername, usernameFromDisplayName } from '@/lib/username';
import { inboxUnreadCountFor } from '@/lib/conversation-push';
import type { ConversationStore } from '@/lib/conversation-store';
import { notifyForumPost } from '@/lib/notification';
import { LIGHTNING_ADDRESS_NOT_ZAP, probeNip57Mint } from '@/lib/nip57-probe';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { signEventForAccount } from '@/lib/nostr/sign';
import type { NotificationStore } from '@/lib/notification-store';
import type { PushStore } from '@/lib/push-store';
import { confirmVerification, startVerification } from '@/lib/verification';

/**
 * `/me` — the authenticated account and its editable profile (display name,
 * unique username, optional location, About me, welcome-forum laws dismiss,
 * living-room rules agreement, notification level, wallet backup seen,
 * and the receiver's Lightning Address), including proof-of-control
 * verification. Shares the {@link AuthStore} instance with `/auth`.
 */

/** Collaborators the `/me` routes need. */
export interface MeRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Forum persistence (About me without LN, activity zaps/invoices, profile notes). */
  messages: MessageStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Pays the verification micro-payment invoice. */
  payer: InvoicePayer;
  /** Injected `fetch` for LNURL-pay resolution. */
  fetchImpl: FetchFn;
  /** AES KEK for signing the NIP-57 mint probe; omit when unset. */
  nostrKek?: Uint8Array;
  /** Optional push outbox; also the bell-subscriber list. */
  pushStore?: PushStore;
  /** Optional in-app notification store for profile-note create. */
  notificationStore?: NotificationStore;
  /** Optional inbox store; profile-note push payloads include listed unread when set. */
  conversationStore?: ConversationStore;
  /**
   * Outbound house gifts (default: empty {@link InMemoryGiftStore}).
   * Used by `GET /activity`.
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
  /**
   * Funding grants for owner JSON (default: empty {@link InMemoryFundingStore}).
   */
  fundingStore?: FundingStore;
}

/**
 * Extract the bearer token from an `Authorization` header value.
 *
 * @param header - The raw header value, or `undefined` when absent.
 * @returns The token, or `null` when the header is missing, uses another
 * scheme, or carries an empty token.
 */
export function bearerToken(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MeRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.store, deps.now(), token);
}

/**
 * Re-read the account after an await so a concurrent profile write is not
 * overwritten by a stale spread of the pre-await snapshot.
 *
 * @param deps - Store and collaborators.
 * @param id - Account id from the authorized snapshot.
 * @returns The latest stored account, or `null` if it disappeared.
 */
async function storedAccount(deps: MeRouteDeps, id: string): Promise<Account | null> {
  const current = await deps.store.getAccount(id);
  /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
  if (current === undefined) {
    return null;
  }
  return current;
}

/** Body schema for setting a display name. */
const nameBody = z.object({ name: z.string() });

/** Body schema for setting a unique username. */
const usernameBody = z.object({ username: z.string() });

/** Body schema for setting a free-text profile location. */
const locationBody = z.object({ location: z.string() });

/** Body schema for linking a Lightning Address. */
const addressBody = z.object({ address: z.string() });

/** Body schema for confirming address verification. */
const confirmBody = z.object({ nonce: z.string() });

/** Body schema for skipping a wizard step. */
const skipBody = z.object({ step: z.enum(['name', 'lightning-address']) });

/** Body schema for writing About me (required text; optional photo tri-state). */
const aboutBody = z.object({
  text: z.string(),
  photo: z
    .union([
      z.object({
        contentType: z.string(),
        data: z.string(),
      }),
      z.null(),
    ])
    .optional(),
});

/** Same decode-failure string as `POST /messages`. */
const ABOUT_PHOTO_ERROR = 'Photo must be a JPEG, PNG, or WebP under 1 MiB';

/** Body schema for setting the owner notification level. */
const notificationLevelBody = z.object({
  level: z.enum(['all', 'active', 'mentions']),
});

/** Owner JSON including the live funding grant. */
function ownerJson(deps: MeRouteDeps, account: Account): Promise<OwnerAccountResponse> {
  return serializeOwnerAccountWithPosts(account, deps.messages, {
    store: deps.fundingStore ?? new InMemoryFundingStore(),
    nowMs: deps.now(),
    authStore: deps.store,
  });
}

/**
 * Build the `/me` route group.
 *
 * @param deps - Shared store, message store, clock, payer, fetch, optional push, optional notification and conversation stores, optional gift/rate/fiat stores for activity, optional funding store, and optional `nostrKek` for the NIP-57 mint probe.
 * @returns A Hono app exposing account, activity, display-name, username, location, About me, wallet-backup-seen, setup skip, forum-laws dismiss,
 * living-room rules agreement, notification level, link/unlink, and verification routes.
 */
export function meRoutes(deps: MeRouteDeps): Hono {
  const giftStore = deps.giftStore ?? new InMemoryGiftStore();
  const rates = deps.rates ?? new InMemoryBtcUsdStore();
  const fiatRates = deps.fiatRates ?? new InMemoryFiatStore();

  return new Hono()
    .get('/', async (c) => {
      const token = bearerToken(c.req.header('authorization'));
      if (token === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const now = deps.now();
      const session = await deps.store.getSession(token);
      if (session === undefined || now - session.createdAt > SESSION_TTL_MS) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const account = await deps.store.getAccount(session.accountId);
      /* v8 ignore next 3 -- a session always references an existing account in-memory */
      if (account === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (isWrongAccount(account)) {
        return c.json({ error: WRONG_ACCOUNT_ERROR }, 403);
      }
      return c.json(await ownerJson(deps, account), 200);
    })
    .get('/activity', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const activity = await buildAccountActivity({
          account,
          gifts: giftStore,
          messages: deps.messages,
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
    .post('/wallet-backup-seen', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (current.walletBackupSeenAt !== null && current.walletBackupSeenAt !== undefined) {
        return c.json(await serializeOwnerAccountWithPosts(current, deps.messages), 200);
      }
      const updated: Account = { ...current, walletBackupSeenAt: deps.now() };
      await deps.store.updateAccount(updated);
      logEvent('account.wallet.backup_seen', { accountId: current.id });
      return c.json(await serializeOwnerAccountWithPosts(updated, deps.messages), 200);
    })
    .post('/setup/skip', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = skipBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'Expected a JSON body with step "name" or "lightning-address"' },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const skippedAt = deps.now();
      const updated: Account =
        parsed.data.step === 'name'
          ? { ...current, nameSkippedAt: skippedAt }
          : { ...current, lightningAddressSkippedAt: skippedAt };
      await deps.store.updateAccount(updated);
      logEvent('account.setup.skipped', { accountId: current.id, step: parsed.data.step });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/name', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = nameBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "name" string' }, 400);
      }
      const name = normalizeDisplayName(parsed.data.name);
      if (name === null) {
        return c.json({ error: 'Name must be 1–80 characters' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const withName: Account = { ...current, name };
      await ensureProfileMessage({
        auth: deps.store,
        messages: deps.messages,
        account: withName,
        now: deps.now,
        ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
        ...(deps.notificationStore === undefined ? {} : { notifications: deps.notificationStore }),
        /* v8 ignore next -- createApp always injects conversationStore */
        ...(deps.conversationStore === undefined ? {} : { conversations: deps.conversationStore }),
      });
      const live = await deps.store.getAccount(current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (live === null || live === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await deps.store.updateAccount({ ...live, name });
      const named = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (named === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const usernameBlank =
        named.username === null || named.username === undefined || named.username.trim() === '';
      if (usernameBlank) {
        const derived = usernameFromDisplayName(name);
        if (derived !== null) {
          const owner = await deps.store.getAccountByUsername(derived);
          if (owner === undefined || owner.id === named.id) {
            const latest = await storedAccount(deps, named.id);
            /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
            if (latest === null) {
              return c.json({ error: 'Unauthorized' }, 401);
            }
            const latestBlank =
              latest.username === null ||
              latest.username === undefined ||
              latest.username.trim() === '';
            if (latestBlank) {
              await deps.store.updateAccount({ ...latest, username: derived });
            }
          }
        }
      }
      const stored = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (stored === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('account.name.set', { accountId: current.id });
      return c.json(await ownerJson(deps, stored), 200);
    })
    .post('/username', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = usernameBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "username" string' }, 400);
      }
      const username = normalizeUsername(parsed.data.username);
      if (username === null) {
        return c.json(
          {
            error: 'Username must be 1–32 characters of a-z, 0-9, hyphen, underscore, or dot',
          },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const owner = await deps.store.getAccountByUsername(username);
      if (owner !== undefined && owner.id !== current.id) {
        return c.json({ error: 'Username is already in use' }, 409);
      }
      const latest = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (latest === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await deps.store.updateAccount({ ...latest, username });
      const stored = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (stored === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      /* v8 ignore next 3 -- unique-index race: update no-ops and the stored handle stays taken */
      if ((stored.username ?? '').trim().toLowerCase() !== username) {
        return c.json({ error: 'Username is already in use' }, 409);
      }
      logEvent('account.username.set', { accountId: current.id });
      return c.json(await ownerJson(deps, stored), 200);
    })
    .post('/location', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = locationBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "location" string' }, 400);
      }
      const normalized = normalizeLocation(parsed.data.location);
      if (!normalized.ok) {
        return c.json({ error: 'Location must be at most 80 characters' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = { ...current, location: normalized.value };
      await deps.store.updateAccount(updated);
      logEvent('account.location.set', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .get('/about/photo', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const profileId = account.profileMessageId;
        if (typeof profileId !== 'string' || profileId.trim() === '') {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const row = await deps.messages.getById(profileId);
        if (row === undefined || row.deletedAt !== null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        const photo = await deps.messages.getPhoto(profileId);
        if (photo === null) {
          return c.json({ error: 'Photo not found' }, 404);
        }
        return forumPhotoResponse(photo);
      } catch {
        logEvent('account.about.photo.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .put('/about', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const raw: unknown = await c.req.json().catch(() => null);
      const parsed = aboutBody.safeParse(raw);
      if (!parsed.success) {
        const textOk =
          raw !== null &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          typeof (raw as { text?: unknown }).text === 'string';
        if (!textOk) {
          return c.json({ error: 'Expected a JSON body with a "text" string' }, 400);
        }
        return c.json({ error: ABOUT_PHOTO_ERROR }, 400);
      }
      const photoKeyPresent =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'photo' in raw;
      let decodedPhoto: ForumPhoto | null | undefined = undefined;
      if (photoKeyPresent) {
        // Zod types optional `photo` as T | null | undefined. A present JSON
        // key is T | null (`undefined` cannot appear in JSON).
        const incoming = parsed.data.photo as { contentType: string; data: string } | null;
        if (incoming === null) {
          decodedPhoto = null;
        } else {
          const decoded = decodeForumPhoto(incoming.contentType, incoming.data);
          if (decoded === null) {
            return c.json({ error: ABOUT_PHOTO_ERROR }, 400);
          }
          decodedPhoto = decoded;
        }
      }
      const normalized = normalizeForumText(parsed.data.text);
      if (normalized === null) {
        return c.json({ error: 'About me must be at most 500 characters' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const displayName = current.name === null ? '' : current.name.trim();
      if (displayName === '') {
        return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: ['name'] }, 409);
      }
      try {
        let owner = current;
        let noteId: string | undefined;
        let createdThisRequest = false;
        const existingId = owner.profileMessageId;
        if (typeof existingId === 'string' && existingId.trim() !== '') {
          const existing = await deps.messages.getById(existingId);
          if (existing !== undefined && existing.deletedAt === null) {
            noteId = existingId;
          }
        }
        if (
          noteId === undefined &&
          normalized === '' &&
          (decodedPhoto === undefined || decodedPhoto === null)
        ) {
          const latest = await storedAccount(deps, owner.id);
          /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
          if (latest === null) {
            return c.json({ error: 'Unauthorized' }, 401);
          }
          logEvent('account.about.set', { accountId: latest.id });
          return c.json(await ownerJson(deps, latest), 200);
        }
        if (noteId === undefined) {
          const messageId = crypto.randomUUID();
          const createPhoto = decodedPhoto ?? undefined;
          const row: MessageRow = {
            id: messageId,
            accountId: owner.id,
            name: displayName,
            text: normalized,
            createdAt: new Date(deps.now()),
            hasPhoto: createPhoto !== undefined,
            hasVideo: false,
            videoContentType: null,
            ...unsignedNostrDefaults(),
          };
          const created = await deps.messages.create(row, createPhoto);
          const insertedThisRequest = created.id === messageId;
          const discardInsert = async (winnerId?: string | null): Promise<void> => {
            if (insertedThisRequest && created.id !== winnerId) {
              await deps.messages.deleteById(created.id);
            }
          };
          const live = await deps.store.getAccount(owner.id);
          if (live === undefined) {
            await discardInsert();
            return c.json({ error: 'Unauthorized' }, 401);
          }
          const liveId = live.profileMessageId;
          if (typeof liveId === 'string' && liveId.trim() !== '') {
            const winner = await deps.messages.getById(liveId);
            if (winner !== undefined && winner.deletedAt === null) {
              await discardInsert(liveId);
              owner = live;
              noteId = liveId;
            }
          }
          if (noteId === undefined) {
            const expectedId =
              typeof live.profileMessageId === 'string' && live.profileMessageId.trim() !== ''
                ? live.profileMessageId
                : null;
            try {
              const claimed = await deps.store.claimProfileMessageId(
                live.id,
                expectedId,
                created.id,
              );
              if (!claimed) {
                const after = await deps.store.getAccount(owner.id);
                await discardInsert(after?.profileMessageId);
                if (after === undefined) {
                  return c.json({ error: 'Unauthorized' }, 401);
                }
                const afterId = after.profileMessageId;
                if (typeof afterId === 'string' && afterId.trim() !== '') {
                  const afterRow = await deps.messages.getById(afterId);
                  if (afterRow !== undefined && afterRow.deletedAt === null) {
                    owner = after;
                    noteId = afterId;
                  }
                }
                if (noteId === undefined) {
                  return c.json({ error: 'Messages are unavailable' }, 503);
                }
              }
            } catch (err) {
              await discardInsert();
              throw err;
            }
            if (noteId === undefined) {
              const confirmed = await deps.store.getAccount(owner.id);
              if (confirmed === undefined || confirmed.profileMessageId !== created.id) {
                await discardInsert(confirmed?.profileMessageId);
                if (confirmed === undefined) {
                  return c.json({ error: 'Unauthorized' }, 401);
                }
                const confirmedId = confirmed.profileMessageId;
                if (typeof confirmedId === 'string' && confirmedId.trim() !== '') {
                  const confirmedRow = await deps.messages.getById(confirmedId);
                  if (confirmedRow !== undefined && confirmedRow.deletedAt === null) {
                    owner = confirmed;
                    noteId = confirmedId;
                  }
                }
                if (noteId === undefined) {
                  return c.json({ error: 'Messages are unavailable' }, 503);
                }
              } else {
                owner = { ...live, profileMessageId: created.id };
                noteId = created.id;
                createdThisRequest = insertedThisRequest;
              }
            }
          }
        }
        await deps.messages.updateText(noteId, normalized);
        if (photoKeyPresent && !createdThisRequest) {
          await deps.messages.updatePhoto(noteId, decodedPhoto ?? null);
        }
        const liveRow = await deps.messages.getById(noteId);
        if (liveRow !== undefined && liveRow.sats === 0 && liveRow.eventId !== null) {
          await deps.messages.resetSignedEvent(noteId, liveRow.eventId);
        }
        if (createdThisRequest && liveRow !== undefined) {
          try {
            await notifyForumPost({
              account: owner,
              created: liveRow,
              auth: deps.store,
              ...(deps.notificationStore === undefined
                ? {}
                : { notifications: deps.notificationStore }),
              ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
              /* v8 ignore next 5 -- createApp always injects conversationStore */
              ...(deps.conversationStore === undefined
                ? {}
                : {
                    inboxUnreadCount: inboxUnreadCountFor(deps.conversationStore, deps.store),
                  }),
            });
          } catch {
            logEvent('push.enqueue.failed');
          }
        }
        const latest = await storedAccount(deps, owner.id);
        /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
        if (latest === null) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
        logEvent('account.about.set', { accountId: latest.id });
        return c.json(await ownerJson(deps, latest), 200);
      } catch {
        logEvent('account.about.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/forum-laws-dismissed', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (current.forumLawsDismissed === true) {
        return c.json(await ownerJson(deps, current), 200);
      }
      const updated: Account = { ...current, forumLawsDismissed: true };
      await deps.store.updateAccount(updated);
      logEvent('account.forum_laws.dismissed', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/notification-level', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = notificationLevelBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'Expected a JSON body with a level of all, active, or mentions' },
          400,
        );
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = { ...current, notificationLevel: parsed.data.level };
      await deps.store.updateAccount(updated);
      logEvent('account.notification_level.set', {
        accountId: current.id,
        level: parsed.data.level,
      });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/rules-agreement', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if (current.rulesAgreedAt !== null) {
        return c.json(await ownerJson(deps, current), 200);
      }
      const updated: Account = { ...current, rulesAgreedAt: deps.now() };
      await deps.store.updateAccount(updated);
      logEvent('account.rules_agreement.set', { accountId: current.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/lightning-address', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = addressBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "address" string' }, 400);
      }
      const address = normalizeLightningAddress(parsed.data.address);
      if (address === null) {
        return c.json({ error: 'Not a valid Lightning Address (expected name@domain)' }, 400);
      }
      const resolved = await resolveLnurlp({ address, fetchImpl: deps.fetchImpl });
      const zapPubkey =
        resolved.ok && resolved.metadata.allowsNostr === true
          ? resolved.metadata.nostrPubkey
          : undefined;
      if (zapPubkey === undefined || zapPubkey.trim() === '') {
        logEvent('account.lightning_address.resolve_failed', {
          accountId: account.id,
          address,
        });
        return c.json({ error: 'Lightning Address could not be resolved' }, 400);
      }
      const kek = deps.nostrKek;
      if (kek === undefined) {
        return c.json({ error: 'Lightning Address could not be resolved' }, 503);
      }
      try {
        await ensureAccountNostrKey(deps.store, account.id, kek);
      } catch {
        return c.json({ error: 'Lightning Address could not be resolved' }, 503);
      }
      const accountPubkey = await deps.store.getNostrPublicKey(account.id);
      if (accountPubkey === undefined || accountPubkey === '') {
        return c.json({ error: 'Lightning Address could not be resolved' }, 503);
      }
      const probe = await probeNip57Mint({
        address,
        recipientPubkey: accountPubkey,
        sign: async (unsigned) => {
          const signed = await signEventForAccount(deps.store, account.id, kek, unsigned);
          return { ...signed };
        },
        fetchImpl: deps.fetchImpl,
        env: process.env,
      });
      if (probe === 'not_zap') {
        logEvent('account.lightning_address.not_zap', { accountId: account.id });
        return c.json({ error: LIGHTNING_ADDRESS_NOT_ZAP }, 400);
      }
      if (probe === 'unreachable') {
        logEvent('account.lightning_address.resolve_failed', {
          accountId: account.id,
          address,
        });
        return c.json({ error: 'Lightning Address could not be resolved' }, 400);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      // Linking a (new) address resets any prior verified state; proof of control
      // is a separate step. Any in-flight verification is dropped with the link.
      const owner = await deps.store.getAccountByLightningAddress(address);
      if (owner !== undefined && owner.id !== current.id) {
        return c.json({ error: 'Lightning Address is already in use' }, 409);
      }
      const updated: Account = {
        ...current,
        lightningAddress: address,
        lightningAddressVerified: false,
      };
      await deps.store.updateAccount(updated);
      const stored = await storedAccount(deps, current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (stored === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      if ((stored.lightningAddress ?? '').trim().toLowerCase() !== address.trim().toLowerCase()) {
        return c.json({ error: 'Lightning Address is already in use' }, 409);
      }
      await deps.store.deleteVerification(current.id);
      await ensureProfileMessage({
        auth: deps.store,
        messages: deps.messages,
        account: stored,
        now: deps.now,
        ...(deps.pushStore === undefined ? {} : { pushStore: deps.pushStore }),
        ...(deps.notificationStore === undefined ? {} : { notifications: deps.notificationStore }),
        /* v8 ignore next -- createApp always injects conversationStore */
        ...(deps.conversationStore === undefined ? {} : { conversations: deps.conversationStore }),
      });
      const live = await deps.store.getAccount(current.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (live === null || live === undefined) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      logEvent('account.lightning_address.linked', {
        accountId: account.id,
        address,
      });
      return c.json(await ownerJson(deps, live), 200);
    })
    .delete('/lightning-address', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const current = await storedAccount(deps, account.id);
      /* v8 ignore next 3 -- the account row cannot vanish mid-request after auth */
      if (current === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = {
        ...current,
        lightningAddress: null,
        lightningAddressVerified: false,
        lightningAddressSkippedAt: null,
      };
      await deps.store.updateAccount(updated);
      await deps.store.deleteVerification(account.id);
      logEvent('account.lightning_address.unlinked', { accountId: account.id });
      return c.json(await ownerJson(deps, updated), 200);
    })
    .post('/lightning-address/verification', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const result = await startVerification({
        store: deps.store,
        payer: deps.payer,
        fetchImpl: deps.fetchImpl,
        now: deps.now(),
        account,
      });
      if (!result.ok) {
        switch (result.code) {
          case 'no_address':
            return c.json({ error: 'No Lightning Address linked' }, 409);
          case 'already_verified':
            return c.json({ error: 'Lightning Address already verified' }, 409);
          case 'not_configured':
            return c.json({ error: 'Verification payments are not configured' }, 503);
          case 'unreachable':
            return c.json(
              { error: 'Lightning Address did not accept the verification payment' },
              502,
            );
        }
      }
      // Do not return the nonce — the user must read it from the wallet history.
      logEvent('account.verification.started', { accountId: account.id });
      return c.json(
        {
          status: 'sent',
          expiresInSeconds: result.expiresInSeconds,
          sats: result.sats,
        },
        200,
      );
    })
    .post('/lightning-address/verification/confirm', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = confirmBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "nonce" string' }, 400);
      }
      const result = await confirmVerification(deps.store, deps.now(), account, parsed.data.nonce);
      if (!result.ok) {
        switch (result.code) {
          case 'bad_nonce':
          case 'mismatch':
            return c.json({ error: 'Incorrect verification code' }, 400);
          case 'no_pending':
            return c.json({ error: 'No verification in progress' }, 409);
          case 'expired':
            return c.json({ error: 'Verification expired' }, 409);
        }
      }
      logEvent('account.verification.confirmed', { accountId: account.id });
      return c.json(await ownerJson(deps, result.account), 200);
    });
}
