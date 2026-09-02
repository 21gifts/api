import { Hono } from 'hono';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import { serializeMessage } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { bearerToken } from '@/routes/me';
import { MESSAGE_ID_RE } from '@/routes/messages';

/**
 * `/members` — signed-in member profile cards (live identity + profile note).
 */

/** Collaborators the `/members` routes need. */
export interface MembersRouteDeps {
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Forum persistence (profile notes). */
  messageStore: MessageStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MembersRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/**
 * Build the `/members` route group.
 *
 * Mounted at `/members` so the public path is `GET /members/:accountId`.
 *
 * @param deps - Auth store, message store, and clock.
 * @returns A Hono app with `GET /:accountId`.
 */
export function membersRoutes(deps: MembersRouteDeps): Hono {
  return new Hono().get('/:accountId', async (c) => {
    const caller = await authedAccount(deps, c.req.header('authorization'));
    if (caller === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const gate = requireAction(caller, 'forum.read');
    if (!gate.ok) {
      return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
    }
    const accountId = c.req.param('accountId');
    if (!MESSAGE_ID_RE.test(accountId)) {
      return c.json({ error: 'Not found' }, 404);
    }
    try {
      const account = await deps.authStore.getAccount(accountId);
      if (account === undefined) {
        return c.json({ error: 'Not found' }, 404);
      }
      let profileMessage: ReturnType<typeof serializeMessage> | null = null;
      const profileId = account.profileMessageId;
      if (typeof profileId === 'string' && profileId.trim() !== '') {
        const row = await deps.messageStore.getById(profileId);
        if (row !== undefined) {
          const payable =
            row.eventId !== null &&
            account.lightningAddress !== null &&
            account.lightningAddress.trim() !== '';
          const children = await deps.messageStore.listReplies(row.id, 200);
          profileMessage = serializeMessage(row, payable, account.role, children.length, true);
        }
      }
      return c.json(
        {
          id: account.id,
          name: account.name,
          role: account.role,
          lightningAddress: account.lightningAddress,
          createdAt: new Date(account.createdAt).toISOString(),
          profileMessage,
        },
        200,
      );
    } catch {
      logEvent('members.get.failed');
      return c.json({ error: 'Messages are unavailable' }, 503);
    }
  });
}
