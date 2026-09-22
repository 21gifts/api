import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import { serializeTrustEdge } from '@/lib/trust';
import type { TrustStore } from '@/lib/trust-store';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * Operator backfill and delete of stored trust edges. Authenticated by
 * `DEBUG_TOKEN` (Bearer), not by an end-user session. Does not change
 * `account.role`.
 */

/** Collaborators the debug trust-edge route needs. */
export interface DebugTrustRouteDeps {
  /** Shared auth persistence port. */
  store: AuthStore;
  /** Trust-edge persistence port. */
  trustStore: TrustStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Clock returning epoch milliseconds (injected for testability). */
  now?: () => number;
}

/** Body schema for operator trust-edge backfill. */
const insertBody = z.object({
  subjectId: z.string(),
  actorId: z.string(),
  kind: z.enum(['verify', 'moderator_propose', 'moderator_confirm', 'moderator_appoint']),
});

/** Shared 503/401 gate for `/debug/trust-edges`. */
function requireDebugToken(deps: DebugTrustRouteDeps): MiddlewareHandler {
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

/** Body schema for operator trust-edge delete. */
const deleteBody = z.object({
  subjectId: z.string(),
  kind: z.enum(['verify', 'moderator_propose', 'moderator_confirm', 'moderator_appoint']),
});

/**
 * Build the `/debug/trust-edges` route group.
 *
 * @param deps - Auth store, trust store, optional debug token, optional `now`.
 * @returns A Hono app exposing `GET /`, `POST /`, and `DELETE /`.
 */
export function debugTrustRoutes(deps: DebugTrustRouteDeps): Hono {
  const now = deps.now ?? Date.now;
  return new Hono()
    .use('*', requireDebugToken(deps))
    .get('/', async (c) => {
      try {
        const edges = [...(await deps.trustStore.listEdges())].sort(
          (a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
        );
        return c.json({ edges: edges.map(serializeTrustEdge) }, 200);
      } catch {
        logEvent('debug.trust_edges.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
    })
    .post('/', async (c) => {
      const parsed = insertBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'Expected a JSON body with "subjectId", "actorId", and "kind" strings' },
          400,
        );
      }
      const { subjectId, actorId, kind } = parsed.data;
      if (!MESSAGE_ID_RE.test(subjectId) || !MESSAGE_ID_RE.test(actorId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const subject = await deps.store.getAccount(subjectId);
        const actor = await deps.store.getAccount(actorId);
        if (subject === undefined || actor === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        if (subjectId === actorId) {
          return c.json({ error: 'Conflict' }, 409);
        }
        const stored = await deps.trustStore.insertEdge({
          id: crypto.randomUUID(),
          subjectId,
          actorId,
          kind,
          createdAt: now(),
        });
        logEvent('debug.trust_edges.inserted', { subjectId, actorId, kind });
        return c.json(serializeTrustEdge(stored), 200);
      } catch (error) {
        if (error instanceof Error && error.message === 'duplicate trust edge') {
          return c.json({ error: 'Conflict' }, 409);
        }
        logEvent('debug.trust_edges.failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
    })
    .delete('/', async (c) => {
      const parsed = deleteBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with "subjectId" and "kind" strings' }, 400);
      }
      const { subjectId, kind } = parsed.data;
      if (!MESSAGE_ID_RE.test(subjectId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const removed = await deps.trustStore.deleteEdge(subjectId, kind);
        if (removed === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        logEvent('debug.trust_edges.deleted', { subjectId, kind });
        return c.json(serializeTrustEdge(removed), 200);
      } catch {
        logEvent('debug.trust_edges.delete_failed');
        return c.json({ error: 'Trust chain is unavailable' }, 503);
      }
    });
}
