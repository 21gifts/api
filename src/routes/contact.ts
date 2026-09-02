import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import { MISSING_REQUIREMENTS_ERROR, requireAction } from '@/lib/auth/requirements';
import type { Account, AuthStore } from '@/lib/auth/store';
import { serializeContact, type ContactRow } from '@/lib/contact';
import type { ContactStore } from '@/lib/contact-store';
import { unsignedConversationDefaults } from '@/lib/conversation';
import type { ConversationStore } from '@/lib/conversation-store';
import { logEvent } from '@/lib/log';
import { normalizeForumText } from '@/lib/message';
import { bearerToken } from '@/routes/me';

/**
 * `/contact` — signed-in member private mailbox to 21.gifts. Requires rules
 * agreement and a display name (`requireAction` `contact.post`). Shares the
 * {@link AuthStore} with `/auth` and `/me`. Never listed publicly.
 */

/** Collaborators the `/contact` routes need. */
export interface ContactRouteDeps {
  /** Contact persistence. */
  store: ContactStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Private messaging store (member→platform thread). */
  conversationStore: ConversationStore;
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
 * @param deps - Contact store, conversation store, auth store, and clock.
 * @returns A Hono app with `POST /` only.
 */
export function contactRoutes(deps: ContactRouteDeps): Hono {
  return new Hono().post('/', async (c) => {
    const account = await authedAccount(deps, c.req.header('authorization'));
    if (account === null) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const gate = requireAction(account, 'contact.post');
    if (!gate.ok) {
      return c.json({ error: MISSING_REQUIREMENTS_ERROR, missing: gate.missing }, 409);
    }
    /* v8 ignore next -- requireAction already rejected a missing name */
    const authorName = (account.name ?? '').trim();
    const parsed = textBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: 'Expected a JSON body with a "text" string' }, 400);
    }
    const text = normalizeForumText(parsed.data.text);
    // Forum photo-only posts may be empty; contact has no photo and still
    // requires 1–500 characters.
    if (text === null || text === '') {
      return c.json({ error: 'Text must be 1–500 characters' }, 400);
    }
    const createdAt = new Date(deps.now());
    const row: ContactRow = {
      id: crypto.randomUUID(),
      accountId: account.id,
      name: authorName,
      text,
      createdAt,
    };
    let platform: Account | undefined;
    try {
      const accounts = await deps.authStore.listAccounts();
      platform = accounts.find((item) => item.isPlatform === true);
    } catch {
      logEvent('contact.create.failed');
      return c.json({ error: 'Contact is unavailable' }, 503);
    }
    if (platform === undefined) {
      return c.json({ error: 'Platform account is not configured' }, 503);
    }
    let created: ContactRow;
    try {
      created = await deps.store.create(row);
    } catch {
      logEvent('contact.create.failed');
      return c.json({ error: 'Contact is unavailable' }, 503);
    }
    try {
      const thread = await deps.conversationStore.openMemberPlatform(
        account.id,
        platform.id,
        createdAt,
      );
      await deps.conversationStore.appendMessage({
        id: crypto.randomUUID(),
        conversationId: thread.id,
        text,
        createdAt,
        senderAccountId: account.id,
        senderPubkey: (await deps.authStore.getNostrPublicKey(account.id)) ?? null,
        name: row.name,
        ...unsignedConversationDefaults(),
      });
    } catch {
      logEvent('conversations.contact_sync.failed');
    }
    return c.json(serializeContact(created), 200);
  });
}
