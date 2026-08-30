import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { InMemoryMessageStore, type MessageStore } from '@/lib/message-store';
import { MESSAGE_MAX_LENGTH, unsignedNostrDefaults } from '@/lib/message';
import { InvoiceRateLimiter, PostRateLimiter } from '@/lib/nostr/rate-limit';
import { messagesRoutes } from '@/routes/messages';

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
const LINKING_KEY = `02${'a'.repeat(64)}`;

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const JPEG_B64 = Buffer.from(JPEG_BYTES).toString('base64');

function mount(
  authStore: InMemoryAuthStore,
  store: MessageStore = new InMemoryMessageStore(),
): Hono {
  return new Hono().route(
    '/messages',
    messagesRoutes({
      store,
      authStore,
      now,
      postLimiter: new PostRateLimiter(),
      invoiceLimiter: new InvoiceRateLimiter(),
    }),
  );
}

/** A store with a signed-in account `acc` reachable via session `tok`. */
async function seededStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: 'acc',
    linkingKey: LINKING_KEY,
    role: 'basis',
    name: null,
    lightningAddress: null,
    lightningAddressVerified: false,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1_000_000,
    rulesAgreedAt: null,
  });
  await store.createSession({ token: 'tok', accountId: 'acc', createdAt: now() });
  return store;
}

async function namedStore(name: string): Promise<InMemoryAuthStore> {
  const store = await seededStore();
  const existing = await store.getAccount('acc');
  expect(existing).toBeDefined();
  if (existing === undefined) {
    throw new Error('expected account');
  }
  await store.updateAccount({ ...existing, name });
  return store;
}

function throwingStore(overrides: Partial<MessageStore> = {}): MessageStore {
  const boom = async (): Promise<never> => {
    throw new Error('boom');
  };
  return {
    listLatest: boom,
    create: boom,
    getPhoto: boom,
    getById: boom,
    getByEventId: boom,
    claimUnsigned: boom,
    claimUnpublished: boom,
    listPendingSigned: boom,
    listSignedMissingPhoto: boom,
    clearSignedEvent: boom,
    resetSignedEvent: boom,
    updateSignedEvent: boom,
    updatePublishState: boom,
    addSats: boom,
    recordZapReceipt: boom,
    recordInvoiceAttempt: boom,
    listInvoiceAttempts: boom,
    recordZapIngest: boom,
    listZapIngests: boom,
    ...overrides,
  };
}

describe('GET /messages', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      headers: { authorization: 'Basic abc' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      headers: { authorization: 'Bearer    ' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(401);
  });

  it('returns an empty list', async () => {
    const res = await mount(await seededStore()).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
  });

  it('returns newest first', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    const app = mount(authStore, messageStore);
    const first = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'older' }),
    });
    expect(first.status).toBe(200);
    await messageStore.create({
      id: 'later',
      accountId: 'acc',
      name: 'Ada',
      text: 'newer',
      createdAt: new Date(now() + 1_000),
      ...unsignedNostrDefaults(),
      hasPhoto: false,
    });
    const res = await app.request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ text: string }> };
    expect(body.messages.map((m) => m.text)).toEqual(['newer', 'older']);
  });

  it('marks a signed note with a Lightning Address as payable', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'pay-1',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean; role: string }> };
    expect(body.messages[0]?.payable).toBe(true);
    expect(body.messages[0]?.role).toBe('basis');
  });

  it('includes the live author role for moderator, founder, and verified', async () => {
    for (const role of ['moderator', 'founder', 'verified'] as const) {
      const authStore = await namedStore('Ada');
      const account = await authStore.getAccount('acc');
      expect(account).toBeDefined();
      if (account === undefined) {
        throw new Error('expected account');
      }
      await authStore.updateAccount({ ...account, role });
      const messageStore = new InMemoryMessageStore();
      await messageStore.create({
        id: `msg-${role}`,
        accountId: 'acc',
        name: 'Ada',
        text: 'hi',
        createdAt: new Date(now()),
        hasPhoto: false,
        ...unsignedNostrDefaults(),
      });
      const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { messages: Array<{ role: string }> };
      expect(body.messages[0]?.role).toBe(role);
    }
  });

  it('marks a signed note without a Lightning Address as not payable', async () => {
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'nopay',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'aa'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean; role: string }> };
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]?.role).toBe('basis');
  });

  it('defaults role to basis and payable to false when the author is missing', async () => {
    const authStore = await seededStore();
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'orphan',
      accountId: 'gone',
      name: 'Ghost',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ff'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean; role: string }> };
    expect(body.messages[0]?.payable).toBe(false);
    expect(body.messages[0]?.role).toBe('basis');
  });

  it('returns 503 and logs when listLatest throws', async () => {
    const res = await mount(await seededStore(), throwingStore()).request('/messages', {
      headers: AUTH,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.list.failed')).toBe(true);
  });
});

describe('POST /messages', () => {
  it('returns 429 on a burst of posts', async () => {
    const limiter = new PostRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await namedStore('Ada'),
        now,
        postLimiter: limiter,
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ text: 'hi' }),
        })
      ).status;
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(429);
  });

  it('returns 401 without an Authorization header', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an empty bearer token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer    ', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 for an unknown token', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages', {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('posts and then lists the message with hasPhoto false', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '  hello world  ' }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      name: string;
      text: string;
      createdAt: string;
      sats: number;
      payable: boolean;
      hasPhoto: boolean;
      role: string;
      accountId?: string;
    };
    expect(created.name).toBe('Ada');
    expect(created.text).toBe('hello world');
    expect(created.hasPhoto).toBe(false);
    expect(created.createdAt).toBe(new Date(now()).toISOString());
    expect(created.sats).toBe(0);
    expect(created.payable).toBe(false);
    expect(created.role).toBe('basis');
    expect(created.accountId).toBeUndefined();
    expect(created.id.length).toBeGreaterThan(8);

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: (typeof created)[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual(created);
  });

  it('includes the session account role on POST', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({ ...account, role: 'moderator' });
    const res = await mount(authStore).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { role: string };
    expect(body.role).toBe('moderator');
  });

  it('rejects posting without a name', async () => {
    const res = await mount(await seededStore()).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Set a name before posting' });
  });

  it('rejects posting with a whitespace-only name', async () => {
    const res = await mount(await namedStore('   ')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Set a name before posting' });
  });

  it('rejects invalid JSON', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with text and/or photo',
    });
  });

  it('rejects a body without text or photo', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with text and/or photo',
    });
  });

  it('rejects whitespace-only text without a photo', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Text must be 1–500 characters or include a photo',
    });
  });

  it('rejects too-long text', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'A'.repeat(MESSAGE_MAX_LENGTH + 1) }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('rejects a tab in text', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello\tworld' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
  });

  it('posts a photo-only message and serves the bytes', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      text: string;
      hasPhoto: boolean;
    };
    expect(created.text).toBe('');
    expect(created.hasPhoto).toBe(true);

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: Array<{ hasPhoto: boolean }> };
    expect(body.messages[0]?.hasPhoto).toBe(true);

    const photo = await app.request(`/messages/${created.id}/photo`, { headers: AUTH });
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(photo.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('posts text together with a photo and serves both', async () => {
    const app = mount(await namedStore('Ada'));
    const post = await app.request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '  hello with photo  ',
        photo: { contentType: 'image/jpeg', data: JPEG_B64 },
      }),
    });
    expect(post.status).toBe(200);
    const created = (await post.json()) as {
      id: string;
      text: string;
      hasPhoto: boolean;
    };
    expect(created.text).toBe('hello with photo');
    expect(created.hasPhoto).toBe(true);

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      messages: Array<{ id: string; text: string; hasPhoto: boolean }>;
    };
    expect(body.messages[0]).toMatchObject({
      id: created.id,
      text: 'hello with photo',
      hasPhoto: true,
    });

    const photo = await app.request(`/messages/${created.id}/photo`, { headers: AUTH });
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('rejects a bad photo payload', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        photo: {
          contentType: 'image/gif',
          data: Buffer.from([0x47, 0x49, 0x46, 0x38]).toString('base64'),
        },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Photo must be a JPEG, PNG, or WebP under 1 MiB',
    });
  });

  it('returns 503 and logs when create throws', async () => {
    const res = await mount(
      await namedStore('Ada'),
      throwingStore({
        listLatest: async () => [],
      }),
    ).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.create.failed')).toBe(true);
  });
});

describe('POST /messages/:id/invoice', () => {
  it('returns 429 on a burst of invoice requests', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '55555555-5555-4555-8555-555555555555',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
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
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages/55555555-5555-4555-8555-555555555555/invoice', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    expect(await hit()).toBe(200);
    expect(await hit()).toBe(429);
  });

  it('does not consume the invoice limiter on a missing id', async () => {
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (): Promise<number> =>
      (
        await app.request('/messages/00000000-0000-4000-8000-000000000001/invoice', {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    expect(await hit()).toBe(404);
    expect(await hit()).toBe(404);
  });

  it('does not consume the invoice limiter on an unpayable note', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '66666666-6666-4666-8666-666666666666',
      accountId: 'acc',
      name: 'Ada',
      text: 'unsigned',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '77777777-7777-4777-8777-777777777777',
      accountId: 'acc',
      name: 'Ada',
      text: 'payable',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
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
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const limiter = new InvoiceRateLimiter();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: limiter,
      }),
    );
    const hit = async (id: string): Promise<number> =>
      (
        await app.request(`/messages/${id}/invoice`, {
          method: 'POST',
          headers: { ...AUTH, 'content-type': 'application/json' },
          body: JSON.stringify({ sats: 21 }),
        })
      ).status;
    expect(await hit('66666666-6666-4666-8666-666666666666')).toBe(400);
    expect(await hit('66666666-6666-4666-8666-666666666666')).toBe(400);
    expect(await hit('77777777-7777-4777-8777-777777777777')).toBe(200);
  });

  it('returns 400 for a non-integer sats body', async () => {
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore: await namedStore('Ada'),
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 1.5 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 401 without a session', async () => {
    const res = await mount(new InMemoryAuthStore()).request('/messages/m1/invoice', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 503 without a KEK', async () => {
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await authStore.setNostrKeyIfAbsent('acc', {
      pubkey: 'aa'.repeat(32),
      ciphertext: new Uint8Array(16),
      kekId: 1,
      custody: 'custodial',
    });
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '88888888-8888-4888-8888-888888888888',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request(
      '/messages/88888888-8888-4888-8888-888888888888/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(res.status).toBe(503);
  });

  it('issues a zap invoice when the note is payable', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '11111111-1111-4111-8111-111111111111',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const prevPublishPublic = process.env['NOSTR_PUBLISH_PUBLIC'];
    delete process.env['NOSTR_PUBLISH_PUBLIC'];
    let callbackUrl: string | undefined;
    try {
      const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
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
        callbackUrl = url;
        return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
          headers: { 'content-type': 'application/json' },
        });
      };
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
      expect(callbackUrl).toBeDefined();
      const nostrParam = new URL(callbackUrl ?? '').searchParams.get('nostr');
      expect(nostrParam).toBeTruthy();
      const zapRequest = JSON.parse(nostrParam ?? '') as { tags: string[][] };
      const relaysTag = zapRequest.tags.find((tag) => tag[0] === 'relays');
      expect(relaysTag).toBeDefined();
      expect(relaysTag?.slice(1)).toContain('wss://relay.damus.io');
    } finally {
      if (prevPublishPublic === undefined) {
        delete process.env['NOSTR_PUBLISH_PUBLIC'];
      } else {
        process.env['NOSTR_PUBLISH_PUBLIC'] = prevPublishPublic;
      }
    }
  });

  it('ensures a Nostr key for a payer who has none yet', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    await authStore.createAccount({
      id: 'payer',
      linkingKey: `02${'b'.repeat(64)}`,
      role: 'basis',
      name: 'Bob',
      lightningAddress: null,
      lightningAddressVerified: false,
      forumLawsDismissed: false,
      viewKey: 'b'.repeat(64),
      createdAt: 1_000_001,
      rulesAgreedAt: null,
    });
    await authStore.createSession({ token: 'payer-tok', accountId: 'payer', createdAt: now() });
    expect(await authStore.getNostrPublicKey('payer')).toBeUndefined();
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '44444444-4444-4444-8444-444444444444',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
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
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/44444444-4444-4444-8444-444444444444/invoice', {
      method: 'POST',
      headers: {
        authorization: 'Bearer payer-tok',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
    expect(await authStore.getNostrPublicKey('payer')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns 400 when the note is unsigned', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '22222222-2222-4222-8222-222222222222',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/22222222-2222-4222-8222-222222222222/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the author has no Lightning Address', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: '33333333-3333-4333-8333-333333333333',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/33333333-3333-4333-8333-333333333333/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown message', async () => {
    const authStore = await namedStore('Ada');
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: new InMemoryMessageStore(),
        authStore,
        now,
        nostrKek: new Uint8Array(32).fill(1),
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/00000000-0000-4000-8000-000000000001/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(404);
  });

  it('persists an ok invoice attempt with pr and isNip57Invoice from inspect', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
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
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const bolt11 = await import('@/lib/bolt11');
    const inspectSpy = vi.spyOn(bolt11, 'inspectBolt11').mockReturnValue({
      paymentHash: 'aa'.repeat(32),
      amountMsat: 21_000,
      description: null,
      descriptionHash: 'bb'.repeat(32),
      expirySeconds: 86400,
    });
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(200);
      const attempts = await messageStore.listInvoiceAttempts(10);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.result).toBe('ok');
      expect(attempts[0]?.pr).toBe('lnbc21n1test');
      expect(attempts[0]?.httpStatus).toBe(200);
      expect(attempts[0]?.paymentHash).toBe('aa'.repeat(32));
      expect(attempts[0]?.descriptionHash).toBe('bb'.repeat(32));
      expect(attempts[0]?.zapRequest).not.toBeNull();
    } finally {
      inspectSpy.mockRestore();
    }
  });

  it('persists noZap and unreachable with pr null and http 400', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const noZapFetch = async (input: string | URL | Request): Promise<Response> => {
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
      return new Response('{}', { status: 500 });
    };
    const appNoZap = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl: noZapFetch,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const noZapRes = await appNoZap.request(
      '/messages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(noZapRes.status).toBe(400);
    expect((await messageStore.listInvoiceAttempts(1))[0]?.result).toBe('noZap');
    expect((await messageStore.listInvoiceAttempts(1))[0]?.pr).toBeNull();
    expect((await messageStore.listInvoiceAttempts(1))[0]?.httpStatus).toBe(400);

    const unreachableFetch = async (): Promise<Response> => new Response('{}', { status: 500 });
    const appUnreachable = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl: unreachableFetch,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const unreachableRes = await appUnreachable.request(
      '/messages/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/invoice',
      {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      },
    );
    expect(unreachableRes.status).toBe(400);
    const attempts = await messageStore.listInvoiceAttempts(2);
    expect(attempts.some((row) => row.result === 'unreachable')).toBe(true);
    expect(attempts.find((row) => row.result === 'unreachable')?.pr).toBeNull();
  });

  it('returns 404 for a non-uuid invoice id without persisting', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/not-a-uuid/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(404);
    expect(await messageStore.listInvoiceAttempts(10)).toHaveLength(0);
  });

  it('persists no_event when the note has no eventId', async () => {
    const kek = new Uint8Array(32).fill(2);
    const authStore = await namedStore('Ada');
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
    });
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store: messageStore,
        authStore,
        now,
        nostrKek: kek,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/cccccccc-cccc-4ccc-8ccc-cccccccccccc/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(400);
    const attempts = await messageStore.listInvoiceAttempts(10);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.result).toBe('no_event');
    expect(attempts[0]?.httpStatus).toBe(400);
  });

  it('still returns 200 when recordInvoiceAttempt throws after LNURL ok', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const base = new InMemoryMessageStore();
    await base.create({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const store: MessageStore = {
      listLatest: (limit) => base.listLatest(limit),
      create: (row, photo) => base.create(row, photo),
      getPhoto: (id) => base.getPhoto(id),
      getById: (id) => base.getById(id),
      getByEventId: (id) => base.getByEventId(id),
      claimUnsigned: (...args) => base.claimUnsigned(...args),
      claimUnpublished: (...args) => base.claimUnpublished(...args),
      listPendingSigned: (limit) => base.listPendingSigned(limit),
      listSignedMissingPhoto: (limit) => base.listSignedMissingPhoto(limit),
      clearSignedEvent: (...args) => base.clearSignedEvent(...args),
      resetSignedEvent: (...args) => base.resetSignedEvent(...args),
      updateSignedEvent: (...args) => base.updateSignedEvent(...args),
      updatePublishState: (...args) => base.updatePublishState(...args),
      addSats: (...args) => base.addSats(...args),
      recordZapReceipt: (...args) => base.recordZapReceipt(...args),
      recordInvoiceAttempt: async () => {
        throw new Error('persist boom');
      },
      listInvoiceAttempts: (limit) => base.listInvoiceAttempts(limit),
      recordZapIngest: (row) => base.recordZapIngest(row),
      listZapIngests: (limit) => base.listZapIngests(limit),
    };
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
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
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), {
        headers: { 'content-type': 'application/json' },
      });
    };
    const app = new Hono().route(
      '/messages',
      messagesRoutes({
        store,
        authStore,
        now,
        nostrKek: kek,
        fetchImpl,
        postLimiter: new PostRateLimiter(),
        invoiceLimiter: new InvoiceRateLimiter(),
      }),
    );
    const res = await app.request('/messages/dddddddd-dddd-4ddd-8ddd-dddddddddddd/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
    expect(parsedEvents(warn).some((e) => e['event'] === 'message.invoice.record_failed')).toBe(
      true,
    );
  });

  it('persists sign_failed when signing throws', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const signMod = await import('@/lib/nostr/sign');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const spy = vi.spyOn(signMod, 'signEventForAccount').mockRejectedValue(new Error('sign boom'));
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(503);
      const attempts = await messageStore.listInvoiceAttempts(10);
      expect(attempts[0]?.result).toBe('sign_failed');
      expect(attempts[0]?.httpStatus).toBe(503);
    } finally {
      spy.mockRestore();
    }
  });

  it('persists ok path with null zapRequest when the signed event is not an object', async () => {
    const { parseNostrKek } = await import('@/lib/nostr/kek');
    const { ensureAccountNostrKey } = await import('@/lib/nostr/keys');
    const signMod = await import('@/lib/nostr/sign');
    const kek = parseNostrKek('11'.repeat(32));
    const authStore = await namedStore('Ada');
    const account = await authStore.getAccount('acc');
    expect(account).toBeDefined();
    if (account === undefined) {
      throw new Error('expected account');
    }
    await authStore.updateAccount({
      ...account,
      lightningAddress: 'ada@walletofsatoshi.com',
    });
    await ensureAccountNostrKey(authStore, 'acc', kek);
    const messageStore = new InMemoryMessageStore();
    await messageStore.create({
      id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
      accountId: 'acc',
      name: 'Ada',
      text: 'hi',
      createdAt: new Date(now()),
      hasPhoto: false,
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const spy = vi
      .spyOn(signMod, 'signEventForAccount')
      .mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof signMod.signEventForAccount>>,
      );
    const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input);
      if (url.includes('/.well-known/lnurlp/')) {
        return new Response(
          JSON.stringify({
            callback: 'https://walletofsatoshi.com/lnurlp/callback',
            minSendable: 1000,
            maxSendable: 100000000000,
            allowsNostr: true,
            nostrPubkey: 'be1d89794bf92de5dd64c1e60f6a2c70c140abac9932418fee30c5c637fe9479',
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ pr: 'lnbc21n1test' }), { status: 200 });
    };
    try {
      const app = new Hono().route(
        '/messages',
        messagesRoutes({
          store: messageStore,
          authStore,
          now,
          nostrKek: kek,
          fetchImpl,
          postLimiter: new PostRateLimiter(),
          invoiceLimiter: new InvoiceRateLimiter(),
        }),
      );
      const res = await app.request('/messages/ffffffff-ffff-4fff-8fff-ffffffffffff/invoice', {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ sats: 21 }),
      });
      expect(res.status).toBe(200);
      const attempts = await messageStore.listInvoiceAttempts(10);
      expect(attempts[0]?.result).toBe('ok');
      expect(attempts[0]?.zapRequest).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('GET /messages/:id/photo', () => {
  it('returns 404 without an Authorization header when no photo exists', async () => {
    const res = await mount(new InMemoryAuthStore()).request(
      '/messages/00000000-0000-0000-0000-000000000000/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns bytes without a bearer when the photo exists', async () => {
    const store = new InMemoryMessageStore();
    await store.create(
      {
        id: '00000000-0000-4000-8000-000000000001',
        accountId: 'acc',
        name: 'Ada',
        text: '',
        createdAt: new Date(now()),
        hasPhoto: true,
        ...unsignedNostrDefaults(),
      },
      { contentType: 'image/jpeg', bytes: JPEG_BYTES },
    );
    const res = await mount(await seededStore(), store).request(
      '/messages/00000000-0000-4000-8000-000000000001/photo',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(JPEG_BYTES);
  });

  it('returns 404 when the photo is missing', async () => {
    const res = await mount(await seededStore()).request(
      '/messages/00000000-0000-0000-0000-000000000000/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
  });

  it('returns 404 for a non-UUID id without calling the store', async () => {
    const getPhoto = vi.fn(async () => {
      throw new Error('boom');
    });
    const res = await mount(await seededStore(), throwingStore({ getPhoto })).request(
      '/messages/not-a-uuid/photo',
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Photo not found' });
    expect(getPhoto).not.toHaveBeenCalled();
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.photo.failed')).toBe(false);
  });

  it('returns 503 and logs when getPhoto throws', async () => {
    const res = await mount(
      await seededStore(),
      throwingStore({
        listLatest: async () => [],
        create: async (row) => row,
      }),
    ).request('/messages/00000000-0000-0000-0000-000000000000/photo');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Messages are unavailable' });
    expect(parsedEvents(warn).some((e) => e['event'] === 'messages.photo.failed')).toBe(true);
  });
});
