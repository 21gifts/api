import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { GIFT_INVOICE_MAX_MSAT } from '@/lib/config';
import { CONVERSATION_LIST_LIMIT } from '@/lib/conversation';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import type { FetchFn } from '@/lib/lnurlp';
import {
  MESSAGE_MAX_LENGTH,
  decodeMessageFeedCursor,
  encodeMessageFeedCursor,
  unsignedNostrDefaults,
} from '@/lib/message';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { InvoiceRateLimiter } from '@/lib/nostr/rate-limit';
import { InMemoryPushStore } from '@/lib/push-store';
import { FUNDING_REQUIRED_FROM_UTC } from '@/lib/funding';
import { InMemoryFundingStore } from '@/lib/funding-store';
import type { SpendPing } from '@/lib/spend-ping';
import { InMemoryTranslationStore, translationSourceHash } from '@/lib/translation-store';
import { conversationRoutes } from '@/routes/conversations';

function parsedEvents(warn: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  return warn.mock.calls
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === 'string' && arg.startsWith('{'))
    .map((arg) => JSON.parse(arg) as Record<string, unknown>);
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

const now = (): number => 1_700_000_000_000;

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await Promise.resolve();
  }
}

const AUTH = { authorization: 'Bearer tok' };
const NOTE_ID = '00000000-0000-4000-8000-000000000001';
const LIVING_ROOM_POST_ID = '00000000-0000-4000-8000-0000000000aa';
const JPEG = {
  contentType: 'image/jpeg' as const,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
};
const JPEG2 = {
  contentType: 'image/jpeg' as const,
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]),
};
const JPEG_B64 = Buffer.from(JPEG.bytes).toString('base64');
const JPEG2_B64 = Buffer.from(JPEG2.bytes).toString('base64');

function livingRoomStore(createdAt: Date = new Date(now())): InMemoryMessageStore {
  return new InMemoryMessageStore([
    {
      id: LIVING_ROOM_POST_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'hello living room',
      createdAt,
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    },
  ]);
}

function admittedFunding(accountId = 'acc'): InMemoryFundingStore {
  return new InMemoryFundingStore([
    {
      accountId,
      status: 'admitted',
      appliedAt: 1,
      decidedAt: 1,
      decidedBy: 'staff',
      trialUtcDate: null,
      admittedAt: 1,
      note: null,
    },
  ]);
}

function mount(
  authStore: InMemoryAuthStore,
  conversations = new InMemoryConversationStore(),
  messages = new InMemoryMessageStore(),
  extra: {
    spendPing?: SpendPing;
    pushStore?: InMemoryPushStore;
    fundingStore?: InMemoryFundingStore;
    now?: () => number;
    translationStore?: InMemoryTranslationStore;
    env?: Record<string, string | undefined>;
    fetchImpl?: FetchFn;
  } = {},
): Hono {
  return new Hono().route(
    '/conversations',
    conversationRoutes({
      store: conversations,
      authStore,
      messageStore: messages,
      now: extra.now ?? now,
      ...(extra.spendPing === undefined ? {} : { spendPing: extra.spendPing }),
      ...(extra.pushStore === undefined ? {} : { pushStore: extra.pushStore }),
      ...(extra.fundingStore === undefined ? {} : { fundingStore: extra.fundingStore }),
      ...(extra.translationStore === undefined ? {} : { translationStore: extra.translationStore }),
      ...(extra.env === undefined ? {} : { env: extra.env }),
      ...(extra.fetchImpl === undefined ? {} : { fetchImpl: extra.fetchImpl }),
    }),
  );
}

async function seeded(
  role: 'basis' | 'moderator' | 'founder' = 'basis',
): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: null,
    role,
    name: 'Ada',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function withOther(store: InMemoryAuthStore, id = 'other'): Promise<void> {
  await store.createAccount({
    id,
    linkingKey: null,
    role: 'basis',
    name: 'Bob',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: id.padEnd(64, 'b'),
    createdAt: 2,
    rulesAgreedAt: null,
  });
}

async function withNip57True<T>(run: () => Promise<T>): Promise<T> {
  const bolt11 = await import('@/lib/bolt11');
  const nip57Spy = vi.spyOn(bolt11, 'isNip57Invoice').mockReturnValue(true);
  try {
    return await run();
  } finally {
    nip57Spy.mockRestore();
  }
}

function lnurlFetchImpl(pr = 'lnbc21n1test'): FetchFn {
  return async (input) => {
    const url = String(input);
    if (url.includes('/.well-known/lnurlp/')) {
      return new Response(
        JSON.stringify({
          callback: 'https://walletofsatoshi.com/lnurlp/callback',
          minSendable: 1000,
          maxSendable: 10_000_000_000,
          allowsNostr: true,
          nostrPubkey: 'aa'.repeat(32),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ pr }), {
      headers: { 'content-type': 'application/json' },
    });
  };
}

async function payableThread(): Promise<{
  auth: InMemoryAuthStore;
  conversations: InMemoryConversationStore;
  messages: InMemoryMessageStore;
  threadId: string;
  kek: Uint8Array;
}> {
  const { parseNostrKek } = await import('@/lib/nostr/kek');
  const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
  const kek = parseNostrKek('11'.repeat(32));
  const auth = await seeded();
  await withOther(auth);
  const other = await auth.getAccount('other');
  if (other === undefined) {
    throw new Error('expected counterpart');
  }
  const messages = new InMemoryMessageStore();
  const profileId = '11111111-1111-4111-8111-111111111111';
  await messages.create({
    id: profileId,
    accountId: 'other',
    name: 'Bob',
    text: 'hi',
    createdAt: new Date(now()),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    eventId: 'ee'.repeat(32),
  });
  await auth.updateAccount({
    ...other,
    lightningAddress: 'bob@walletofsatoshi.com',
    profileMessageId: profileId,
  });
  await ensureAccountNostrKey(auth, 'other', kek);
  const conversations = new InMemoryConversationStore();
  const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
  return { auth, conversations, messages, threadId: thread.id, kek };
}

async function withPlatform(store: InMemoryAuthStore): Promise<void> {
  await store.createAccount({
    id: 'plat',
    linkingKey: null,
    role: 'founder',
    name: '21.gifts',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'p'.repeat(64),
    createdAt: 3,
    rulesAgreedAt: null,
    isPlatform: true,
  });
}

describe('GET /conversations', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/conversations');
    expect(res.status).toBe(401);
  });

  it('omits a member thread when only the viewer sent', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm1',
      conversationId: thread.id,
      text: 'hi',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; name: string; lastText: string; lastFromMe: boolean }>;
    };
    expect(body.conversations).toHaveLength(0);
  });

  it('lists the member own platform thread when only the member sent', async () => {
    const auth = await seeded();
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm1',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{
        kind: string;
        lastFromMe: boolean;
        lastText: string;
        lastMessageId: string | null;
        accountId?: string;
      }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.kind).toBe('member_platform');
    expect(body.conversations[0]?.lastFromMe).toBe(true);
    expect(body.conversations[0]?.lastText).toBe('help');
    expect(body.conversations[0]?.lastMessageId).toBe('m1');
    expect(body.conversations[0]?.accountId).toBe('plat');
  });

  it('lists the member own platform thread when the last row is gift-only', async () => {
    const auth = await seeded();
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-gift',
      conversationId: thread.id,
      text: '',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 21,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{
        kind: string;
        lastText: string;
        lastSats: number;
      }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.kind).toBe('member_platform');
    expect(body.conversations[0]?.lastSats).toBe(21);
    expect(body.conversations[0]?.lastText).toBe('');
  });

  it('omits the member own platform thread when it has no messages', async () => {
    const auth = await seeded();
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(0);
  });

  it('lists a two-way thread with lastFromMe from the latest sender', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-bob',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: 'm-ada',
      conversationId: thread.id,
      text: 'hi',
      createdAt: new Date(now() + 1),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{
        kind: string;
        name: string;
        lastText: string;
        lastFromMe: boolean;
        accountId?: string;
      }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.kind).toBe('member_member');
    expect(body.conversations[0]?.name).toBe('Bob');
    expect(body.conversations[0]?.lastText).toBe('hi');
    expect(body.conversations[0]?.lastFromMe).toBe(true);
    expect(body.conversations[0]?.accountId).toBe('other');
    expect(body.conversations[0]).not.toHaveProperty('accountA');
    expect(body.conversations[0]).not.toHaveProperty('eventId');
    expect(body.conversations[0]).not.toHaveProperty('npub');
    expect(body.conversations[0]).not.toHaveProperty('lastSenderAccountId');
  });

  it('sets lastFromMe false when the counterpart sent the last message', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm1',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ lastFromMe: boolean }> };
    expect(body.conversations[0]?.lastFromMe).toBe(false);
  });

  it('lists a platform thread when staff sees only a platform send without actor', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-plat',
      conversationId: thread.id,
      text: 'official',
      createdAt: new Date(now()),
      senderAccountId: 'plat',
      senderPubkey: null,
      name: '21.gifts',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; lastFromMe: boolean }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.lastFromMe).toBe(false);
  });

  it('sets lastFromMe false when staff views a member-sent last message', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-mem',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'someone',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; lastFromMe: boolean }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.lastFromMe).toBe(false);
  });

  it('sets lastFromMe false when staff views a platform-sent last message without actor', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-mem',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'someone',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: 'm-plat',
      conversationId: thread.id,
      text: 'official',
      createdAt: new Date(now() + 1),
      senderAccountId: 'plat',
      senderPubkey: null,
      name: '21.gifts',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; lastFromMe: boolean }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.lastFromMe).toBe(false);
  });

  it('sets lastFromMe true when staff views their own actor on a platform send', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-mem',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'someone',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: 'm-plat',
      conversationId: thread.id,
      text: 'official',
      createdAt: new Date(now() + 1),
      senderAccountId: 'plat',
      senderPubkey: null,
      name: '21.gifts',
      actorAccountId: 'acc',
      actorName: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; lastFromMe: boolean }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.lastFromMe).toBe(true);
  });

  it('sets lastFromMe false for Damus inbound without a sender account', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberDamus('acc', 'aa'.repeat(32), new Date(now()));
    await conversations.appendMessage({
      id: 'm-damus',
      conversationId: thread.id,
      text: 'from damus',
      createdAt: new Date(now()),
      senderAccountId: null,
      senderPubkey: 'aa'.repeat(32),
      name: 'aabbccdd…8899',
      sats: 0,
      eventId: 'ef'.repeat(32),
      nostrPublishState: 'published',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ lastFromMe: boolean; accountId?: string }>;
    };
    expect(body.conversations[0]?.lastFromMe).toBe(false);
    expect(body.conversations[0]).not.toHaveProperty('accountId');
  });

  it('lets staff see platform threads they are not in', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'someone',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; name: string; accountId?: string }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('Bob');
    expect(body.conversations[0]?.accountId).toBe('someone');
  });

  it('lets staff see a member_platform thread when no platform account exists', async () => {
    const auth = await seeded('moderator');
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'someone',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const noPlat = (await res.json()) as {
      conversations: Array<{ kind: string; name: string; accountId?: string }>;
    };
    expect(noPlat.conversations).toHaveLength(1);
    expect(noPlat.conversations[0]?.name).toBe('Bob');
    expect(noPlat.conversations[0]?.accountId).toBe('someone');
  });

  it('names the counterpart when the viewer is accountB', async () => {
    const auth = await seeded();
    await withOther(auth, 'aaa');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('aaa', 'acc', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'aaa',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ name: string; accountId?: string }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('Bob');
    expect(body.conversations[0]?.accountId).toBe('aaa');
  });

  it('lets staff list a member_member thread where the platform is a party', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('plat', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; name: string; accountId?: string }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('Bob');
    expect(body.conversations[0]?.accountId).toBe('other');
  });

  it('lets staff list a member_member platform thread when the platform sorts first', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'zzz');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('plat', 'zzz', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'zzz',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const sortBody = (await res.json()) as {
      conversations: Array<{ kind: string; name: string; accountId?: string }>;
    };
    expect(sortBody.conversations).toHaveLength(1);
    expect(sortBody.conversations[0]?.name).toBe('Bob');
    expect(sortBody.conversations[0]?.accountId).toBe('zzz');
  });

  it('names a counterpart without a display name as member', async () => {
    const auth = await seeded();
    await auth.createAccount({
      id: 'other',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'other'.padEnd(64, 'b'),
      createdAt: 2,
      rulesAgreedAt: null,
      isPlatform: false,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'member',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ name: string }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('member');
  });

  it('names a member_platform thread with a null platform party 21.gifts', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore(
      [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          kind: 'member_platform',
          accountA: 'acc',
          accountB: null,
          counterpartPubkey: null,
          createdAt: new Date(now()),
          lastMessageAt: new Date(now()),
          name: '',
          lastText: '',
          lastMessageId: null,
          lastSenderAccountId: null,
          lastActorAccountId: null,
          lastSats: 0,
        },
      ],
      [
        {
          id: 'm-in',
          conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          text: 'hello',
          createdAt: new Date(now()),
          senderAccountId: null,
          senderPubkey: null,
          name: 'someone',
          sats: 0,
          eventId: null,
          nostrPublishState: 'pending',
          nostrEvent: null,
          claimedUntil: null,
        },
      ],
    );
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ name: string; lastFromMe: boolean; accountId?: string }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('21.gifts');
    expect(body.conversations[0]?.lastFromMe).toBe(false);
    expect(body.conversations[0]).not.toHaveProperty('accountId');
  });

  it('names a member_member thread with a null counterpart member', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore(
      [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          kind: 'member_member',
          accountA: 'acc',
          accountB: null,
          counterpartPubkey: null,
          createdAt: new Date(now()),
          lastMessageAt: new Date(now()),
          name: '',
          lastText: '',
          lastMessageId: null,
          lastSenderAccountId: null,
          lastActorAccountId: null,
          lastSats: 0,
        },
      ],
      [
        {
          id: 'm-in',
          conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          text: 'hello',
          createdAt: new Date(now()),
          senderAccountId: null,
          senderPubkey: null,
          name: 'someone',
          sats: 0,
          eventId: null,
          nostrPublishState: 'pending',
          nostrEvent: null,
          claimedUntil: null,
        },
      ],
    );
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ name: string; accountId?: string }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('member');
    expect(body.conversations[0]).not.toHaveProperty('accountId');
  });

  it('omits empty threads', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: unknown[] };
    expect(body.conversations).toHaveLength(0);
  });

  it('returns 503 when listing throws', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    conversations.listVisible = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.list.failed')).toBe(true);
  });

  it('returns 503 when hasInboundMessage throws', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberMember('acc', 'other', new Date(now()));
    conversations.hasInboundMessage = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.list.failed')).toBe(true);
  });

  it('includes unread and unreadCount for an inbound never-read thread', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ unread: boolean; unreadMessageCount: number }>;
      unreadCount: number;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.unread).toBe(true);
    expect(body.conversations[0]?.unreadMessageCount).toBe(1);
    expect(body.unreadCount).toBe(1);
  });

  it('counts two inbound and ignores outbound on a never-read thread', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in-1',
      conversationId: thread.id,
      text: 'one',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: 'm-in-2',
      conversationId: thread.id,
      text: 'two',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: 'm-out',
      conversationId: thread.id,
      text: 'mine',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ unread: boolean; unreadMessageCount: number }>;
      unreadCount: number;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.unread).toBe(true);
    expect(body.conversations[0]?.unreadMessageCount).toBe(2);
    expect(body.unreadCount).toBe(1);
  });

  it('returns 503 when countUnread throws', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    conversations.countUnread = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Conversations are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.list.failed')).toBe(true);
  });

  it('omits an outbound-only member thread and reports unreadCount 0', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-out',
      conversationId: thread.id,
      text: 'hi',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: unknown[];
      unreadCount: number;
    };
    expect(body.conversations).toHaveLength(0);
    expect(body.unreadCount).toBe(0);
  });

  it('lists own outbound-only platform contact with unread false', async () => {
    const auth = await seeded();
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-out',
      conversationId: thread.id,
      text: 'help',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ unread: boolean }>;
      unreadCount: number;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.unread).toBe(false);
    expect(body.unreadCount).toBe(0);
  });
});

describe('POST /conversations', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ forumMessageId: NOTE_ID }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a missing forumMessageId', async () => {
    const res = await mount(await seeded()).request('/conversations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-uuid forumMessageId', async () => {
    const res = await mount(await seeded()).request('/conversations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ forumMessageId: 'nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the note is missing', async () => {
    const res = await mount(await seeded()).request('/conversations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ forumMessageId: NOTE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when opening a thread with yourself', async () => {
    const auth = await seeded();
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'acc',
      name: 'Ada',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(auth, new InMemoryConversationStore(), messages).request(
      '/conversations',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ forumMessageId: NOTE_ID }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot message yourself' });
  });

  it('returns 400 when the note author pubkey matches the session pubkey', async () => {
    const auth = await seeded();
    await withOther(auth);
    await auth.setNostrKeyIfAbsent('acc', {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'other',
      name: 'Bob',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      hasVideo: false,
      ...unsignedNostrDefaults(),
      authorPubkey: 'AA'.repeat(32),
    });
    const res = await mount(auth, new InMemoryConversationStore(), messages).request(
      '/conversations',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ forumMessageId: NOTE_ID }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot message yourself' });
  });

  it('opens a member thread from a forum note', async () => {
    const auth = await seeded();
    await withOther(auth);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'other',
      name: 'Bob',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(auth, new InMemoryConversationStore(), messages).request(
      '/conversations',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ forumMessageId: NOTE_ID }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      kind: string;
      name: string;
      lastFromMe: boolean;
      unread: boolean;
      unreadMessageCount: number;
      accountId?: string;
    };
    expect(body.name).toBe('Bob');
    expect(body.kind).toBe('member_member');
    expect(body.id.length).toBeGreaterThan(8);
    expect(body.lastFromMe).toBe(false);
    expect(body.unread).toBe(false);
    expect(body.unreadMessageCount).toBe(0);
    expect(body.accountId).toBe('other');
    expect(body).not.toHaveProperty('accountA');
    expect(body).not.toHaveProperty('eventId');
    expect(body).not.toHaveProperty('npub');
    expect(body).not.toHaveProperty('lastSenderAccountId');
  });

  it('opens a platform thread when the note author is the platform account', async () => {
    const auth = await seeded();
    await withPlatform(auth);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'plat',
      name: '21.gifts',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(auth, new InMemoryConversationStore(), messages).request(
      '/conversations',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ forumMessageId: NOTE_ID }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; name: string; accountId?: string };
    expect(body.name).toBe('21.gifts');
    expect(body.kind).toBe('member_platform');
    expect(body.accountId).toBe('plat');
  });

  it('opens a Damus thread from a note without a 21gifts account', async () => {
    const auth = await seeded();
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: null,
      name: 'aabbccdd…8899',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      authorPubkey: 'aa'.repeat(32),
    });
    const res = await mount(auth, new InMemoryConversationStore(), messages).request(
      '/conversations',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ forumMessageId: NOTE_ID }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; name: string; accountId?: string };
    expect(body.name).toMatch(/aa/);
    expect(body.kind).toBe('member_damus');
    expect(body).not.toHaveProperty('accountId');
  });

  it('returns 404 when a Damus note has no author pubkey', async () => {
    const auth = await seeded();
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: null,
      name: 'anon',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const res = await mount(auth, new InMemoryConversationStore(), messages).request(
      '/conversations',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ forumMessageId: NOTE_ID }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('returns 503 when opening throws', async () => {
    const auth = await seeded();
    await withOther(auth);
    const messages = new InMemoryMessageStore();
    await messages.create({
      id: NOTE_ID,
      accountId: 'other',
      name: 'Bob',
      text: 'note',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const conversations = new InMemoryConversationStore();
    conversations.openMemberMember = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations, messages).request('/conversations', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ forumMessageId: NOTE_ID }),
    });
    expect(res.status).toBe(503);
  });
});

describe('GET /conversations/:id', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/conversations/${NOTE_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seeded()).request('/conversations/nope', { headers: AUTH });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the session cannot see the thread', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('x', 'y', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('lets staff read a member_member thread where the platform is a party', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('plat', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-staff',
      conversationId: thread.id,
      text: 'official',
      createdAt: new Date(now()),
      senderAccountId: 'plat',
      senderPubkey: null,
      name: '21.gifts',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ text: string; fromMe: boolean; accountId?: string }>;
    };
    expect(body.messages.map((m) => m.text)).toEqual(['official']);
    expect(body.messages[0]?.fromMe).toBe(false);
    expect(body.messages[0]?.accountId).toBe('plat');
  });

  it('returns messages oldest-first', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm1',
      conversationId: thread.id,
      text: 'first',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: 'm2',
      conversationId: thread.id,
      text: 'second',
      createdAt: new Date(now() + 1),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ text: string; name: string; fromMe: boolean; accountId?: string }>;
    };
    expect(body).not.toHaveProperty('accountId');
    expect(body.messages.map((m) => m.text)).toEqual(['first', 'second']);
    expect(body.messages[0]?.fromMe).toBe(true);
    expect(body.messages[0]?.accountId).toBe('acc');
    expect(body.messages[1]?.fromMe).toBe(false);
    expect(body.messages[1]?.accountId).toBe('other');
    expect(body.messages[0]).not.toHaveProperty('eventId');
    expect(body.messages[0]).not.toHaveProperty('senderAccountId');
  });

  it('returns the newest 200 messages oldest-first by default with an older cursor', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const ids: string[] = [];
    for (let i = 0; i <= CONVERSATION_LIST_LIMIT; i += 1) {
      const id = `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      ids.push(id);
      await conversations.appendMessage({
        id,
        conversationId: thread.id,
        text: `message ${i}`,
        createdAt: new Date(now() + i),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      });
    }

    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(body.messages.map((row) => row.id)).toEqual(ids.slice(1));
    expect(body.nextCursor).toBeDefined();
    expect(decodeMessageFeedCursor(body.nextCursor ?? '')).toEqual({
      k: 't',
      c: new Date(now() + 1).toISOString(),
      i: ids[1],
    });
  });

  it('pages older messages from the oldest row of the newest page', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const ids = [
      '00000000-0000-4000-8000-000000000011',
      '00000000-0000-4000-8000-000000000012',
      '00000000-0000-4000-8000-000000000013',
    ];
    for (const [i, id] of ids.entries()) {
      await conversations.appendMessage({
        id,
        conversationId: thread.id,
        text: `message ${i}`,
        createdAt: new Date(now() + i),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      });
    }

    const first = await mount(auth, conversations).request(`/conversations/${thread.id}?limit=2`, {
      headers: AUTH,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(firstBody.messages.map((row) => row.id)).toEqual(ids.slice(1));
    expect(firstBody.nextCursor).toBeDefined();

    const second = await mount(auth, conversations).request(
      `/conversations/${thread.id}?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { headers: AUTH },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(secondBody.messages.map((row) => row.id)).toEqual(ids.slice(0, 1));
    expect(secondBody).not.toHaveProperty('nextCursor');
  });

  it.each(['0', '201', 'abc'])('returns 400 for invalid limit %s', async (limit) => {
    const res = await mount(await seeded()).request(`/conversations/${NOTE_ID}?limit=${limit}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid limit' });
  });

  it.each([
    '%%%',
    encodeMessageFeedCursor({
      k: 's',
      s: 21,
      c: new Date(now()).toISOString(),
      i: NOTE_ID,
    }),
    encodeMessageFeedCursor({
      k: 't',
      c: new Date(now()).toISOString(),
      i: 'not-a-uuid',
    }),
  ])('returns 400 for an invalid cursor', async (cursor) => {
    const res = await mount(await seeded()).request(
      `/conversations/${NOTE_ID}?cursor=${encodeURIComponent(cursor)}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid cursor' });
  });

  it('sets fromMe false for Damus inbound without a sender account', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberDamus('acc', 'aa'.repeat(32), new Date(now()));
    await conversations.appendMessage({
      id: 'm-damus',
      conversationId: thread.id,
      text: 'from damus',
      createdAt: new Date(now()),
      senderAccountId: null,
      senderPubkey: 'aa'.repeat(32),
      name: 'aabbccdd…8899',
      sats: 0,
      eventId: 'ef'.repeat(32),
      nostrPublishState: 'published',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      messages: Array<{ fromMe: boolean; accountId?: string }>;
    };
    expect(body.messages[0]?.fromMe).toBe(false);
    expect(body.messages[0]).not.toHaveProperty('accountId');
  });

  it('returns 503 when get throws', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    conversations.getById = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request(`/conversations/${NOTE_ID}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
  });
});

const TRANSLATE_ENV = {
  TRANSLATE_URL: 'https://api.deepl.com/v2/translate',
  TRANSLATE_API_KEY: 'deepl-secret-key',
};
const MISSING_UUID = '00000000-0000-4000-8000-0000000000ff';

async function memberThreadWithText(
  text: string,
  role: 'basis' | 'moderator' | 'founder' = 'basis',
): Promise<{
  auth: InMemoryAuthStore;
  conversations: InMemoryConversationStore;
  threadId: string;
}> {
  const auth = await seeded(role);
  await withOther(auth);
  const conversations = new InMemoryConversationStore();
  const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
  await conversations.appendMessage({
    id: NOTE_ID,
    conversationId: thread.id,
    text,
    createdAt: new Date(now()),
    senderAccountId: 'acc',
    senderPubkey: null,
    name: 'Ada',
    sats: 0,
    eventId: null,
    nostrPublishState: 'pending',
    nostrEvent: null,
    claimedUntil: null,
  });
  return { auth, conversations, threadId: thread.id };
}

describe('POST /conversations/:id/messages/:messageId/translate', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(
      `/conversations/${NOTE_ID}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the conversation id is not a UUID', async () => {
    const res = await mount(await seeded()).request(
      `/conversations/not-a-uuid/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the message id is not a UUID', async () => {
    const res = await mount(await seeded()).request(
      `/conversations/${NOTE_ID}/messages/not-a-uuid/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 400 when the body is missing target or is not en|de|es|fil', async () => {
    const auth = await seeded();
    const missing = await mount(auth).request(
      `/conversations/${NOTE_ID}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(missing.status).toBe(400);
    expect(await missing.json()).toEqual({ error: 'Invalid body' });
    const bad = await mount(auth).request(
      `/conversations/${NOTE_ID}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'fr' }),
      },
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid body' });
  });

  it('returns 400 when the body is not JSON', async () => {
    const res = await mount(await seeded()).request(
      `/conversations/${NOTE_ID}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: 'not-json',
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
  });

  it('returns 404 when the thread is missing', async () => {
    const res = await mount(await seeded()).request(
      `/conversations/${MISSING_UUID}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when canAccess is false and lets a moderator translate moderator_group', async () => {
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: NOTE_ID,
      conversationId: thread.id,
      text: 'Hallo Welt',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const stranger = new InMemoryAuthStore();
    await stranger.createAccount({
      id: 'stranger',
      linkingKey: null,
      role: 'basis',
      name: 'Eve',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'e'.repeat(64),
      createdAt: 4,
      rulesAgreedAt: null,
    });
    await stranger.createSession({ token: 'tok', accountId: 'stranger', createdAt: now() });
    const foreign = await mount(stranger, conversations).request(
      `/conversations/${thread.id}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'Not found' });

    const basis = await seeded();
    await withPlatform(basis);
    const groupStore = new InMemoryConversationStore();
    const group = await groupStore.ensureModeratorGroup('plat', new Date(now()));
    await groupStore.appendMessage({
      id: NOTE_ID,
      conversationId: group.id,
      text: 'Hallo Welt',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    const basisDenied = await mount(basis, groupStore).request(
      `/conversations/${group.id}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(basisDenied.status).toBe(404);
    expect(await basisDenied.json()).toEqual({ error: 'Not found' });

    const mod = await seeded('moderator');
    await withPlatform(mod);
    const translations = new InMemoryTranslationStore();
    await translations.put(NOTE_ID, 'en', translationSourceHash('Hallo Welt'), 'Hello, World');
    const allowed = await mount(mod, groupStore, new InMemoryMessageStore(), {
      env: TRANSLATE_ENV,
      translationStore: translations,
    }).request(`/conversations/${group.id}/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ translatedText: 'Hello, World', cached: true });
  });

  it('returns 404 when the message is missing', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    const res = await mount(auth, conversations).request(
      `/conversations/${threadId}/messages/${MISSING_UUID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the message belongs to another conversation', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const mine = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const theirs = await conversations.openMemberMember('other', 'third', new Date(now()));
    await conversations.appendMessage({
      id: NOTE_ID,
      conversationId: theirs.id,
      text: 'Hallo Welt',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request(
      `/conversations/${mine.id}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 400 when stored text trims empty', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('   ');
    const res = await mount(auth, conversations).request(
      `/conversations/${threadId}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Invalid body' });
  });

  it('returns cached true from stored text and ignores a client text field', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    const translations = new InMemoryTranslationStore();
    await translations.put(NOTE_ID, 'en', translationSourceHash('Hallo Welt'), 'Hello, World');
    let fetchCalls = 0;
    const fetchImpl: FetchFn = async () => {
      fetchCalls += 1;
      throw new Error('DeepL must not be called');
    };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), {
      env: TRANSLATE_ENV,
      translationStore: translations,
      fetchImpl,
    }).request(`/conversations/${threadId}/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en', text: 'client source' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ translatedText: 'Hello, World', cached: true });
    expect(fetchCalls).toBe(0);
  });

  it('returns cached false when DeepL JSON is fetched', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    let fetchCalls = 0;
    const fetchImpl: FetchFn = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ translations: [{ text: 'Hello world' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), {
      env: TRANSLATE_ENV,
      translationStore: new InMemoryTranslationStore(),
      fetchImpl,
    }).request(`/conversations/${threadId}/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ translatedText: 'Hello world', cached: false });
    expect(fetchCalls).toBe(1);
  });

  it('returns 503 when translate is not configured', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    const res = await mount(auth, conversations, new InMemoryMessageStore(), {
      env: {},
    }).request(`/conversations/${threadId}/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Translate is not configured' });
  });

  it('returns 503 when translate is not configured and env is omitted', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    const res = await mount(auth, conversations).request(
      `/conversations/${threadId}/messages/${NOTE_ID}/translate`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ target: 'en' }),
      },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Translate is not configured' });
  });

  it('returns 502 when DeepL fails', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    const fetchImpl: FetchFn = async () =>
      new Response('nope', { status: 500, headers: { 'content-type': 'application/json' } });
    const res = await mount(auth, conversations, new InMemoryMessageStore(), {
      env: TRANSLATE_ENV,
      fetchImpl,
    }).request(`/conversations/${threadId}/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en' }),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Translate upstream failed' });
  });

  it('returns 503 Conversations are unavailable when getById throws', async () => {
    const { auth, conversations, threadId } = await memberThreadWithText('Hallo Welt');
    conversations.getById = async (): Promise<never> => {
      throw new Error('db down');
    };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), {
      env: TRANSLATE_ENV,
    }).request(`/conversations/${threadId}/messages/${NOTE_ID}/translate`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'en', text: 'Hallo Welt' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Conversations are unavailable' });
    const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('conversations.translate.failed');
    expect(logged).not.toContain('Hallo Welt');
    expect(logged).not.toContain(TRANSLATE_ENV.TRANSLATE_API_KEY);
  });
});

describe('POST /conversations/:id/read', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/conversations/${NOTE_ID}/read`, {
      method: 'POST',
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seeded()).request('/conversations/nope/read', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the session cannot see the thread', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('x', 'y', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the thread is missing', async () => {
    const res = await mount(await seeded()).request(`/conversations/${NOTE_ID}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 200 then GET lists the thread as read', async () => {
    const auth = await seeded();
    await withOther(auth);
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    await conversations.appendMessage({
      id: 'm-in',
      conversationId: thread.id,
      text: 'yo',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const read = await mount(auth, conversations).request(`/conversations/${thread.id}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ ok: true });
    const listed = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      conversations: Array<{ unread: boolean; unreadMessageCount: number }>;
      unreadCount: number;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.unread).toBe(false);
    expect(body.conversations[0]?.unreadMessageCount).toBe(0);
    expect(body.unreadCount).toBe(0);
  });

  it('returns 503 when markRead throws', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    conversations.markRead = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/read`, {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Conversations are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.read.failed')).toBe(true);
  });
});

describe('POST /conversations/:id', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request(`/conversations/${NOTE_ID}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 for invalid text', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo`,
    });
  });

  it('returns 400 for a malformed JSON body', async () => {
    const auth = await seeded();
    const res = await mount(auth).request(`/conversations/${NOTE_ID}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with text and/or photo' });
  });

  it('returns 200 hasPhoto true when a member_member thread includes a photo', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPhoto: true, photoCount: 1, text: '' });
    const listed = await conversations.listMessages(thread.id, 10);
    expect(listed[0]?.nostrPublishState).toBe('skipped');
    expect(listed[0]?.eventId).toBeNull();
  });

  it('stores a photo capture time and leaves it out of the conversation JSON', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: {
          contentType: 'image/jpeg',
          data: JPEG_B64,
          takenAt: '2020-01-01T00:00:00+00:00',
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('takenAt');
    expect(body).not.toHaveProperty('photoTakenAt');
    expect(body).not.toHaveProperty('photoTakenAts');
    const stored = await conversations.listMessages(thread.id, 10);
    expect((await conversations.getPhoto(stored[0]!.id))?.takenAt).toBe(
      '2020-01-01T00:00:00+00:00',
    );
    const invalid = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'other',
        photo: { contentType: 'image/jpeg', data: JPEG_B64, takenAt: 'not-a-time' },
      }),
    });
    expect(invalid.status).toBe(200);
    const again = await conversations.listMessages(thread.id, 10);
    const other = again.find((row) => row.text === 'other');
    expect((await conversations.getPhoto(other!.id))?.takenAt).toBeUndefined();
  });

  it('returns 200 hasPhoto true when a member_platform thread includes a photo', async () => {
    const auth = await seeded();
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: [{ contentType: 'image/jpeg', data: JPEG_B64 }],
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPhoto: true, photoCount: 1 });
    const listed = await conversations.listMessages(thread.id, 10);
    expect(listed[0]?.nostrPublishState).toBe('skipped');
    expect(listed[0]?.eventId).toBeNull();
  });

  it('returns 200 hasPhoto true when a member_damus thread includes a photo', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberDamus('acc', 'aa'.repeat(32), new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; hasPhoto: boolean; photoCount: number };
    expect(body).toMatchObject({ hasPhoto: true, photoCount: 1 });
    const listed = await conversations.listMessages(thread.id, 10);
    expect(listed[0]?.nostrPublishState).toBe('skipped');
    expect(listed[0]?.eventId).toBeNull();
    const claimed = await conversations.claimUnsigned(10, now(), 60_000);
    expect(claimed.map((row) => row.id)).not.toContain(body.id);
  });

  it('returns 400 for an empty text string', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo`,
    });
  });

  it(`returns 400 when text is longer than ${MESSAGE_MAX_LENGTH} characters`, async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(MESSAGE_MAX_LENGTH + 1) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` });
  });

  it('returns 404 when the thread is missing', async () => {
    const res = await mount(await seeded()).request(`/conversations/${NOTE_ID}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('returns 404 when the session cannot see the thread', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('x', 'y', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('enqueues a conversation push for the counterpart after append', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    const res = await mount(auth, conversations, new InMemoryMessageStore(), { pushStore }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ping' }),
      },
    );
    expect(res.status).toBe(200);
    await flushMicrotasks();
    const claimed = await pushStore.claimPending(10, now(), 60_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.type).toBe('conversation');
    expect(claimed[0]?.accountId).toBe('other');
    const payload = JSON.parse(claimed[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(payload['url']).toBe(`/messages?c=${thread.id}`);
    expect(payload['unreadCount']).toBe(1);
  });

  it('still 200 when conversation push enqueue fails', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const pushStore = new InMemoryPushStore();
    await pushStore.upsertSubscription({
      endpoint: 'https://push.example/other',
      accountId: 'other',
      p256dh: 'p',
      auth: 'a',
      createdAt: new Date(now()),
    });
    pushStore.enqueue = async () => {
      throw new Error('enqueue boom');
    };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), { pushStore }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'ping' }),
      },
    );
    expect(res.status).toBe(200);
    await flushMicrotasks();
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.push.failed')).toBe(true);
  });

  it('appends a member reply', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  ping  ' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      text: string;
      name: string;
      fromMe: boolean;
      accountId?: string;
    };
    expect(body.text).toBe('ping');
    expect(body.name).toBe('Ada');
    expect(body.fromMe).toBe(true);
    expect(body.accountId).toBe('acc');
    const listed = await conversations.listMessages(thread.id, 10);
    expect(listed[0]?.nostrPublishState).toBe('pending');
  });

  it('lets staff reply on a platform thread as the platform account', async () => {
    const auth = await seeded('founder');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'official' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      text: string;
      fromMe: boolean;
      accountId?: string;
    };
    expect(body.name).toBe('Ada');
    expect(body.text).toBe('official');
    expect(body.fromMe).toBe(true);
    expect(body.accountId).toBe('acc');
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
    expect(rows[0]?.name).toBe('21.gifts');
    expect(rows[0]?.actorAccountId).toBe('acc');
    expect(rows[0]?.actorName).toBe('Ada');
  });

  it('labels staff-as-platform replies 21.gifts when the platform has no name', async () => {
    const auth = await seeded('founder');
    await auth.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'p'.repeat(64),
      createdAt: 3,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'official' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; accountId?: string };
    expect(body.name).toBe('Ada');
    expect(body.accountId).toBe('acc');
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
    expect(rows[0]?.name).toBe('21.gifts');
    expect(rows[0]?.actorAccountId).toBe('acc');
  });

  it('lets unnamed staff reply on a platform thread as the platform', async () => {
    const auth = await seeded('founder');
    const acc = await auth.getAccount('acc');
    if (acc === undefined) {
      throw new Error('expected staff');
    }
    await auth.updateAccount({ ...acc, name: null });
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'official' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; accountId?: string; fromMe: boolean };
    expect(body.name).toBe('21.gifts');
    expect(body.accountId).toBe('acc');
    expect(body.fromMe).toBe(true);
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
    expect(rows[0]?.actorAccountId).toBe('acc');
    expect(rows[0]?.actorName).toBe('');
  });

  it('lets staff reply on a member_member thread where the platform is a party as the platform', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('plat', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'official' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; accountId?: string; fromMe: boolean };
    expect(body.name).toBe('Ada');
    expect(body.accountId).toBe('acc');
    expect(body.fromMe).toBe(true);
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
    expect(rows[0]?.name).toBe('21.gifts');
    expect(rows[0]?.actorAccountId).toBe('acc');
    expect(rows[0]?.actorName).toBe('Ada');
  });

  it('rejects posting without a name on a member thread', async () => {
    const store = new InMemoryAuthStore();
    await store.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'basis',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
    await withOther(store);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(store, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Set a name before posting' });
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seeded()).request('/conversations/nope', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 503 when append throws', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    conversations.appendMessage = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
  });

  it('labels a platform thread 21.gifts when the counterpart has no name', async () => {
    const store = await seeded('moderator');
    await store.createAccount({
      id: 'plat',
      linkingKey: null,
      role: 'founder',
      name: null,
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm1',
      conversationId: thread.id,
      text: 'hi',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(store, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ kind: string; name: string }> };
    expect(body.conversations.find((c) => c.kind === 'member_platform')?.name).toBe('21.gifts');
  });
});

describe('moderator_group', () => {
  it('returns the empty singleton named Moderators for a moderator', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const res = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: {
        kind: string;
        name: string;
        lastText: string;
        lastFromMe: boolean;
        unread: boolean;
        unreadMessageCount: number;
      };
    };
    expect(body.conversation.kind).toBe('moderator_group');
    expect(body.conversation.name).toBe('Moderators');
    expect(body.conversation.lastText).toBe('');
    expect(body.conversation.lastFromMe).toBe(false);
    expect(body.conversation.unread).toBe(false);
    expect(body.conversation.unreadMessageCount).toBe(0);
    const list = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { conversations: Array<{ kind: string }> };
    expect(listed.conversations).toHaveLength(0);
    expect(listed.conversations.some((c) => c.kind === 'moderator_group')).toBe(false);
  });

  it('does not list the moderator group after an inbound message from another account', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-inbound',
      conversationId: thread.id,
      text: 'hello mods',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const listVisible = vi.spyOn(conversations, 'listVisible');
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ kind: string }> };
    expect(body.conversations.some((c) => c.kind === 'moderator_group')).toBe(false);
    expect(listVisible.mock.calls[0]?.[4]).toBe(false);
    const group = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: AUTH,
    });
    expect(group.status).toBe(200);
    const groupBody = (await group.json()) as {
      conversation: { kind: string; unread: boolean; unreadMessageCount: number };
    };
    expect(groupBody.conversation.kind).toBe('moderator_group');
    expect(groupBody.conversation.unread).toBe(true);
    expect(groupBody.conversation.unreadMessageCount).toBe(1);
  });

  it('skips a moderator_group row even when listVisible returns one', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const inbound = vi.spyOn(conversations, 'hasInboundMessage');
    conversations.listVisible = async () => [thread];
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ kind: string }> };
    expect(body.conversations).toHaveLength(0);
    expect(inbound).not.toHaveBeenCalled();
  });

  it('does not list the moderator group when 200 newer threads exist', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    await conversations.ensureModeratorGroup('plat', new Date(now() - 86_400_000));
    for (let i = 0; i < 200; i++) {
      await withOther(auth, `o${i}`);
      const thread = await conversations.openMemberMember('acc', `o${i}`, new Date(now() + i));
      await conversations.appendMessage({
        id: `m${i}`,
        conversationId: thread.id,
        text: 'yo',
        createdAt: new Date(now() + i),
        senderAccountId: `o${i}`,
        senderPubkey: null,
        name: 'Bob',
        sats: 0,
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      });
    }
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ kind: string }> };
    expect(body.conversations.some((c) => c.kind === 'moderator_group')).toBe(false);
    expect(body.conversations.length).toBeLessThanOrEqual(200);
    const group = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: AUTH,
    });
    expect(group.status).toBe(200);
    const groupBody = (await group.json()) as { conversation: { kind: string } };
    expect(groupBody.conversation.kind).toBe('moderator_group');
  });

  it('does not list the group for a founder and GET /:id is 200', async () => {
    const auth = await seeded('founder');
    await withPlatform(auth);
    await auth.createAccount({
      id: 'mod',
      linkingKey: null,
      role: 'moderator',
      name: 'Mod',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'm'.repeat(64),
      createdAt: 4,
      rulesAgreedAt: null,
    });
    await auth.createSession({ token: 'modtok', accountId: 'mod', createdAt: now() });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    await conversations.appendMessage({
      id: 'm-inbound',
      conversationId: thread.id,
      text: 'hello mods',
      createdAt: new Date(now()),
      senderAccountId: 'other',
      senderPubkey: null,
      name: 'Bob',
      sats: 0,
      eventId: null,
      nostrPublishState: 'pending',
      nostrEvent: null,
      claimedUntil: null,
    });
    const list = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { conversations: Array<{ kind: string }> };
    expect(listed.conversations.some((c) => c.kind === 'moderator_group')).toBe(false);
    const getFounder = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(getFounder.status).toBe(200);
    const founderBody = (await getFounder.json()) as {
      messages: Array<{ text: string; fromMe: boolean }>;
    };
    expect(founderBody.messages.map((row) => row.text)).toEqual(['hello mods']);
    expect(founderBody.messages[0]?.fromMe).toBe(false);
    const getMod = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: { authorization: 'Bearer modtok' },
    });
    expect(getMod.status).toBe(200);
    expect(await getMod.json()).toEqual(founderBody);
  });

  it('returns 404 for verified and basis GET /:id', async () => {
    const conversations = new InMemoryConversationStore();
    await conversations.ensureModeratorGroup('plat', new Date(now()));
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    for (const role of ['verified', 'basis'] as const) {
      const auth = new InMemoryAuthStore();
      await auth.createAccount({
        id: 'acc',
        linkingKey: null,
        role,
        name: 'Ada',
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        location: null,
        viewKey: 'a'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
      await withPlatform(auth);
      const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns 401 for unauthenticated GET /:id before 404', async () => {
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(new InMemoryAuthStore(), conversations).request(
      `/conversations/${thread.id}`,
    );
    expect(res.status).toBe(401);
  });

  it('returns 200 for a founder GET /moderator-group and lets the founder read and post', async () => {
    const auth = await seeded('founder');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const res = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversation: {
        kind: string;
        name: string;
        lastText: string;
        lastFromMe: boolean;
        unread: boolean;
        unreadMessageCount: number;
      };
    };
    expect(body.conversation.kind).toBe('moderator_group');
    expect(body.conversation.name).toBe('Moderators');
    expect(body.conversation.lastText).toBe('');
    expect(body.conversation.lastFromMe).toBe(false);
    expect(body.conversation.unread).toBe(false);
    expect(body.conversation.unreadMessageCount).toBe(0);
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const get = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ messages: [] });
    const post = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello mods' }),
    });
    expect(post.status).toBe(200);
    const posted = (await post.json()) as { text: string; name: string; fromMe: boolean };
    expect(posted.text).toBe('hello mods');
    expect(posted.name).toBe('Ada');
    expect(posted.fromMe).toBe(true);
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderAccountId).toBe('acc');
    expect(rows[0]?.nostrPublishState).toBe('skipped');
    expect(rows[0]?.eventId).toBeNull();
  });

  it('refuses moderator-group open, send, and mark-read on the device Sunday', async () => {
    const sundayMs = Date.parse('2026-09-26T22:30:00.000Z');
    const auth = new InMemoryAuthStore();
    await auth.createAccount({
      id: 'acc',
      linkingKey: null,
      role: 'founder',
      name: 'Ada',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      location: null,
      viewKey: 'a'.repeat(64),
      createdAt: sundayMs,
      rulesAgreedAt: null,
    });
    await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: sundayMs });
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const sunday = (): number => sundayMs;
    const app = mount(auth, conversations, new InMemoryMessageStore(), { now: sunday });
    const opened = await app.request('/conversations/moderator-group', { headers: AUTH });
    expect(opened.status).toBe(200);
    const id = ((await opened.json()) as { conversation: { id: string } }).conversation.id;
    const sundayHeaders = { ...AUTH, 'Time-Zone': 'Europe/Zurich' };
    const thread = await app.request(`/conversations/${id}`, { headers: sundayHeaders });
    expect(thread.status).toBe(403);
    expect(await thread.json()).toEqual({ error: 'SUNDAY_REST' });
    const post = await app.request(`/conversations/${id}`, {
      method: 'POST',
      headers: { ...sundayHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'nope' }),
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toEqual({ error: 'SUNDAY_REST' });
    const read = await app.request(`/conversations/${id}/read`, {
      method: 'POST',
      headers: sundayHeaders,
    });
    expect(read.status).toBe(403);
    expect(await read.json()).toEqual({ error: 'SUNDAY_REST' });
    const saturday = await app.request(`/conversations/${id}`, {
      headers: { ...AUTH, 'Time-Zone': 'Pacific/Honolulu' },
    });
    expect(saturday.status).toBe(200);
  });

  it('shows a platform stipend row in the group as the house, not as the viewer', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const triggerId = '6e8b1a0d-3f2c-4b4a-9d5e-9f0a1b2c3d4e';
    await conversations.appendMessage({
      id: triggerId,
      conversationId: thread.id,
      text: 'hello mods',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    await conversations.appendMessage({
      id: '7f9c2b1e-4a3d-4c5b-8e6f-0a1b2c3d4e5f',
      conversationId: thread.id,
      text: '21gifts moderator · Ada',
      createdAt: new Date(now()),
      senderAccountId: 'plat',
      senderPubkey: null,
      name: '21.gifts',
      sats: 1233,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
      giftForMessageId: triggerId,
    });
    const get = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(get.status).toBe(200);
    const body = (await get.json()) as {
      messages: Array<{
        name: string;
        text: string;
        sats: number;
        fromMe: boolean;
        giftFor?: string;
      }>;
    };
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]).toMatchObject({
      name: 'Ada',
      text: 'hello mods',
      sats: 0,
      fromMe: true,
    });
    expect(body.messages[0]).not.toHaveProperty('giftFor');
    expect(body.messages[1]).toMatchObject({
      name: '21.gifts',
      text: '21gifts moderator · Ada',
      sats: 1233,
      fromMe: false,
      giftFor: triggerId,
    });
    const group = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: AUTH,
    });
    expect(group.status).toBe(200);
    const groupBody = (await group.json()) as {
      conversation: {
        lastFromMe: boolean;
        lastSats: number;
        unread: boolean;
        unreadMessageCount: number;
      };
    };
    expect(groupBody.conversation.lastFromMe).toBe(false);
    expect(groupBody.conversation.lastSats).toBe(1233);
    expect(groupBody.conversation.unread).toBe(true);
    expect(groupBody.conversation.unreadMessageCount).toBe(1);
  });

  it('keeps the platform account out of the Moderators group even with a founder role', async () => {
    const auth = await seeded('founder');
    await withPlatform(auth);
    await auth.createSession({ token: 'plat-tok', accountId: 'plat', createdAt: now() });
    const platformAuth = { authorization: 'Bearer plat-tok' };
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const group = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: platformAuth,
    });
    expect(group.status).toBe(404);
    const read = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: platformAuth,
    });
    expect(read.status).toBe(404);
  });

  it('returns 404 for verified and basis GET /moderator-group', async () => {
    for (const role of ['verified', 'basis'] as const) {
      const auth = new InMemoryAuthStore();
      await auth.createAccount({
        id: 'acc',
        linkingKey: null,
        role,
        name: 'Ada',
        lightningAddress: null,
        lightningAddressVerified: false,
        forumLawsDismissed: false,
        location: null,
        viewKey: 'a'.repeat(64),
        createdAt: 1,
        rulesAgreedAt: null,
      });
      await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
      await withPlatform(auth);
      const res = await mount(auth).request('/conversations/moderator-group', {
        headers: AUTH,
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
    }
  });

  it('returns 401 for unauthenticated GET /moderator-group', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/conversations/moderator-group');
    expect(res.status).toBe(401);
  });

  it('returns 503 when a moderator has no platform account', async () => {
    const auth = await seeded('moderator');
    const res = await mount(auth).request('/conversations/moderator-group', { headers: AUTH });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Conversations are unavailable' });
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'conversations.moderator_group.failed'),
    ).toBe(true);
  });

  it('returns 503 when ensureModeratorGroup throws', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    conversations.ensureModeratorGroup = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request('/conversations/moderator-group', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Conversations are unavailable' });
    expect(
      parsedEvents(warn).some((e) => e['event'] === 'conversations.moderator_group.failed'),
    ).toBe(true);
  });

  it('persists a moderator reply as the moderator with skipped Nostr', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello mods' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text: string; name: string; fromMe: boolean };
    expect(body.text).toBe('hello mods');
    expect(body.name).toBe('Ada');
    expect(body.fromMe).toBe(true);
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.senderAccountId).toBe('acc');
    expect(rows[0]?.nostrPublishState).toBe('skipped');
    expect(rows[0]?.eventId).toBeNull();
  });

  it('pings spend once with kind moderator when a Lightning Address is set', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const res = await mount(auth, conversations, livingRoomStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello mods' }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id, 'moderator');
  });

  it('does not ping when the moderator is not funding-eligible', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const gateNow = Date.parse(`${FUNDING_REQUIRED_FROM_UTC}T12:00:00.000Z`);
    await auth.createSession({ token: 'tok', accountId: 'acc', createdAt: gateNow });
    const res = await mount(auth, conversations, livingRoomStore(new Date(gateNow)), {
      spendPing,
      now: () => gateNow,
    }).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello mods' }),
    });
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'not_eligible',
      ),
    ).toBe(true);
  });

  it('does not ping when the moderator has no living-room post today', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), { spendPing }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'no_public_post',
      ),
    ).toBe(true);
  });

  it('does not ping when the only post today is the profile note', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
      profileMessageId: LIVING_ROOM_POST_ID,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const res = await mount(auth, conversations, livingRoomStore(), { spendPing }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'no_public_post',
      ),
    ).toBe(true);
  });

  it('does not ping when the living-room post is on a previous UTC day', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const yesterday = new Date(now() - 86_400_000);
    const res = await mount(auth, conversations, livingRoomStore(yesterday), { spendPing }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('still returns 200 when spendPing.ping throws', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = {
      ping: vi.fn(async () => {
        throw new Error('ping boom');
      }),
    };
    const res = await mount(auth, conversations, livingRoomStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello mods' }),
    });
    expect(res.status).toBe(200);
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when living-room lookup throws after persist', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const messages = livingRoomStore();
    vi.spyOn(messages, 'listPostsByAccount').mockRejectedValue(new Error('boom'));
    const res = await mount(auth, conversations, messages, { spendPing }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
    expect(
      parsedEvents(warn).some(
        (e) => e['event'] === 'spend.ping.skipped' && e['reason'] === 'posted_unreachable',
      ),
    ).toBe(true);
    expect(await conversations.listMessages(thread.id, 10)).toHaveLength(1);
  });

  it('does not ping when lightningAddress is missing', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), { spendPing }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
    expect(res.status).toBe(200);
    expect(spendPing.ping).not.toHaveBeenCalled();
  });

  it('returns 400 for empty text and does not ping', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const res = await mount(auth, conversations, new InMemoryMessageStore(), { spendPing }).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo`,
    });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });
});

describe('moderator-group photos', () => {
  it('POST text only is hasPhoto false photoCount 0', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello mods' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPhoto: false, photoCount: 0 });
  });

  it('POST photo with no text is 200 hasPhoto true photoCount 1', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPhoto: true, photoCount: 1, text: '' });
    const listed = await conversations.listMessages(thread.id, 10);
    expect(listed[0]?.nostrPublishState).toBe('skipped');
    expect(listed[0]?.eventId).toBeNull();
  });

  it('POST photos array of 10 is 200 photoCount 10', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: Array.from({ length: 10 }, () => ({
          contentType: 'image/jpeg',
          data: JPEG_B64,
        })),
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hasPhoto: true, photoCount: 10 });
    const listed = await conversations.listMessages(thread.id, 10);
    expect(listed[0]?.nostrPublishState).toBe('skipped');
    expect(listed[0]?.eventId).toBeNull();
  });

  it('POST 11 photos is 400 At most 10 photos', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: Array.from({ length: 11 }, () => ({
          contentType: 'image/jpeg',
          data: JPEG_B64,
        })),
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'At most 10 photos' });
  });

  it('POST video without text or photo is 400', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ video: { contentType: 'video/mp4', data: 'AAAA' } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with text and/or photo' });
  });

  it('POST text plus video is 400 and does not persist', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'caption',
        video: { contentType: 'video/mp4', data: 'AAAA' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with text and/or photo' });
    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
  });

  it('POST photo plus video is 400 and does not persist', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
        video: { contentType: 'video/mp4', data: 'AAAA' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with text and/or photo' });
    expect(await conversations.listMessages(thread.id, 10)).toEqual([]);
  });

  it('POST invalid still is 400', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: 'nope' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB',
    });
  });

  it('POST invalid still in photos is 400', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photos: [
          { contentType: 'image/jpeg', data: JPEG_B64 },
          { contentType: 'image/jpeg', data: 'nope' },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB',
    });
  });

  it('POST empty text without a photo is 400', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters or include a photo`,
    });
  });

  it('GET photo 0 as moderator returns JPEG bytes', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = (await (
      await mount(auth, conversations).request(`/conversations/${thread.id}`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          photo: { contentType: 'image/jpeg', data: JPEG_B64 },
        }),
      })
    ).json()) as { id: string };
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${created.id}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG.bytes);
  });

  it('GET photo as moderator without a platform account returns JPEG bytes', async () => {
    const auth = await seeded('moderator');
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = await conversations.appendMessage(
      {
        id: NOTE_ID,
        conversationId: thread.id,
        text: '',
        createdAt: new Date(now()),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'skipped',
        nostrEvent: null,
        claimedUntil: null,
      },
      JPEG,
    );
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${created.id}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG.bytes);
  });

  it('GET photo/1.jpg after two stills returns JPEG2', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = (await (
      await mount(auth, conversations).request(`/conversations/${thread.id}`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          photos: [
            { contentType: 'image/jpeg', data: JPEG_B64 },
            { contentType: 'image/jpeg', data: JPEG2_B64 },
          ],
        }),
      })
    ).json()) as { id: string };
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${created.id}/photo/1.jpg`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG2.bytes);
  });

  it('GET photo with a non-UUID message id is 404 Photo not found', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/not-a-uuid/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('GET photo for an unknown conversation UUID is 404 Not found', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const res = await mount(auth, new InMemoryConversationStore()).request(
      `/conversations/${NOTE_ID}/messages/${NOTE_ID}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('GET photo with a non-UUID conversation id is 404 Not found', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const res = await mount(auth, new InMemoryConversationStore()).request(
      `/conversations/not-a-uuid/messages/${NOTE_ID}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('GET photo missing still is 404 Photo not found', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = await conversations.appendMessage({
      id: NOTE_ID,
      conversationId: thread.id,
      text: 'no still',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${created.id}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('GET photo for a message in another thread is 404 Photo not found', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const group = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const other = await conversations.openMemberMember('acc', 'bob', new Date(now()));
    const created = await conversations.appendMessage({
      id: NOTE_ID,
      conversationId: other.id,
      text: 'elsewhere',
      createdAt: new Date(now()),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 0,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    const res = await mount(auth, conversations).request(
      `/conversations/${group.id}/messages/${created.id}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('GET photo without bearer is 401', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${NOTE_ID}/photo`,
    );
    expect(res.status).toBe(401);
    const extra = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${NOTE_ID}/photo/1.jpg`,
    );
    expect(extra.status).toBe(401);
  });

  it('GET photo as a basis non-member is 404 Not found', async () => {
    const mod = await seeded('moderator');
    await withPlatform(mod);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = await conversations.appendMessage(
      {
        id: NOTE_ID,
        conversationId: thread.id,
        text: '',
        createdAt: new Date(now()),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'skipped',
        nostrEvent: null,
        claimedUntil: null,
      },
      JPEG,
    );
    const basis = await seeded();
    await withPlatform(basis);
    const res = await mount(basis, conversations).request(
      `/conversations/${thread.id}/messages/${created.id}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  it('GET photo bad file is 404 Photo not found', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = await conversations.appendMessage(
      {
        id: NOTE_ID,
        conversationId: thread.id,
        text: '',
        createdAt: new Date(now()),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'skipped',
        nostrEvent: null,
        claimedUntil: null,
      },
      JPEG,
    );
    const app = mount(auth, conversations);
    for (const file of ['0.jpg', '10.jpg', 'foo.png']) {
      const res = await app.request(
        `/conversations/${thread.id}/messages/${created.id}/photo/${file}`,
        { headers: AUTH },
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Photo not found' });
    }
  });

  it('GET photo 503 when getPhoto throws', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const created = await conversations.appendMessage(
      {
        id: NOTE_ID,
        conversationId: thread.id,
        text: '',
        createdAt: new Date(now()),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'skipped',
        nostrEvent: null,
        claimedUntil: null,
      },
      JPEG,
    );
    conversations.getPhoto = async () => {
      throw new Error('boom');
    };
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}/messages/${created.id}/photo`,
      { headers: AUTH },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Conversations are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'conversations.photo.failed')).toBe(true);
  });

  it('pings spend once with kind moderator for a photo-only post', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const existing = await auth.getAccount('acc');
    expect(existing).toBeDefined();
    if (existing === undefined) {
      throw new Error('expected account');
    }
    await auth.updateAccount({
      ...existing,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const spendPing = { ping: vi.fn(async () => undefined) };
    const res = await mount(auth, conversations, livingRoomStore(), {
      spendPing,
      fundingStore: admittedFunding(),
    }).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id, 'moderator');
  });
});

describe('POST /conversations/:id/invoice', () => {
  it('returns 401 without a session', async () => {
    const res = await mount(await seeded()).request(
      '/conversations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/invoice',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for a non-uuid id', async () => {
    const res = await mount(await seeded()).request('/conversations/not-a-uuid/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 when the thread is Damus', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberDamus('acc', 'aa'.repeat(32), new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('returns 400 for a missing sats body', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a positive "sats" integer',
    });
  });

  it('returns 400 when invoice text is too long', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21, text: 'a'.repeat(MESSAGE_MAX_LENGTH + 1) }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: `Text must be 1–${MESSAGE_MAX_LENGTH} characters` });
  });

  it('stores the fiat shown with the invoice even when the text is rejected', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          sats: 21,
          text: 'a'.repeat(MESSAGE_MAX_LENGTH + 1),
          amountUsd: '5.00',
          amountChf: '4.00',
          amountEur: '4.50',
          amountPhp: '280.00',
        }),
      },
    );
    expect(res.status).toBe(400);
    const attempt = (await messages.listInvoiceAttempts(1))[0];
    expect(attempt?.result).toBe('bad_body');
    expect(attempt?.fiatPinned).toBe(true);
    expect(attempt?.amountUsd).toBe('5.00');
    expect(attempt?.amountChf).toBe('4.00');
    expect(attempt?.amountEur).toBe('4.50');
    expect(attempt?.amountPhp).toBe('280.00');
  });

  it('rejects a shown amount that is not a fiat string', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21, amountUsd: 'nope' }),
      },
    );
    expect(res.status).toBe(400);
    const attempt = (await messages.listInvoiceAttempts(1))[0];
    expect(attempt?.result).toBe('bad_body');
    expect(attempt?.fiatPinned).toBe(false);
    expect(attempt?.amountUsd).toBeNull();
  });

  it('returns 400 when sats exceed the gift cap', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: GIFT_INVOICE_MAX_MSAT / 1000 + 1 }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a positive "sats" integer',
    });
  });

  it('returns 404 when the thread is missing', async () => {
    const { auth, conversations, messages } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      '/conversations/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when invoicing yourself', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'acc', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Cannot message yourself' });
  });

  it('invoices as accountB of a member_member thread', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    await auth.createSession({ token: 'tok-other', accountId: 'other', createdAt: now() });
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const acc = await auth.getAccount('acc');
    if (acc === undefined) {
      throw new Error('expected payer profile');
    }
    const profileId = '33333333-3333-4333-8333-333333333333';
    await messages.create({
      id: profileId,
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'dd'.repeat(32),
    });
    await auth.updateAccount({
      ...acc,
      lightningAddress: 'ada@walletofsatoshi.com',
      profileMessageId: profileId,
    });
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    await ensureAccountNostrKey(auth, 'acc', kek);
    const res = await withNip57True(async () =>
      app.request(`/conversations/${threadId}/invoice`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok-other',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ sats: 21 }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('lets staff invoice a platform member thread they are not a party of', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'zzz');
    const zzz = await auth.getAccount('zzz');
    if (zzz === undefined) {
      throw new Error('expected member');
    }
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const messages = new InMemoryMessageStore();
    const profileId = '11111111-1111-4111-8111-111111111111';
    await messages.create({
      id: profileId,
      accountId: 'zzz',
      name: 'Bob',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    await auth.updateAccount({
      ...zzz,
      lightningAddress: 'bob@walletofsatoshi.com',
      profileMessageId: profileId,
    });
    await ensureAccountNostrKey(auth, 'zzz', kek);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('plat', 'zzz', new Date(now()));
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await withNip57True(async () =>
      app.request(`/conversations/${thread.id}/invoice`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('lets staff invoice when the platform account is accountB', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'aaa');
    const aaa = await auth.getAccount('aaa');
    if (aaa === undefined) {
      throw new Error('expected member');
    }
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const messages = new InMemoryMessageStore();
    const profileId = '11111111-1111-4111-8111-111111111111';
    await messages.create({
      id: profileId,
      accountId: 'aaa',
      name: 'Bob',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    await auth.updateAccount({
      ...aaa,
      lightningAddress: 'bob@walletofsatoshi.com',
      profileMessageId: profileId,
    });
    await ensureAccountNostrKey(auth, 'aaa', kek);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('aaa', 'plat', new Date(now()));
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await withNip57True(async () =>
      app.request(`/conversations/${thread.id}/invoice`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when the counterpart has a Lightning Address but no profile note', async () => {
    const auth = await seeded();
    await withOther(auth);
    const other = await auth.getAccount('other');
    if (other === undefined) {
      throw new Error('expected counterpart');
    }
    await auth.updateAccount({
      ...other,
      lightningAddress: 'bob@walletofsatoshi.com',
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
  });

  it('lets staff invoice a member_platform thread when no platform account exists', async () => {
    const auth = await seeded('moderator');
    await withOther(auth, 'someone');
    const someone = await auth.getAccount('someone');
    if (someone === undefined) {
      throw new Error('expected member');
    }
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const messages = new InMemoryMessageStore();
    const profileId = '11111111-1111-4111-8111-111111111111';
    await messages.create({
      id: profileId,
      accountId: 'someone',
      name: 'Bob',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    await auth.updateAccount({
      ...someone,
      lightningAddress: 'bob@walletofsatoshi.com',
      profileMessageId: profileId,
    });
    await ensureAccountNostrKey(auth, 'someone', kek);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await withNip57True(async () =>
      app.request(`/conversations/${thread.id}/invoice`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      }),
    );
    expect(res.status).toBe(200);
  });

  it('returns 400 when the counterpart account is missing', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'ghost', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('returns 400 when the counterpart has no Lightning Address', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('returns 400 when the sender has no name', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const acc = await auth.getAccount('acc');
    if (acc === undefined) {
      throw new Error('expected payer');
    }
    await auth.updateAccount({ ...acc, name: null });
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Set a name before posting' });
  });

  it('returns 400 when the profile note is unsigned', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const other = await auth.getAccount('other');
    if (other === undefined) {
      throw new Error('expected counterpart');
    }
    const unsignedId = '22222222-2222-4222-8222-222222222222';
    await messages.create({
      id: unsignedId,
      accountId: 'other',
      name: 'Bob',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await auth.updateAccount({ ...other, profileMessageId: unsignedId });
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 when the counterpart has no nostr key', async () => {
    const auth = await seeded();
    await withOther(auth);
    const other = await auth.getAccount('other');
    if (other === undefined) {
      throw new Error('expected counterpart');
    }
    const messages = new InMemoryMessageStore();
    const profileId = '11111111-1111-4111-8111-111111111111';
    await messages.create({
      id: profileId,
      accountId: 'other',
      name: 'Bob',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    await auth.updateAccount({
      ...other,
      lightningAddress: 'bob@walletofsatoshi.com',
      profileMessageId: profileId,
    });
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${thread.id}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 when nostrKek is missing', async () => {
    const { auth, conversations, messages, threadId } = await payableThread();
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
  });

  it('returns 429 when the invoice limiter trips', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request(`/conversations/${threadId}/invoice`, {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    await withNip57True(async () => {
      expect(await hit()).toBe(200);
    });
    expect(await hit()).toBe(429);
  });

  it('returns 503 when signing the zap request fails', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const sign = await import('@/lib/nostr/sign');
    const spy = vi.spyOn(sign, 'signEventForAccount').mockRejectedValue(new Error('sign'));
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request(`/conversations/${threadId}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    spy.mockRestore();
    expect(res.status).toBe(503);
  });

  it('returns 400 when LNURL does not support zaps', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ status: 'ERROR' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request(`/conversations/${threadId}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('returns 400 when LNURL is unreachable after zap metadata', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const fetchImpl: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 10_000_000_000,
            allowsNostr: true,
            nostrPubkey: 'aa'.repeat(32),
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('nope', { headers: { 'content-type': 'text/plain' } });
    };
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request(`/conversations/${threadId}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Could not start the Bitcoin payment' });
  });

  it('returns 400 when the bolt11 is not NIP-57', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request(`/conversations/${threadId}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('returns 400 when a decoded bolt11 is still not NIP-57', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const bolt11 = await import('@/lib/bolt11');
    const inspectSpy = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'aa'.repeat(32),
      amountMsat: 21_000,
      description: 'zap',
      descriptionHash: 'bb'.repeat(32),
      expirySeconds: 600,
    });
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request(`/conversations/${threadId}/invoice`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    inspectSpy.mockRestore();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "The author's wallet cannot receive this Bitcoin payment",
    });
  });

  it('returns pr, amountSats, and messageId on success', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: messages,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const bolt11 = await import('@/lib/bolt11');
    const inspectSpy = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'aa'.repeat(32),
      amountMsat: 21_000,
      description: 'zap',
      descriptionHash: 'bb'.repeat(32),
      expirySeconds: 600,
    });
    const res = await withNip57True(async () =>
      app.request(`/conversations/${threadId}/invoice`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21, text: 'cheers' }),
      }),
    );
    inspectSpy.mockRestore();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pr: string; amountSats: number; messageId: string };
    expect(body.pr).toBe('lnbc21n1test');
    expect(body.amountSats).toBe(21);
    expect(body.messageId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('returns 503 when recording an ok invoice attempt throws', async () => {
    const { auth, conversations, messages, threadId, kek } = await payableThread();
    const messageStore: MessageStore = new Proxy(messages, {
      get(target, prop) {
        if (prop === 'recordInvoiceAttempt') {
          return () => Promise.reject(new Error('disk'));
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function'
          ? (value as (...args: never[]) => unknown).bind(target)
          : value;
      },
    });
    const bolt11 = await import('@/lib/bolt11');
    const inspectSpy = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'aa'.repeat(32),
      amountMsat: 21_000,
      description: 'zap',
      descriptionHash: 'bb'.repeat(32),
      expirySeconds: 600,
    });
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore,
        now,
        nostrKek: kek,
        fetchImpl: lnurlFetchImpl(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await withNip57True(async () =>
      app.request(`/conversations/${threadId}/invoice`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      }),
    );
    inspectSpy.mockRestore();
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: 'Conversations are unavailable' });
    expect(body).not.toHaveProperty('pr');
  });

  it('returns 503 when listing the thread throws', async () => {
    const { auth, messages, threadId } = await payableThread();
    const conversations = {
      getById: () => Promise.reject(new Error('down')),
    } as unknown as InMemoryConversationStore;
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(503);
  });

  it('still 400s when recording a bad body fails', async () => {
    const { auth, conversations, threadId } = await payableThread();
    const messages = {
      recordInvoiceAttempt: () => Promise.reject(new Error('disk')),
    } as unknown as InMemoryMessageStore;
    const res = await mount(auth, conversations, messages).request(
      `/conversations/${threadId}/invoice`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /conversations/:id?sinceMessageId=', () => {
  it('returns 400 when sinceMessageId is not a uuid', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(
      `/conversations/${thread.id}?sinceMessageId=nope`,
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected sinceMessageId to be a UUID' });
  });

  it('returns 200 without the id after a zero timeout', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: new InMemoryMessageStore(),
        now,
        waitTimeoutMs: 0,
        waitSleep: async () => undefined,
      }),
    );
    const missing = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const res = await app.request(`/conversations/${thread.id}?sinceMessageId=${missing}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.some((row) => row.id === missing)).toBe(false);
  });

  it('polls until the gift id appears', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const giftId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    let ticks = 0;
    const clock = { t: 0 };
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: new InMemoryMessageStore(),
        now: () => clock.t,
        waitTimeoutMs: 5,
        waitPollMs: 1,
        waitSleep: async () => {
          ticks += 1;
          clock.t += 1;
          if (ticks === 1) {
            await conversations.appendMessage({
              id: giftId,
              conversationId: thread.id,
              text: '',
              createdAt: new Date(now()),
              senderAccountId: 'acc',
              senderPubkey: null,
              name: 'Ada',
              sats: 21,
              eventId: null,
              nostrPublishState: 'skipped',
              nostrEvent: null,
              claimedUntil: null,
            });
          }
        },
      }),
    );
    const res = await app.request(`/conversations/${thread.id}?sinceMessageId=${giftId}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ id: string }> };
    expect(body.messages.some((row) => row.id === giftId)).toBe(true);
  });

  it('returns a newest gift immediately and pages to the remaining older row', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const giftId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    for (let i = 0; i < CONVERSATION_LIST_LIMIT; i += 1) {
      await conversations.appendMessage({
        id: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
        conversationId: thread.id,
        text: 'old',
        createdAt: new Date(now() + i),
        senderAccountId: 'acc',
        senderPubkey: null,
        name: 'Ada',
        sats: 0,
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      });
    }
    await conversations.appendMessage({
      id: giftId,
      conversationId: thread.id,
      text: '',
      createdAt: new Date(now() + CONVERSATION_LIST_LIMIT),
      senderAccountId: 'acc',
      senderPubkey: null,
      name: 'Ada',
      sats: 21,
      eventId: null,
      nostrPublishState: 'skipped',
      nostrEvent: null,
      claimedUntil: null,
    });
    let slept = 0;
    const clock = { t: 0 };
    const app = new Hono().route(
      '/conversations',
      conversationRoutes({
        store: conversations,
        authStore: auth,
        messageStore: new InMemoryMessageStore(),
        now: () => clock.t,
        waitTimeoutMs: 5,
        waitPollMs: 1,
        waitSleep: async () => {
          slept += 1;
          clock.t += 1;
        },
      }),
    );
    const res = await app.request(`/conversations/${thread.id}?sinceMessageId=${giftId}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(slept).toBe(0);
    const body = (await res.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(body.messages).toHaveLength(CONVERSATION_LIST_LIMIT);
    expect(body.messages.some((row) => row.id === giftId)).toBe(true);
    expect(body.nextCursor).toBeDefined();

    const older = await app.request(
      `/conversations/${thread.id}?cursor=${encodeURIComponent(body.nextCursor ?? '')}`,
      { headers: AUTH },
    );
    expect(older.status).toBe(200);
    const olderBody = (await older.json()) as {
      messages: Array<{ id: string }>;
      nextCursor?: string;
    };
    expect(olderBody.messages.map((row) => row.id)).toEqual([
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(olderBody).not.toHaveProperty('nextCursor');
  });
});
