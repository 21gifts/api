import { Hono } from 'hono';
import { z } from 'zod';
import { resolveSession } from '@/lib/auth/service';
import type { Account, AccountRole, AuthStore } from '@/lib/auth/store';
import { inspectBolt11, isNip57Invoice } from '@/lib/bolt11';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
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
import type { FetchFn } from '@/lib/lnurlp';
import { requestZapInvoice } from '@/lib/lnurl-pay';
import { MESSAGE_LIST_LIMIT, normalizeForumText, truncatePubkeyDisplay } from '@/lib/message';
import type {
  MessageInvoiceAttempt,
  MessageInvoiceResult,
  MessageStore,
} from '@/lib/message-store';
import { ensureAccountNostrKey } from '@/lib/nostr/keys';
import { InvoiceRateLimiter } from '@/lib/nostr/rate-limit';
import { resolveZapRelays } from '@/lib/nostr/relays';
import { signEventForAccount } from '@/lib/nostr/sign';
import { buildZapRequest } from '@/lib/nostr/zap-request';
import type { SpendPing } from '@/lib/spend-ping';
import { bearerToken } from '@/routes/me';
import { WAIT_SATS_POLL_MS, WAIT_SATS_TIMEOUT_MS } from '@/routes/messages';

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
  /** LNURL fetch (invoice path). */
  fetchImpl?: FetchFn;
  /** Optional AES KEK; without it invoice signing is 503. */
  nostrKek?: Uint8Array;
  /** Invoice limiter (tests inject). */
  invoiceLimiter?: InvoiceRateLimiter;
  /** Sleep between `sinceMessageId` polls (tests inject). */
  waitSleep?: (ms: number) => Promise<void>;
  /** Max wait for `sinceMessageId` (tests inject). */
  waitTimeoutMs?: number;
  /** Poll interval for `sinceMessageId` (tests inject). */
  waitPollMs?: number;
}

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const textBody = z.object({ text: z.string() });
const forumMessageBody = z.object({ forumMessageId: z.string() });
const invoiceBody = z.object({ sats: z.number().int().positive(), text: z.string().optional() });
const defaultInvoiceLimiter = new InvoiceRateLimiter();
const UNKNOWN_ACCOUNT_ID = '00000000-0000-0000-0000-000000000000';
const AUTHOR_WALLET_CANNOT_RECEIVE = "The author's wallet cannot receive this Bitcoin payment";

/** Default sleep between `sinceMessageId` polls. */
/* v8 ignore next 6 -- tests inject waitSleep */
async function defaultWaitSatsSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Persist an invoice attempt without changing the HTTP response on failure. */
async function persistInvoiceAttempt(
  store: MessageStore,
  row: MessageInvoiceAttempt,
): Promise<void> {
  try {
    await store.recordInvoiceAttempt(row);
  } catch {
    logEvent('conversations.invoice.record_failed');
  }
}

/** Build a private-conversation invoice-attempt row. */
function invoiceAttemptBase(args: {
  now: number;
  messageId: string;
  payerAccountId: string;
  authorAccountId: string;
  amountSats: number;
  lightningAddress: string | null;
  zapRequest: Record<string, unknown> | null;
  result: MessageInvoiceResult;
  httpStatus: number;
  pr: string | null;
  paymentHash: string | null;
  description: string | null;
  descriptionHash: string | null;
  isNip57Invoice: boolean;
  conversationId: string | null;
  conversationMessageId: string | null;
  lnurlResponse?: Record<string, unknown> | null;
}): MessageInvoiceAttempt {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date(args.now),
    messageId: args.messageId,
    payerAccountId: args.payerAccountId,
    authorAccountId: args.authorAccountId,
    amountSats: args.amountSats,
    lightningAddress: args.lightningAddress,
    zapRequest: args.zapRequest,
    result: args.result,
    httpStatus: args.httpStatus,
    pr: args.pr,
    paymentHash: args.paymentHash,
    description: args.description,
    descriptionHash: args.descriptionHash,
    isNip57Invoice: args.isNip57Invoice,
    lnurlResponse: args.lnurlResponse ?? null,
    conversationId: args.conversationId,
    conversationMessageId: args.conversationMessageId,
  };
}

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

/** Resolve the account receiving a member/member or member/platform gift. */
async function giftCounterpart(
  thread: ConversationThread,
  viewer: Account,
  platform: Account | undefined,
  authStore: AuthStore,
): Promise<Account | undefined> {
  let counterpartId: string | null;
  if (thread.accountA === viewer.id) {
    counterpartId = thread.accountB;
  } else if (thread.accountB === viewer.id) {
    counterpartId = thread.accountA;
  } else if (
    isStaffRole(viewer.role) &&
    platform !== undefined &&
    (thread.accountA === platform.id || thread.accountB === platform.id)
  ) {
    counterpartId = thread.accountA === platform.id ? thread.accountB : thread.accountA;
  } else if (thread.kind === 'member_platform' && isStaffRole(viewer.role)) {
    counterpartId = thread.accountA;
    /* v8 ignore start -- canAccess already rejected non-parties */
  } else {
    counterpartId = null;
  }
  if (counterpartId === null) {
    return undefined;
  }
  /* v8 ignore stop */
  return authStore.getAccount(counterpartId);
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
 * @param deps - Stores, clock, optional spend ping, invoice collaborators, and wait injects.
 * @returns A Hono app with list/open/read/reply/invoice routes.
 */
export function conversationRoutes(deps: ConversationRouteDeps): Hono {
  const invoiceLimiter = deps.invoiceLimiter ?? defaultInvoiceLimiter;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  return new Hono()
    .get('/', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      try {
        const platform = await platformAccount(deps.authStore);
        let threads = await deps.store.listVisible(
          account.id,
          isStaffRole(account.role),
          platform?.id ?? null,
          CONVERSATION_LIST_LIMIT,
          account.role === 'moderator',
        );
        if (account.role === 'moderator' && platform !== undefined) {
          const group = await deps.store.ensureModeratorGroup(platform.id, new Date(deps.now()));
          threads = [group, ...threads.filter((thread) => thread.id !== group.id)].slice(
            0,
            CONVERSATION_LIST_LIMIT,
          );
        }
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
      const sinceMessageId = c.req.query('sinceMessageId');
      if (sinceMessageId !== undefined && !CONVERSATION_ID_RE.test(sinceMessageId)) {
        return c.json({ error: 'Expected sinceMessageId to be a UUID' }, 400);
      }
      try {
        const thread = await deps.store.getById(id);
        const platform = await platformAccount(deps.authStore);
        if (thread === undefined || !canAccess(thread, account, platform?.id ?? null)) {
          return c.json({ error: 'Not found' }, 404);
        }
        const started = deps.now();
        const timeoutMs = deps.waitTimeoutMs ?? WAIT_SATS_TIMEOUT_MS;
        const pollMs = deps.waitPollMs ?? WAIT_SATS_POLL_MS;
        const sleep = deps.waitSleep ?? defaultWaitSatsSleep;
        let rows = await deps.store.listMessages(id, CONVERSATION_LIST_LIMIT);
        while (
          sinceMessageId !== undefined &&
          !rows.some((row) => row.id === sinceMessageId) &&
          deps.now() - started < timeoutMs
        ) {
          await sleep(pollMs);
          rows = await deps.store.listMessages(id, CONVERSATION_LIST_LIMIT);
        }
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
    })
    .post('/:id/invoice', async (c) => {
      const account = await authedAccount(deps, c.req.header('authorization'));
      if (account === null) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      const id = c.req.param('id');
      if (!CONVERSATION_ID_RE.test(id)) {
        return c.json({ error: 'Not found' }, 404);
      }
      const parsed = invoiceBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        await persistInvoiceAttempt(
          deps.messageStore,
          invoiceAttemptBase({
            now: deps.now(),
            messageId: UNKNOWN_ACCOUNT_ID,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: 0,
            lightningAddress: null,
            zapRequest: null,
            result: 'bad_body',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationId: null,
            conversationMessageId: null,
          }),
        );
        return c.json({ error: 'Expected a JSON body with a positive "sats" integer' }, 400);
      }
      const amountMsat = parsed.data.sats * 1000;
      const invoiceText = normalizeForumText(parsed.data.text ?? '');
      if (invoiceText === null) {
        await persistInvoiceAttempt(
          deps.messageStore,
          invoiceAttemptBase({
            now: deps.now(),
            messageId: UNKNOWN_ACCOUNT_ID,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: parsed.data.sats,
            lightningAddress: null,
            zapRequest: null,
            result: 'bad_body',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationId: id,
            conversationMessageId: null,
          }),
        );
        return c.json({ error: 'Text must be 1–500 characters' }, 400);
      }
      if (amountMsat > GIFT_INVOICE_MAX_MSAT) {
        await persistInvoiceAttempt(
          deps.messageStore,
          invoiceAttemptBase({
            now: deps.now(),
            messageId: UNKNOWN_ACCOUNT_ID,
            payerAccountId: account.id,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: parsed.data.sats,
            lightningAddress: null,
            zapRequest: null,
            result: 'bad_body',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationId: id,
            conversationMessageId: null,
          }),
        );
        return c.json({ error: 'Expected a JSON body with a positive "sats" integer' }, 400);
      }
      try {
        const thread = await deps.store.getById(id);
        const platform = await platformAccount(deps.authStore);
        if (thread === undefined || !canAccess(thread, account, platform?.id ?? null)) {
          return c.json({ error: 'Not found' }, 404);
        }
        const persist = (
          extra: Omit<
            Parameters<typeof invoiceAttemptBase>[0],
            'now' | 'payerAccountId' | 'conversationId'
          >,
        ): Promise<void> =>
          persistInvoiceAttempt(
            deps.messageStore,
            invoiceAttemptBase({
              now: deps.now(),
              payerAccountId: account.id,
              conversationId: thread.id,
              ...extra,
            }),
          );
        if (thread.kind === 'member_damus') {
          await persist({
            messageId: UNKNOWN_ACCOUNT_ID,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: parsed.data.sats,
            lightningAddress: null,
            zapRequest: null,
            result: 'no_author',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        const counterpart = await giftCounterpart(thread, account, platform, deps.authStore);
        if (counterpart === undefined) {
          await persist({
            messageId: UNKNOWN_ACCOUNT_ID,
            authorAccountId: UNKNOWN_ACCOUNT_ID,
            amountSats: parsed.data.sats,
            lightningAddress: null,
            zapRequest: null,
            result: 'no_author',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        if (counterpart.id === account.id) {
          return c.json({ error: 'Cannot message yourself' }, 400);
        }
        const senderName = account.name?.trim() ?? '';
        if (senderName === '') {
          return c.json({ error: 'Set a name before posting' }, 400);
        }
        const address = counterpart.lightningAddress;
        const profileId = counterpart.profileMessageId ?? null;
        if (address === null || address.trim() === '' || profileId === null) {
          await persist({
            messageId: profileId ?? UNKNOWN_ACCOUNT_ID,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest: null,
            result: 'no_author',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        const profile = await deps.messageStore.getById(profileId);
        if (profile === undefined || profile.eventId === null || profile.eventId === '') {
          await persist({
            messageId: profileId,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest: null,
            result: 'no_event',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        const recipientPubkey = await deps.authStore.getNostrPublicKey(counterpart.id);
        if (recipientPubkey === undefined) {
          await persist({
            messageId: profile.id,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest: null,
            result: 'no_key',
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        const kek = deps.nostrKek;
        if (kek === undefined) {
          await persist({
            messageId: profile.id,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest: null,
            result: 'no_key',
            httpStatus: 503,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
        if (!invoiceLimiter.allow(account.id, deps.now())) {
          c.header('Retry-After', '10');
          await persist({
            messageId: profile.id,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest: null,
            result: 'rate_limited',
            httpStatus: 429,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId: null,
          });
          return c.json({ error: 'Too many payments' }, 429);
        }
        const conversationMessageId = crypto.randomUUID();
        const relays = resolveZapRelays(process.env);
        const unsigned = buildZapRequest({
          recipientPubkey,
          eventId: profile.eventId,
          amountMsat,
          relays,
          content: invoiceText,
        });
        let signed;
        try {
          await ensureAccountNostrKey(deps.authStore, account.id, kek);
          signed = await signEventForAccount(deps.authStore, account.id, kek, unsigned);
        } catch {
          logEvent('nostr.sign.failed', { conversationId: thread.id });
          await persist({
            messageId: profile.id,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest: null,
            result: 'sign_failed',
            httpStatus: 503,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId,
          });
          return c.json({ error: 'Messages are unavailable' }, 503);
        }
        const zapRequestJson = JSON.stringify(signed);
        /* v8 ignore next 4 -- signEventForAccount returns an event object */
        const zapRequest =
          signed !== null && typeof signed === 'object'
            ? (signed as unknown as Record<string, unknown>)
            : null;
        const zap = await requestZapInvoice({
          address,
          amountMsat,
          zapRequestJson,
          fetchImpl,
        });
        if (!zap.ok) {
          await persist({
            messageId: profile.id,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest,
            result: zap.reason,
            httpStatus: 400,
            pr: null,
            paymentHash: null,
            description: null,
            descriptionHash: null,
            isNip57Invoice: false,
            conversationMessageId,
            lnurlResponse: zap.lnurlResponse,
          });
          if (zap.reason === 'noZap') {
            return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
          }
          return c.json({ error: 'Could not start the Bitcoin payment' }, 400);
        }
        /* v8 ignore next 3 -- fake BOLT11s in tests decode to null */
        const inspected = inspectBolt11(zap.pr);
        const description = inspected?.description ?? null;
        const descriptionHash = inspected?.descriptionHash ?? null;
        const nip57 = isNip57Invoice(descriptionHash, zapRequestJson);
        if (!nip57) {
          await persist({
            messageId: profile.id,
            authorAccountId: counterpart.id,
            amountSats: parsed.data.sats,
            lightningAddress: address,
            zapRequest,
            result: 'not_zap',
            httpStatus: 400,
            pr: zap.pr,
            /* v8 ignore next -- inspectBolt11 is null on fake test invoices */
            paymentHash: inspected?.paymentHash ?? null,
            description,
            descriptionHash,
            isNip57Invoice: false,
            conversationMessageId,
            lnurlResponse: zap.lnurlResponse,
          });
          return c.json({ error: AUTHOR_WALLET_CANNOT_RECEIVE }, 400);
        }
        await persist({
          messageId: profile.id,
          authorAccountId: counterpart.id,
          amountSats: parsed.data.sats,
          lightningAddress: address,
          zapRequest,
          result: 'ok',
          httpStatus: 200,
          pr: zap.pr,
          /* v8 ignore next -- inspectBolt11 is null on fake test invoices */
          paymentHash: inspected?.paymentHash ?? null,
          description,
          descriptionHash,
          isNip57Invoice: true,
          conversationMessageId,
          lnurlResponse: zap.lnurlResponse,
        });
        return c.json(
          { pr: zap.pr, amountSats: zap.amountSats, messageId: conversationMessageId },
          200,
        );
      } catch {
        logEvent('conversations.invoice.failed');
        return c.json({ error: 'Conversations are unavailable' }, 503);
      }
    });
}
