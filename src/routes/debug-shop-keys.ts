/**
 * Operator import of a shop Nostr secret that already exists at OpenCryptoPay.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 * The secret is never logged and never returned.
 */

import { Hono } from 'hono';
import type { MessageStore } from '@/lib/message-store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { shopKeyMustBeAdopted, shopNpub, type ShopIdentityStore } from '@/lib/shop-identity';

/** Collaborators the debug shop-key route needs. */
export interface DebugShopKeyRouteDeps {
  /** Shop identity store that can adopt a known secret. */
  identities: ShopIdentityStore;
  /** Forum notes. The note must exist. */
  messages: MessageStore;
  /** 32-byte shop KEK, or omitted when shop keys are off. */
  kek: Uint8Array | undefined;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

const HEX_SECRET = /^[0-9a-f]{64}$/;

/**
 * Build the `/debug/shop-keys` route group.
 *
 * Mounted at `/debug/shop-keys` so the public path is `POST /debug/shop-keys`.
 *
 * @param deps - Identity store, notes, KEK and optional debug token.
 * @returns A Hono app exposing `POST /`.
 */
export function debugShopKeyRoutes(deps: DebugShopKeyRouteDeps): Hono {
  return new Hono().post('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (deps.kek === undefined || deps.kek.length !== 32) {
      return c.json({ error: 'Shop keys are not configured' }, 503);
    }
    const body = (await c.req.json().catch(() => null)) as {
      messageId?: unknown;
      secret?: unknown;
    } | null;
    const messageId =
      typeof body?.messageId === 'string' ? body.messageId.trim().toLowerCase() : '';
    const secretHex = typeof body?.secret === 'string' ? body.secret.trim().toLowerCase() : '';
    if (!shopKeyMustBeAdopted(messageId) || !HEX_SECRET.test(secretHex)) {
      return c.json({ error: 'Invalid shop key' }, 400);
    }
    const secret = Uint8Array.from(Buffer.from(secretHex, 'hex'));
    let response: Response;
    try {
      const row = await deps.identities.adoptKnownSecret(messageId, secret, deps.kek);
      logEvent('debug.shop_key.adopted', { messageId: row.messageId });
      response = c.json({ messageId: row.messageId, npub: shopNpub(row) }, 200);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message === 'shop note not found') {
        response = c.json({ error: 'Not found' }, 404);
      } else if (message === 'shop nostr pubkey already exists') {
        response = c.json({ error: 'Shop key already exists' }, 409);
      } else {
        response = c.json({ error: 'Invalid shop key' }, 400);
      }
    }
    secret.fill(0);
    return response;
  });
}
