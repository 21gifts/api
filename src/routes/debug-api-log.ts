import { Hono } from 'hono';
import {
  API_LOG_LIST_LIMIT,
  serializeDebugApiLog,
  type ApiLogPageQuery,
  type ApiLogStore,
} from '@/lib/api-log';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';

/**
 * Operator debug surface. Read-only listing of HTTP audit rows.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/** Collaborators the debug api-log routes need. */
export interface DebugApiLogRouteDeps {
  /** Audit persistence port. */
  store: ApiLogStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the `/debug/api-log` route group.
 *
 * @param deps - Audit store and optional debug token.
 * @returns A Hono app exposing `GET /`.
 */
export function debugApiLogRoutes(deps: DebugApiLogRouteDeps): Hono {
  return new Hono().get('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const query: ApiLogPageQuery = {};
    const accountIdRaw = c.req.query('accountId');
    if (accountIdRaw !== undefined) {
      const accountId = accountIdRaw.trim();
      if (!UUID_RE.test(accountId)) {
        return c.json({ error: 'Invalid account' }, 400);
      }
      query.accountId = accountId.toLowerCase();
    }
    const beforeRaw = c.req.query('before');
    const beforeIdRaw = c.req.query('beforeId');
    if ((beforeRaw === undefined) !== (beforeIdRaw === undefined)) {
      return c.json({ error: 'Invalid cursor' }, 400);
    }
    if (beforeRaw !== undefined && beforeIdRaw !== undefined) {
      const parsed = Date.parse(beforeRaw);
      if (!Number.isFinite(parsed) || !UUID_RE.test(beforeIdRaw)) {
        return c.json({ error: 'Invalid cursor' }, 400);
      }
      query.before = { createdAt: new Date(parsed), id: beforeIdRaw.toLowerCase() };
    }
    try {
      const rows = await deps.store.listPage(API_LOG_LIST_LIMIT + 1, query);
      const hasMore = rows.length > API_LOG_LIST_LIMIT;
      const page = rows.slice(0, API_LOG_LIST_LIMIT);
      logEvent('debug.api_log.listed', { count: page.length });
      return c.json({ logs: page.map((row) => serializeDebugApiLog(row)), hasMore }, 200);
    } catch {
      logEvent('api_log.list.failed');
      return c.json({ error: 'Log is unavailable' }, 503);
    }
  });
}
