import { Hono } from 'hono';
import type { OperatorLogin } from '@/lib/operator-login';
import {
  DIAGNOSTIC_LIST_LIMIT,
  serializeDebugDiagnostic,
  type DiagnosticStore,
} from '@/lib/diagnostic-log';
import { requireOperator } from '@/lib/operator';
import { logEvent } from '@/lib/log';

/**
 * Operator debug surface. Read-only listing of diagnostic_event rows.
 * Authenticated by `DEBUG_TOKEN` or an operator key token (Bearer), not by an end-user session.
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
  /** SSH key login whose short-lived tokens this route accepts. */
  operatorLogin?: OperatorLogin | undefined;
}): Hono {
  return new Hono().get('/', requireOperator('read', deps), async (c) => {
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
