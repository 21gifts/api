import { Hono } from 'hono';
import { classifyDebugDbBearer } from '@/lib/debug-token';
import { DebugDbCursorError, type DebugDbStore } from '@/lib/debug-db';
import { logEvent } from '@/lib/log';
import { resolveSession } from '@/lib/auth/service';
import type { AuthStore } from '@/lib/auth/store';
import { roleAtLeast } from '@/lib/auth/roles';

/**
 * Operator debug surface for the whole database.
 * Authenticated by `DEBUG_TOKEN` or `DEBUG_READ_TOKEN` (Bearer), not by an
 * end-user session. `DEBUG_READ_TOKEN` is GET and HEAD on this route, opens
 * `GET /debug/accounts/:id/wallet`, and otherwise opens only
 * `GET /funding/goal`, the operator reads on staff GET routes, and the
 * operator-only `GET /funding/daily-roster/links` and `GET /funding/withdrawals`
 * (`isOperatorBearer`).
 * `GET /` lists ordinary public tables or one keyset page. It does not
 * create or update rows.
 */

/** Collaborators the debug database routes need. */
export interface DebugDbRouteDeps {
  /** Catalog reader, or `undefined` when this process has no SQL client. */
  store: DebugDbStore | undefined;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Optional read-only bearer. `GET /debug/db` here; it also opens the operator staff reads. */
  debugReadToken?: string;
  /** Live member sessions used for software-developer wallet-table access. */
  authStore?: AuthStore;
  /** Session-expiry clock. */
  now?: () => number;
}

const MEMBER_WALLET_TABLES = new Set([
  'wallet_balance_snapshot',
  'wallet_payment',
  'wallet_transfer',
  'wallet_token_transaction',
]);

function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token === '' ? null : token;
}

/**
 * Build the `/debug/db` route group.
 *
 * Mounted at `/debug/db` so the path is `GET /debug/db`.
 * No `table` returns `{ tables }`. `table` returns one page and omits
 * `nextCursor` when there is no further page. `cursor` without `table` is 400.
 *
 * @param deps - Optional store, optional write token, optional read token.
 * @returns A Hono app exposing `GET /`.
 */
export function debugDbRoutes(deps: DebugDbRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const access = classifyDebugDbBearer(
      deps.debugToken,
      deps.debugReadToken,
      c.req.header('authorization'),
    );
    let memberAccess = false;
    if (access !== 'write' && access !== 'read') {
      const token = bearer(c.req.header('authorization'));
      if (token !== null && deps.authStore !== undefined) {
        const account = await resolveSession(deps.authStore, deps.now?.() ?? Date.now(), token);
        memberAccess = account !== null && roleAtLeast(account.role, 'software_developer');
        if (account !== null && !memberAccess) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      }
    }
    if (!memberAccess && access === 'unconfigured') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!memberAccess && access === 'unauthorized') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (memberAccess && c.req.method !== 'GET') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const table = c.req.query('table');
    const cursor = c.req.query('cursor');
    if (cursor !== undefined && (table === undefined || table === '')) {
      return c.json({ error: 'Invalid cursor' }, 400);
    }
    const store = deps.store;
    if (store === undefined) {
      return c.json({ error: 'Database is not configured' }, 503);
    }
    try {
      if (table === undefined || table === '') {
        const tables = (await store.listTables()).filter(
          (entry) => !memberAccess || MEMBER_WALLET_TABLES.has(entry.name),
        );
        logEvent('debug.db.listed', { count: tables.length });
        return c.json({ tables }, 200);
      }
      if (memberAccess && !MEMBER_WALLET_TABLES.has(table)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const page = await store.readPage(table, cursor ?? null);
      if (page === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      logEvent('debug.db.page', { table: page.table, count: page.rows.length });
      if (page.nextCursor === null) {
        return c.json({ table: page.table, columns: page.columns, rows: page.rows }, 200);
      }
      return c.json(page, 200);
    } catch (error) {
      if (error instanceof DebugDbCursorError) {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
      logEvent('debug.db.failed');
      return c.json({ error: 'Database is unavailable' }, 503);
    }
  });
}
