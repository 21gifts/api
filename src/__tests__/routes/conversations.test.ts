import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { unsignedNostrDefaults } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
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

function mount(
  authStore: InMemoryAuthStore,
  conversations = new InMemoryConversationStore(),
  messages = new InMemoryMessageStore(),
): Hono {
  return new Hono().route(
    '/conversations',
    conversationRoutes({ store: conversations, authStore, messageStore: messages, now }),
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

  it('lists the session threads newest last-message first', async () => {
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
    const body = (await res.json()) as { conversations: Array<{ name: string; lastText: string }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('Bob');
    expect(body.conversations[0]?.lastText).toBe('hi');
    expect(body.conversations[0]).not.toHaveProperty('accountId');
  });

  it('lets staff see platform threads they are not in', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth, 'someone');
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberPlatform('someone', 'plat', new Date(now()));
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ name: string }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('Bob');
  });

  it('names the counterpart when the viewer is accountB', async () => {
    const auth = await seeded();
    await withOther(auth, 'aaa');
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberMember('aaa', 'acc', new Date(now()));
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ name: string }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('Bob');
  });

  it('lets staff list a member_member thread where the platform is a party', async () => {
    const auth = await seeded('moderator');
    await withPlatform(auth);
    await withOther(auth);
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberMember('plat', 'other', new Date(now()));
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ name: string }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('21.gifts');
  });

  it('names a member_platform thread with a null platform party 21.gifts', async () => {
    const auth = await seeded();
    const conversations = new InMemoryConversationStore([
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
      },
    ]);
    const res = await mount(auth, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ name: string }> };
    expect(body.conversations).toHaveLength(1);
    expect(body.conversations[0]?.name).toBe('21.gifts');
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
    const body = (await res.json()) as { id: string; name: string };
    expect(body.name).toBe('Bob');
    expect(body.id.length).toBeGreaterThan(8);
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
    expect(((await res.json()) as { name: string }).name).toBe('21.gifts');
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
    const body = (await res.json()) as { name: string };
    expect(body.name).toMatch(/aa/);
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
    const body = (await res.json()) as { messages: Array<{ text: string }> };
    expect(body.messages.map((m) => m.text)).toEqual(['official']);
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
    const res = await mount(auth, conversations).request(`/conversations/${thread.id}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ text: string; name: string }> };
    expect(body.messages.map((m) => m.text)).toEqual(['first']);
    expect(body.messages[0]).not.toHaveProperty('eventId');
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
    const body = (await res.json()) as { text: string; name: string };
    expect(body.text).toBe('ping');
    expect(body.name).toBe('Ada');
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
    const body = (await res.json()) as { name: string; text: string };
    expect(body.name).toBe('21.gifts');
    expect(body.text).toBe('official');
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
      viewKey: 'c'.repeat(64),
      createdAt: 1,
      rulesAgreedAt: null,
      isPlatform: true,
    });
    await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
    const conversations = new InMemoryConversationStore();
    await conversations.openMemberPlatform('acc', 'plat', new Date(now()));
    const res = await mount(store, conversations).request('/conversations', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { conversations: Array<{ name: string }> };
    expect(body.conversations[0]?.name).toBe('21.gifts');
  });
});
