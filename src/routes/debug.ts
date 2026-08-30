import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { serializeAccount } from '@/lib/auth/account-json';
import { randomHex } from '@/lib/auth/hex';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { normalizeLightningAddress } from '@/lib/lightning-address';
import { logEvent } from '@/lib/log';
import { normalizeDisplayName } from '@/lib/name';

/**
 * Operator debug surface for registered accounts.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 * Exposes `GET /` (list), `POST /` (provision), and `PATCH /:id` (set role).
 */

/** Collaborators the debug routes need. */
export interface DebugRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/** Body schema for operator role assignment. */
const roleBody = z.object({
  role: z.enum(['basis', 'verified', 'moderator', 'founder']),
});

/** One row in the operator provision body. */
const provisionAccountRow = z.object({
  name: z.string().trim().min(1).max(80),
  lightningAddress: z
    .string()
    .trim()
    .refine((value) => {
      const at = value.indexOf('@');
      return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
    }),
});

/** Body schema for operator account provisioning. */
const provisionBody = z.object({
  accounts: z.array(provisionAccountRow).min(1).max(100),
});

/** Shared 503/401 gate for every `/debug/accounts` method. */
function requireDebugToken(deps: DebugRouteDeps): MiddlewareHandler {
  return async (c, next) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    await next();
  };
}

/**
 * Build the `/debug/accounts` route group.
 *
 * @param deps - Shared store and optional debug token.
 * @returns A Hono app exposing `GET /`, `POST /`, and `PATCH /:id`.
 */
export function debugRoutes(deps: DebugRouteDeps): Hono {
  return new Hono()
    .use('*', requireDebugToken(deps))
    .get('/', async (c) => {
      const accounts = await deps.store.listAccounts();
      logEvent('debug.accounts.listed', { count: accounts.length });
      return c.json({ accounts: accounts.map(serializeAccount) }, 200);
    })
    .post('/', async (c) => {
      const parsed = provisionBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with an "accounts" array' }, 400);
      }
      const accounts: Array<{ name: string; lightningAddress: string }> = [];
      for (const raw of parsed.data.accounts) {
        const name = normalizeDisplayName(raw.name);
        const lightningAddress = normalizeLightningAddress(raw.lightningAddress);
        if (name === null || lightningAddress === null) {
          return c.json({ error: 'Expected a JSON body with an "accounts" array' }, 400);
        }
        accounts.push({ name, lightningAddress });
      }
      let created = 0;
      let updated = 0;
      const results: Array<{
        name: string;
        lightningAddress: string;
        viewKey: string;
        created: boolean;
      }> = [];
      for (const row of accounts) {
        const found = await deps.store.getAccountByLightningAddress(row.lightningAddress);
        if (found !== undefined) {
          const named = await deps.store.updateAccountNameByLightningAddress(
            row.lightningAddress,
            row.name,
          );
          if (named === undefined || named.name !== row.name) {
            return c.json({ error: 'Could not save the account' }, 500);
          }
          updated += 1;
          results.push({
            name: named.name,
            lightningAddress: named.lightningAddress ?? row.lightningAddress,
            viewKey: named.viewKey,
            created: false,
          });
          continue;
        }
        const viewKey = randomHex(32);
        await deps.store.createAccount({
          id: crypto.randomUUID(),
          linkingKey: null,
          role: 'basis',
          name: row.name,
          lightningAddress: row.lightningAddress,
          lightningAddressVerified: false,
          forumLawsDismissed: false,
          viewKey,
          createdAt: Date.now(),
          rulesAgreedAt: null,
        });
        const stored = await deps.store.getAccountByLightningAddress(row.lightningAddress);
        if (stored === undefined) {
          return c.json({ error: 'Could not save the account' }, 500);
        }
        const didCreate = stored.viewKey === viewKey;
        if (didCreate) {
          created += 1;
          results.push({
            name: stored.name ?? row.name,
            lightningAddress: stored.lightningAddress ?? row.lightningAddress,
            viewKey: stored.viewKey,
            created: true,
          });
        } else {
          const named = await deps.store.updateAccountNameByLightningAddress(
            row.lightningAddress,
            row.name,
          );
          if (named === undefined || named.name !== row.name) {
            return c.json({ error: 'Could not save the account' }, 500);
          }
          updated += 1;
          results.push({
            name: named.name,
            lightningAddress: named.lightningAddress ?? row.lightningAddress,
            viewKey: named.viewKey,
            created: false,
          });
        }
      }
      logEvent('debug.accounts.provisioned', { created, updated });
      return c.json({ accounts: results }, 200);
    })
    .patch('/:id', async (c) => {
      const parsed = roleBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "role" string' }, 400);
      }
      const existing = await deps.store.getAccount(c.req.param('id'));
      if (existing === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      const updated = { ...existing, role: parsed.data.role };
      await deps.store.updateAccount(updated);
      logEvent('debug.accounts.role_set', { accountId: updated.id, role: updated.role });
      return c.json(serializeAccount(updated), 200);
    });
}
