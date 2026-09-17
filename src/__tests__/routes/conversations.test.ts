import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import type { SpendPing } from '@/lib/spend-ping';
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
const AUTH = { authorization: 'Bearer tok' };
const NOTE_ID = '00000000-0000-4000-8000-000000000001';
const LIVING_ROOM_POST_ID = '00000000-0000-4000-8000-0000000000aa';

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

function mount(
  authStore: InMemoryAuthStore,
  conversations = new InMemoryConversationStore(),
  messages = new InMemoryMessageStore(),
  spendPing?: SpendPing,
): Hono {
  return new Hono().route(
    '/conversations',
    conversationRoutes({
      store: conversations,
      authStore,
      messageStore: messages,
      now,
      ...(spendPing === undefined ? {} : { spendPing }),
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
        accountId?: string;
      }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.kind).toBe('member_platform');
    expect(body.conversations[0]?.lastFromMe).toBe(true);
    expect(body.conversations[0]?.lastText).toBe('help');
    expect(body.conversations[0]?.accountId).toBe('plat');
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

  it('omits a platform thread when staff sees only a platform send', async () => {
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
    expect(body.conversations.filter((c) => c.kind !== 'moderator_group')).toHaveLength(0);
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
    const listed = body.conversations.filter((c) => c.kind !== 'moderator_group');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastFromMe).toBe(false);
  });

  it('sets lastFromMe true when staff views a platform-sent last message after a member send', async () => {
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
    const listed = body.conversations.filter((c) => c.kind !== 'moderator_group');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastFromMe).toBe(true);
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
    const listed = body.conversations.filter((c) => c.kind !== 'moderator_group');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('Bob');
    expect(listed[0]?.accountId).toBe('someone');
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
    const listedNoPlat = noPlat.conversations.filter((c) => c.kind !== 'moderator_group');
    expect(listedNoPlat).toHaveLength(1);
    expect(listedNoPlat[0]?.name).toBe('Bob');
    expect(listedNoPlat[0]?.accountId).toBe('someone');
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
    const listed = body.conversations.filter((c) => c.kind !== 'moderator_group');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.name).toBe('Bob');
    expect(listed[0]?.accountId).toBe('other');
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
    const sortListed = sortBody.conversations.filter((c) => c.kind !== 'moderator_group');
    expect(sortListed).toHaveLength(1);
    expect(sortListed[0]?.name).toBe('Bob');
    expect(sortListed[0]?.accountId).toBe('zzz');
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
          lastSenderAccountId: null,
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
          lastSenderAccountId: null,
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
      accountId?: string;
    };
    expect(body.name).toBe('Bob');
    expect(body.kind).toBe('member_member');
    expect(body.id.length).toBeGreaterThan(8);
    expect(body.lastFromMe).toBe(false);
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
    expect(body.messages[0]?.fromMe).toBe(true);
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
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('returns 400 for a malformed JSON body', async () => {
    const auth = await seeded();
    const res = await mount(auth).request(`/conversations/${NOTE_ID}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON body with a "text" string' });
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
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('returns 400 when text is longer than 500 characters', async () => {
    const auth = await seeded();
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.openMemberMember('acc', 'other', new Date(now()));
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'a'.repeat(501) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
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
    expect(body.name).toBe('21.gifts');
    expect(body.text).toBe('official');
    expect(body.fromMe).toBe(true);
    expect(body.accountId).toBe('plat');
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
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
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('21.gifts');
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
    expect(rows[0]?.name).toBe('21.gifts');
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
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('21.gifts');
    const rows = await conversations.listMessages(thread.id, 10);
    expect(rows[0]?.senderAccountId).toBe('plat');
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
  it('lists the empty singleton named Moderators for a moderator', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    const res = await mount(auth).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      conversations: Array<{ kind: string; name: string; lastText: string }>;
    };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.kind).toBe('moderator_group');
    expect(body.conversations[0]?.name).toBe('Moderators');
    expect(body.conversations[0]?.lastText).toBe('');
  });

  it('still lists the empty moderator group when 200 newer threads exist', async () => {
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
        eventId: null,
        nostrPublishState: 'pending',
        nostrEvent: null,
        claimedUntil: null,
      });
    }
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ kind: string }> };
    expect(body.conversations.some((c) => c.kind === 'moderator_group')).toBe(true);
    expect(body.conversations[0]?.kind).toBe('moderator_group');
    expect(body.conversations.length).toBeLessThanOrEqual(200);
  });

  it('does not list the group for a founder and GET /:id is 404', async () => {
    const auth = await seeded('founder');
    await withPlatform(auth);
    const conversations = new InMemoryConversationStore();
    const thread = await conversations.ensureModeratorGroup('plat', new Date(now()));
    const list = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { conversations: Array<{ kind: string }> };
    expect(listed.conversations.some((c) => c.kind === 'moderator_group')).toBe(false);
    const get = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'Not found' });
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
    const res = await mount(auth, conversations, livingRoomStore(), spendPing).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
    expect(res.status).toBe(200);
    const created = (await res.json()) as { id: string };
    expect(spendPing.ping).toHaveBeenCalledTimes(1);
    expect(spendPing.ping).toHaveBeenCalledWith('ada@walletofsatoshi.com', created.id, 'moderator');
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
    const res = await mount(auth, conversations, new InMemoryMessageStore(), spendPing).request(
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
    const res = await mount(auth, conversations, livingRoomStore(), spendPing).request(
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
    const res = await mount(auth, conversations, livingRoomStore(yesterday), spendPing).request(
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
    const res = await mount(auth, conversations, livingRoomStore(), spendPing).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hello mods' }),
      },
    );
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
    const res = await mount(auth, conversations, messages, spendPing).request(
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
    const res = await mount(auth, conversations, new InMemoryMessageStore(), spendPing).request(
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
    const res = await mount(auth, conversations, new InMemoryMessageStore(), spendPing).request(
      `/conversations/${thread.id}`,
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ text: '   ' }),
      },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
    expect(spendPing.ping).not.toHaveBeenCalled();
  });
});
