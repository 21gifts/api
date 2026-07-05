import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import type { Account, AuthStore } from '@/lib/auth/store';

/**
 * `/me` — the authenticated account and its editable profile (the receiver's
 * Lightning Address). Shares the {@link AuthStore} instance with `/auth`.
 */

/** Collaborators the `/me` routes need. */
export interface MeRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

/** The public JSON shape of an account. */
interface AccountResponse {
  id: string;
  linkingKey: string;
  role: string;
  lightningAddress: string | null;
  lightningAddressVerified: boolean;
  createdAt: number;
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
function authedAccount(deps: MeRouteDeps, header: string | undefined): Account | null {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.store, deps.now(), token);
}

/** Project an account to its public JSON shape. */
function serializeAccount(account: Account): AccountResponse {
  return {
    id: account.id,
    linkingKey: account.linkingKey,
    role: account.role,
    lightningAddress: account.lightningAddress,
    lightningAddressVerified: account.lightningAddressVerified,
    createdAt: account.createdAt,
  };
}

/** Body schema for linking a Lightning Address. */
const addressBody = z.object({ address: z.string() });

/**
 * Build the `/me` route group.
 *
 * @param deps - Shared store and clock.
 * @returns A Hono app exposing `GET /` and `POST`/`DELETE /lightning-address`.
 */
export function meRoutes(deps: MeRouteDeps): Hono {
  return new Hono()
    .get('/', (c) => {
      const account = authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(serializeAccount(account), 200);
    })
    .post('/lightning-address', async (c) => {
      const account = authedAccount(deps, c.req.header('authorization'));
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
      // Linking a (new) address resets any prior verified state; proof of control
      // is a separate step.
      const updated: Account = {
        ...account,
        lightningAddress: address,
        lightningAddressVerified: false,
      };
      deps.store.updateAccount(updated);
      return c.json(serializeAccount(updated), 200);
    })
    .delete('/lightning-address', (c) => {
      const account = authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const updated: Account = {
        ...account,
        lightningAddress: null,
        lightningAddressVerified: false,
      };
      deps.store.updateAccount(updated);
      return c.json(serializeAccount(updated), 200);
    });
}
