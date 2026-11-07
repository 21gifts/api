import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { InMemoryAuthStore } from '@/lib/auth/store';
import { IpRateLimiter } from '@/lib/ip-rate-limit';
import { unsignedNostrDefaults, type MessageRow } from '@/lib/message';
import type { MessageInvoiceAttempt } from '@/lib/message-store';
import { HEART_LOOKUP_BODY_LIMIT_BYTES, walletHeartRoutes } from '@/routes/wallet-hearts';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const AUTHOR = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'wallet-heart-token';
const AUTH = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
};
const START = Date.parse('2026-10-01T12:00:00.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);
const HASH_D = 'd'.repeat(64);
const HASH_E = 'e'.repeat(64);
const HASH_F = 'f'.repeat(64);
const HASH_0 = '0'.repeat(64);
const HASH_1 = '1'.repeat(64);

class FakeMessages {
  readonly invoices = new Map<string, MessageInvoiceAttempt>();
  readonly notes = new Map<string, MessageRow>();

  findOkInvoiceByPaymentHash(paymentHash: string): Promise<MessageInvoiceAttempt | undefined> {
    return Promise.resolve(this.invoices.get(paymentHash));
  }

  getById(id: string): Promise<MessageRow | undefined> {
    return Promise.resolve(this.notes.get(id));
  }
}

class ThrowOnSecondHash extends FakeMessages {
  #calls = 0;

  override findOkInvoiceByPaymentHash(
    paymentHash: string,
  ): Promise<MessageInvoiceAttempt | undefined> {
    this.#calls += 1;
    if (this.#calls === 2) {
      return Promise.reject(new Error('lookup down'));
    }
    return super.findOkInvoiceByPaymentHash(paymentHash);
  }
}

class ThrowingGetById extends FakeMessages {
  override getById(): Promise<MessageRow | undefined> {
    return Promise.reject(new Error('lookup down'));
  }
}

async function authStore(): Promise<InMemoryAuthStore> {
  const store = new InMemoryAuthStore();
  await store.createAccount({
    id: ACCOUNT,
    linkingKey: null,
    role: 'verified',
    name: 'Ada',
    location: null,
    forumLawsDismissed: false,
    viewKey: 'a'.repeat(64),
    createdAt: 1,
    rulesAgreedAt: 1,
  });
  await store.createSession({ token: TOKEN, accountId: ACCOUNT, createdAt: START });
  return store;
}

function invoice(row: {
  paymentHash: string;
  messageId: string;
  payerAccountId: string;
  authorAccountId: string;
  heart: boolean;
}): MessageInvoiceAttempt {
  return {
    id: `inv-${row.paymentHash.slice(0, 8)}`,
    createdAt: new Date(START),
    messageId: row.messageId,
    payerAccountId: row.payerAccountId,
    authorAccountId: row.authorAccountId,
    amountSats: 1,
    lightningAddress: null,
    zapRequest: null,
    result: 'ok',
    httpStatus: 200,
    pr: 'lnbc1',
    paymentHash: row.paymentHash,
    description: null,
    descriptionHash: null,
    isNip57Invoice: true,
    lnurlResponse: null,
    heart: row.heart,
  };
}

function note(row: {
  id: string;
  name: string;
  text: string;
  deletedAt?: Date | null;
}): MessageRow {
  return {
    id: row.id,
    accountId: AUTHOR,
    name: row.name,
    text: row.text,
    createdAt: new Date(START),
    hasPhoto: false,
    ...unsignedNostrDefaults(),
    deletedAt: row.deletedAt === undefined ? null : row.deletedAt,
  };
}

async function mount(
  options: {
    now?: () => number;
    limiter?: IpRateLimiter;
    auth?: InMemoryAuthStore;
    messages?: FakeMessages;
  } = {},
): Promise<{ app: Hono; messages: FakeMessages }> {
  const messages = options.messages ?? new FakeMessages();
  const app = new Hono().route(
    '/',
    walletHeartRoutes({
      authStore: options.auth ?? (await authStore()),
      messages,
      now: options.now ?? (() => START),
      ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
    }),
  );
  return { app, messages };
}

async function post(
  app: Hono,
  value: unknown,
  headers: Record<string, string> = AUTH,
): Promise<Response> {
  return app.request('/me/wallet/hearts', {
    method: 'POST',
    headers,
    body: typeof value === 'string' ? value : JSON.stringify(value),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /me/wallet/hearts', () => {
  it('returns 401 before reading the body for missing or invalid sessions', async () => {
    const { app } = await mount();
    const missing = await post(app, { hashes: [HASH_A] }, { 'content-type': 'application/json' });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ error: 'Unauthorized' });
    const invalid = await post(
      app,
      { hashes: [HASH_A] },
      { ...AUTH, authorization: 'Bearer wrong' },
    );
    expect(invalid.status).toBe(401);
  });

  it('rate limits by account id and allows a new one-minute window', async () => {
    let now = START;
    const { app } = await mount({ now: () => now, limiter: new IpRateLimiter(1) });
    expect((await post(app, { hashes: [HASH_A] })).status).toBe(200);
    const limited = await post(app, { hashes: [HASH_A] });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'Too many requests' });
    now += 60_000;
    expect((await post(app, { hashes: [HASH_A] })).status).toBe(200);
  });

  it('returns 413 for declared and streamed bodies above the cap', async () => {
    const declaredApp = (await mount()).app;
    const declared = await declaredApp.request('/me/wallet/hearts', {
      method: 'POST',
      headers: {
        ...AUTH,
        'content-length': String(HEART_LOOKUP_BODY_LIMIT_BYTES + 1),
      },
      body: '{}',
    });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toEqual({ error: 'Request body is too large' });

    const streamApp = (await mount()).app;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(HEART_LOOKUP_BODY_LIMIT_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const request = new Request('http://x/me/wallet/hearts', {
      method: 'POST',
      headers: AUTH,
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const streamed = await streamApp.request(request);
    expect(streamed.status).toBe(413);
  });

  it('returns 400 for invalid JSON', async () => {
    const { app } = await mount();
    const malformed = await post(app, '{');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Invalid heart lookup' });
  });

  it('returns 400 when hashes is missing', async () => {
    const { app } = await mount();
    for (const value of [{}, { other: true }, null, 1, []]) {
      const response = await post(app, value);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid heart lookup' });
    }
  });

  it('returns 400 for an empty hashes array', async () => {
    const { app } = await mount();
    const response = await post(app, { hashes: [] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid heart lookup' });
  });

  it('returns 400 for more than 32 hashes', async () => {
    const { app } = await mount();
    const hashes = Array.from({ length: 33 }, (_, index) => index.toString(16).padStart(64, '0'));
    const response = await post(app, { hashes });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Invalid heart lookup' });
  });

  it('returns 400 for a bad hashes element', async () => {
    const { app } = await mount();
    for (const hashes of [
      [1],
      ['not-a-hash'],
      ['g'.repeat(64)],
      [HASH_A.slice(0, 63)],
      [HASH_A + 'aa'],
    ]) {
      const response = await post(app, { hashes });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid heart lookup' });
    }
  });

  it('returns a heart for the payer', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_A,
      invoice({
        paymentHash: HASH_A,
        messageId: 'msg-payer',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set(
      'msg-payer',
      note({ id: 'msg-payer', name: '  Ada  ', text: '  Hello forum  ' }),
    );
    const response = await post(app, { hashes: [HASH_A] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_A,
          messageId: 'msg-payer',
          authorName: 'Ada',
          text: 'Hello forum',
          deleted: false,
        },
      ],
    });
  });

  it('returns a heart for the author who is not the payer', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_B,
      invoice({
        paymentHash: HASH_B,
        messageId: 'msg-author',
        payerAccountId: OTHER,
        authorAccountId: ACCOUNT,
        heart: true,
      }),
    );
    messages.notes.set('msg-author', note({ id: 'msg-author', name: 'Bea', text: 'Author note' }));
    const response = await post(app, { hashes: [HASH_B] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_B,
          messageId: 'msg-author',
          authorName: 'Bea',
          text: 'Author note',
          deleted: false,
        },
      ],
    });
  });

  it('omits a gift that is not a heart', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_C,
      invoice({
        paymentHash: HASH_C,
        messageId: 'msg-gift',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: false,
      }),
    );
    messages.notes.set('msg-gift', note({ id: 'msg-gift', name: 'Ada', text: 'Gift' }));
    const response = await post(app, { hashes: [HASH_C] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hearts: [] });
  });

  it('omits a heart of a third account', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_D,
      invoice({
        paymentHash: HASH_D,
        messageId: 'msg-third',
        payerAccountId: OTHER,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set('msg-third', note({ id: 'msg-third', name: 'Ada', text: 'Secret' }));
    const response = await post(app, { hashes: [HASH_D] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hearts: [] });
  });

  it('omits an unknown hash', async () => {
    const { app } = await mount();
    const response = await post(app, { hashes: [HASH_E] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hearts: [] });
  });

  it('returns a duplicate hash once', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_A,
      invoice({
        paymentHash: HASH_A,
        messageId: 'msg-dup',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set('msg-dup', note({ id: 'msg-dup', name: 'Ada', text: 'Once' }));
    const response = await post(app, { hashes: [HASH_A, HASH_A.toUpperCase()] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_A,
          messageId: 'msg-dup',
          authorName: 'Ada',
          text: 'Once',
          deleted: false,
        },
      ],
    });
  });

  it('returns an uppercase hash in lowercase', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_F,
      invoice({
        paymentHash: HASH_F,
        messageId: 'msg-case',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set('msg-case', note({ id: 'msg-case', name: 'Ada', text: 'Case' }));
    const response = await post(app, { hashes: [HASH_F.toUpperCase()] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_F,
          messageId: 'msg-case',
          authorName: 'Ada',
          text: 'Case',
          deleted: false,
        },
      ],
    });
  });

  it('clips name and text with an ellipsis after trimming', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_0,
      invoice({
        paymentHash: HASH_0,
        messageId: 'msg-clip',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set(
      'msg-clip',
      note({
        id: 'msg-clip',
        name: `  ${'💖'.repeat(81)}  `,
        text: `  ${'t'.repeat(241)}  `,
      }),
    );
    const response = await post(app, { hashes: [HASH_0] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_0,
          messageId: 'msg-clip',
          authorName: `${'💖'.repeat(80)}…`,
          text: `${'t'.repeat(240)}…`,
          deleted: false,
        },
      ],
    });
  });

  it('marks deleted true when deletedAt is set', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_1,
      invoice({
        paymentHash: HASH_1,
        messageId: 'msg-hidden',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set(
      'msg-hidden',
      note({
        id: 'msg-hidden',
        name: 'Ada',
        text: 'Hidden',
        deletedAt: new Date(START),
      }),
    );
    const response = await post(app, { hashes: [HASH_1] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_1,
          messageId: 'msg-hidden',
          authorName: 'Ada',
          text: 'Hidden',
          deleted: true,
        },
      ],
    });
  });

  it('marks deleted true with empty name and text when getById returns undefined', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_A,
      invoice({
        paymentHash: HASH_A,
        messageId: 'msg-missing',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    const response = await post(app, { hashes: [HASH_A] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      hearts: [
        {
          paymentHash: HASH_A,
          messageId: 'msg-missing',
          authorName: '',
          text: '',
          deleted: true,
        },
      ],
    });
  });

  it('omits a heart whose messageId is empty or not a string', async () => {
    const { app, messages } = await mount();
    messages.invoices.set(
      HASH_A,
      invoice({
        paymentHash: HASH_A,
        messageId: '',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.invoices.set(HASH_B, {
      ...invoice({
        paymentHash: HASH_B,
        messageId: 'ignored',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
      messageId: 1 as unknown as string,
    });
    const response = await post(app, { hashes: [HASH_A, HASH_B] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hearts: [] });
  });

  it('returns 503 and logs only the account id when a lookup throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages = new ThrowOnSecondHash();
    messages.invoices.set(
      HASH_A,
      invoice({
        paymentHash: HASH_A,
        messageId: 'msg-ok',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    messages.notes.set('msg-ok', note({ id: 'msg-ok', name: 'Ada', text: 'Ok' }));
    const { app } = await mount({ messages });
    const response = await post(app, { hashes: [HASH_A, HASH_B] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Heart lookup is unavailable' });
    const line = String(warn.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        event: 'wallet_hearts.lookup.failed',
        accountId: ACCOUNT,
      }),
    );
    expect(line).not.toContain('lookup down');
  });

  it('returns 503 when getById throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const messages = new ThrowingGetById();
    messages.invoices.set(
      HASH_A,
      invoice({
        paymentHash: HASH_A,
        messageId: 'msg-ok',
        payerAccountId: ACCOUNT,
        authorAccountId: AUTHOR,
        heart: true,
      }),
    );
    const { app } = await mount({ messages });
    const response = await post(app, { hashes: [HASH_A] });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Heart lookup is unavailable' });
  });
});
