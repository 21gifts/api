import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AccountRole, AuthStore } from '@/lib/auth/store';
import {
  CONVERSATION_LIST_LIMIT,
  conversationFromMe,
  moderatorGroupDisplayName,
  serializeConversation,
  serializeConversationMessage,
  unsignedConversationDefaults,
  type ConversationThread,
  type PublicConversation,
} from '@/lib/conversation';
import type { ConversationStore } from '@/lib/conversation-store';
import { logEvent } from '@/lib/log';
import { MESSAGE_LIST_LIMIT, normalizeForumText, truncatePubkeyDisplay } from '@/lib/message';
import type { MessageStore } from '@/lib/message-store';
import type { SpendPing } from '@/lib/spend-ping';
import { bearerToken } from '@/routes/me';

/**
 * `/conversations` — signed-in private messaging (member↔member, member↔platform,
 * member↔Damus, closed moderator_group). Nothing public. DEBUG_TOKEN cannot
 * read member PNs.
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
  /** Optional spend ping after a new moderator-group message. */
  spendPing?: SpendPing;
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

function utcDayFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Whether this account has a live living-room top-level post (not the
 * profile note) whose `createdAt` falls on the UTC day of `nowMs`.
 *
 * @param messageStore - Forum store.
 * @param account - Caller.
 * @param nowMs - Clock.
 * @returns True when the newest non-profile top-level post is today UTC.
 */
async function hasLivingRoomPostOnUtcDay(
  messageStore: MessageStore,
  account: Account,
  nowMs: number,
): Promise<boolean> {
  const posts = await messageStore.listPostsByAccount(account.id, MESSAGE_LIST_LIMIT);
  const profileId = account.profileMessageId ?? null;
  const newest = posts.find((row) => row.id !== profileId);
  if (newest === undefined) {
    return false;
  }
  return utcDayFromMs(newest.createdAt.getTime()) === utcDayFromMs(nowMs);
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
  if (thread.kind === 'moderator_group') {
    return account.role === 'moderator';
  }
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
 * Counterpart 21.gifts account id for list/open JSON. Damus-only threads
 * omit it so a truncated npub is never paired with an account id.
 *
 * Same party selection as {@link counterpartName} `otherId`, except Damus
 * is always `null`. Staff who are not a party of a thread that includes
 * the platform see the other account (the member), not the platform.
 *
 * @param thread - Stored thread.
 * @param viewerId - Session account id.
 * @param platformId - Official platform account id, or `null`.
 */
function counterpartAccountId(
  thread: ConversationThread,
  viewerId: string,
  platformId: string | null,
): string | null {
  if (thread.kind === 'member_damus') {
    return null;
  }
  if (thread.accountA === viewerId) {
    return thread.accountB;
  }
  if (thread.accountB === viewerId) {
    return thread.accountA;
  }
  if (platformId !== null) {
    if (thread.accountA === platformId) {
      return thread.accountB;
    }
    if (thread.accountB === platformId) {
      return thread.accountA;
    }
  }
  return thread.accountA;
}

/**
 * Counterpart display name for member JSON. Damus-only names may be a
 * truncated npub; 21gifts members never expose npubs.
 *
 * @param thread - Stored thread.
 * @param viewerId - Session account id.
 * @param authStore - Account lookup.
 * @param platformId - Official platform account id, or `null`.
 */
async function counterpartName(
  thread: ConversationThread,
  viewerId: string,
  authStore: AuthStore,
  platformId: string | null,
): Promise<string> {
  const groupName = moderatorGroupDisplayName(thread.kind);
  if (groupName !== null) {
    return groupName;
  }
  if (thread.kind === 'member_damus' && thread.counterpartPubkey !== null) {
    return truncatePubkeyDisplay(thread.counterpartPubkey);
  }
  const otherId = counterpartAccountId(thread, viewerId, platformId);
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
  account: Account,
  authStore: AuthStore,
  platformId: string | null,
): Promise<PublicConversation> {
  return serializeConversation(
    {
      ...thread,
      name: await counterpartName(thread, account.id, authStore, platformId),
    },
    conversationFromMe({
      senderAccountId: thread.lastSenderAccountId,
      viewerId: account.id,
      staff: isStaffRole(account.role),
      platformId,
    }),
    counterpartAccountId(thread, account.id, platformId),
  );
}

/**
 * Build the `/conversations` route group.
 *
 * @param deps - Conversation store, auth store, forum store, clock, and
 *   optional spend ping.
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
        if (account.role === 'moderator' && platform !== undefined) {
          await deps.store.ensureModeratorGroup(platform.id, new Date(deps.now()));
        }
        const threads = await deps.store.listVisible(
          account.id,
          isStaffRole(account.role),
          platform?.id ?? null,
          CONVERSATION_LIST_LIMIT,
          account.role === 'moderator',
        );
        const conversations: PublicConversation[] = [];
        const staff = isStaffRole(account.role);
        const platformId = platform?.id ?? null;
        for (const thread of threads) {
          const inbound = await deps.store.hasInboundMessage(
            thread.id,
            account.id,
            staff,
            platformId,
          );
          const ownContactTicket =
            thread.kind === 'member_platform' &&
            thread.accountA === account.id &&
            thread.lastText !== '';
          if (!inbound && !ownContactTicket && thread.kind !== 'moderator_group') {
            continue;
          }
          conversations.push(await publicThread(thread, account, deps.authStore, platformId));
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
        const platform = await platformAccount(deps.authStore);
        return c.json(
          await publicThread(thread, account, deps.authStore, platform?.id ?? null),
          200,
        );
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
        const platformId = platform?.id ?? null;
        return c.json(
          {
            messages: rows.map((row) =>
              serializeConversationMessage(
                row,
                conversationFromMe({
                  senderAccountId: row.senderAccountId,
                  viewerId: account.id,
                  staff: isStaffRole(account.role),
                  platformId,
                }),
              ),
            ),
          },
          200,
        );
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
          thread.kind !== 'moderator_group' &&
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
          ...(thread.kind === 'moderator_group'
            ? {
                eventId: null,
                nostrPublishState: 'skipped' as const,
                nostrEvent: null,
                claimedUntil: null,
              }
            : unsignedConversationDefaults()),
        });
        if (thread.kind === 'moderator_group') {
          try {
            const address = account.lightningAddress?.trim() ?? '';
            if (address !== '' && deps.spendPing !== undefined) {
              const publicToday = await hasLivingRoomPostOnUtcDay(
                deps.messageStore,
                account,
                deps.now(),
              );
              if (publicToday) {
                try {
                  await deps.spendPing.ping(address, created.id, 'moderator');
                } catch {
                  /* persist must not fail */
                }
              } else {
                logEvent('spend.ping.skipped', { reason: 'no_public_post' });
              }
            }
          } catch {
            /* persist must not fail */
            logEvent('spend.ping.skipped', { reason: 'posted_unreachable' });
          }
        }
        return c.json(
          serializeConversationMessage(
            created,
            conversationFromMe({
              senderAccountId: created.senderAccountId,
              viewerId: account.id,
              staff: isStaffRole(account.role),
              platformId: platform?.id ?? null,
            }),
          ),
          200,
        );
      } catch {
        logEvent('conversations.reply.failed');
        return c.json({ error: 'Conversations are unavailable' }, 503);
      }
    });
}
