import { Hono } from 'hono';
import { serializeViewProfile } from '@/lib/auth/account-json';
import type { AuthStore } from '@/lib/auth/store';

/**
 * Public capability URL for a read-only account profile card.
 * Anyone with the view key can read; they cannot write or mint a session.
 */

/** Collaborators the view routes need. */
export interface ViewRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
}

/** 64 lowercase hex view-key shape. */
const VIEW_KEY_RE = /^[0-9a-f]{64}$/;

/**
 * Build the `/view` route group.
 *
 * Mounted at `/view` so the public path is `GET /view/:viewKey`.
 * No auth. Never calls `resolveSession`. Never accepts the key as Bearer.
 *
 * @param deps - Shared auth store.
 * @returns A Hono app exposing `GET /:viewKey`.
 */
export function viewRoutes(deps: ViewRouteDeps): Hono {
  return new Hono().get('/:viewKey', async (c) => {
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
