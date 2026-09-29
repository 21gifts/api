import { Hono } from 'hono';
import {
  DIAGNOSTIC_LIST_LIMIT,
  serializeDebugDiagnostic,
  type DiagnosticStore,
} from '@/lib/diagnostic-log';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';

/**
 * Operator debug surface. Read-only listing of diagnostic_event rows.
 * Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user session.
 */

/**
 * Build the `/debug/diagnostics` route group.
 *
 * @param deps - Diagnostic store and optional debug token.
 * @returns A Hono app exposing `GET /`.
 */
export function debugDiagnosticsRoutes(deps: {
  store: DiagnosticStore;
  debugToken: string | undefined;
}): Hono {
  return new Hono().get('/', async (c) => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
      const rows = await deps.store.listLatest(DIAGNOSTIC_LIST_LIMIT);
      logEvent('debug.diagnostics.listed', { count: rows.length });
      return c.json({ logs: rows.map((row) => serializeDebugDiagnostic(row)) }, 200);
    } catch {
      logEvent('diagnostic.list.failed');
      return c.json({ error: 'Log is unavailable' }, 503);
    }
  });
}
