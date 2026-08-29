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
    createdAt: 1_000_000,
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
    // Advance clock via a second create with a later now by posting after
    // mutating through a dedicated store create with a later timestamp.
    await messageStore.create({
      id: 'later',
      accountId: 'acc',
      name: 'Ada',
      text: 'newer',
      createdAt: new Date(now() + 1_000),
      ...unsignedNostrDefaults(),
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
      ...unsignedNostrDefaults(),
      eventId: 'ee'.repeat(32),
    });
    const res = await mount(authStore, messageStore).request('/messages', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { messages: Array<{ payable: boolean }> };
    expect(body.messages[0]?.payable).toBe(true);
  });

  it('returns 503 and logs when listLatest throws', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('boom');
    };
    const throwing: MessageStore = {
      listLatest: boom,
      create: boom,
      getById: boom,
      getByEventId: boom,
      claimUnsigned: boom,
      claimUnpublished: boom,
      listPendingSigned: boom,
      clearSignedEvent: boom,
      updateSignedEvent: boom,
      updatePublishState: boom,
      addSats: boom,
      recordZapReceipt: boom,
    };
    const res = await mount(await seededStore(), throwing).request('/messages', {
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

  it('posts and then lists the message', async () => {
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
      accountId?: string;
    };
    expect(created.name).toBe('Ada');
    expect(created.text).toBe('hello world');
    expect(created.createdAt).toBe(new Date(now()).toISOString());
    expect(created.sats).toBe(0);
    expect(created.payable).toBe(false);
    expect(created.accountId).toBeUndefined();
    expect(created.id.length).toBeGreaterThan(8);

    const list = await app.request('/messages', { headers: AUTH });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { messages: (typeof created)[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toEqual(created);
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
      error: 'Expected a JSON body with a "text" string',
    });
  });

  it('rejects a body without a text field', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Expected a JSON body with a "text" string',
    });
  });

  it('rejects empty text', async () => {
    const res = await mount(await namedStore('Ada')).request('/messages', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Text must be 1–500 characters' });
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

  it('returns 503 and logs when create throws', async () => {
    const boom = async (): Promise<never> => {
      throw new Error('boom');
    };
    const throwing: MessageStore = {
      listLatest: async () => [],
      create: boom,
      getById: boom,
      getByEventId: boom,
      claimUnsigned: boom,
      claimUnpublished: boom,
      listPendingSigned: boom,
      clearSignedEvent: boom,
      updateSignedEvent: boom,
      updatePublishState: boom,
      addSats: boom,
      recordZapReceipt: boom,
    };
    const res = await mount(await namedStore('Ada'), throwing).request('/messages', {
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
      ...unsignedNostrDefaults(),
    });
    await messageStore.create({
      id: '77777777-7777-4777-8777-777777777777',
      accountId: 'acc',
      name: 'Ada',
      text: 'payable',
      createdAt: new Date(now()),
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
    const res = await app.request('/messages/m1/invoice', {
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
    const res = await app.request('/messages/11111111-1111-4111-8111-111111111111/invoice', {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ sats: 21 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pr: 'lnbc21n1test', amountSats: 21 });
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
      createdAt: 1_000_001,
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
});
