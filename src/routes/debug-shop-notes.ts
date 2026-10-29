/**
 * Operator insert of a live shop note that has a till and no pin.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 * `POST /messages` still refuses this shape. The pin is not accepted.
 */

import { Hono } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { normalizeForumText, unsignedNostrDefaults } from '@/lib/message';
import { textHasHashtagToken, type MessageStore } from '@/lib/message-store';
import { shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';
import { normalizeUsername } from '@/lib/username';
import { MESSAGE_ID_RE } from '@/routes/messages';

/** Collaborators the debug shop-note route needs. */
export interface DebugShopNoteRouteDeps {
  /** Accounts. The author and the till must already exist. */
  auth: AuthStore;
  /** Forum notes. */
  messages: MessageStore;
  /** Shop identities. A stored public note gets its key here. */
  identities: ShopIdentityStore;
  /** 32-byte shop KEK, or omitted when shop keys are off. */
  kek: Uint8Array | undefined;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Clock for the note's `createdAt`. */
  now: () => number;
}

/**
 * Build the `/debug/shop-notes` route group.
 *
 * Mounted at `/debug/shop-notes` so the public path is `POST /debug/shop-notes`.
 *
 * @param deps - Accounts, notes, identities, KEK, debug token, and clock.
 * @returns A Hono app exposing `POST /`.
 */
export function debugShopNoteRoutes(deps: DebugShopNoteRouteDeps): Hono {
  return new Hono().post('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const kek = deps.kek;
    if (kek === undefined || kek.length !== 32) {
      return c.json({ error: 'Shop keys are not configured' }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as {
      text?: unknown;
      shopUsername?: unknown;
      authorId?: unknown;
    } | null;
    const text = typeof body?.text === 'string' ? normalizeForumText(body.text) : null;
    const username =
      typeof body?.shopUsername === 'string' ? normalizeUsername(body.shopUsername) : null;
    const authorId = typeof body?.authorId === 'string' ? body.authorId.trim().toLowerCase() : '';
    if (
      text === null ||
      text === '' ||
      !textHasHashtagToken(text, '21GiftsShop') ||
      username === null ||
      !MESSAGE_ID_RE.test(authorId)
    ) {
      return c.json({ error: 'Invalid shop note' }, 400);
    }
    try {
      const till = await deps.auth.getAccountByUsername(username);
      const author = await deps.auth.getAccount(authorId);
      const tillUsername = till?.username;
      if (
        till === undefined ||
        typeof tillUsername !== 'string' ||
        tillUsername.trim() === '' ||
        author === undefined
      ) {
        return c.json({ error: 'Not found' }, 404);
      }
      const created = await deps.messages.create({
        id: crypto.randomUUID(),
        accountId: author.id,
        name: author.name ?? '',
        text,
        createdAt: new Date(deps.now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        parentId: null,
        place: null,
        shopAccount: {
          id: till.id,
          username: tillUsername,
          name: till.name ?? '',
        },
      });
      const identity = await deps.identities.ensureListed(created.id, kek);
      if (identity === undefined) {
        return c.json({ error: 'Shop key was not created' }, 503);
      }
      logEvent('debug.shop_note.stored', { messageId: created.id });
      return c.json({ id: created.id, shopNpub: shopNpub(identity) }, 200);
    } catch {
      logEvent('debug.shop_note.failed');
      return c.json({ error: 'Shop note was not stored' }, 503);
    }
  });
}
