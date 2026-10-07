import { Hono, type Context } from 'hono';
import type { AuthStore } from '@/lib/auth/store';
import { bearerMatchesDebugToken } from '@/lib/debug-token';
import { logEvent } from '@/lib/log';
import {
  readMemberEvents,
  readMemberWallet,
  readTeamAudit,
  type MemberDataResult,
} from '@/lib/member-data';
import type { MemberDataStore } from '@/lib/member-data-store';

/**
 * Operator debug surface. Read-only equivalents of the `/team` member-data
 * routes. Authenticated by `DEBUG_TOKEN` (Bearer), not by an end-user
 * session. These reads write no `team_access_audit` row: they are not a team
 * member's read, and the HTTP request log already records them.
 */

/** Collaborators the debug team routes need. */
export interface DebugTeamRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Member data and audit persistence. */
  memberDataStore: MemberDataStore;
  /** Configured operator token, or `undefined` when debug is disabled. */
  debugToken: string | undefined;
  /** Clock returning epoch milliseconds. */
  now: () => number;
}

/**
 * Build the `/debug/team` route group.
 *
 * Mounted at `/debug/team`: `GET /debug/team/members/:id/wallet`,
 * `GET /debug/team/members/:id/events`, and `GET /debug/team/audit`.
 *
 * @param deps - Auth store, member data store, optional debug token, and clock.
 * @returns A Hono app with the read-only operator routes.
 */
export function debugTeamRoutes(deps: DebugTeamRouteDeps): Hono {
  const gate = (c: Context): Response | null => {
    const token = deps.debugToken;
    if (token === undefined || token.trim() === '') {
      return c.json({ error: 'Debug is not configured' }, 503);
    }
    if (!bearerMatchesDebugToken(token, c.req.header('authorization'))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    return null;
  };
  const respond = (c: Context, result: MemberDataResult): Response =>
    c.json(result.body, result.status);
  const readDeps = (): { store: MemberDataStore; auth: AuthStore; nowMs: number } => ({
    store: deps.memberDataStore,
    auth: deps.authStore,
    nowMs: deps.now(),
  });

  return new Hono()
    .get('/members/:id/wallet', async (c) => {
      const denied = gate(c);
      if (denied !== null) {
        return denied;
      }
      try {
        return respond(
          c,
          await readMemberWallet(readDeps(), c.req.param('id'), {
            period: c.req.query('period'),
            category: c.req.query('category'),
            direction: c.req.query('direction'),
            cursor: c.req.query('cursor'),
          }),
        );
      } catch {
        logEvent('debug.team.wallet_failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    })
    .get('/members/:id/events', async (c) => {
      const denied = gate(c);
      if (denied !== null) {
        return denied;
      }
      try {
        return respond(
          c,
          await readMemberEvents(readDeps(), c.req.param('id'), c.req.query('cursor')),
        );
      } catch {
        logEvent('debug.team.events_failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    })
    .get('/audit', async (c) => {
      const denied = gate(c);
      if (denied !== null) {
        return denied;
      }
      try {
        return respond(c, await readTeamAudit(readDeps(), c.req.query('cursor')));
      } catch {
        logEvent('debug.team.audit_failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    });
}
