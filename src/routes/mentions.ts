import { Hono, type Context } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import type { Account, AuthStore } from '@/lib/auth/store';
import { mentionQueryPrefix } from '@/lib/mention-query';
import { bearerToken } from '@/routes/me';

/**
 * `/mentions` — signed-in `@` suggestions. `q` matches the start of the
 * username, a `.` `_` `-` segment, or the start of the display name or one
 * of its words — not only the whole username.
 */

/** Maximum accounts returned by `GET /mentions`. */
export const MENTION_SUGGEST_LIMIT = 20;

/** Collaborators the `/mentions` routes need. */
interface MentionsRouteDeps {
  /** Shared auth persistence port. */
  auth: AuthStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
}

/** Auth outcome. */
type MentionsLoad = { ok: true; account: Account } | { ok: false; response: Response };

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MentionsRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.auth, deps.now(), token);
}

/**
 * Require a signed-in caller with `forum.read`.
 *
 * @param deps - Auth store.
 * @param c - Request.
 * @returns The caller, or a 401/409 response.
 */
async function requireForumRead(deps: MentionsRouteDeps, c: Context): Promise<MentionsLoad> {
  const caller = await authedAccount(deps, c.req.header('authorization'));
  if (caller === null) {
    return { ok: false, response: c.json({ error: 'Unauthorized' }, 401) };
  }
  const gate = requireAction(caller, 'forum.read');
  if (!gate.ok) {
    return {
      ok: false,
      response: c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409),
    };
  }
  return { ok: true, account: caller };
}

/**
 * Build the `/mentions` route group.
 *
 * Mounted at `/mentions` so the public path is `GET /mentions`. Optional `q`
 * matches the start of the username, a `.` `_` `-` segment, or the start of
 * the display name or one of its words. Does not change how a sent post
 * stores `@username` marks.
 *
 * @param deps - Auth store and clock.
 * @returns A Hono app with mention GET.
 */
export function mentionsRoutes(deps: MentionsRouteDeps): Hono {
  return new Hono().get('/', async (c): Promise<Response> => {
    const auth = await requireForumRead(deps, c);
    if (!auth.ok) {
      return auth.response;
    }
    const prefix = mentionQueryPrefix(c.req.query('q'));
    if (prefix === null) {
      return c.json({ error: 'Invalid query' }, 400);
    }
    const accounts = await deps.auth.listAccountsByUsernamePrefix(prefix, MENTION_SUGGEST_LIMIT);
    return c.json({ accounts }, 200);
  });
}
