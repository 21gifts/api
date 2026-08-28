import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { logEvent } from '@/lib/log';
import {
  MESSAGE_LIST_LIMIT,
  normalizeForumText,
  serializeMessage,
  type MessageRow,
} from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { bearerToken } from '@/routes/me';

/**
 * `/messages` — signed-in member forum: list every message, post when the
 * account has a display name. Shares the {@link AuthStore} with `/auth` and
 * `/me`.
 */

/** Collaborators the `/messages` routes need. */
export interface MessagesRouteDeps {
  /** Forum persistence. */
  store: MessageStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: MessagesRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/** Body schema for posting a forum message. */
const textBody = z.object({ text: z.string() });

/**
 * Build the `/messages` route group.
 *
 * Mounted at `/messages` so the public paths are `GET /messages` and
 * `POST /messages`.
 *
 * @param deps - Message store, auth store, and clock.
 * @returns A Hono app with `GET /` and `POST /`.
 */
export function messagesRoutes(deps: MessagesRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const rows = await deps.store.listLatest(MESSAGE_LIST_LIMIT);
        return c.json({ messages: rows.map((row) => serializeMessage(row)) }, 200);
      } catch {
        logEvent('messages.list.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    })
    .post('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = textBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "text" string' }, 400);
      }
      if (account.name === null || account.name.trim() === '') {
        return c.json({ error: 'Set a name before posting' }, 400);
      }
      const text = normalizeForumText(parsed.data.text);
      if (text === null) {
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
      }
      const row: MessageRow = {
        id: crypto.randomUUID(),
        accountId: account.id,
        name: account.name.trim(),
        text,
        createdAt: new Date(deps.now()),
      };
      try {
        const created = await deps.store.create(row);
        return c.json(serializeMessage(created), 200);
      } catch {
        logEvent('messages.create.failed');
        return c.json({ error: 'Messages are unavailable' }, 503);
      }
    });
}
