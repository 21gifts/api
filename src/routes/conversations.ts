import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AccountRole, AuthStore } from '@/lib/auth/store';
import {
  CONVERSATION_LIST_LIMIT,
  serializeConversation,
  serializeConversationMessage,
  unsignedConversationDefaults,
  type ConversationThread,
  type PublicConversation,
} from '@/lib/conversation';
import type { ConversationStore } from '@/lib/conversation-store';
import { logEvent } from '@/lib/log';
import { normalizeForumText, truncatePubkeyDisplay } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import { bearerToken } from '@/routes/me';

/**
 * `/conversations` — signed-in private messaging (member↔member, member↔platform,
 * member↔Damus). Nothing public. DEBUG_TOKEN cannot read member PNs.
 */

/** Collaborators the `/conversations` routes need. */
export interface ConversationRouteDeps {
  /** Conversation persistence. */
  store: ConversationStore;
  /** Shared auth persistence port. */
  authStore: AuthStore;
  /** Forum store (author lookup for `POST /` from a note). */
  messageStore: MessageStore;
  /** Clock returning epoch milliseconds (injected for testability). */
  now: () => number;
}

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const textBody = z.object({ text: z.string() });
const forumMessageBody = z.object({ forumMessageId: z.string() });

/** Resolve the account behind a request's bearer session, or `null`. */
async function authedAccount(
  deps: ConversationRouteDeps,
  header: string | undefined,
): Promise<Account | null> {
  const token = bearerToken(header);
  if (token === null) {
    return null;
  }
  return resolveSession(deps.authStore, deps.now(), token);
}

function isStaffRole(role: AccountRole): boolean {
  return role === 'founder' || role === 'moderator';
}

async function platformAccount(store: AuthStore): Promise<Account | undefined> {
  const accounts = await store.listAccounts();
  return accounts.find((account) => account.isPlatform === true);
}

function canAccess(
  thread: ConversationThread,
  account: Account,
  platformId: string | null,
): boolean {
  if (thread.accountA === account.id || thread.accountB === account.id) {
    return true;
  }
  if (!isStaffRole(account.role)) {
    return false;
  }
  if (thread.kind === 'member_platform') {
    return true;
  }
  return platformId !== null && (thread.accountA === platformId || thread.accountB === platformId);
}

/**
 * Counterpart display name for member JSON. Damus-only names may be a
 * truncated npub; 21gifts members never expose npubs.
 *
 * @param thread - Stored thread.
 * @param viewerId - Session account id.
 * @param authStore - Account lookup.
 */
async function counterpartName(
  thread: ConversationThread,
  viewerId: string,
  authStore: AuthStore,
): Promise<string> {
  if (thread.kind === 'member_damus' && thread.counterpartPubkey !== null) {
    return truncatePubkeyDisplay(thread.counterpartPubkey);
  }
  const otherId =
    thread.accountA === viewerId
      ? thread.accountB
      : thread.accountB === viewerId
        ? thread.accountA
        : thread.kind === 'member_platform'
          ? thread.accountA
          : thread.accountB;
  if (otherId === null) {
    return thread.kind === 'member_platform' ? '21.gifts' : 'member';
  }
  const other = await authStore.getAccount(otherId);
  const name = other?.name?.trim() ?? '';
  if (name !== '') {
    return name;
  }
  if (other?.isPlatform === true) {
    return '21.gifts';
  }
  return 'member';
}

async function publicThread(
  thread: ConversationThread,
  viewerId: string,
  authStore: AuthStore,
): Promise<PublicConversation> {
  return serializeConversation({
    ...thread,
    name: await counterpartName(thread, viewerId, authStore),
  });
}

/**
 * Build the `/conversations` route group.
 *
 * @param deps - Conversation store, auth store, forum store, and clock.
 * @returns A Hono app with list/open/read/reply.
 */
export function conversationRoutes(deps: ConversationRouteDeps): Hono {
  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const platform = await platformAccount(deps.authStore);
        const threads = await deps.store.listVisible(
          account.id,
          isStaffRole(account.role),
          platform?.id ?? null,
          CONVERSATION_LIST_LIMIT,
        );
        const conversations: PublicConversation[] = [];
        for (const thread of threads) {
          conversations.push(await publicThread(thread, account.id, deps.authStore));
        }
        return c.json({ conversations }, 200);
      } catch {
        logEvent('conversations.list.failed');
        return c.json({ error: 'Conversations are unavailable' }, 503);
      }
    })
    .post('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const parsed = forumMessageBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "forumMessageId" string' }, 400);
      }
      if (!CONVERSATION_ID_RE.test(parsed.data.forumMessageId)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const note = await deps.messageStore.getById(parsed.data.forumMessageId);
        if (note === undefined) {
          return c.json({ error: 'Not found' }, 404);
        }
        const ourPubkey = await deps.authStore.getNostrPublicKey(account.id);
        if (
          note.accountId === account.id ||
          (ourPubkey !== undefined &&
            note.authorPubkey !== null &&
            note.authorPubkey.toLowerCase() === ourPubkey.toLowerCase())
        ) {
          return c.json({ error: 'Cannot message yourself' }, 400);
        }
        const now = new Date(deps.now());
        let thread: ConversationThread;
        if (note.accountId !== null) {
          const author = await deps.authStore.getAccount(note.accountId);
          if (author?.isPlatform === true) {
            thread = await deps.store.openMemberPlatform(account.id, author.id, now);
          } else {
            thread = await deps.store.openMemberMember(account.id, note.accountId, now);
          }
        } else if (note.authorPubkey !== null && note.authorPubkey !== '') {
          thread = await deps.store.openMemberDamus(account.id, note.authorPubkey, now);
        } else {
          return c.json({ error: 'Not found' }, 404);
        }
        return c.json(await publicThread(thread, account.id, deps.authStore), 200);
      } catch {
        logEvent('conversations.open.failed');
        return c.json({ error: 'Conversations are unavailable' }, 503);
      }
    })
    .get('/:id', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const id = c.req.param('id');
      if (!CONVERSATION_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      try {
        const thread = await deps.store.getById(id);
        const platform = await platformAccount(deps.authStore);
        if (thread === undefined || !canAccess(thread, account, platform?.id ?? null)) {
          return c.json({ error: 'Not found' }, 404);
        }
        const rows = await deps.store.listMessages(id, CONVERSATION_LIST_LIMIT);
        return c.json({ messages: rows.map(serializeConversationMessage) }, 200);
      } catch {
        logEvent('conversations.get.failed');
        return c.json({ error: 'Conversations are unavailable' }, 503);
      }
    })
    .post('/:id', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const id = c.req.param('id');
      if (!CONVERSATION_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const parsed = textBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json({ error: 'Expected a JSON body with a "text" string' }, 400);
      }
      const text = normalizeForumText(parsed.data.text);
      if (text === null || text === '') {
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
      }
      try {
        const thread = await deps.store.getById(id);
        const platform = await platformAccount(deps.authStore);
        if (thread === undefined || !canAccess(thread, account, platform?.id ?? null)) {
          return c.json({ error: 'Not found' }, 404);
        }
        const staffOnPlatform =
          isStaffRole(account.role) &&
          platform !== undefined &&
          account.id !== platform.id &&
          (thread.kind === 'member_platform' ||
            thread.accountA === platform.id ||
            thread.accountB === platform.id);
        const sender: Account = staffOnPlatform && platform !== undefined ? platform : account;
        const senderName = sender.name?.trim() ?? '';
        if (!staffOnPlatform && senderName === '') {
          return c.json({ error: 'Set a name before posting' }, 400);
        }
        const created = await deps.store.appendMessage({
          id: crypto.randomUUID(),
          conversationId: thread.id,
          text,
          createdAt: new Date(deps.now()),
          senderAccountId: sender.id,
          senderPubkey: (await deps.authStore.getNostrPublicKey(sender.id)) ?? null,
          name: senderName !== '' ? senderName : '21.gifts',
          ...unsignedConversationDefaults(),
        });
        return c.json(serializeConversationMessage(created), 200);
      } catch {
        logEvent('conversations.reply.failed');
        return c.json({ error: 'Conversations are unavailable' }, 503);
      }
    });
}
