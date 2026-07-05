import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';

/**
 * `GET /me` — the authenticated account behind a bearer session token. Shares
 * the {@link AuthStore} instance with the `/auth` routes.
 */

/** Collaborators the `/me` route needs. */
export interface MeRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
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

/**
 * Build the `/me` route.
 *
 * @param deps - Shared store and clock.
 * @returns A Hono app exposing `GET /` (the current account).
 */
export function meRoutes(deps: MeRouteDeps): Hono {
  return new Hono().get('/', (c) => {
    const token = bearerToken(c.req.header('authorization'));
    if (token === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const account = resolveSession(deps.store, deps.now(), token);
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return c.json(
      {
        id: account.id,
        linkingKey: account.linkingKey,
        role: account.role,
        createdAt: account.createdAt,
      },
      200,
    );
  });
}
