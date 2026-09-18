/** Operator-only inspection of entitled and blocked external Nostr pubkeys. */

import { Hono } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';

/** Collaborators for the external-pubkey debug route. */
export interface DebugExternalRouteDeps {
  /** Message persistence containing zapper and block rows. */
  store: MessageStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/**
 * Build `GET /debug/external-pubkeys`.
 *
 * @param deps - Message store and optional operator token.
 * @returns A Hono app with the bearer-gated external identity list.
 */
export function debugExternalRoutes(deps: DebugExternalRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    if (deps.debugToken === undefined || deps.debugToken.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(deps.debugToken, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const [zappers, blocked] = await Promise.all([
        deps.store.listZappers(MESSAGE_LIST_LIMIT),
        deps.store.listBlockedPubkeyRows(MESSAGE_LIST_LIMIT),
      ]);
      logEvent('debug.external_pubkeys.listed', {
        zappers: zappers.length,
        blocked: blocked.length,
      });
      return c.json(
        {
          zappers: zappers.map((row) => ({
            pubkey: row.pubkey,
            receiptEventId: row.receiptEventId,
            createdAt: row.createdAt.toISOString(),
          })),
          blocked: blocked.map((row) => ({
            pubkey: row.pubkey,
            blockedAt: row.blockedAt.toISOString(),
            blockedBy: row.blockedBy,
            messageId: row.messageId,
          })),
        },
        200,
      );
    } catch {
      logEvent('debug.external_pubkeys.list_failed');
      return c.json({ error: 'External pubkeys are unavailable' }, 503);
    }
  });
}
