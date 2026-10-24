import { Hono, type Context } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import type { Account, AuthStore } from '@/lib/auth/store';
import { normalizeUsername } from '@/lib/username';
import { bearerToken } from '@/routes/me';

/**
 * `/accounts` — exact username lookup. One stored handle, not a prefix list.
 */

/** Collaborators the `/accounts` routes need. */
interface AccountsRouteDeps {
  /** Shared auth persistence port. */
  auth: AuthStore;
  /** Clock returning epoch milliseconds. */
  now: () => number;
}

/** Auth outcome. */
type AccountsLoad = { ok: true; account: Account } | { ok: false; response: Response };

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: AccountsRouteDeps,
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
async function requireForumRead(deps: AccountsRouteDeps, c: Context): Promise<AccountsLoad> {
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
 * Build the `/accounts` route group.
 *
 * Mounted at `/accounts` so the public path is
 * `GET /accounts/by-username/:username`. The param is an exact handle
 * ({@link normalizeUsername}). The body is exactly `{ id, username, name }`:
 * `username` is the stored string and `name` is the stored display name,
 * including `null`. A blank stored username is 404. Does not suggest prefixes.
 *
 * @param deps - Auth store and clock.
 * @returns A Hono app with the exact-username GET.
 */
export function accountsByUsernameRoutes(deps: AccountsRouteDeps): Hono {
  return new Hono().get('/by-username/:username', async (c): Promise<Response> => {
    const auth = await requireForumRead(deps, c);
    if (!auth.ok) {
      return auth.response;
    }
    const username = normalizeUsername(c.req.param('username'));
    if (username === null) {
      return c.json({ error: 'Username is not valid' }, 400);
    }
    const found = await deps.auth.getAccountByUsername(username);
    if (found === undefined) {
      return c.json({ error: 'No account with that username' }, 404);
    }
    const storedUsername = found.username;
    if (typeof storedUsername !== 'string' || storedUsername.trim() === '') {
      return c.json({ error: 'No account with that username' }, 404);
    }
    return c.json({ id: found.id, username: storedUsername, name: found.name }, 200);
  });
}
