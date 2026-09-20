import { Hono } from 'hono';
import { API_LOG_LIST_LIMIT, serializeDebugApiLog, type ApiLogStore } from '@/lib/api-log';
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
    try {
      const rows = await deps.store.listLatest(API_LOG_LIST_LIMIT);
      logEvent('debug.api_log.listed', { count: rows.length });
      return c.json({ logs: rows.map((row) => serializeDebugApiLog(row)) }, 200);
    } catch {
      logEvent('api_log.list.failed');
      return c.json({ error: 'Log is unavailable' }, 503);
    }
  });
}
