import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AuthStore } from '@/lib/auth/store';
import { serializeContact, type ContactRow } from '@/lib/contact';
import type { ContactStore } from '@/lib/contact-store';
import { logEvent } from '@/lib/log';
import { normalizeForumText } from '@/lib/message';
import { bearerToken } from '@/routes/me';

/**
 * `/contact` — signed-in member private mailbox to 21.gifts. Posts when the
 * account has a display name. Shares the {@link AuthStore} with `/auth` and
 * `/me`. Never listed publicly.
 */

/** Collaborators the `/contact` routes need. */
export interface ContactRouteDeps {
  /** Contact persistence. */
  store: ContactStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: ContactRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

/** Body schema for posting a contact message. */
const textBody = z.object({ text: z.string() });

/**
 * Build the `/contact` route group.
 *
 * Mounted at `/contact` so the public path is `POST /contact`.
 *
 * @param deps - Contact store, auth store, and clock.
 * @returns A Hono app with `POST /` only.
 */
export function contactRoutes(deps: ContactRouteDeps): Hono {
  return new Hono().post('/', async (c) => {
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
    const row: ContactRow = {
      id: crypto.randomUUID(),
      accountId: account.id,
      name: account.name.trim(),
      text,
      createdAt: new Date(deps.now()),
    };
    try {
      const created = await deps.store.create(row);
      return c.json(serializeContact(created), 200);
    } catch {
      logEvent('contact.create.failed');
      return c.json({ error: 'Contact is unavailable' }, 503);
    }
  });
}
