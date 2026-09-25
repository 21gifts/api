import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryMessageStore } from '@/lib/message-store';
import { InMemoryNotificationStore } from '@/lib/notification-store';
import { unsignedNostrDefaults } from '@/lib/message';
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
});
