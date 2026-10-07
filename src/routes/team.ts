import { Hono, type Context } from 'hono';
import { canReadTeamAudit, roleAtLeast } from '@/lib/auth/roles';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import {
  readMemberEvents,
  readMemberWallet,
  readTeamAudit,
  type MemberDataResult,
} from '@/lib/member-data';
import type { MemberDataStore, TeamAccessWhat } from '@/lib/member-data-store';
import { mentionQueryPrefix } from '@/lib/mention-query';
import { bearerToken } from '@/routes/me';
import { MENTION_SUGGEST_LIMIT } from '@/routes/mentions';

/**
 * `/team` — the team's view of a member's reported wallet data and
 * interaction events, for a moderator session or above. Every read of a
 * member's wallet data or events first writes a `team_access_audit` row;
 * initiator and founder can list that log.
 */

/** Collaborators the `/team` routes need. */
export interface TeamRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Member data and audit persistence. */
  memberDataStore: MemberDataStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
}

/** Auth outcome. */
type TeamLoad = { ok: true; account: Account } | { ok: false; response: Response };

/**
 * Require a session whose live role passes `allowed`.
 *
 * @param deps - Auth store and clock.
 * @param c - Request.
 * @param allowed - Role check.
 * @returns The caller, or a 401/403 response.
 */
async function requireTeam(
  deps: TeamRouteDeps,
  c: Context,
  allowed: (account: Account) => boolean,
): Promise<TeamLoad> {
  const token = bearerToken(c.req.header('authorization'));
  const caller = token === null ? null : await resolveSession(deps.authStore, deps.now(), token);
  if (caller === null) {
    return { ok: false, response: c.json({ error: 'Unauthorized' }, 401) };
  }
  if (!allowed(caller)) {
    return { ok: false, response: c.json({ error: 'Forbidden' }, 403) };
  }
  return { ok: true, account: caller };
}

/** Moderator or above. */
function isTeam(account: Account): boolean {
  return roleAtLeast(account.role, 'moderator');
}

/**
 * Build the `/team` route group.
 *
 * Mounted at `/team`: `GET /team/members?query=`, `GET /team/members/:id/wallet`,
 * `GET /team/members/:id/events`, and `GET /team/audit`.
 *
 * @param deps - Auth store, member data store, and clock.
 * @returns A Hono app with the team member-data routes.
 */
export function teamRoutes(deps: TeamRouteDeps): Hono {
  const audited =
    (viewer: Account, memberId: string, what: TeamAccessWhat) => async (): Promise<void> => {
      await deps.memberDataStore.appendAccess({
        id: crypto.randomUUID(),
        viewerAccountId: viewer.id,
        memberAccountId: memberId.toLowerCase(),
        what,
        at: new Date(deps.now()),
      });
    };
  const respond = (c: Context, result: MemberDataResult): Response =>
    c.json(result.body, result.status);

  return new Hono()
    .get('/members', async (c) => {
      const auth = await requireTeam(deps, c, isTeam);
      if (!auth.ok) {
        return auth.response;
      }
      const prefix = mentionQueryPrefix(c.req.query('query'));
      if (prefix === null) {
        return c.json({ error: 'Invalid query' }, 400);
      }
      try {
        const matches = await deps.authStore.listAccountsByUsernamePrefix(
          prefix,
          MENTION_SUGGEST_LIMIT,
        );
        const members = [];
        for (const match of matches) {
          const account = await deps.authStore.getAccount(match.id);
          members.push({ ...match, role: account?.role ?? null });
        }
        return c.json({ members }, 200);
      } catch {
        logEvent('team.members.search_failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    })
    .get('/members/:id/wallet', async (c) => {
      const auth = await requireTeam(deps, c, isTeam);
      if (!auth.ok) {
        return auth.response;
      }
      const memberId = c.req.param('id');
      try {
        const result = await readMemberWallet(
          {
            store: deps.memberDataStore,
            auth: deps.authStore,
            nowMs: deps.now(),
            beforeRead: audited(auth.account, memberId, 'wallet'),
          },
          memberId,
          {
            period: c.req.query('period'),
            category: c.req.query('category'),
            direction: c.req.query('direction'),
            cursor: c.req.query('cursor'),
          },
        );
        if (result.status === 200) {
          logEvent('team.member_wallet.read');
        }
        return respond(c, result);
      } catch {
        logEvent('team.member_wallet.failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    })
    .get('/members/:id/events', async (c) => {
      const auth = await requireTeam(deps, c, isTeam);
      if (!auth.ok) {
        return auth.response;
      }
      const memberId = c.req.param('id');
      try {
        const result = await readMemberEvents(
          {
            store: deps.memberDataStore,
            auth: deps.authStore,
            nowMs: deps.now(),
            beforeRead: audited(auth.account, memberId, 'events'),
          },
          memberId,
          c.req.query('cursor'),
        );
        if (result.status === 200) {
          logEvent('team.member_events.read');
        }
        return respond(c, result);
      } catch {
        logEvent('team.member_events.failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    })
    .get('/audit', async (c) => {
      const auth = await requireTeam(deps, c, (account) => canReadTeamAudit(account.role));
      if (!auth.ok) {
        return auth.response;
      }
      try {
        return respond(
          c,
          await readTeamAudit(
            { store: deps.memberDataStore, auth: deps.authStore },
            c.req.query('cursor'),
          ),
        );
      } catch {
        logEvent('team.audit.failed');
        return c.json({ error: 'Member data is unavailable' }, 503);
      }
    });
}
