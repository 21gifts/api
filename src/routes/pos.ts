import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import { isUniqueViolation } from '@/lib/auth/sql';
import type { Account, AuthStore } from '@/lib/auth/store';
import type { LnurlServerConfig } from '@/lib/config';
import type { FetchFn } from '@/lib/lnurlp';
import { resolveLnurlp } from '@/lib/lnurlp';
import { POS_CHARGE_TTL_MS, serializePosCharge, type PosCharge } from '@/lib/pos-charge';
import type { PosStore } from '@/lib/pos-store';
import { lnurlServerFetch, receivingAddress } from '@/lib/receiving-address';
import { bearerToken } from '@/routes/me';

/**
 * `/pos` — signed-in member point-of-sale amount in whole sats.
 * Settlement goes to the member's receiving address (a verified wallet when
 * the LNURL server is configured, else the linked address). There is no paid
 * status.
 * Shares the {@link AuthStore} with `/auth` and `/me`.
 */

/** Collaborators the `/pos` routes need. All required except `lnurlServer`. */
export interface PosRouteDeps {
  /** Charge persistence. */
  store: PosStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
  /** Injected `fetch` for LNURL-pay range checks. */
  fetchImpl: FetchFn;
  /** LNURL server; omitted when off. A verified wallet is checked against it. */
  lnurlServer?: LnurlServerConfig;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: PosRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/**
 * Build the `/pos` route group.
 *
 * Mounted at `/pos` so the public paths are `GET /pos`, `POST /pos`,
 * and `DELETE /pos`.
 *
 * @param deps - Charge store, auth store, clock, and LNURL fetch.
 * @returns A Hono app with `GET /`, `POST /`, and `DELETE /`.
 */
export function posRoutes(deps: PosRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const pending = await deps.store.currentPending(account.id, deps.now());
      const history = await deps.store.listForAccount(account.id, 20);
      return c.json(
        {
          charge: pending === null ? null : serializePosCharge(pending),
          history: history.map((row) => serializePosCharge(row)),
        },
        200,
      );
    })
    .post('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const body: unknown = await c.req.json().catch(() => null);
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return c.json({ error: 'Expected a JSON body with an integer "amountSats"' }, 400);
      }
      const amountSats = (body as { amountSats?: unknown }).amountSats;
      if (typeof amountSats !== 'number' || !Number.isInteger(amountSats) || amountSats < 1) {
        return c.json({ error: 'Expected a JSON body with an integer "amountSats"' }, 400);
      }
      const username = (account.username ?? '').trim();
      if (username === '') {
        return c.json({ error: 'Set a username first' }, 400);
      }
      const receiving = receivingAddress(account, deps.lnurlServer);
      if (receiving === null) {
        return c.json({ error: 'Set a Wallet of Satoshi address first' }, 400);
      }
      const open = await deps.store.currentPending(account.id, deps.now());
      if (open !== null) {
        return c.json({ error: 'A payment is already open' }, 409);
      }
      const resolved = await resolveLnurlp({
        address: receiving.address,
        fetchImpl: lnurlServerFetch(deps.lnurlServer, deps.fetchImpl),
      });
      if (!resolved.ok) {
        return c.json({ error: 'Lightning Address could not be resolved' }, 502);
      }
      const millisats = amountSats * 1000;
      if (millisats < resolved.metadata.minSendable || millisats > resolved.metadata.maxSendable) {
        return c.json({ error: 'Amount is outside the wallet range' }, 400);
      }
      const createdMs = deps.now();
      const row: PosCharge = {
        id: crypto.randomUUID(),
        accountId: account.id,
        amountSats,
        status: 'pending',
        createdAt: new Date(createdMs),
        expiresAt: new Date(createdMs + POS_CHARGE_TTL_MS),
      };
      try {
        const created = await deps.store.create(row);
        return c.json({ charge: serializePosCharge(created) }, 201);
      } catch (error) {
        if (
          isUniqueViolation(error) ||
          (error instanceof Error && error.message === 'A payment is already open')
        ) {
          return c.json({ error: 'A payment is already open' }, 409);
        }
        throw error;
      }
    })
    .delete('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const cancelled = await deps.store.cancelPending(account.id, deps.now());
      if (cancelled === null) {
        return c.json({ error: 'No open payment' }, 404);
      }
      return c.json({ charge: null }, 200);
    });
}
