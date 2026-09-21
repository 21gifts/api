import { Hono } from 'hono';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { DebugDbCursorError, type DebugDbStore } from '@/lib/debug-db';
import { logEvent } from '@/lib/log';

/**
 * Operator debug surface for the whole database.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 * `GET /` lists ordinary public tables or one keyset page. It does not
 * create or update rows.
 */

/** Collaborators the debug database routes need. */
export interface DebugDbRouteDeps {
  /** Catalog reader, or `undefined` when this process has no SQL client. */
  store: DebugDbStore | undefined;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

/**
 * Build the `/debug/db` route group.
 *
 * Mounted at `/debug/db` so the path is `GET /debug/db`.
 * No `table` returns `{ tables }`. `table` returns one page and omits
 * `nextCursor` when there is no further page. `cursor` without `table` is 400.
 *
 * @param deps - Optional store and optional debug token.
 * @returns A Hono app exposing `GET /`.
 */
export function debugDbRoutes(deps: DebugDbRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
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
        const tables = await store.listTables();
        logEvent('debug.db.listed', { count: tables.length });
        return c.json({ tables }, 200);
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
