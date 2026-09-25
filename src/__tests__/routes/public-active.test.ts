import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryConversationStore } from '@/lib/conversation-store';
import { encodeMessageFeedCursor, unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { InMemoryPushStore } from '@/lib/push-store';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { messagesRoutes } from '@/routes/messages';

const now = (): number => 1_700_000_000_000;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

function mount(
  authStore: InMemoryAuthStore,
  store: InMemoryMessageStore,
  notifications?: InMemoryNotificationStore,
  extra?: {
    pushStore?: InMemoryPushStore;
    conversationStore?: InMemoryConversationStore;
  },
): Hono {
  return new Hono().route(
    '/messages',
    messagesRoutes({
      store,
      authStore,
      now,
      postLimiter: new PostRateLimiter(),
      invoiceLimiter: new InvoiceRateLimiter(),
      ...(notifications === undefined ? {} : { notificationStore: notifications }),
      ...(extra?.pushStore === undefined ? {} : { pushStore: extra.pushStore }),
      ...(extra?.conversationStore === undefined
        ? {}
        : { conversationStore: extra.conversationStore }),
    }),
  );
}

async function poster(): Promise<InMemoryAuthStore> {
  const auth = new InMemoryAuthStore();
  await auth.createAccount({
    id: 'ada',
    linkingKey: `02${'a'.repeat(64)}`,
    role: 'verified',
    name: 'Ada',
    lightningAddress: 'ada@walletofsatoshi.com',
    lightningAddressVerified: true,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: now(),
    username: 'ada',
  });
  await auth.createAccount({
    id: 'bob',
    linkingKey: `02${'b'.repeat(64)}`,
    role: 'basis',
    name: 'Bob',
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    location: null,
    viewKey: 'b'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: now(),
    username: 'bob',
  });
  await auth.createSession({ token: 'tok', accountId: 'ada', createdAt: now() });
  return auth;
}

describe('public active window', () => {
  it('pages the first 200 active notes without accountId and 401s past the window', async () => {
    const store = new InMemoryMessageStore();
    for (let n = 1; n <= 201; n += 1) {
      await store.create({
        id: id(n),
        accountId: 'ada',
        name: 'Ada',
        text: `n${n}`,
        createdAt: new Date(n * 1000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        sats: 1,
      });
    }
    const app = mount(new InMemoryAuthStore(), store);
    const first = await app.request('/messages?mode=active&limit=200');
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      messages: Array<{ accountId?: string }>;
      nextCursor?: string;
    };
    expect(page.messages).toHaveLength(200);
    expect(page.messages[0]).not.toHaveProperty('accountId');
    expect(page.nextCursor).toBeTypeOf('string');
    const past = await app.request(`/messages?mode=active&cursor=${page.nextCursor ?? ''}`);
    expect(past.status).toBe(401);
    expect((await app.request('/messages')).status).toBe(401);
    expect((await app.request('/messages?mode=all')).status).toBe(401);
    expect((await app.request('/messages?mode=active&hashtag=shop')).status).toBe(401);
    expect(
      (await app.request('/messages?mode=active', { headers: { authorization: 'Bearer no' } }))
        .status,
    ).toBe(401);
  }, 20_000);

  it('serves an external author, a short page, and the error paths', async () => {
    const store = new InMemoryMessageStore();
    await store.create({
      id: id(1),
      accountId: null,
      name: 'Visitor',
      text: 'outside',
      createdAt: new Date(10_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      authorPubkey: 'ab'.repeat(32),
      sats: 1,
    });
    for (let n = 2; n <= 4; n += 1) {
      await store.create({
        id: id(n),
        accountId: 'ada',
        name: 'Ada',
        text: `n${String(n)}`,
        createdAt: new Date(n * 1000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        sats: 1,
      });
    }
    const app = mount(new InMemoryAuthStore(), store);
    const first = await app.request('/messages?mode=active&limit=1');
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      messages: Array<{ accountId?: string }>;
      nextCursor?: string;
    };
    expect(page.messages[0]).not.toHaveProperty('accountId');
    expect(page.nextCursor).toBeTypeOf('string');
    const inside = await app.request(
      `/messages?mode=active&limit=1&cursor=${page.nextCursor ?? ''}`,
    );
    expect(inside.status).toBe(200);
    expect((await app.request('/messages?mode=active&limit=0')).status).toBe(400);
    expect((await app.request('/messages?mode=active&limit=no')).status).toBe(400);
    expect((await app.request('/messages?mode=active&cursor=nope')).status).toBe(400);
    expect((await app.request('/messages?mode=nope')).status).toBe(401);
    class Boom extends InMemoryMessageStore {
      override listFeed(): Promise<never> {
        return Promise.reject(new Error('boom'));
      }
    }
    expect(
      (await mount(new InMemoryAuthStore(), new Boom()).request('/messages?mode=active')).status,
    ).toBe(503);
  });

  it('stores a mark and notifies the other person once', async () => {
    const auth = await poster();
    const notes = new InMemoryNotificationStore();
    const app = mount(auth, new InMemoryMessageStore(), notes);
    const res = await app.request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi @Bob @bob @nobody' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mentions?: { username: string; accountId: string }[] };
    expect(body.mentions).toEqual([{ username: 'bob', accountId: 'bob' }]);
    const rows = (await notes.listByRecipient('bob', 10)).filter(
      (row) => row.type === 'forum_mention',
    );
    expect(rows).toHaveLength(1);
    const self = await notes.listByRecipient('ada', 10);
    expect(self.filter((row) => row.type === 'forum_mention')).toHaveLength(0);
  });

  it('marks a reply, skips a vanished parent, and still answers when notify throws', async () => {
    const auth = await poster();
    const store = new InMemoryMessageStore();
    const parentId = id(20);
    await store.create({
      id: parentId,
      accountId: 'ada',
      name: 'Ada',
      text: 'parent',
      createdAt: new Date(1),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 0,
    });
    const quiet = await mount(auth, store).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'reply @bob', inReplyTo: parentId }),
    });
    expect(quiet.status).toBe(200);
    const paidId = id(21);
    await store.create({
      id: paidId,
      accountId: 'ada',
      name: 'Ada',
      text: 'paid',
      createdAt: new Date(2),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 5,
    });
    const paid = await mount(auth, store, new InMemoryNotificationStore(), {
      pushStore: new InMemoryPushStore(),
      conversationStore: new InMemoryConversationStore(),
    }).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'paid @bob', inReplyTo: paidId }),
    });
    expect(paid.status).toBe(200);
    const goneId = id(22);
    await store.create({
      id: goneId,
      accountId: 'ada',
      name: 'Ada',
      text: 'gone',
      createdAt: new Date(3),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 1,
    });
    const original = store.getById.bind(store);
    let reads = 0;
    store.getById = (messageId: string): Promise<MessageRow | undefined> => {
      reads += 1;
      if (reads > 1) {
        return Promise.resolve(undefined);
      }
      return original(messageId);
    };
    const gone = await mount(auth, store).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'gone @bob', inReplyTo: goneId }),
    });
    expect(gone.status).toBe(200);
    vi.spyOn(auth, 'listAccounts').mockRejectedValue(new Error('down'));
    const failed = await mount(auth, new InMemoryMessageStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still @bob' }),
    });
    expect(failed.status).toBe(200);
  });

  it('pages a short public list, an external pin, and the odd cursors', async () => {
    const auth = await poster();
    const store = new InMemoryMessageStore([
      {
        id: id(30),
        accountId: null,
        name: 'Visitor',
        text: 'clip',
        createdAt: new Date(5_000),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
        hasVideo: true,
        videoContentType: 'video/mp4',
        authorPubkey: 'cd'.repeat(32),
        sats: 1,
      },
    ]);
    await store.create({
      id: id(31),
      accountId: 'ada',
      name: 'Ada',
      text: 'kept',
      createdAt: new Date(4_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      sats: 1,
      place: { lat: 1, lng: 2, label: 'Till' },
    });
    await store.create({
      id: id(32),
      accountId: null,
      name: 'Visitor',
      text: 'pin',
      createdAt: new Date(3_000),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      authorPubkey: 'ef'.repeat(32),
      sats: 1,
      place: { lat: 3, lng: 4, label: 'Outside' },
    });
    const app = mount(auth, store);
    const page = await app.request('/messages?mode=active');
    expect(page.status).toBe(200);
    const body = (await page.json()) as { messages: Array<{ id: string }>; nextCursor?: string };
    expect(body.messages.map((row) => row.id)).toEqual([id(31), id(32)]);
    expect(body.nextCursor).toBeUndefined();
    const note = await app.request(`/messages/${id(31)}`, {
      headers: { authorization: 'Bearer tok' },
    });
    expect(note.status).toBe(200);
    expect((await note.json()) as { accountId?: string }).toMatchObject({ accountId: 'ada' });
    const places = await app.request('/messages/places', {
      headers: { authorization: 'Bearer tok' },
    });
    expect(places.status).toBe(200);
    const listed = (await places.json()) as {
      places: Array<{ id: string; accountId?: string }>;
    };
    expect(listed.places.map((row) => row.id)).toEqual([id(31), id(32)]);
    expect(listed.places[0]?.accountId).toBe('ada');
    expect(listed.places[1]).not.toHaveProperty('accountId');
    expect((await app.request('/messages?mode=active&limit=10000')).status).toBe(400);
    const popular = encodeMessageFeedCursor({
      k: 's',
      s: 1,
      c: new Date(0).toISOString(),
      i: id(31),
    });
    expect((await app.request(`/messages?mode=active&cursor=${popular}`)).status).toBe(400);
    const missing = encodeMessageFeedCursor({
      k: 't',
      c: new Date(0).toISOString(),
      i: id(99),
    });
    expect((await app.request(`/messages?mode=active&cursor=${missing}`)).status).toBe(401);
  });
});
